'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const ora = require('ora');
const { getAuthClient } = require('../auth');
const { getDriveClient, parseFolderId, listFilesRecursive, downloadFile } = require('../drive');
const { writeConfig, writeIndex } = require('../index');

const cmd = new Command('clone');

cmd
  .description('Clone a Google Drive folder into a new local directory')
  .argument('<folderUrl>', 'Google Drive folder URL or folder ID')
  .argument('[directory]', 'Local directory name (defaults to folder name)')
  .action(async (folderUrl, directory) => {
    try {
      const folderId = parseFolderId(folderUrl);

      console.log(chalk.cyan('Authenticating...'));
      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      // Get folder metadata
      const res = await drive.files.get({
        fileId: folderId,
        fields: 'id, name, mimeType',
      });
      const folderMeta = res.data;

      if (folderMeta.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error('The provided ID is not a folder.');
      }

      const targetDir = path.resolve(directory || folderMeta.name);

      if (await fs.pathExists(targetDir)) {
        throw new Error(`Directory already exists: ${targetDir}`);
      }

      await fs.ensureDir(targetDir);

      console.log(chalk.cyan(`Cloning "${folderMeta.name}" into ${path.basename(targetDir)}/\n`));

      // Write config
      await writeConfig(
        { folderId, remoteName: folderMeta.name, createdAt: new Date().toISOString() },
        targetDir
      );

      // List all remote files
      const spinner = ora('Fetching file list...').start();
      const remoteFiles = await listFilesRecursive(drive, folderId);
      spinner.succeed(`Found ${remoteFiles.length} file(s)`);

      const index = { files: {}, lastSync: null };
      let downloaded = 0;

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
            localMd5: file.md5Checksum || null,
          };
          downloaded++;
        } catch (e) {
          bar.fail(chalk.red(`${file.relativePath} — ${e.message}`));
        }
      }

      index.lastSync = new Date().toISOString();
      await writeIndex(index, targetDir);

      // Create .gdriveignore
      await fs.writeFile(
        path.join(targetDir, '.gdriveignore'),
        '# gdrive-cli ignore file\n\n.git/\nnode_modules/\n.DS_Store\n*.tmp\n*.log\n'
      );

      console.log(chalk.green(`\nCloned ${downloaded}/${remoteFiles.length} files into ${path.basename(targetDir)}/`));
      console.log(`\nRun ${chalk.cyan(`cd ${path.basename(targetDir)} && gdrive status`)} to see the repository state.`);
    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;
