'use strict';

/**
 * tests/index.test.js
 * Unit tests for src/index.js
 *
 * Run with: npx jest tests/index.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs-extra');

// Use real fs-extra on a temp directory — no mocking needed here
const {
  readConfig,
  writeConfig,
  readIndex,
  writeIndex,
  loadIgnorePatterns,
  shouldIgnore,
  scanLocalFiles,
  GDRIVE_DIR,
  INDEX_FILE,
  CONFIG_FILE,
  IGNORE_FILE,
} = require('../src/index');

// ── Temp directory helpers ───────────────────────────────────────────────────
let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-test-'));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Constants', () => {
  it('exports the expected path constants', () => {
    expect(GDRIVE_DIR).toBe('.gdrive');
    expect(INDEX_FILE).toBe('.gdrive/index.json');
    expect(CONFIG_FILE).toBe('.gdrive/config.json');
    expect(IGNORE_FILE).toBe('.gdriveignore');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('writeConfig / readConfig', () => {
  it('round-trips a config object to disk', async () => {
    const config = { folderId: 'abc123', remoteName: 'My Project' };
    await writeConfig(config, tmpDir);
    const result = await readConfig(tmpDir);
    expect(result).toEqual(config);
  });

  it('creates parent directories automatically', async () => {
    const config = { folderId: 'xyz', remoteName: 'Test' };
    await writeConfig(config, tmpDir);
    expect(await fs.pathExists(path.join(tmpDir, CONFIG_FILE))).toBe(true);
  });

  it('throws a helpful error when config file does not exist', async () => {
    await expect(readConfig(tmpDir)).rejects.toThrow('Not a gdrive repository');
  });

  it('preserves all config fields including nested objects', async () => {
    const config = { folderId: 'f1', remoteName: 'X', createdAt: '2026-01-01T00:00:00Z', extra: { deep: true } };
    await writeConfig(config, tmpDir);
    expect(await readConfig(tmpDir)).toEqual(config);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('writeIndex / readIndex', () => {
  it('returns empty index when no index file exists', async () => {
    const result = await readIndex(tmpDir);
    expect(result).toEqual({ files: {} });
  });

  it('round-trips an index object to disk', async () => {
    const index = {
      files: {
        'doc.txt': { driveId: 'id1', localMd5: 'md5a', driveMd5: 'md5a', driveModifiedTime: '2026-01-01T00:00:00Z' },
      },
      lastSync: '2026-01-01T00:00:00Z',
    };
    await writeIndex(index, tmpDir);
    const result = await readIndex(tmpDir);
    expect(result).toEqual(index);
  });

  it('overwrites existing index on second write', async () => {
    await writeIndex({ files: { 'a.txt': { driveId: 'old' } } }, tmpDir);
    await writeIndex({ files: { 'b.txt': { driveId: 'new' } } }, tmpDir);
    const result = await readIndex(tmpDir);
    // Use array syntax — Jest treats dots in strings as nested key paths
    expect(result.files).not.toHaveProperty(['a.txt']);
    expect(result.files).toHaveProperty(['b.txt']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('loadIgnorePatterns', () => {
  it('returns defaults when .gdriveignore does not exist', async () => {
    const patterns = await loadIgnorePatterns(tmpDir);
    expect(patterns).toContain('.gdrive/');
    expect(patterns).toContain('node_modules/');
    expect(patterns).toContain('.git/');
    expect(patterns).toContain('.DS_Store');
    expect(patterns).toContain('*.tmp');
  });

  it('merges user patterns with defaults', async () => {
    await fs.writeFile(path.join(tmpDir, '.gdriveignore'), 'dist/\n*.log\n');
    const patterns = await loadIgnorePatterns(tmpDir);
    expect(patterns).toContain('.gdrive/');
    expect(patterns).toContain('dist/');
    expect(patterns).toContain('*.log');
  });

  it('ignores comment lines and blank lines in .gdriveignore', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.gdriveignore'),
      '# this is a comment\n\nbuild/\n\n# another comment\n'
    );
    const patterns = await loadIgnorePatterns(tmpDir);
    expect(patterns).toContain('build/');
    expect(patterns).not.toContain('# this is a comment');
    expect(patterns).not.toContain('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('shouldIgnore', () => {
  const defaults = ['.gdrive/', 'node_modules/', '.git/', '.DS_Store', '*.tmp'];

  it('ignores files inside .gdrive/', () => {
    expect(shouldIgnore('.gdrive/config.json', defaults)).toBe(true);
  });

  it('ignores files inside node_modules/', () => {
    expect(shouldIgnore('node_modules/lodash/index.js', defaults)).toBe(true);
  });

  it('ignores .DS_Store exactly', () => {
    expect(shouldIgnore('.DS_Store', defaults)).toBe(true);
  });

  it('ignores files matching *.tmp glob', () => {
    expect(shouldIgnore('session.tmp', defaults)).toBe(true);
    expect(shouldIgnore('subdir/cache.tmp', defaults)).toBe(true);
  });

  it('does NOT ignore normal files', () => {
    expect(shouldIgnore('report.pdf', defaults)).toBe(false);
    expect(shouldIgnore('src/index.js', defaults)).toBe(false);
  });

  it('does NOT ignore files that partially match a pattern name', () => {
    // "node_modules_backup" should not match "node_modules/"
    expect(shouldIgnore('node_modules_backup/file.js', defaults)).toBe(false);
  });

  it('ignores custom extension patterns', () => {
    const patterns = [...defaults, '*.log'];
    expect(shouldIgnore('server.log', patterns)).toBe(true);
    expect(shouldIgnore('logs/app.log', patterns)).toBe(true);
  });

  it('ignores custom directory patterns', () => {
    const patterns = [...defaults, 'dist/'];
    expect(shouldIgnore('dist/bundle.js', patterns)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('scanLocalFiles', () => {
  it('returns an empty object for an empty directory', async () => {
    // No files created — loadIgnorePatterns falls back to defaults when
    // .gdriveignore is absent, so the directory is truly empty
    const result = await scanLocalFiles(tmpDir);
    expect(result).toEqual({});
  });

  it('detects files and returns their md5, size, and modifiedTime', async () => {
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hello world');
    const result = await scanLocalFiles(tmpDir);
    // Use array syntax — Jest treats dots as nested key separators in strings
    expect(result).toHaveProperty(['hello.txt']);
    expect(result['hello.txt']).toMatchObject({
      localMd5: expect.any(String),
      size: expect.any(Number),
      localModifiedTime: expect.any(String),
    });
  });

  it('recursively scans subdirectories', async () => {
    await fs.ensureDir(path.join(tmpDir, 'docs'));
    await fs.writeFile(path.join(tmpDir, 'docs', 'readme.md'), '# Hello');
    const result = await scanLocalFiles(tmpDir);
    expect(result).toHaveProperty(['docs/readme.md']);
  });

  it('excludes .gdrive/ directory from scan', async () => {
    await fs.ensureDir(path.join(tmpDir, '.gdrive'));
    await fs.writeFile(path.join(tmpDir, '.gdrive', 'config.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'real.txt'), 'data');
    const result = await scanLocalFiles(tmpDir);
    expect(result).not.toHaveProperty(['.gdrive/config.json']);
    expect(result).toHaveProperty(['real.txt']);
  });

  it('excludes .tmp files from scan', async () => {
    await fs.writeFile(path.join(tmpDir, 'session.tmp'), 'temp');
    await fs.writeFile(path.join(tmpDir, 'keep.txt'), 'keep');
    const result = await scanLocalFiles(tmpDir);
    expect(result).not.toHaveProperty(['session.tmp']);
    expect(result).toHaveProperty(['keep.txt']);
  });

  it('produces consistent md5 for identical content', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'same content');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'same content');
    const result = await scanLocalFiles(tmpDir);
    expect(result['a.txt'].localMd5).toBe(result['b.txt'].localMd5);
  });

  it('produces different md5 for different content', async () => {
    await fs.writeFile(path.join(tmpDir, 'x.txt'), 'content A');
    await fs.writeFile(path.join(tmpDir, 'y.txt'), 'content B');
    const result = await scanLocalFiles(tmpDir);
    expect(result['x.txt'].localMd5).not.toBe(result['y.txt'].localMd5);
  });
});