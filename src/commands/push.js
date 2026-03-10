'use strict';

/**
 * @fileoverview Push command for gdrive-cli.
 * Uploads new and modified local files to Google Drive, optionally deletes
 * remote files that no longer exist locally, and updates the local index.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const ora = require('ora');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive, uploadFile, ensureFolder } = require('../drive');
const { readConfig, readIndex, writeIndex, scanLocalFiles } = require('../index');

const cmd = new Command('push');

/**
 * `gdrive push`
 *
 * Compares the local working directory against the remote Drive folder
 * and uploads every file that is new or has changed since the last sync.
 * - Recreates the remote folder hierarchy via `ensureFolder` as needed.
 * - Skips files/directories matched by `.gdrive` and `.gdriveignore` rules.
 * - Updates the local index and `lastSync` timestamp on completion.
 *
 * @option {boolean} [--force]   - Upload all local files regardless of remote state.
 * @option {boolean} [--dry-run] - Preview changes without uploading anything.
 * @option {boolean} [--delete]  - Delete remote files that no longer exist locally.
 */
cmd
  .description('Upload local changes to Google Drive')
  .option('--force', 'Push all local files, ignoring remote state')
  .option('--dry-run', 'Show what would be uploaded without doing it')
  .option('--delete', 'Also delete remote files that no longer exist locally')
  .action(async (opts) => {
    const cwd = process.cwd();

    try {
      const config = await readConfig(cwd);
      const index = await readIndex(cwd);

      const spinner = ora("Scanning local and remote files...").start();
      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      const localFiles = await scanLocalFiles(cwd);
      const remoteFiles = await listFilesRecursive(drive, config.folderId);
      spinner.stop();

      // Build a lookup map: relativePath → remote file metadata
      const remoteMap = {};
      for (const f of remoteFiles) remoteMap[f.relativePath] = f;

      const toUpload = []; // { rel, localPath, driveId, isNew, reason }
      const toDelete = []; // { rel, driveId }

      // Identify new and modified local files to upload
      for (const [rel, local] of Object.entries(localFiles)) {
        if (shouldIgnoreRel(rel)) continue;

        const indexed = index.files[rel];
        const remote = remoteMap[rel];

        const localMd5 = local.localMd5;
        const indexedLocalMd5 = indexed?.localMd5 || null;
        const localChanged = !indexed || localMd5 !== indexedLocalMd5;

        if (!localChanged && !opts.force) continue;

        toUpload.push({
          rel,
          localPath: path.join(cwd, rel),
          driveId: remote?.id || indexed?.driveId || null,
          isNew: !remote,
          reason: !indexed ? "new" : "modified",
        });
      }

      // Identify remote files to delete (only when --delete is set)
      if (opts.delete) {
        for (const [rel, info] of Object.entries(index.files)) {
          if (shouldIgnoreRel(rel)) continue;
          if (!localFiles[rel]) {
            const remote = remoteMap[rel];
            if (remote) toDelete.push({ rel, driveId: remote.id });
          }
        }
      }

      if (toUpload.length === 0 && toDelete.length === 0) {
        console.log(chalk.green("\nNothing to push"));
        return;
      }

      if (opts.dryRun) {
        console.log(chalk.cyan(`\nWould push ${toUpload.length} file(s):\n`));
        for (const f of toUpload) {
          const prefix = f.isNew ? chalk.green("+ ") : chalk.yellow("↑ ");
          console.log(`  ${prefix}${f.rel}`);
        }
        if (toDelete.length) {
          console.log(
            chalk.red(`\nWould delete ${toDelete.length} remote file(s):`),
          );
          for (const f of toDelete) console.log(`  - ${f.rel}`);
        }
        return;
      }

      console.log(chalk.cyan(`\nPushing ${toUpload.length} file(s)...\n`));

      let success = 0;
      let failed = 0;

      for (const file of toUpload) {
        const { rel, localPath, driveId, isNew } = file;
        const spinner = ora(`  ${isNew ? "+" : "↑"} ${rel}`).start();

        try {
          // Ensure the full parent folder path exists on Drive
          const parts = rel.split("/");
          const fileName = parts.pop();
          let parentId = config.folderId;

          for (const part of parts) {
            parentId = await ensureFolder(drive, part, parentId);
          }

          const result = await uploadFile(
            drive,
            localPath,
            fileName,
            parentId,
            driveId,
          );

          const md5File = require("md5-file");
          const localMd5 = await md5File(localPath);

          index.files[rel] = {
            driveId: result.id,
            driveMd5: result.md5Checksum || null,
            driveModifiedTime: result.modifiedTime,
            localMd5,
          };

          spinner.succeed(
            `  ${isNew ? chalk.green("+") : chalk.yellow("↑")} ${chalk.dim(rel)}`,
          );
          success++;
        } catch (e) {
          spinner.fail(chalk.red(`  ${file.rel} — ${e.message}`));
          failed++;
        }
      }

      // Handle remote deletions
      if (toDelete.length) {
        console.log(
          chalk.red(`\nDeleting ${toDelete.length} remote file(s)...\n`),
        );
        for (const file of toDelete) {
          const spinner = ora(`  - ${file.rel}`).start();
          try {
            await drive.files.delete({ fileId: file.driveId });
            delete index.files[file.rel];
            spinner.succeed(chalk.red(`  - ${file.rel}`));
          } catch (e) {
            spinner.fail(chalk.red(`  ${file.rel} — ${e.message}`));
          }
        }
      }

      index.lastSync = new Date().toISOString();
      await writeIndex(index, cwd);

      console.log(
        chalk.green(
          `\nPush complete — ${success} uploaded${failed > 0 ? `, ${failed} failed` : ""}${
            toDelete.length ? `, ${toDelete.length} deleted` : ""
          }`,
        ),
      );
    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;

/**
 * Returns `true` if the given relative path should be excluded from push
 * operations (i.e. it is part of the `.gdrive` metadata directory or the
 * `.gdriveignore` file itself).
 *
 * @param {string} rel - Relative file path using either `/` or `\` separators.
 * @returns {boolean}
 */
function shouldIgnoreRel(rel) {
  const normalized = rel.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.includes('.gdrive') || parts.includes('.gdriveignore');
}
