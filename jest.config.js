'use strict';

/**
 * @fileoverview Jest configuration for gdrive-cli.
 * Place this file at the project root alongside package.json.
 */

module.exports = {
  testMatch: ['**/tests/**/*.test.js'],
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.js'],
  verbose: true,
  silent: true,
};