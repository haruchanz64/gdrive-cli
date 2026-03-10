'use strict';

/**
 * @fileoverview Status command for gdrive-cli.
 * Compares local files, the last-known index, and the current remote state
 * to classify every tracked file into one of: new, modified, deleted,
 * conflict, remoteNew, remoteModified, remoteDeleted, or upToDate.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const ora = require('ora');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive } = require('../drive');
const { readConfig, readIndex, scanLocalFiles } = require('../index');

const cmd = new Command('status');

/**
 * `gdrive status`
 *
 * Scans both the local working directory and the remote Drive folder,
 * then prints a categorised diff similar to `git status`.
 *
 * Categories reported:
 * - **New**            – local file not yet in the index or on Drive.
 * - **Modified**       – local file changed since last sync.
 * - **Deleted**        – file removed locally but still in the index.
 * - **Conflict**       – both local and remote changed independently.
 * - **Remote new**     – file added on Drive, not yet pulled.
 * - **Remote modified**– file changed on Drive since last sync.
 * - **Remote deleted** – file removed on Drive, still exists locally.
 *
 * @option {boolean} [--short] - Emit compact one-line-per-file output.
 */
cmd
  .description('Show local vs remote file differences')
  .option('--short', 'Short one-line output per file')
  .action(async (opts) => {
    const cwd = process.cwd();

    try {
      const config = await readConfig(cwd);
      const index = await readIndex(cwd);

      const spinner = ora("Scanning files...").start();

      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      const localFiles = await scanLocalFiles(cwd);

      const remoteFiles = await listFilesRecursive(drive, config.folderId);
      const remoteMap = {};
      for (const f of remoteFiles) {
        remoteMap[f.relativePath] = f;
      }

      spinner.stop();

      const staged = {
        new: [],
        modified: [],
        deleted: [],
        conflict: [],
        remoteNew: [],
        remoteModified: [],
        remoteDeleted: [],
        upToDate: [],
      };

      // Build a unified key set across local, index, and remote
      const allKeys = new Set([
        ...Object.keys(localFiles),
        ...Object.keys(index.files),
        ...Object.keys(remoteMap),
      ]);

      for (const rel of allKeys) {
        const local = localFiles[rel];
        const indexed = index.files[rel];
        const remote = remoteMap[rel];

        const localMd5 = local?.localMd5 || null;
        const indexedLocalMd5 = indexed?.localMd5 || null;
        const indexedDriveMd5 = indexed?.driveMd5 || null;
        const remoteMd5 = remote?.md5Checksum || null;

        if (local && !indexed && !remote) {
          staged.new.push(rel);
        } else if (!local && indexed) {
          staged.deleted.push(rel);
        } else if (local && indexed && !remote) {
          // Was tracked, remote deleted
          if (localMd5 !== indexedLocalMd5) {
            staged.conflict.push({
              file: rel,
              reason: "local modified + remote deleted",
            });
          } else {
            staged.remoteDeleted.push(rel);
          }
        } else if (!local && !indexed && remote) {
          staged.remoteNew.push(rel);
        } else if (local && indexed && remote) {
          const localChanged = localMd5 !== indexedLocalMd5;
          const remoteChanged = remoteMd5 && remoteMd5 !== indexedDriveMd5;

          if (localChanged && remoteChanged) {
            staged.conflict.push({ file: rel, reason: "both changed" });
          } else if (localChanged) {
            staged.modified.push(rel);
          } else if (remoteChanged) {
            staged.remoteModified.push(rel);
          } else {
            staged.upToDate.push(rel);
          }
        }
      }

      const total =
        staged.new.length +
        staged.modified.length +
        staged.deleted.length +
        staged.conflict.length +
        staged.remoteNew.length +
        staged.remoteModified.length +
        staged.remoteDeleted.length;

      const lastSync = index.lastSync
        ? new Date(index.lastSync).toLocaleString()
        : "never";

      if (!opts.short) {
        console.log(chalk.bold(`\n${config.remoteName}`));
        console.log(chalk.dim(`Last sync: ${lastSync}\n`));
      }

      if (total === 0) {
        console.log(chalk.green("Everything up to date"));
        return;
      }

      /**
       * Prints a labelled section of changed files.
       *
       * @param {string} label   - Section heading shown in non-short mode.
       * @param {string} color   - Chalk colour name applied to the heading and file names.
       * @param {Array<string|{file:string,reason:string}>} files - Files to list.
       * @param {string} prefix  - Single-character status prefix (e.g. 'A', 'M', 'D', '!').
       */
      function printSection(label, color, files, prefix) {
        if (!files.length) return;
        if (!opts.short) console.log(chalk[color].bold(label));
        for (const f of files) {
          const name = typeof f === "string" ? f : f.file;
          const note = typeof f === "string" ? "" : chalk.dim(` (${f.reason})`);
          if (opts.short) {
            console.log(`${prefix} ${name}${note}`);
          } else {
            console.log(`  ${prefix} ${chalk[color](name)}${note}`);
          }
        }
        if (!opts.short) console.log("");
      }

      printSection("Changes to push (local → remote):", "yellow", [], "");
      printSection("  New files:", "green", staged.new, "A");
      printSection("  Modified:", "yellow", staged.modified, "M");
      printSection("  Deleted:", "red", staged.deleted, "D");
      printSection("Changes to pull (remote → local):", "cyan", [], "");
      printSection("  New files:", "green", staged.remoteNew, "A");
      printSection("  Modified:", "cyan", staged.remoteModified, "U");
      printSection("  Deleted:", "red", staged.remoteDeleted, "D");
      printSection(
        "Conflicts (manual resolution required):",
        "red",
        staged.conflict,
        "!",
      );

      if (!opts.short) {
        console.log(
          chalk.dim(`\n  ${staged.upToDate.length} file(s) up to date`),
        );
        console.log(
          `\nRun ${chalk.cyan("gdrive push")} to upload local changes.` +
            `\nRun ${chalk.cyan("gdrive pull")} to download remote changes.\n`,
        );
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
