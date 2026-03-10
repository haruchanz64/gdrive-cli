'use strict';

/**
 * @fileoverview Pull command for gdrive-cli.
 * Downloads files that have changed on Google Drive since the last sync,
 * handles conflicts interactively, and updates the local index.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const ora = require('ora');
const inquirer = require('inquirer');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive, downloadFile } = require('../drive');
const { readConfig, readIndex, writeIndex, scanLocalFiles } = require('../index');

const cmd = new Command('pull');

/**
 * `gdrive pull`
 *
 * Fetches the remote file list and downloads every file whose Drive MD5
 * differs from the one stored in the local index.
 *
 * Conflict resolution (both local and remote changed):
 * - Without `--force`: prompts the user to choose keep-remote, keep-local,
 *   or keep-both (backs up the local copy as `<file>.local` then downloads).
 * - With `--force`: silently overwrites the local file.
 *
 * Remote deletions:
 * - Files removed on Drive are deleted locally only when `--force` is set;
 *   otherwise a warning is printed.
 *
 * @option {boolean} [--force]   - Overwrite local changes without prompting.
 * @option {boolean} [--dry-run] - Preview changes without downloading anything.
 */
cmd
  .description('Download remote changes from Google Drive')
  .option('--force', 'Overwrite local changes without prompting')
  .option('--dry-run', 'Show what would be downloaded without doing it')
  .action(async (opts) => {
    const cwd = process.cwd();

    try {
      const config = await readConfig(cwd);
      const index = await readIndex(cwd);

      const spinner = ora("Fetching remote file list...").start();
      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      const remoteFiles = await listFilesRecursive(drive, config.folderId);
      const localFiles = await scanLocalFiles(cwd);
      spinner.stop();

      const toDownload = [];
      const conflicts = [];

      // Classify each remote file as up-to-date, downloadable, or conflicted
      for (const remote of remoteFiles) {
        const rel = remote.relativePath;
        const indexed = index.files[rel];
        const local = localFiles[rel];

        const remoteMd5 = remote.md5Checksum || null;
        const indexedDriveMd5 = indexed?.driveMd5 || null;
        const localMd5 = local?.localMd5 || null;
        const indexedLocalMd5 = indexed?.localMd5 || null;

        const remoteChanged = !indexed || remoteMd5 !== indexedDriveMd5;
        const localChanged = indexed && local && localMd5 !== indexedLocalMd5;

        if (!remoteChanged) continue;

        if (localChanged && !opts.force) {
          conflicts.push(remote);
        } else {
          toDownload.push(remote);
        }
      }

      // Prompt the user for each conflicted file
      for (const remote of conflicts) {
        const rel = remote.relativePath;
        console.log(chalk.yellow(`\nConflict: ${rel}`));
        console.log(chalk.dim("  Both local and remote have changed.\n"));

        const { resolution } = await inquirer.prompt([
          {
            type: "list",
            name: "resolution",
            message: `How do you want to resolve this?`,
            choices: [
              { name: "Keep remote  (overwrite local)", value: "remote" },
              { name: "Keep local   (skip this file)", value: "local" },
              { name: "Keep both    (rename local to .local)", value: "both" },
            ],
          },
        ]);

        if (resolution === "remote") {
          toDownload.push(remote);
        } else if (resolution === "both") {
          // Back up the local file before downloading the remote version
          const destPath = path.join(cwd, rel);
          const backupPath = destPath + ".local";
          const fs = require("fs-extra");
          await fs.copy(destPath, backupPath);
          console.log(chalk.dim(`  Backed up to ${rel}.local`));
          toDownload.push(remote);
        }
        // 'local' → skip, no action needed
      }

      if (toDownload.length === 0) {
        console.log(chalk.green("\nAlready up to date."));
        return;
      }

      if (opts.dryRun) {
        console.log(
          chalk.cyan(`\nWould download ${toDownload.length} file(s):\n`),
        );
        for (const f of toDownload) {
          const isNew = !index.files[f.relativePath];
          console.log(
            `  ${isNew ? chalk.green("+ ") : chalk.yellow("↑ ")}${f.relativePath}`,
          );
        }
        return;
      }

      console.log(chalk.cyan(`\nPulling ${toDownload.length} file(s)...\n`));

      let success = 0;
      let failed = 0;

      for (const file of toDownload) {
        const rel = file.relativePath;
        const destPath = path.join(cwd, rel);
        const isNew = !index.files[rel];
        const spinner = ora(`  ${isNew ? "+" : "↑"} ${rel}`).start();

        try {
          await downloadFile(drive, file.id, destPath);

          // Record the new state — local and remote are now identical
          index.files[rel] = {
            driveId: file.id,
            driveMd5: file.md5Checksum || null,
            driveModifiedTime: file.modifiedTime,
            localMd5: file.md5Checksum || null,
          };

          spinner.succeed(
            `  ${isNew ? chalk.green("+") : chalk.yellow("↑")} ${chalk.dim(rel)}`,
          );
          success++;
        } catch (e) {
          spinner.fail(chalk.red(`${rel} — ${e.message}`));
          failed++;
        }
      }

      // Handle files that were deleted on the remote side
      for (const rel of Object.keys(index.files)) {
        const stillOnRemote = remoteFiles.some((f) => f.relativePath === rel);
        if (!stillOnRemote) {
          const localFile = localFiles[rel];
          if (!localFile) {
            // Already gone locally — clean up the stale index entry
            delete index.files[rel];
          } else if (opts.force) {
            const fs = require("fs-extra");
            await fs.remove(path.join(cwd, rel));
            delete index.files[rel];
            console.log(chalk.red(`  - ${rel} (deleted on remote)`));
          } else {
            console.log(
              chalk.yellow(
                `${rel} was deleted on remote (kept locally). Run with --force to delete.`,
              ),
            );
          }
        }
      }

      index.lastSync = new Date().toISOString();
      await writeIndex(index, cwd);

      console.log(
        chalk.green(
          `\nPull complete — ${success} downloaded${failed > 0 ? `, ${failed} failed` : ""}`,
        ),
      );
    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
