# gdrive-cli

A Git-like CLI for Google Drive. Pull, push, check status, diff, and view
revision history from your terminal — the same way you work with Git.

```
$ gdrive status

My Project Folder
   Last sync: 3/8/2026, 10:00:00 AM

Changes to push (local -> remote):
  A report.pdf
  M notes.txt

Changes to pull (remote -> local):
  U slides.pptx

  3 files up to date
```

---

## Requirements

- Node.js 18 or later
- A Google account
- A Google Cloud project with the Drive API enabled (see Setup below)

---

## Installation

```bash
npm install -g @haruchanz64/gdrive-cli
```

Or run without installing:

```bash
node cli.js <command>
```

---

## Setup

> **Follow these steps in order.** You only need to do this once.

### Step 1 — Create OAuth credentials on Google Cloud

gdrive-cli uses Google OAuth2 to access your Drive. Because Google requires
every third-party app to be registered, you need to create your own OAuth
credentials before using the tool. This takes about five minutes.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Go to **APIs & Services → Library**, search for **Google Drive API**, and enable it
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Choose **Desktop app**, give it any name, and click **Create**
6. On the credential detail page, add `http://localhost:4242` under **Authorized redirect URIs**
7. Click **Download JSON** and save the file somewhere on your machine (e.g. `~/Downloads/client_secret.json`)

---

### Step 2 — Save the credentials file

Point the CLI to the JSON file you just downloaded:

```bash
gdrive auth setup --file ~/Downloads/client_secret.json
```

> This copies the file to `~/.gdrive/credentials.json`.  
> You do **not** need to run this again unless you rotate your credentials.

---

### Step 3 — Log in to your Google account

```bash
gdrive auth login
```

Your browser opens automatically. Sign in with your Google account and click
**Allow**. The terminal confirms when authentication is complete — no code to
copy and paste.

To verify you are logged in:

```bash
gdrive auth whoami
```

```
Authenticated User
  Name:    Jane Doe
  Email:   jane@gmail.com
  Storage: 4.20 GB / 15.00 GB
```

---

### Full setup at a glance

```bash
# 1. Download your credentials JSON from Google Cloud Console (manual step above)

# 2. Save it to the CLI config
gdrive auth setup --file ~/Downloads/client_secret.json

# 3. Log in — opens your browser
gdrive auth login

# 4. Confirm you are authenticated
gdrive auth whoami
```

---

## Quick start

```bash
# Go to the directory you want to sync
cd my-project

# Option A: Create a new Drive folder automatically (uses the current directory name)
gdrive init

# Option B: Create a new Drive folder with a custom name
gdrive init --name "My Project Folder"

# Option C: Link to an existing Drive folder
gdrive init https://drive.google.com/drive/folders/1xYzABC...

# See what is different between local and remote
gdrive status

# Download everything from Drive
gdrive pull

# Make some changes, then upload them
gdrive push
```

---

## Commands

### `gdrive auth`

```bash
gdrive auth setup --file <path>   # Step 1: save your OAuth credentials JSON
gdrive auth login                  # Step 2: open browser and authenticate
gdrive auth whoami                 # Show current user and storage quota
gdrive auth switch                 # Sign out and log in as a different account
gdrive auth logout                 # Remove stored token
```

#### Switching accounts

If you need to use gdrive-cli with a different Google account, run:

```bash
gdrive auth switch
```

This removes the currently stored token and immediately opens your browser
so you can sign in with a different account. When complete, the terminal
confirms the new account:

```
Signing out of current account...
  Token removed.

Starting login for new account...

Authenticated User
  Name:    John Doe
  Email:   john@gmail.com
  Storage: 1.50 GB / 15.00 GB
```

> `gdrive auth switch` is equivalent to running `gdrive auth logout` followed
> by `gdrive auth login`, but does both in a single step and confirms the new
> account automatically.

---

### `gdrive init [folderUrl]`

Initialize the current directory as a gdrive repository.

- If `folderUrl` (or raw folder ID) is provided, links to that existing Drive folder.
- If omitted, creates a new Drive folder automatically.
- Use `--name <n>` to set the remote folder name when creating (or override the display name when linking).
- Creates `.gdrive/` with `config.json` and `index.json`.
- Creates `.gdriveignore` if missing.
- If `.gitignore` exists, appends `.gdrive/` when not already present.

```bash
# Create a new Drive folder named after the current directory
gdrive init

# Create a new Drive folder with an explicit name
gdrive init --name "Project Backup"

# Link to an existing Drive folder
gdrive init https://drive.google.com/drive/folders/1xYzABC...
gdrive init 1xYzABC...    # raw folder ID also works
```

---

### `gdrive clone <folderUrl> [directory]`

Clone a Drive folder into a new local directory.

```bash
gdrive clone https://drive.google.com/drive/folders/1xYzABC... my-project
```

---

### `gdrive status`

Show what has changed locally vs. remotely since the last sync.

```bash
gdrive status
gdrive status --short    # compact one-line-per-file output
```

| Symbol | Meaning |
|--------|---------|
| `A` | New file, not yet pushed or pulled |
| `M` | Modified locally |
| `U` | Updated on remote |
| `!` | Conflict — both sides changed |
| `D` | Deleted |

---

### `gdrive pull`

Download remote changes to your local directory.

```bash
gdrive pull
gdrive pull --force      # overwrite local changes without prompting
gdrive pull --dry-run    # preview what would be downloaded
```

When a file has been changed both locally and on Drive, the CLI prompts you
to resolve the conflict:

```
⚠ Conflict: report.pdf
  Both local and remote have changed.

? How do you want to resolve this?
  > Keep remote  (overwrite local)
    Keep local   (skip this file)
    Keep both    (rename local copy to report.pdf.local)
```

---

### `gdrive push`

Upload local changes to Drive.

```bash
gdrive push
gdrive push --force      # upload all files regardless of change state
gdrive push --dry-run    # preview what would be uploaded
gdrive push --delete     # also delete remote files that no longer exist locally
```

---

### `gdrive diff [file]`

Show which files differ between local and remote, with checksum and size details.

```bash
gdrive diff
gdrive diff report.pdf
```

---

### `gdrive log [file]`

Show revision history using Drive's built-in versioning.

```bash
gdrive log
gdrive log report.pdf
gdrive log -n 10         # show up to 10 revisions per file
```

---

## .gdriveignore

Place a `.gdriveignore` file in your project root to exclude files and
directories from push and pull. The syntax is the same as `.gitignore`.

```
# Ignore build output
dist/

# Ignore logs and temp files
*.log
*.tmp

# Ignore dependencies
node_modules/

# Ignore secrets
.env
```

A default `.gdriveignore` is created automatically when you run `gdrive init`
or `gdrive clone` if one does not already exist.

---

## How it works

```
your-directory/
├── .gdrive/
│   ├── config.json    <- remote folder ID and name
│   └── index.json     <- snapshot of file states (md5, driveId, modifiedTime)
├── .gdriveignore
└── your files...
```

Change detection uses MD5 checksums stored in `.gdrive/index.json`, not
file modification timestamps. A file that is copied or touched without its
content changing will not be flagged as modified.

| localMd5 vs indexed | driveMd5 vs indexed | Status |
|---------------------|---------------------|--------|
| same | same | Up to date |
| different | same | Push needed |
| same | different | Pull needed |
| different | different | Conflict |

OAuth tokens are stored securely in your OS credential store
(Windows Credential Manager, macOS Keychain, or libsecret on Linux)
and are never written to the project directory.

---

## Limitations

- **Google Docs, Sheets, and Slides** (native Google formats) cannot be
  downloaded directly and are skipped. Export them to PDF or XLSX first
  if you need to track them.
- **Line-by-line diffs** are not available. Drive has no diff API, so
  `gdrive diff` compares checksums and metadata only.
- **Large files** may occasionally hit Drive API rate limits. Retry the
  command if that happens.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT License — Copyright (c) 2026 gdrive-cli contributors.  
See the [LICENSE](LICENSE) file for the full license text.
