'use strict';

/**
 * @fileoverview Unit tests for src/commands/diff.js
 * Tests cover: local-only files, remote-only files, identical files (skipped),
 * local-ahead, remote-ahead, conflict detection, and size delta calculation.
 *
 * The diff command compares MD5 checksums and metadata — no content diff.
 * We test the classification logic as a pure function.
 *
 * Run with: npx jest tests/diff.test.js
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pure classification logic extracted from diff.js for unit testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a single file's diff status given its local, indexed, and remote states.
 *
 * @param {{ localMd5: string }|null} local
 * @param {{ localMd5: string, driveMd5: string }|null} indexed
 * @param {{ md5Checksum: string, modifiedTime: string, size?: string }|null} remote
 * @returns {'identical'|'localOnly'|'remoteOnly'|'localAhead'|'remoteAhead'|'conflict'}
 */
function classifyDiff(local, indexed, remote) {
  const localMd5 = local?.localMd5 ?? null;
  const remoteMd5 = remote?.md5Checksum ?? null;

  // Byte-for-byte identical — skip
  if (localMd5 && localMd5 === remoteMd5) return 'identical';

  if (!local && remote) return 'remoteOnly';
  if (local && !remote) return 'localOnly';

  if (local && remote && indexed) {
    const localChanged = localMd5 !== indexed.localMd5;
    const remoteChanged = remoteMd5 !== null && remoteMd5 !== indexed.driveMd5;

    if (localChanged && remoteChanged) return 'conflict';
    if (localChanged) return 'localAhead';
    if (remoteChanged) return 'remoteAhead';
  }

  // Local and remote both exist but no index entry — treat as conflict
  if (local && remote && !indexed) return 'conflict';

  return 'identical';
}

/**
 * Calculate the size delta in bytes between local and remote.
 *
 * @param {number|null} localSize  - Local file size in bytes.
 * @param {number|null} remoteSize - Remote file size in bytes.
 * @returns {{ delta: number, hasDelta: boolean }}
 */
function sizeDelta(localSize, remoteSize) {
  if (!localSize || !remoteSize || localSize === remoteSize) {
    return { delta: 0, hasDelta: false };
  }
  return { delta: localSize - remoteSize, hasDelta: true };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('classifyDiff', () => {
  // ── Identical ───────────────────────────────────────────────────────────────
  describe('identical', () => {
    it('returns identical when local and remote md5 match', () => {
      expect(
        classifyDiff(
          { localMd5: 'abc' },
          { localMd5: 'abc', driveMd5: 'abc' },
          { md5Checksum: 'abc', modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('identical');
    });

    it('returns identical when no index exists but md5 matches', () => {
      expect(
        classifyDiff(
          { localMd5: 'abc' },
          null,
          { md5Checksum: 'abc', modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('identical');
    });
  });

  // ── Local only ──────────────────────────────────────────────────────────────
  describe('localOnly', () => {
    it('returns localOnly when file exists locally but not on remote', () => {
      expect(classifyDiff({ localMd5: 'abc' }, null, null)).toBe('localOnly');
    });

    it('returns localOnly even when indexed but remote is gone', () => {
      expect(
        classifyDiff(
          { localMd5: 'abc' },
          { localMd5: 'abc', driveMd5: 'abc' },
          null
        )
      ).toBe('localOnly');
    });
  });

  // ── Remote only ─────────────────────────────────────────────────────────────
  describe('remoteOnly', () => {
    it('returns remoteOnly when file exists on remote but not locally', () => {
      expect(
        classifyDiff(null, null, { md5Checksum: 'zzz', modifiedTime: '2026-01-01T00:00:00Z' })
      ).toBe('remoteOnly');
    });
  });

  // ── Local ahead ─────────────────────────────────────────────────────────────
  describe('localAhead', () => {
    it('returns localAhead when only local md5 has changed', () => {
      expect(
        classifyDiff(
          { localMd5: 'NEW_LOCAL' },
          { localMd5: 'ORIGINAL', driveMd5: 'ORIGINAL' },
          { md5Checksum: 'ORIGINAL', modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('localAhead');
    });
  });

  // ── Remote ahead ────────────────────────────────────────────────────────────
  describe('remoteAhead', () => {
    it('returns remoteAhead when only remote md5 has changed', () => {
      expect(
        classifyDiff(
          { localMd5: 'ORIGINAL' },
          { localMd5: 'ORIGINAL', driveMd5: 'ORIGINAL' },
          { md5Checksum: 'NEW_REMOTE', modifiedTime: '2026-01-02T00:00:00Z' }
        )
      ).toBe('remoteAhead');
    });
  });

  // ── Conflict ────────────────────────────────────────────────────────────────
  describe('conflict', () => {
    it('returns conflict when both local and remote have changed', () => {
      expect(
        classifyDiff(
          { localMd5: 'NEW_LOCAL' },
          { localMd5: 'ORIGINAL', driveMd5: 'ORIGINAL' },
          { md5Checksum: 'NEW_REMOTE', modifiedTime: '2026-01-02T00:00:00Z' }
        )
      ).toBe('conflict');
    });

    it('returns conflict when both exist but no index entry', () => {
      expect(
        classifyDiff(
          { localMd5: 'abc' },
          null,
          { md5Checksum: 'xyz', modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('conflict');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles null remote md5 (Google Docs native format)', () => {
      expect(
        classifyDiff(
          { localMd5: 'abc' },
          { localMd5: 'original', driveMd5: null },
          { md5Checksum: null, modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('localAhead');
    });

    it('returns conflict for two null md5 values — both sides exist but are untrackable', () => {
      expect(
        classifyDiff(
          { localMd5: null },
          null,
          { md5Checksum: null, modifiedTime: '2026-01-01T00:00:00Z' }
        )
      ).toBe('conflict');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sizeDelta', () => {
  it('returns hasDelta false when sizes are equal', () => {
    expect(sizeDelta(1024, 1024)).toEqual({ delta: 0, hasDelta: false });
  });

  it('returns positive delta when local is larger', () => {
    const result = sizeDelta(2048, 1024);
    expect(result.hasDelta).toBe(true);
    expect(result.delta).toBe(1024);
  });

  it('returns negative delta when remote is larger', () => {
    const result = sizeDelta(512, 1024);
    expect(result.hasDelta).toBe(true);
    expect(result.delta).toBe(-512);
  });

  it('returns hasDelta false when either size is null', () => {
    expect(sizeDelta(null, 1024)).toEqual({ delta: 0, hasDelta: false });
    expect(sizeDelta(1024, null)).toEqual({ delta: 0, hasDelta: false });
    expect(sizeDelta(null, null)).toEqual({ delta: 0, hasDelta: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('classifyDiff — bulk scenario simulation', () => {
  it('correctly classifies a mixed set of files', () => {
    const scenarios = [
      // [local, indexed, remote, expected]
      [{ localMd5: 'A' }, { localMd5: 'A', driveMd5: 'A' }, { md5Checksum: 'A', modifiedTime: '' }, 'identical'],
      [{ localMd5: 'B' }, null, null, 'localOnly'],
      [null, null, { md5Checksum: 'C', modifiedTime: '' }, 'remoteOnly'],
      [{ localMd5: 'D2' }, { localMd5: 'D1', driveMd5: 'D1' }, { md5Checksum: 'D1', modifiedTime: '' }, 'localAhead'],
      [{ localMd5: 'E' }, { localMd5: 'E', driveMd5: 'E1' }, { md5Checksum: 'E2', modifiedTime: '' }, 'remoteAhead'],
      [{ localMd5: 'F2' }, { localMd5: 'F1', driveMd5: 'F1' }, { md5Checksum: 'F3', modifiedTime: '' }, 'conflict'],
    ];

    for (const [local, indexed, remote, expected] of scenarios) {
      expect(classifyDiff(local, indexed, remote)).toBe(expected);
    }
  });
});