# Contributing to gdrive-cli

Thanks for taking the time to contribute. This document covers how to get the
project running locally, the testing setup, and the general pull request process.

---

## Getting started

You will need Node.js 18 or later.

```bash
git clone https://github.com/haruchanz64/gdrive-cli
cd gdrive-cli
npm install
npm link        # makes "gdrive" available as a global command
```

---

## Project structure

```
gdrive-cli/
├── cli.js                  entry point, registers all commands
├── src/
│   ├── auth.js             OAuth2 flow and token storage
│   ├── drive.js            Google Drive API wrapper
│   ├── index.js            local index and config management
│   └── commands/
│       ├── auth.js         gdrive auth subcommands
│       ├── clone.js        gdrive clone
│       ├── diff.js         gdrive diff
│       ├── init.js         gdrive init
│       ├── log.js          gdrive log
│       ├── pull.js         gdrive pull
│       ├── push.js         gdrive push
│       └── status.js       gdrive status
└── tests/
    ├── auth.test.js
    ├── drive.test.js
    ├── index.test.js
    ├── push-pull.test.js
    └── status.test.js
```

---

## Running tests

The test suite uses Jest and does not require real Google credentials —
all Drive API calls are mocked.

```bash
npm test                  # run all tests
npm test -- --watch       # watch mode
npm run test:coverage     # with coverage report
```

No files are written to your home directory during tests. The only real
filesystem I/O happens in `index.test.js`, which uses a temporary directory
that is cleaned up after each test.

---

## Authentication for manual testing

To test end-to-end against a real Google Drive folder you need your own
OAuth credentials. See the Setup section in the README for the full steps.
Keep your `client_secret.json` and `~/.gdrive/token.json` out of the repo
— they are already covered by `.gitignore`.

---

## Making changes

- Keep each command self-contained in its own file under `src/commands/`
- Drive API calls belong in `src/drive.js`, not inside command files
- Add or update tests for any logic change — especially in `src/index.js`
  and the push/pull/status decision logic
- Run `npm test` before opening a PR and make sure all tests pass

---

## Pull request checklist

- [ ] `npm test` passes with no failures
- [ ] New behaviour is covered by a test
- [ ] No credentials, tokens, or personal Drive folder IDs are committed
- [ ] README/CONTRIBUTING are updated if command usage changed (for example, `gdrive init [folderUrl]` or `--name`)

---

## Reporting bugs

Open an issue and include:

- Your Node.js version (`node --version`)
- The command you ran
- The full error output
- Whether it happens with `--dry-run` as well (if applicable)

Do not include your `client_secret.json` contents or token values in issues.