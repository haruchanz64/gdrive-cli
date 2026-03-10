'use strict';

/**
 * @fileoverview Authentication commands for gdrive-cli.
 * Handles OAuth2 setup, login, logout, and user info display.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const { getAuthClient, CREDENTIALS_PATH, deleteToken } = require("../auth");

const cmd = new Command('auth');
cmd.description('Manage Google Drive authentication');

/**
 * `gdrive auth setup`
 * Copies a downloaded OAuth2 credentials JSON to the expected config path,
 * or prints manual setup instructions if no file is provided.
 *
 * @option {string} [--file] - Path to the downloaded credentials JSON file.
 */
cmd
  .command('setup')
  .description('Configure OAuth2 credentials')
  .option('--file <path>', 'Path to downloaded credentials JSON')
  .action(async (opts) => {
    try {
      if (opts.file) {
        await fs.copy(opts.file, CREDENTIALS_PATH);
        console.log(chalk.green(`Credentials saved to ${CREDENTIALS_PATH}`));
      } else {
        console.log(chalk.yellow('Steps to set up credentials:\n'));
        console.log('  1. Go to ' + chalk.cyan('https://console.cloud.google.com'));
        console.log('  2. Create a project and enable the ' + chalk.bold('Google Drive API'));
        console.log('  3. Go to APIs & Services → Credentials');
        console.log('  4. Create OAuth 2.0 Client ID (Desktop app type)');
        console.log('  5. Download the JSON file');
        console.log(`  6. Run: ${chalk.cyan(`gdrive auth setup --file ~/Downloads/client_secret.json`)}\n`);
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

/**
 * `gdrive auth login`
 * Initiates the OAuth2 browser flow and verifies authentication
 * by fetching the authenticated user's profile from Google Drive.
 */
cmd
  .command('login')
  .description('Authenticate with Google Drive')
  .action(async () => {
    try {
      const auth = await getAuthClient();
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.about.get({ fields: 'user' });
      const user = res.data.user;
      console.log(chalk.green(`Logged in as ${user.displayName} (${user.emailAddress})`));
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

/**
 * `gdrive auth logout`
 * Removes the stored OAuth2 token from the OS credential store
 * and deletes any legacy token file on disk.
 */
cmd
  .command('logout')
  .description('Remove stored authentication token')
  .action(async () => {
    try {
      await deleteToken();
      console.log(chalk.green("Logged out. Token removed."));
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

/**
 * `gdrive auth whoami`
 * Displays the authenticated user's display name, email address,
 * and current Google Drive storage usage.
 */
cmd
  .command('whoami')
  .description('Show currently authenticated user')
  .action(async () => {
    try {
      const auth = await getAuthClient();
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.about.get({ fields: 'user, storageQuota' });
      const { user, storageQuota } = res.data;

      const usedGB = (parseInt(storageQuota.usage) / 1e9).toFixed(2);
      const limitGB = storageQuota.limit
        ? (parseInt(storageQuota.limit) / 1e9).toFixed(2)
        : '∞';

      console.log(chalk.bold('\nAuthenticated User'));
      console.log(`  Name:    ${user.displayName}`);
      console.log(`  Email:   ${user.emailAddress}`);
      console.log(`  Storage: ${usedGB} GB / ${limitGB} GB\n`);
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

/**
 * `gdrive auth switch`
 * Removes the currently stored OAuth2 token and immediately starts a new
 * browser-based login flow, allowing the user to authenticate with a
 * different Google account.
 */
cmd
  .command('switch')
  .description('Switch to a different Google account')
  .action(async () => {
    try {
      console.log(chalk.cyan('Signing out of current account...'));
      await deleteToken();
      console.log(chalk.dim('  Token removed.'));

      console.log(chalk.cyan('\nStarting login for new account...'));
      const auth = await getAuthClient();

      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.about.get({ fields: 'user' });
      const user = res.data.user;

      console.log(chalk.green(`\nSwitched to ${user.displayName} (${user.emailAddress})`));
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

module.exports = cmd;