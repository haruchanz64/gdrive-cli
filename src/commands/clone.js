'use strict';

/**
 * @fileoverview Clone command for gdrive-cli.
 * Downloads an entire Google Drive folder into a new local directory
 * and writes the tracking index so subsequent push/pull/status work.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const ora = require('ora');
const { getAuthClient } = require('../auth');
const { getDriveClient, parseFolderId, listFilesRecursive, downloadFile } = require('../drive');
const { writeConfig, writeIndex } = require('../index');

const cmd = new Command('clone');

/**
 * `gdrive clone <folderUrl> [directory]`
 *
 * Clones a remote Google Drive folder to a local directory.
 * - Validates that the remote target is a folder (not a file).
 * - Recursively downloads all files, preserving the folder structure.
 * - Writes `.gdrive/config.json`, `.gdrive/index.json`, and `.gdriveignore`.
 *
 * @argument {string} folderUrl  - Google Drive folder URL or raw folder ID.
 * @argument {string} [directory] - Destination directory name. Defaults to the
 *   remote folder name.
 */
cmd
  .description('Clone a Google Drive folder into a new local directory')
  .argument('<folderUrl>', 'Google Drive folder URL or folder ID')
  .argument('[directory]', 'Local directory name (defaults to folder name)')
  .action(async (folderUrl, directory) => {
    try {
      const folderId = parseFolderId(folderUrl);

      console.log(chalk.cyan("Authenticating..."));
      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      // Fetch folder metadata to validate type and get its display name
      const res = await drive.files.get({
        fileId: folderId,
        fields: "id, name, mimeType",
      });
      const folderMeta = res.data;

      if (folderMeta.mimeType !== "application/vnd.google-apps.folder") {
        throw new Error("The provided ID is not a folder.");
      }

      const targetDir = path.resolve(directory || folderMeta.name);

      if (await fs.pathExists(targetDir)) {
        throw new Error(`Directory already exists: ${targetDir}`);
      }

      await fs.ensureDir(targetDir);

      console.log(
        chalk.cyan(
          `Cloning "${folderMeta.name}" into ${path.basename(targetDir)}/\n`,
        ),
      );

      await writeConfig(
        {
          folderId,
          remoteName: folderMeta.name,
          createdAt: new Date().toISOString(),
        },
        targetDir,
      );

      // Recursively list all files in the remote folder
      const spinner = ora("Fetching file list...").start();
      const remoteFiles = await listFilesRecursive(drive, folderId);
      spinner.succeed(`Found ${remoteFiles.length} file(s)`);

      const index = { files: {}, lastSync: null };
      let downloaded = 0;

      // Download each file and record it in the local index
      for (const file of remoteFiles) {
        const destPath = path.join(targetDir, file.relativePath);
        const bar = ora(`  ↓ ${file.relativePath}`).start();

        try {
          await downloadFile(drive, file.id, destPath);
          bar.succeed(chalk.dim(`  ↓ ${file.relativePath}`));

          index.files[file.relativePath] = {
            driveId: file.id,
            driveMd5: file.md5Checksum || null,
            driveModifiedTime: file.modifiedTime,
            localMd5: file.md5Checksum || null, // just downloaded — in sync
          };
          downloaded++;
        } catch (e) {
          bar.fail(chalk.red(`${file.relativePath} — ${e.message}`));
        }
      }

      index.lastSync = new Date().toISOString();
      await writeIndex(index, targetDir);

      await fs.writeFile(
        path.join(targetDir, ".gdriveignore"),
        "# gdrive-cli ignore file\n\n.git/\nnode_modules/\n.DS_Store\n*.tmp\n*.log\n",
      );

      console.log(
        chalk.green(
          `\nCloned ${downloaded}/${remoteFiles.length} files into ${path.basename(targetDir)}/`,
        ),
      );
      console.log(
        `\nRun ${chalk.cyan(`cd ${path.basename(targetDir)} && gdrive status`)} to see the repository state.`,
      );
    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
