#!/usr/bin/env node
'use strict';

/**
 * @fileoverview Main CLI entry point for gdrive-cli.
 * Registers all sub-commands and parses process arguments.
 */

const { program } = require('commander');
const chalk = require('chalk');
const { version } = require('./package.json');

program
  .name('gdrive')
  .description(chalk.cyan('Git-like CLI for Google Drive'))
  .version(version);

program.addCommand(require('./src/commands/init'));
program.addCommand(require('./src/commands/clone'));
program.addCommand(require('./src/commands/status'));
program.addCommand(require('./src/commands/pull'));
program.addCommand(require('./src/commands/push'));
program.addCommand(require('./src/commands/log'));
program.addCommand(require('./src/commands/diff'));
program.addCommand(require('./src/commands/auth'));

program.parse(process.argv);
