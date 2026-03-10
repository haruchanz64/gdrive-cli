'use strict';

/**
 * @fileoverview Log command for gdrive-cli.
 * Displays the Google Drive revision history for tracked files,
 * showing the date, author, and size of each stored revision.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive, getRevisions } = require('../drive');
const { readConfig, readIndex } = require('../index');

const cmd = new Command('log');

/**
 * `gdrive log [file]`
 *
 * Retrieves and prints the Drive revision history for one or all tracked files.
 *
 * - **Single-file mode** (`gdrive log <file>`): looks up the Drive file ID from
 *   the local index and fetches its full revision list.
 * - **All-files mode** (`gdrive log`): lists the first 20 tracked remote files
 *   to avoid hitting Drive API rate limits.
 *
 * Revisions are displayed newest-first, capped at `--limit` entries per file.
 * Files that do not support revision history (e.g. Google Docs native formats)
 * are silently skipped with a dim notice.
 *
 * @argument {string} [file]       - Relative path of a specific file to inspect.
 * @option   {number} [-n, --limit] - Maximum number of revisions to show per file (default: 5).
 */
cmd
  .description('Show revision history of remote files')
  .argument('[file]', 'Show history for a specific file only')
  .option('-n, --limit <n>', 'Max revisions to show per file', '5')
  .action(async (file, opts) => {
    const cwd = process.cwd();
    const limit = parseInt(opts.limit, 10);

    try {
      const config = await readConfig(cwd);
      const index = await readIndex(cwd);

      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      let targets = [];

      if (file) {
        // Single-file mode: resolve Drive ID from local index
        const indexed = index.files[file];
        if (!indexed)
          throw new Error(`File not tracked: ${file}. Run gdrive pull first.`);
        targets = [{ relativePath: file, id: indexed.driveId }];
      } else {
        // All-files mode: cap at 20 to respect Drive API rate limits
        const spinner = ora("Loading file list...").start();
        const remoteFiles = await listFilesRecursive(drive, config.folderId);
        spinner.stop();
        targets = remoteFiles.slice(0, 20);
        if (remoteFiles.length > 20) {
          console.log(
            chalk.yellow(
              `\nShowing log for first 20 files. Use 'gdrive log <file>' for a specific file.\n`,
            ),
          );
        }
      }

      console.log(chalk.bold(`\nRevision History — ${config.remoteName}\n`));

      for (const target of targets) {
        console.log(chalk.cyan.bold(target.relativePath));

        try {
          const revisions = await getRevisions(drive, target.id);
          // Show the most recent `limit` revisions, newest first
          const toShow = revisions.slice(-limit).reverse();

          if (toShow.length === 0) {
            console.log(chalk.dim("No revision history available"));
          }

          for (const rev of toShow) {
            const date = new Date(rev.modifiedTime).toLocaleString();
            const user = rev.lastModifyingUser?.displayName || "Unknown";
            const size = rev.size
              ? `${(parseInt(rev.size) / 1024).toFixed(1)} KB`
              : "unknown size";

            console.log(
              `  ${chalk.dim(rev.id.slice(0, 8))}  ${chalk.yellow(date)}  ${chalk.green(user)}  ${chalk.dim(size)}`,
            );
          }
        } catch {
          console.log(chalk.dim('Revision history not available for this file type'));
        }

        console.log('');
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
