'use strict';

/**
 * @fileoverview Diff command for gdrive-cli.
 * Compares local files against their remote Drive counterparts using MD5
 * checksums and reports size, modification time, and sync status differences.
 * Does not perform a line-by-line content diff.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive } = require('../drive');
const { readConfig, readIndex, scanLocalFiles } = require('../index');

const cmd = new Command('diff');

/**
 * `gdrive diff [file]`
 *
 * Lists files whose local MD5 differs from the remote MD5, printing a
 * git-style header (`---`/`+++`) followed by metadata for each differing file.
 *
 * Per-file output includes:
 * - Whether the file exists only locally, only remotely, or in both places.
 * - Sync status: `local ahead`, `remote ahead`, or `conflict — both changed`.
 * - MD5 checksums and last-modified timestamps for both sides.
 * - Size comparison when both sides are present and sizes differ.
 *
 * Files with identical MD5 checksums on both sides are silently skipped.
 *
 * @argument {string} [file] - Relative path to diff a single file.
 *   When omitted, all tracked and untracked files are compared.
 */
cmd
  .description('Show which files differ between local and remote')
  .argument('[file]', 'Diff a specific file (shows metadata only, no content diff)')
  .action(async (file) => {
    const cwd = process.cwd();

    try {
      const config = await readConfig(cwd);
      const index = await readIndex(cwd);

      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      const localFiles = await scanLocalFiles(cwd);
      const remoteFiles = await listFilesRecursive(drive, config.folderId);

      // Build a lookup map: relativePath → remote file metadata
      const remoteMap = {};
      for (const f of remoteFiles) remoteMap[f.relativePath] = f;

      // Diff a single file or the full union of local and remote paths
      const keys = file
        ? [file]
        : [...new Set([...Object.keys(localFiles), ...Object.keys(remoteMap)])];

      let diffCount = 0;

      for (const rel of keys) {
        const local = localFiles[rel];
        const remote = remoteMap[rel];
        const indexed = index.files[rel];

        const localMd5 = local?.localMd5;
        const remoteMd5 = remote?.md5Checksum;

        // Skip files that are byte-for-byte identical
        if (localMd5 === remoteMd5 && localMd5) continue;

        diffCount++;

        console.log(chalk.bold(`\n--- ${rel} (local)`));
        console.log(chalk.bold(`+++ ${rel} (remote)`));

        if (!local && remote) {
          // File exists on Drive but has not been downloaded yet
          console.log(chalk.green(`  + Only on remote (not downloaded)`));
          console.log(
            chalk.dim(
              `    Remote modified: ${new Date(remote.modifiedTime).toLocaleString()}`,
            ),
          );
          console.log(chalk.dim(`    Remote MD5: ${remoteMd5 || "N/A"}`));
        } else if (local && !remote) {
          // File exists locally but has never been uploaded
          console.log(chalk.red(`  - Only local (not uploaded)`));
          console.log(
            chalk.dim(`    Local modified: ${local.localModifiedTime}`),
          );
          console.log(chalk.dim(`    Local MD5: ${localMd5}`));
        } else if (local && remote) {
          const localDate = local.localModifiedTime;
          const remoteDate = remote.modifiedTime;

          if (indexed) {
            const localChanged = localMd5 !== indexed.localMd5;
            const remoteChanged = remoteMd5 && remoteMd5 !== indexed.driveMd5;
            const status =
              localChanged && remoteChanged
                ? chalk.red("conflict — both changed")
                : localChanged
                  ? chalk.yellow("local ahead")
                  : chalk.cyan("remote ahead");
            console.log(`  Status: ${status}`);
          }

          console.log(
            chalk.dim(`  - local  md5: ${localMd5 || "N/A"}  (${localDate})`),
          );
          console.log(
            chalk.dim(
              `  + remote md5: ${remoteMd5 || "N/A"}  (${new Date(remoteDate).toLocaleString()})`,
            ),
          );

          // Show size delta when both sides report a size and they differ
          if (local.size) {
            const remoteSize = remote.size ? parseInt(remote.size) : null;
            const localSize = local.size;
            if (remoteSize && localSize !== remoteSize) {
              const delta = localSize - remoteSize;
              console.log(
                chalk.dim(
                  `  Size: local ${(localSize / 1024).toFixed(1)} KB  remote ${(remoteSize / 1024).toFixed(1)} KB  (${delta > 0 ? "+" : ""}${(delta / 1024).toFixed(1)} KB)`,
                ),
              );
            }
          }
        }
      }

      if (diffCount === 0) {
        console.log(chalk.green("\nNo differences found"));
      } else {
        console.log(chalk.dim(`\n${diffCount} file(s) differ`));
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
