'use strict';

/**
 * tests/commands/push-pull.test.js
 * Unit tests for the push/pull decision logic
 *
 * Rather than spawning the full CLI commands (which require auth + Drive),
 * we extract and test the core "what needs to happen" logic as pure functions.
 *
 * Run with: npx jest tests/commands/push-pull.test.js
 */

// ─────────────────────────────────────────────────────────────────────────────
// Push logic: decide which files to upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the local file map, the index, and the remote map,
 * return the list of files that need to be uploaded.
 *
 * @param {Object} localFiles  { rel: { localMd5 } }
 * @param {Object} index       { files: { rel: { localMd5, driveMd5, driveId } } }
 * @param {Object} remoteMap   { rel: { id, md5Checksum } }
 * @param {boolean} force      upload all files regardless
 * @returns {{ rel, driveId, isNew, reason }[]}
 */
function computePushList(localFiles, index, remoteMap, force = false) {
  const toUpload = [];

  for (const [rel, local] of Object.entries(localFiles)) {
    const indexed = index.files[rel];
    const remote = remoteMap[rel];

    const localChanged = !indexed || local.localMd5 !== indexed.localMd5;

    if (!localChanged && !force) continue;

    toUpload.push({
      rel,
      driveId: remote?.id || indexed?.driveId || null,
      isNew: !remote,
      reason: !indexed ? 'new' : 'modified',
    });
  }

  return toUpload;
}

/**
 * Compute files that should be deleted from remote
 * (present in index but missing locally, when --delete flag is set).
 */
function computeDeleteList(localFiles, index, remoteMap) {
  const toDelete = [];
  for (const [rel, info] of Object.entries(index.files)) {
    if (!localFiles[rel]) {
      const remote = remoteMap[rel];
      if (remote) toDelete.push({ rel, driveId: remote.id });
    }
  }
  return toDelete;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull logic: decide which files to download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the local file map, the index, and the remote file list,
 * return the list of files that need to be downloaded, and any conflicts.
 */
function computePullList(localFiles, index, remoteFiles) {
  const toDownload = [];
  const conflicts = [];

  for (const remote of remoteFiles) {
    const rel = remote.relativePath;
    const indexed = index.files[rel];
    const local = localFiles[rel];

    const remoteMd5 = remote.md5Checksum || null;
    const indexedDriveMd5 = indexed?.driveMd5 || null;
    const localMd5 = local?.localMd5 || null;
    const indexedLocalMd5 = indexed?.localMd5 || null;

    const remoteChanged = !indexed || remoteMd5 !== indexedDriveMd5;
    const localChanged = indexed && local && localMd5 !== indexedLocalMd5;

    if (!remoteChanged) continue;

    if (localChanged) {
      conflicts.push(remote);
    } else {
      toDownload.push(remote);
    }
  }

  return { toDownload, conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────────────────────────────────────
function local(rel, md5) {
  return { [rel]: { localMd5: md5 } };
}
function remoteFile(rel, id, md5) {
  return { relativePath: rel, id, md5Checksum: md5 };
}
function indexEntry(rel, localMd5, driveMd5, driveId = 'id_' + rel) {
  return { [rel]: { localMd5, driveMd5, driveId } };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('computePushList', () => {
  it('returns empty list when nothing has changed', () => {
    const result = computePushList(
      local('a.txt', 'aaa'),
      { files: indexEntry('a.txt', 'aaa', 'aaa') },
      { 'a.txt': { id: 'drv1', md5Checksum: 'aaa' } }
    );
    expect(result).toHaveLength(0);
  });

  it('marks locally modified files for upload', () => {
    const result = computePushList(
      local('a.txt', 'NEW'),
      { files: indexEntry('a.txt', 'OLD', 'OLD') },
      { 'a.txt': { id: 'drv1', md5Checksum: 'OLD' } }
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rel: 'a.txt', isNew: false, reason: 'modified' });
  });

  it('marks new local files (not in index) for upload', () => {
    const result = computePushList(
      local('new.txt', 'zzz'),
      { files: {} },
      {}
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rel: 'new.txt', isNew: true, reason: 'new', driveId: null });
  });

  it('sets driveId from remote map when file exists remotely', () => {
    const result = computePushList(
      local('doc.txt', 'NEW'),
      { files: indexEntry('doc.txt', 'OLD', 'OLD', 'idx_id') },
      { 'doc.txt': { id: 'remote_id', md5Checksum: 'OLD' } }
    );
    expect(result[0].driveId).toBe('remote_id');
  });

  it('falls back to indexed driveId when file is not in remote map', () => {
    const result = computePushList(
      local('doc.txt', 'NEW'),
      { files: indexEntry('doc.txt', 'OLD', 'OLD', 'idx_id') },
      {}
    );
    expect(result[0].driveId).toBe('idx_id');
  });

  it('uploads everything when force=true, even unchanged files', () => {
    const result = computePushList(
      { 'a.txt': { localMd5: 'same' }, 'b.txt': { localMd5: 'same2' } },
      { files: { 'a.txt': { localMd5: 'same', driveMd5: 'same' }, 'b.txt': { localMd5: 'same2', driveMd5: 'same2' } } },
      {},
      true // force
    );
    expect(result).toHaveLength(2);
  });

  it('handles multiple files with mixed states', () => {
    const result = computePushList(
      { 'changed.txt': { localMd5: 'NEW' }, 'same.txt': { localMd5: 'ABC' }, 'added.txt': { localMd5: 'XYZ' } },
      { files: { 'changed.txt': { localMd5: 'OLD', driveMd5: 'OLD' }, 'same.txt': { localMd5: 'ABC', driveMd5: 'ABC' } } },
      {}
    );
    const rels = result.map((f) => f.rel);
    expect(rels).toContain('changed.txt');
    expect(rels).toContain('added.txt');
    expect(rels).not.toContain('same.txt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeDeleteList', () => {
  it('returns files that exist on remote but were deleted locally', () => {
    const result = computeDeleteList(
      {}, // no local files
      { files: { 'gone.txt': { driveId: 'drv_gone' } } },
      { 'gone.txt': { id: 'drv_gone' } }
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rel: 'gone.txt', driveId: 'drv_gone' });
  });

  it('skips files that are not on remote (already deleted remotely)', () => {
    const result = computeDeleteList(
      {},
      { files: { 'ghost.txt': { driveId: 'old_id' } } },
      {} // not in remote map
    );
    expect(result).toHaveLength(0);
  });

  it('does not include files still present locally', () => {
    const result = computeDeleteList(
      { 'kept.txt': { localMd5: 'abc' } },
      { files: { 'kept.txt': { driveId: 'drv1' } } },
      { 'kept.txt': { id: 'drv1' } }
    );
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computePullList', () => {
  it('returns empty when everything is up to date', () => {
    const remote = [remoteFile('a.txt', 'id1', 'md5a')];
    const index = { files: { 'a.txt': { localMd5: 'md5a', driveMd5: 'md5a' } } };
    const local = { 'a.txt': { localMd5: 'md5a' } };

    const { toDownload, conflicts } = computePullList(local, index, remote);
    expect(toDownload).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it('adds a file to download when remote has changed', () => {
    const remote = [remoteFile('doc.txt', 'id1', 'REMOTE_NEW')];
    const index = { files: { 'doc.txt': { localMd5: 'original', driveMd5: 'original' } } };
    const local = { 'doc.txt': { localMd5: 'original' } };

    const { toDownload, conflicts } = computePullList(local, index, remote);
    expect(toDownload).toHaveLength(1);
    expect(toDownload[0].relativePath).toBe('doc.txt');
    expect(conflicts).toHaveLength(0);
  });

  it('flags a conflict when both local and remote have changed', () => {
    const remote = [remoteFile('doc.txt', 'id1', 'REMOTE_NEW')];
    const index = { files: { 'doc.txt': { localMd5: 'original', driveMd5: 'original' } } };
    const local = { 'doc.txt': { localMd5: 'LOCAL_NEW' } };

    const { toDownload, conflicts } = computePullList(local, index, remote);
    expect(toDownload).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].relativePath).toBe('doc.txt');
  });

  it('adds new remote files (not in index) to download list', () => {
    const remote = [remoteFile('brand_new.txt', 'id99', 'md5new')];
    const index = { files: {} };
    const local = {};

    const { toDownload, conflicts } = computePullList(local, index, remote);
    expect(toDownload).toHaveLength(1);
    expect(toDownload[0].relativePath).toBe('brand_new.txt');
    expect(conflicts).toHaveLength(0);
  });

  it('handles multiple files with mixed outcomes', () => {
    const remote = [
      remoteFile('same.txt', 'id1', 'AAA'),
      remoteFile('updated.txt', 'id2', 'BBB_NEW'),
      remoteFile('conflict.txt', 'id3', 'CCC_REMOTE'),
    ];
    const index = {
      files: {
        'same.txt': { localMd5: 'AAA', driveMd5: 'AAA' },
        'updated.txt': { localMd5: 'BBB', driveMd5: 'BBB' },
        'conflict.txt': { localMd5: 'CCC', driveMd5: 'CCC' },
      },
    };
    const local = {
      'same.txt': { localMd5: 'AAA' },
      'updated.txt': { localMd5: 'BBB' },     // local unchanged
      'conflict.txt': { localMd5: 'CCC_LOCAL' }, // local also changed
    };

    const { toDownload, conflicts } = computePullList(local, index, remote);
    expect(toDownload.map((f) => f.relativePath)).toContain('updated.txt');
    expect(conflicts.map((f) => f.relativePath)).toContain('conflict.txt');
    expect(toDownload.map((f) => f.relativePath)).not.toContain('same.txt');
  });
});
