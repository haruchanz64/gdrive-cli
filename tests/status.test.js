'use strict';

/**
 * @fileoverview Unit tests for src/commands/status.js — change-detection logic.
 *
 * The command itself uses process.cwd() and calls external modules.
 * We test the core change-detection logic by extracting it into a pure helper
 * and verifying every state-machine rule directly.
 *
 * Run with: npx jest tests/status.test.js
 */

// ─────────────────────────────────────────────────────────────────────────────
// The change-detection logic lives inline in status.js.
// We reproduce it here as a pure function so it can be unit tested
// without spinning up a full CLI process.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies a single file given its local, indexed, and remote states.
 *
 * @param {{ localMd5: string }|null} local
 *   The local file state, or `null` if the file does not exist locally.
 * @param {{ localMd5: string, driveMd5: string }|null} indexed
 *   The last-synced state from `.gdrive/index.json`, or `null` if never tracked.
 * @param {{ md5Checksum: string }|null} remote
 *   The remote Drive file state, or `null` if the file does not exist on Drive.
 * @returns {'upToDate'|'localNew'|'localModified'|'localDeleted'|
 *           'remoteNew'|'remoteModified'|'remoteDeleted'|'conflict'}
 */
function classifyFile(local, indexed, remote) {
  const localMd5 = local?.localMd5 ?? null;
  const indexedLocalMd5 = indexed?.localMd5 ?? null;
  const indexedDriveMd5 = indexed?.driveMd5 ?? null;
  const remoteMd5 = remote?.md5Checksum ?? null;

  // Never been tracked — exists locally only
  if (local && !indexed && !remote) return "localNew";

  // Locally deleted — was tracked and still exists on remote
  if (!local && indexed && remote) return "localDeleted";

  // Remote deleted — was tracked but no longer on Drive
  if (local && indexed && !remote) {
    // If local was also modified, that is a conflict (modify vs delete)
    if (localMd5 !== indexedLocalMd5) return "conflict";
    return "remoteDeleted";
  }

  // Remote file that was never pulled locally
  if (!local && !indexed && remote) return "remoteNew";

  // Both exist and were indexed — compare checksums
  if (local && indexed && remote) {
    const localChanged = localMd5 !== indexedLocalMd5;
    const remoteChanged = remoteMd5 !== null && remoteMd5 !== indexedDriveMd5;

    if (localChanged && remoteChanged) return "conflict";
    if (localChanged) return "localModified";
    if (remoteChanged) return "remoteModified";
    return "upToDate";
  }

  return "upToDate";
}

// ─────────────────────────────────────────────────────────────────────────────
describe("classifyFile - state machine", () => {
  // ── Up to date ─────────────────────────────────────────────────────────────
  describe("upToDate", () => {
    it("returns upToDate when all three hashes match", () => {
      expect(
        classifyFile(
          { localMd5: "abc" },
          { localMd5: "abc", driveMd5: "abc" },
          { md5Checksum: "abc" },
        ),
      ).toBe("upToDate");
    });
  });

  // ── Local-only changes ──────────────────────────────────────────────────────
  describe("localNew", () => {
    it("returns localNew for a file that only exists locally", () => {
      expect(classifyFile({ localMd5: "aaa" }, null, null)).toBe("localNew");
    });
  });

  describe("localModified", () => {
    it("returns localModified when only the local md5 has changed", () => {
      expect(
        classifyFile(
          { localMd5: "NEW" },
          { localMd5: "OLD", driveMd5: "OLD" },
          { md5Checksum: "OLD" },
        ),
      ).toBe("localModified");
    });
  });

  describe("localDeleted", () => {
    it("returns localDeleted when the file is missing locally but exists in index and remote", () => {
      expect(
        classifyFile(
          null,
          { localMd5: "abc", driveMd5: "abc" },
          { md5Checksum: "abc" },
        ),
      ).toBe("localDeleted");
    });
  });

  // ── Remote-only changes ─────────────────────────────────────────────────────
  describe("remoteNew", () => {
    it("returns remoteNew for a file that only exists on remote", () => {
      expect(classifyFile(null, null, { md5Checksum: "zzz" })).toBe(
        "remoteNew",
      );
    });
  });

  describe("remoteModified", () => {
    it("returns remoteModified when only the remote md5 has changed", () => {
      expect(
        classifyFile(
          { localMd5: "same" },
          { localMd5: "same", driveMd5: "old_remote" },
          { md5Checksum: "new_remote" },
        ),
      ).toBe("remoteModified");
    });
  });

  describe("remoteDeleted", () => {
    it("returns remoteDeleted when remote is gone but local is unchanged", () => {
      expect(
        classifyFile(
          { localMd5: "abc" },
          { localMd5: "abc", driveMd5: "abc" },
          null,
        ),
      ).toBe("remoteDeleted");
    });
  });

  // ── Conflicts ───────────────────────────────────────────────────────────────
  describe("conflict", () => {
    it("returns conflict when both local and remote have changed", () => {
      expect(
        classifyFile(
          { localMd5: "local_new" },
          { localMd5: "original", driveMd5: "original" },
          { md5Checksum: "remote_new" },
        ),
      ).toBe("conflict");
    });

    it("returns conflict when local is modified and remote was deleted", () => {
      expect(
        classifyFile(
          { localMd5: "modified" },
          { localMd5: "original", driveMd5: "original" },
          null,
        ),
      ).toBe("conflict");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("handles null md5Checksum from remote (Google Docs native format)", () => {
      // Remote md5 is null — treat remoteChanged as false, result is upToDate
      expect(
        classifyFile(
          { localMd5: "abc" },
          { localMd5: "abc", driveMd5: null },
          { md5Checksum: null },
        ),
      ).toBe("upToDate");
    });

    it("treats a file as localNew even with a full 32-char md5 hash", () => {
      const md5 = "d41d8cd98f00b204e9800998ecf8427e";
      expect(classifyFile({ localMd5: md5 }, null, null)).toBe("localNew");
    });

    it("treats identical hashes after a no-op edit as upToDate", () => {
      const h = "cafebabe";
      expect(
        classifyFile(
          { localMd5: h },
          { localMd5: h, driveMd5: h },
          { md5Checksum: h },
        ),
      ).toBe("upToDate");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classifyFile - bulk scenario simulation", () => {
  it("correctly classifies a mixed set of files in a single pass", () => {
    /** @type {Array<[object|null, object|null, object|null, string]>} */
    const scenarios = [
      // [local, indexed, remote, expectedStatus]
      [
        { localMd5: "A" },
        { localMd5: "A", driveMd5: "A" },
        { md5Checksum: "A" },
        "upToDate",
      ],
      [{ localMd5: "B" }, null, null, "localNew"],
      [
        null,
        { localMd5: "C", driveMd5: "C" },
        { md5Checksum: "C" },
        "localDeleted",
      ],
      [null, null, { md5Checksum: "D" }, "remoteNew"],
      [
        { localMd5: "E2" },
        { localMd5: "E1", driveMd5: "E1" },
        { md5Checksum: "E1" },
        "localModified",
      ],
      [
        { localMd5: "F" },
        { localMd5: "F", driveMd5: "F1" },
        { md5Checksum: "F2" },
        "remoteModified",
      ],
      [
        { localMd5: "G2" },
        { localMd5: "G1", driveMd5: "G1" },
        { md5Checksum: "G3" },
        "conflict",
      ],
    ];

    for (const [local, indexed, remote, expected] of scenarios) {
      expect(classifyFile(local, indexed, remote)).toBe(expected);
    }
  });
});
