// jest.config.js
// Place this file in the root of gdrive-cli/

'use strict';

module.exports = {
  // Look for tests in a /tests directory or files ending in .test.js
  testMatch: [
    '**/tests/**/*.test.js',
    '**/*.test.js',
  ],

  // Don't try to transform node_modules
  testEnvironment: 'node',

  // Collect coverage from source files
  collectCoverageFrom: [
    'src/**/*.js',
  ],

  // Display individual test names in output
  verbose: true,
};

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP INSTRUCTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Install dependencies (from inside gdrive-cli/):
 *
 *      npm install
 *      npm install --save-dev jest
 *
 * 2. Drop all four test files into a tests/ directory:
 *
 *      gdrive-cli/
 *      ├── tests/
 *      │   ├── drive.test.js
 *      │   ├── index.test.js
 *      │   ├── auth.test.js
 *      │   ├── status.test.js
 *      │   └── push-pull.test.js
 *      └── jest.config.js        ← this file
 *
 * 3. Add a test script to package.json:
 *
 *      "scripts": {
 *        "test": "jest",
 *        "test:coverage": "jest --coverage"
 *      }
 *
 * 4. Run the tests:
 *
 *      npm test                  # run all tests
 *      npm test -- --watch       # watch mode
 *      npm run test:coverage     # with coverage report
 *
 *      # Run a single suite:
 *      npx jest tests/drive.test.js
 *      npx jest tests/index.test.js
 *      npx jest tests/auth.test.js
 *      npx jest tests/status.test.js
 *      npx jest tests/push-pull.test.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT EACH FILE TESTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  drive.test.js     – parseFolderId, listFilesRecursive (pagination + recursion),
 *                      downloadFile (stream success + error), uploadFile
 *                      (create vs update), ensureFolder, getRevisions
 *                      → uses jest.mock for googleapis and fs-extra
 *
 *  index.test.js     – readConfig / writeConfig (round-trips, errors),
 *                      readIndex / writeIndex, loadIgnorePatterns,
 *                      shouldIgnore (glob rules), scanLocalFiles (real FS
 *                      via a tmp directory)
 *                      → uses real fs-extra on a per-test tmpDir
 *
 *  auth.test.js      – getAuthClient: missing credentials error, stored token
 *                      path, first-run OAuth flow, "web" credential format,
 *                      token refresh listener registration
 *                      → uses jest.mock for googleapis, fs-extra, readline
 *
 *  status.test.js    – classifyFile state machine: upToDate, localNew,
 *                      localModified, localDeleted, remoteNew, remoteModified,
 *                      remoteDeleted, conflict (all variants), edge cases
 *                      (null md5, Google Docs), bulk scenario table
 *                      → pure function, no mocks needed
 *
 *  push-pull.test.js – computePushList: unchanged skip, modified, new, force
 *                      flag, driveId resolution, mixed states
 *                      computeDeleteList: remote present/absent, local kept
 *                      computePullList: up-to-date, remote changed, conflict,
 *                      new remote file, mixed multi-file scenario
 *                      → pure functions, no mocks needed
 */
