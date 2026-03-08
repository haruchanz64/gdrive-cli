'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const { getAuthClient } = require('../auth');
const { getDriveClient, listFilesRecursive } = require('../drive');
const { readConfig, readIndex, scanLocalFiles } = require('../index');

const cmd = new Command('diff');

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
      const remoteMap = {};
      for (const f of remoteFiles) remoteMap[f.relativePath] = f;

      // Filter to specific file if requested
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

        if (localMd5 === remoteMd5 && localMd5) continue; // identical

        diffCount++;

        console.log(chalk.bold(`\n--- ${rel} (local)`));
        console.log(chalk.bold(`+++ ${rel} (remote)`));

        if (!local && remote) {
          console.log(chalk.green(`  + Only on remote (not downloaded)`));
          console.log(chalk.dim(`    Remote modified: ${new Date(remote.modifiedTime).toLocaleString()}`));
          console.log(chalk.dim(`    Remote MD5: ${remoteMd5 || 'N/A'}`));
        } else if (local && !remote) {
          console.log(chalk.red(`  - Only local (not uploaded)`));
          console.log(chalk.dim(`    Local modified: ${local.localModifiedTime}`));
          console.log(chalk.dim(`    Local MD5: ${localMd5}`));
        } else if (local && remote) {
          // Both exist but differ
          const localDate = local.localModifiedTime;
          const remoteDate = remote.modifiedTime;

          if (indexed) {
            const localChanged = localMd5 !== indexed.localMd5;
            const remoteChanged = remoteMd5 && remoteMd5 !== indexed.driveMd5;
            const status =
              localChanged && remoteChanged
                ? chalk.red('conflict — both changed')
                : localChanged
                ? chalk.yellow('local ahead')
                : chalk.cyan('remote ahead');
            console.log(`  Status: ${status}`);
          }

          console.log(chalk.dim(`  - local  md5: ${localMd5 || 'N/A'}  (${localDate})`));
          console.log(chalk.dim(`  + remote md5: ${remoteMd5 || 'N/A'}  (${new Date(remoteDate).toLocaleString()})`));

          // Size comparison
          if (local.size) {
            const remoteSize = remote.size ? parseInt(remote.size) : null;
            const localSize = local.size;
            if (remoteSize && localSize !== remoteSize) {
              const delta = localSize - remoteSize;
              console.log(
                chalk.dim(
                  `  Size: local ${(localSize / 1024).toFixed(1)} KB  remote ${(remoteSize / 1024).toFixed(1)} KB  (${delta > 0 ? '+' : ''}${(delta / 1024).toFixed(1)} KB)`
                )
              );
            }
          }
        }
      }

      if (diffCount === 0) {
        console.log(chalk.green('\nNo differences found'));
      } else {
        console.log(chalk.dim(`\n${diffCount} file(s) differ`));
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
