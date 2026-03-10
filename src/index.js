'use strict';

/**
 * @fileoverview Local repository state management for gdrive-cli.
 * Provides helpers for reading/writing the config and index files,
 * loading .gdriveignore patterns, and scanning local files with MD5 hashing.
 */

const fs = require('fs-extra');
const path = require('path');
const md5File = require('md5-file');

const GDRIVE_DIR = '.gdrive';
const INDEX_FILE = '.gdrive/index.json';
const CONFIG_FILE = '.gdrive/config.json';
const IGNORE_FILE = '.gdriveignore';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Read and parse `.gdrive/config.json` from the given working directory.
 *
 * @param {string} [cwd=process.cwd()] - Root of the gdrive repository.
 * @returns {Promise<{ folderId: string, remoteName: string, createdAt: string }>}
 * @throws {Error} When the config file does not exist (not a gdrive repository).
 */
async function readConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!(await fs.pathExists(configPath))) {
    throw new Error(
      `Not a gdrive repository. Run ${require('chalk').cyan('gdrive init <folderUrl>')} first.`
    );
  }
  return fs.readJson(configPath);
}

/**
 * Serialise and write a config object to `.gdrive/config.json`,
 * creating parent directories if they do not exist.
 *
 * @param {{ folderId: string, remoteName: string, createdAt: string }} config
 * @param {string} [cwd=process.cwd()] - Root of the gdrive repository.
 * @returns {Promise<void>}
 */
async function writeConfig(config, cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  await fs.outputJson(configPath, config, { spaces: 2 });
}

// ── Index ─────────────────────────────────────────────────────────────────────

/**
 * Read and parse `.gdrive/index.json` from the given working directory.
 * Returns a default empty index when the file does not yet exist.
 *
 * @param {string} [cwd=process.cwd()] - Root of the gdrive repository.
 * @returns {Promise<{ files: Object<string, {
 *   driveId: string,
 *   driveMd5: string|null,
 *   driveModifiedTime: string,
 *   localMd5: string|null
 * }>, lastSync: string|null }>}
 */
async function readIndex(cwd = process.cwd()) {
  const indexPath = path.join(cwd, INDEX_FILE);
  if (!(await fs.pathExists(indexPath))) return { files: {} };
  return fs.readJson(indexPath);
}

/**
 * Serialise and write the index object to `.gdrive/index.json`,
 * creating parent directories if they do not exist.
 *
 * @param {{ files: Object, lastSync: string|null }} index
 * @param {string} [cwd=process.cwd()] - Root of the gdrive repository.
 * @returns {Promise<void>}
 */
async function writeIndex(index, cwd = process.cwd()) {
  const indexPath = path.join(cwd, INDEX_FILE);
  await fs.outputJson(indexPath, index, { spaces: 2 });
}

// ── Ignore patterns ───────────────────────────────────────────────────────────

/**
 * Hard-coded paths that are always excluded regardless of `.gdriveignore`.
 * Prevents metadata and VCS directories from being synced to Drive.
 *
 * @type {Set<string>}
 */
const ALWAYS_IGNORE = new Set([
  '.gdrive',
  '.gdriveignore',
  '.git',
  '.gitignore',
]);

/**
 * Return `true` if any path segment of `rel` matches an entry in
 * `ALWAYS_IGNORE`, ensuring that nested paths inside ignored directories
 * are also excluded.
 *
 * @param {string} rel - Relative file path (may use `\` or `/` separators).
 * @returns {boolean}
 */
function shouldIgnoreRel(rel) {
  const normalized = rel.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.some((p) => ALWAYS_IGNORE.has(p));
}

/**
 * Load glob patterns from `.gdriveignore` and merge them with the built-in
 * defaults. Lines beginning with `#` and blank lines are skipped.
 *
 * @param {string} [cwd=process.cwd()] - Directory containing `.gdriveignore`.
 * @returns {Promise<string[]>} Array of ignore pattern strings.
 */
async function loadIgnorePatterns(cwd = process.cwd()) {
  const ignorePath = path.join(cwd, IGNORE_FILE);
  const defaults = ['.gdrive/', 'node_modules/', '.git/', '.DS_Store', '*.tmp'];

  if (!(await fs.pathExists(ignorePath))) return defaults;

  const lines = (await fs.readFile(ignorePath, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  return [...defaults, ...lines];
}

/**
 * Test whether a relative file path matches any of the given ignore patterns.
 *
 * Pattern matching rules:
 * - Patterns ending with `/` match any path that starts with or contains that prefix.
 * - Patterns starting with `*.` match files by extension.
 * - All other patterns match by exact equality or as a trailing path segment.
 *
 * @param {string}   relativePath - Relative file path to test.
 * @param {string[]} patterns     - Array of ignore pattern strings.
 * @returns {boolean} `true` if the path should be ignored.
 */
function shouldIgnore(relativePath, patterns) {
  const parts = relativePath.split(path.sep).join('/');
  return patterns.some((pat) => {
    if (pat.endsWith("/"))
      return parts.startsWith(pat) || parts.includes("/" + pat);
    if (pat.startsWith("*.")) return parts.endsWith(pat.slice(1));
    return parts === pat || parts.includes("/" + pat);
  });
}

// ── Local file scanning ───────────────────────────────────────────────────────

/**
 * Recursively scan `cwd` and return a map of relative paths to their MD5 checksums.
 * Entries matched by `shouldIgnoreRel` (i.e. `.gdrive`, `.git`, etc.) are skipped.
 * Only regular files are included — directories and special files are ignored.
 *
 * @param {string} cwd - Absolute path to the directory to scan.
 * @returns {Promise<Object<string, { localMd5: string }>>}
 *   Map of `relativePath → { localMd5 }`.
 */
async function scanLocalFiles(cwd) {
  const out = {};

  /**
   * Walk a directory tree depth-first, populating `out` with file entries.
   *
   * @param {string} dir - Absolute path of the directory to walk.
   * @returns {Promise<void>}
   */
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs).replace(/\\/g, "/");

      if (shouldIgnoreRel(rel)) continue;

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      const localMd5 = await md5File(abs);
      out[rel] = { localMd5 };
    }
  }

  await walk(cwd);
  return out;
}

module.exports = {
  GDRIVE_DIR,
  INDEX_FILE,
  CONFIG_FILE,
  IGNORE_FILE,
  readConfig,
  writeConfig,
  readIndex,
  writeIndex,
  loadIgnorePatterns,
  shouldIgnore,
  scanLocalFiles,
};
