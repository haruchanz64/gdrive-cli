'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const { getAuthClient } = require('../auth');
const { getDriveClient, parseFolderId, createRootFolder } = require('../drive');
const { writeConfig, writeIndex, GDRIVE_DIR } = require('../index');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function hideDirectoryOnWindows(dirPath) {
  if (process.platform !== 'win32') return;
  try {
    await execFileAsync('attrib', ['+h', dirPath]);
  } catch {
    // Ignore errors (e.g. if attrib is not available)
  }
}

const cmd = new Command('init');

cmd
  .description('Initialize a gdrive repository, creating the Drive folder automatically')
  .argument('[folderUrl]', 'Link to an existing Drive folder URL or ID (optional)')
  .option('--name <n>', 'Name for the new Drive folder (defaults to current directory name)')
  .action(async (folderUrl, opts) => {
    const cwd = process.cwd();
    const gdrivePath = path.join(cwd, GDRIVE_DIR);
    const dirName = path.basename(cwd);

    try {
      if (await fs.pathExists(gdrivePath)) {
        const shownPath = gdrivePath.replace(/\\/g, '/') + '/';
        console.log(chalk.yellow(`Reinitialized existing gdrive repository in ${shownPath}`));
        return; // success, like git init
      }

      console.log(chalk.cyan('Authenticating...'));
      const auth = await getAuthClient();
      const drive = getDriveClient(auth);

      let folderId;
      let remoteName;

      if (folderUrl) {
        // ── Link to existing folder ────────────────────────────────────────
        console.log(chalk.cyan('Verifying remote folder...'));
        folderId = parseFolderId(folderUrl);

        let folderMeta;
        try {
          const res = await drive.files.get({
            fileId: folderId,
            fields: 'id, name, mimeType',
          });
          folderMeta = res.data;
        } catch {
          throw new Error(
            `Cannot access folder ${folderId}.\n` +
            `Make sure it exists and is shared with your account.`
          );
        }

        if (folderMeta.mimeType !== 'application/vnd.google-apps.folder') {
          throw new Error(`The provided ID is not a folder (got: ${folderMeta.mimeType})`);
        }

        remoteName = opts.name || folderMeta.name;
        console.log(chalk.dim(`  Linked to existing folder "${remoteName}"`));

      } else {
        // ── Create a new folder on Drive ───────────────────────────────────
        remoteName = opts.name || dirName;
        console.log(chalk.cyan(`Creating Drive folder "${remoteName}"...`));

        const created = await createRootFolder(drive, remoteName);
        folderId = created.id;

        console.log(chalk.dim(`  Created at ${chalk.white(created.webViewLink)}`));
      }

      // Write config and empty index
      await writeConfig({ folderId, remoteName, createdAt: new Date().toISOString() });
      await writeIndex({ files: {}, lastSync: null });

      // Append .gdrive/ to .gitignore if the project uses git
      const gitignorePath = path.join(cwd, '.gitignore');
      if (await fs.pathExists(gitignorePath)) {
        const content = await fs.readFile(gitignorePath, 'utf8');
        if (!content.includes('.gdrive')) {
          await fs.appendFile(gitignorePath, '\n# gdrive-cli\n.gdrive/\n');
          console.log(chalk.dim('  Added .gdrive/ to .gitignore'));
        }
      }

      // Create default .gdriveignore if missing
      const ignorePath = path.join(cwd, '.gdriveignore');
      if (!(await fs.pathExists(ignorePath))) {
        await fs.writeFile(
          ignorePath,
          '# gdrive-cli ignore file (same syntax as .gitignore)\n\n' +
          '.git/\n' +
          'node_modules/\n' +
          '.DS_Store\n' +
          '*.tmp\n' +
          '*.log\n'
        );
        console.log(chalk.dim('  Created .gdriveignore'));
      }

      await fs.ensureDir(gdrivePath);
      await hideDirectoryOnWindows(gdrivePath);

      console.log(chalk.green(`\nInitialized gdrive repository`));
      console.log(`  Drive folder: ${chalk.bold(remoteName)}`);
      console.log(`  Folder ID:    ${chalk.dim(folderId)}`);

      if (folderUrl) {
        console.log(`\nRun ${chalk.cyan('gdrive pull')} to download remote files.`);
      } else {
        console.log(`\nRun ${chalk.cyan('gdrive push')} to upload local files to Drive.`);
      }

    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      if (await fs.pathExists(gdrivePath)) await fs.remove(gdrivePath);
      process.exit(1);
    }
  });

module.exports = cmd;