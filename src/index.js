'use strict';

const fs = require('fs-extra');
const path = require('path');
const md5File = require('md5-file');

const GDRIVE_DIR = '.gdrive';
const INDEX_FILE = '.gdrive/index.json';
const CONFIG_FILE = '.gdrive/config.json';
const IGNORE_FILE = '.gdriveignore';

// ── Config ───────────────────────────────────────────────────────────────────

async function readConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!(await fs.pathExists(configPath))) {
    throw new Error(
      `Not a gdrive repository. Run ${require('chalk').cyan('gdrive init <folderUrl>')} first.`
    );
  }
  return fs.readJson(configPath);
}

async function writeConfig(config, cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  await fs.outputJson(configPath, config, { spaces: 2 });
}

// ── Index ────────────────────────────────────────────────────────────────────

async function readIndex(cwd = process.cwd()) {
  const indexPath = path.join(cwd, INDEX_FILE);
  if (!(await fs.pathExists(indexPath))) return { files: {} };
  return fs.readJson(indexPath);
}

async function writeIndex(index, cwd = process.cwd()) {
  const indexPath = path.join(cwd, INDEX_FILE);
  await fs.outputJson(indexPath, index, { spaces: 2 });
}

// ── Ignore patterns ───────────────────────────────────────────────────────────

const ALWAYS_IGNORE = new Set([
  '.gdrive',
  '.gdriveignore',
  '.git',
  '.gitignore',
]);

function shouldIgnoreRel(rel) {
  const normalized = rel.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.some((p) => ALWAYS_IGNORE.has(p));
}

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

function shouldIgnore(relativePath, patterns) {
  const parts = relativePath.split(path.sep).join('/');
  return patterns.some((pat) => {
    // Simple glob matching
    if (pat.endsWith('/')) return parts.startsWith(pat) || parts.includes('/' + pat);
    if (pat.startsWith('*.')) return parts.endsWith(pat.slice(1));
    return parts === pat || parts.includes('/' + pat);
  });
}

// ── Local file scanning ───────────────────────────────────────────────────────

async function scanLocalFiles(cwd) {
  const out = {};

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs).replace(/\\/g, '/');

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
