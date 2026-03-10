'use strict';

/**
 * @fileoverview Unit tests for the push/pull decision logic.
 *
 * Rather than spawning the full CLI commands (which require auth and Drive),
 * we extract and test the core "what needs to happen" logic as pure functions.
 * These functions mirror what lives inside push.js and pull.js.
 *
 * Run with: npx jest tests/push-pull.test.js
 */

// ─────────────────────────────────────────────────────────────────────────────
// Push logic: decide which files to upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the local file map, the index, and the remote map, return the list of
 * files that need to be uploaded to Drive.
 *
 * @param {Record<string, { localMd5: string }>} localFiles
 *   Map of relative path to local file state.
 * @param {{ files: Record<string, { localMd5: string, driveMd5: string, driveId: string }> }} index
 *   The current `.gdrive/index.json` contents.
 * @param {Record<string, { id: string, md5Checksum: string }>} remoteMap
 *   Map of relative path to remote Drive file metadata.
 * @param {boolean} [force=false]
 *   When `true`, upload all files regardless of change state.
 * @returns {Array<{ rel: string, driveId: string|null, isNew: boolean, reason: 'new'|'modified' }>}
 */
function computePushList(localFiles, index, remoteMap, force = false) {
  const toUpload = [];

  for (const [rel, localFile] of Object.entries(localFiles)) {
    const indexed = index.files[rel];
    const remote = remoteMap[rel];

    const localChanged = !indexed || localFile.localMd5 !== indexed.localMd5;

    if (!localChanged && !force) continue;

    toUpload.push({
      rel,
      driveId: remote?.id ?? indexed?.driveId ?? null,
      isNew: !remote,
      reason: !indexed ? "new" : "modified",
    });
  }

  return toUpload;
}

/**
 * Given the local file map and index, return files that should be deleted from
 * Drive — i.e. files tracked in the index that no longer exist locally.
 * Only used when the `--delete` flag is set.
 *
 * @param {Record<string, { localMd5: string }>} localFiles
 *   Map of relative path to local file state.
 * @param {{ files: Record<string, { driveId: string }> }} index
 *   The current `.gdrive/index.json` contents.
 * @param {Record<string, { id: string }>} remoteMap
 *   Map of relative path to remote Drive file metadata.
 * @returns {Array<{ rel: string, driveId: string }>}
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
 * Given the local file map, the index, and the remote file list, return the
 * files that need to be downloaded and any files in conflict.
 *
 * @param {Record<string, { localMd5: string }>} localFiles
 *   Map of relative path to local file state.
 * @param {{ files: Record<string, { localMd5: string, driveMd5: string }> }} index
 *   The current `.gdrive/index.json` contents.
 * @param {Array<{ relativePath: string, id: string, md5Checksum: string }>} remoteFiles
 *   Flat list of remote Drive files from `listFilesRecursive`.
 * @returns {{
 *   toDownload: Array<{ relativePath: string, id: string, md5Checksum: string }>,
 *   conflicts:  Array<{ relativePath: string, id: string, md5Checksum: string }>
 * }}
 */
function computePullList(localFiles, index, remoteFiles) {
  const toDownload = [];
  const conflicts = [];

  for (const remoteFile of remoteFiles) {
    const rel = remoteFile.relativePath;
    const indexed = index.files[rel];
    const localFile = localFiles[rel];

    const remoteMd5 = remoteFile.md5Checksum ?? null;
    const indexedDriveMd5 = indexed?.driveMd5 ?? null;
    const localMd5 = localFile?.localMd5 ?? null;
    const indexedLocalMd5 = indexed?.localMd5 ?? null;

    const remoteChanged = !indexed || remoteMd5 !== indexedDriveMd5;
    const localChanged = indexed && localFile && localMd5 !== indexedLocalMd5;

    if (!remoteChanged) continue;

    if (localChanged) {
      conflicts.push(remoteFile);
    } else {
      toDownload.push(remoteFile);
    }
  }

  return { toDownload, conflicts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a single-entry local file map.
 *
 * @param {string} rel - Relative file path.
 * @param {string} md5 - MD5 checksum of the local file.
 * @returns {Record<string, { localMd5: string }>}
 */
function makeLocal(rel, md5) {
  return { [rel]: { localMd5: md5 } };
}

/**
 * Build a remote file descriptor as returned by `listFilesRecursive`.
 *
 * @param {string} rel - Relative file path.
 * @param {string} id  - Drive file ID.
 * @param {string} md5 - MD5 checksum reported by Drive.
 * @returns {{ relativePath: string, id: string, md5Checksum: string }}
 */
function makeRemoteFile(rel, id, md5) {
  return { relativePath: rel, id, md5Checksum: md5 };
}

/**
 * Build a single-entry index files map.
 *
 * @param {string} rel       - Relative file path.
 * @param {string} localMd5  - Last-synced local MD5.
 * @param {string} driveMd5  - Last-synced Drive MD5.
 * @param {string} [driveId] - Drive file ID (defaults to `'id_' + rel`).
 * @returns {Record<string, { localMd5: string, driveMd5: string, driveId: string }>}
 */
function makeIndexEntry(rel, localMd5, driveMd5, driveId = 'id_' + rel) {
  return { [rel]: { localMd5, driveMd5, driveId } };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('computePushList', () => {
  it("returns an empty list when nothing has changed", () => {
    const result = computePushList(
      makeLocal("a.txt", "aaa"),
      { files: makeIndexEntry("a.txt", "aaa", "aaa") },
      { "a.txt": { id: "drv1", md5Checksum: "aaa" } },
    );
    expect(result).toHaveLength(0);
  });

  it('marks locally modified files for upload', () => {
    const result = computePushList(
      makeLocal("a.txt", "NEW"),
      { files: makeIndexEntry("a.txt", "OLD", "OLD") },
      { "a.txt": { id: "drv1", md5Checksum: "OLD" } },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rel: 'a.txt', isNew: false, reason: 'modified' });
  });

  it("marks new local files (not in index) for upload as isNew", () => {
    const result = computePushList(
      makeLocal("new.txt", "zzz"),
      { files: {} },
      {},
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      rel: "new.txt",
      isNew: true,
      reason: "new",
      driveId: null,
    });
  });

  it("sets driveId from the remote map when the file exists on Drive", () => {
    const result = computePushList(
      makeLocal("doc.txt", "NEW"),
      { files: makeIndexEntry("doc.txt", "OLD", "OLD", "idx_id") },
      { "doc.txt": { id: "remote_id", md5Checksum: "OLD" } },
    );
    expect(result[0].driveId).toBe("remote_id");
  });

  it("falls back to the indexed driveId when the file is absent from the remote map", () => {
    const result = computePushList(
      makeLocal("doc.txt", "NEW"),
      { files: makeIndexEntry("doc.txt", "OLD", "OLD", "idx_id") },
      {},
    );
    expect(result[0].driveId).toBe("idx_id");
  });

  it("uploads all files when force=true, even unchanged ones", () => {
    const result = computePushList(
      { "a.txt": { localMd5: "same" }, "b.txt": { localMd5: "same2" } },
      {
        files: {
          "a.txt": { localMd5: "same", driveMd5: "same" },
          "b.txt": { localMd5: "same2", driveMd5: "same2" },
        },
      },
      {},
      true,
    );
    expect(result).toHaveLength(2);
  });

  it("handles a mix of changed, unchanged, and new files correctly", () => {
    const result = computePushList(
      {
        "changed.txt": { localMd5: "NEW" },
        "same.txt": { localMd5: "ABC" },
        "added.txt": { localMd5: "XYZ" },
      },
      {
        files: {
          "changed.txt": { localMd5: "OLD", driveMd5: "OLD" },
          "same.txt": { localMd5: "ABC", driveMd5: "ABC" },
        },
      },
      {},
    );
    const rels = result.map((f) => f.rel);
    expect(rels).toContain("changed.txt");
    expect(rels).toContain("added.txt");
    expect(rels).not.toContain("same.txt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeDeleteList', () => {
  it("returns files that are tracked in the index but deleted locally", () => {
    const result = computeDeleteList(
      {},
      { files: { "gone.txt": { driveId: "drv_gone" } } },
      { "gone.txt": { id: "drv_gone" } },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rel: "gone.txt", driveId: "drv_gone" });
  });

  it('skips files that are not on remote (already deleted remotely)', () => {
    const result = computeDeleteList(
      {},
      { files: { "ghost.txt": { driveId: "old_id" } } },
      {},
    );
    expect(result).toHaveLength(0);
  });

  it("does not include files that still exist locally", () => {
    const result = computeDeleteList(
      { "kept.txt": { localMd5: "abc" } },
      { files: { "kept.txt": { driveId: "drv1" } } },
      { "kept.txt": { id: "drv1" } },
    );
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computePullList', () => {
  it("returns empty lists when everything is up to date", () => {
    const { toDownload, conflicts } = computePullList(
      makeLocal("a.txt", "md5a"),
      { files: { "a.txt": { localMd5: "md5a", driveMd5: "md5a" } } },
      [makeRemoteFile("a.txt", "id1", "md5a")],
    );
    expect(toDownload).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it("adds a file to toDownload when only the remote has changed", () => {
    const { toDownload, conflicts } = computePullList(
      makeLocal("doc.txt", "original"),
      { files: { "doc.txt": { localMd5: "original", driveMd5: "original" } } },
      [makeRemoteFile("doc.txt", "id1", "REMOTE_NEW")],
    );
    expect(toDownload).toHaveLength(1);
    expect(toDownload[0].relativePath).toBe("doc.txt");
    expect(conflicts).toHaveLength(0);
  });

  it("flags a conflict when both local and remote have changed independently", () => {
    const { toDownload, conflicts } = computePullList(
      makeLocal("doc.txt", "LOCAL_NEW"),
      { files: { "doc.txt": { localMd5: "original", driveMd5: "original" } } },
      [makeRemoteFile("doc.txt", "id1", "REMOTE_NEW")],
    );
    expect(toDownload).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].relativePath).toBe("doc.txt");
  });

  it("adds new remote files (not in index) to toDownload", () => {
    const { toDownload, conflicts } = computePullList({}, { files: {} }, [
      makeRemoteFile("brand_new.txt", "id99", "md5new"),
    ]);
    expect(toDownload).toHaveLength(1);
    expect(toDownload[0].relativePath).toBe("brand_new.txt");
    expect(conflicts).toHaveLength(0);
  });

  it("correctly categorises a mixed set of files in a single call", () => {
    const { toDownload, conflicts } = computePullList(
      {
        "same.txt": { localMd5: "AAA" },
        "updated.txt": { localMd5: "BBB" },
        "conflict.txt": { localMd5: "CCC_LOCAL" },
      },
      {
        files: {
          "same.txt": { localMd5: "AAA", driveMd5: "AAA" },
          "updated.txt": { localMd5: "BBB", driveMd5: "BBB" },
          "conflict.txt": { localMd5: "CCC", driveMd5: "CCC" },
        },
      },
      [
        makeRemoteFile("same.txt", "id1", "AAA"),
        makeRemoteFile("updated.txt", "id2", "BBB_NEW"),
        makeRemoteFile("conflict.txt", "id3", "CCC_REMOTE"),
      ],
    );
    expect(toDownload.map((f) => f.relativePath)).toContain("updated.txt");
    expect(conflicts.map((f) => f.relativePath)).toContain("conflict.txt");
    expect(toDownload.map((f) => f.relativePath)).not.toContain("same.txt");
  });
});
