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
npm install -g .
```

Or run without installing:

```bash
node cli.js <command>
```

---

## Setup

gdrive-cli uses Google OAuth2 to access your Drive. Because Google requires
every third-party app to be registered, you need to create your own OAuth
credentials once before using the tool. This takes about five minutes and
is a one-time step.

### 1. Create OAuth credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Go to **APIs & Services -> Library**, search for **Google Drive API**, and enable it
4. Go to **APIs & Services -> Credentials -> Create Credentials -> OAuth 2.0 Client ID**
5. Choose **Desktop app**, give it any name, and click Create
6. On the credential detail page, add `http://localhost:4242` under **Authorized redirect URIs**
7. Click **Download JSON** and save the file

### 2. Configure the CLI

```bash
gdrive auth setup --file ~/Downloads/client_secret.json
```

### 3. Log in

```bash
gdrive auth login
```

Your browser opens automatically. Sign in with your Google account and click
Allow. The terminal confirms when authentication is complete — no code to
copy and paste.

---

## Quick start

```bash
# Start in your project directory
cd my-project

# Option 1: Create a new Drive folder automatically (uses local directory name)
gdrive init

# Option 2: Create a new Drive folder with a custom name
gdrive init --name "My Project Folder"

# Option 3: Link to an existing Drive folder
gdrive init https://drive.google.com/drive/folders/1xYzABC...
```

# See what is on the remote
gdrive status

# Download everything from Drive
gdrive pull

# Make some changes, then upload them
gdrive push
```

---

## Commands

### `gdrive init [folderUrl]`

Initialize the current directory as a gdrive repository.

- If `folderUrl` (or raw folder ID) is provided, links to that existing Drive folder.
- If omitted, creates a new Drive folder automatically.
- Use `--name <n>` to set the remote folder name when creating a folder (or override display name when linking).
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

Creates a `.gdrive/` directory with `config.json` (folder ID) and
`index.json` (file state snapshot).

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
Conflict: report.pdf
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

### `gdrive auth`

```bash
gdrive auth setup --file <path>   # configure OAuth credentials
gdrive auth login                  # open browser and authenticate
gdrive auth logout                 # remove stored token
gdrive auth whoami                 # show current user and storage quota
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
(or `gdrive clone`) if one does not already exist.

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

Credentials and tokens are stored in `~/.gdrive/` on your machine and are
never written to the project directory.

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

MIT