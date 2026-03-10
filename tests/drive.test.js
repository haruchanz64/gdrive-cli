'use strict';

/**
 * @fileoverview Unit tests for src/drive.js
 *
 * Covers: getDriveClient, parseFolderId, listFilesRecursive, downloadFile,
 * uploadFile, ensureFolder, createRootFolder, and getRevisions.
 *
 * Run with: npx jest tests/drive.test.js
 */

const { PassThrough } = require('stream');

// ── Mock googleapis & fs-extra before requiring the module ───────────────────

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn(() => mockDriveClient),
  },
}));

jest.mock('fs-extra', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  createWriteStream: jest.fn(),
  createReadStream: jest.fn(),
}));

/**
 * Reusable mock Drive v3 API client.
 * Each method is a Jest mock function that can be configured per test.
 */
const mockDriveClient = {
  files: {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  revisions: {
    list: jest.fn(),
  },
};

const {
  parseFolderId,
  listFilesRecursive,
  downloadFile,
  uploadFile,
  ensureFolder,
  createRootFolder,
  getRevisions,
  getDriveClient,
} = require("../src/drive");

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Drive file metadata object for use in tests.
 *
 * @param {object} [overrides={}] - Properties to override on the default object.
 * @returns {{ id: string, name: string, mimeType: string, md5Checksum: string, modifiedTime: string }}
 */
function makeFile(overrides = {}) {
  return {
    id: 'file_id_001',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    md5Checksum: 'abc123',
    modifiedTime: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('getDriveClient', () => {
  it("calls google.drive with v3 and the supplied auth object", () => {
    const { google } = require("googleapis");
    const fakeAuth = { token: "fake" };
    getDriveClient(fakeAuth);
    expect(google.drive).toHaveBeenCalledWith({
      version: "v3",
      auth: fakeAuth,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('parseFolderId', () => {
  it('extracts ID from a standard Drive folder URL', () => {
    expect(
      parseFolderId("https://drive.google.com/drive/folders/1ABC_defGHI-jkl"),
    ).toBe("1ABC_defGHI-jkl");
  });

  it('extracts ID from a /u/0/ style URL', () => {
    expect(
      parseFolderId("https://drive.google.com/drive/u/0/folders/XYZ123abcdef"),
    ).toBe("XYZ123abcdef");
  });

  it("returns a raw ID when a plain folder ID string is passed", () => {
    expect(parseFolderId("1xYzABCDEFGHIJ")).toBe("1xYzABCDEFGHIJ");
  });

  it("handles folder IDs with hyphens and underscores", () => {
    expect(parseFolderId("abc-def_GHI123xyz")).toBe("abc-def_GHI123xyz");
  });

  it("throws on a string that is too short to be a valid ID", () => {
    expect(() => parseFolderId("bad")).toThrow("Cannot parse folder ID");
  });

  it("throws on an empty string", () => {
    expect(() => parseFolderId("")).toThrow("Cannot parse folder ID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('listFilesRecursive', () => {
  beforeEach(() => {
    mockDriveClient.files.list.mockReset();
  });

  it("returns a flat list of files from a single-page response", async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: {
        files: [
          makeFile({ id: "f1", name: "a.txt" }),
          makeFile({ id: "f2", name: "b.txt" }),
        ],
        nextPageToken: null,
      },
    });

    const result = await listFilesRecursive(mockDriveClient, "root_folder_id");

    expect(result).toHaveLength(2);
    expect(result[0].relativePath).toBe("a.txt");
    expect(result[1].relativePath).toBe("b.txt");
  });

  it("prepends the relativePath prefix when called recursively", async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: {
        files: [makeFile({ id: "f1", name: "note.md" })],
        nextPageToken: null,
      },
    });

    const result = await listFilesRecursive(mockDriveClient, "sub_id", "docs");
    expect(result[0].relativePath).toBe("docs/note.md");
  });

  it("recurses into sub-folders and includes their files", async () => {
    mockDriveClient.files.list
      // First call: root folder contains one sub-folder and one file
      .mockResolvedValueOnce({
        data: {
          files: [
            makeFile({
              id: "dir1",
              name: "subdir",
              mimeType: "application/vnd.google-apps.folder",
            }),
            makeFile({ id: "f1", name: "root.txt" }),
          ],
          nextPageToken: null,
        },
      })
      // Second call: recursion into subdir returns one child file
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: "f2", name: "child.txt" })],
          nextPageToken: null,
        },
      });

    const result = await listFilesRecursive(mockDriveClient, "root");

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.relativePath)).toEqual(
      expect.arrayContaining(["subdir/child.txt", "root.txt"]),
    );
  });

  it("follows pagination via nextPageToken until exhausted", async () => {
    mockDriveClient.files.list
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: "f1", name: "page1.txt" })],
          nextPageToken: "token_page2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: "f2", name: "page2.txt" })],
          nextPageToken: null,
        },
      });

    const result = await listFilesRecursive(mockDriveClient, "folder_id");
    expect(result).toHaveLength(2);
    expect(result[1].relativePath).toBe("page2.txt");
  });

  it("returns an empty array for an empty folder", async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: { files: [], nextPageToken: null },
    });
    const result = await listFilesRecursive(mockDriveClient, "empty_folder");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('downloadFile', () => {
  it("creates the destination directory and resolves when the stream finishes", async () => {
    const fs = require("fs-extra");

    const readable = new PassThrough();
    const writable = new PassThrough();
    // Consume the writable so the stream does not back-pressure
    writable.resume();

    fs.createWriteStream.mockReturnValue(writable);
    mockDriveClient.files.get.mockResolvedValue({ data: readable });

    const promise = downloadFile(
      mockDriveClient,
      "file_id",
      "/tmp/test/out.txt",
    );

    // Wait for all microtasks (ensureDir + files.get awaits) to settle so that
    // the pipe and its 'finish' / 'error' listeners are fully attached before
    // we push data into the stream.
    await new Promise((r) => setImmediate(r));

    readable.end("hello");

    await promise;

    expect(fs.ensureDir).toHaveBeenCalledWith("/tmp/test");
    expect(mockDriveClient.files.get).toHaveBeenCalledWith(
      { fileId: "file_id", alt: "media" },
      { responseType: "stream" },
    );
  });

  it("rejects when the readable stream emits an error", async () => {
    const fs = require("fs-extra");

    const readable = new PassThrough();
    const writable = new PassThrough();
    writable.resume();

    fs.createWriteStream.mockReturnValue(writable);
    mockDriveClient.files.get.mockResolvedValue({ data: readable });

    const promise = downloadFile(mockDriveClient, "file_id", "/tmp/fail.txt");

    // Ensure all async setup (ensureDir, files.get, pipe) completes and the
    // error listener is registered before emitting the error.
    await new Promise((r) => setImmediate(r));

    readable.emit("error", new Error("network error"));

    await expect(promise).rejects.toThrow("network error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('uploadFile', () => {
  beforeEach(() => {
    mockDriveClient.files.create.mockReset();
    mockDriveClient.files.update.mockReset();
    const fs = require('fs-extra');
    fs.createReadStream.mockReturnValue({ pipe: jest.fn() });
  });

  it('calls files.create when no existingFileId is provided', async () => {
    const mockResult = {
      id: "new_id",
      name: "doc.txt",
      md5Checksum: "xyz",
      modifiedTime: "2026-01-01T00:00:00Z",
    };
    mockDriveClient.files.create.mockResolvedValue({ data: mockResult });

    const result = await uploadFile(mockDriveClient, '/local/doc.txt', 'doc.txt', 'parent_id');

    expect(mockDriveClient.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ name: 'doc.txt', parents: ['parent_id'] }),
      })
    );
    expect(result).toEqual(mockResult);
    expect(mockDriveClient.files.update).not.toHaveBeenCalled();
  });

  it("calls files.update when an existingFileId is provided", async () => {
    const mockResult = {
      id: "existing_id",
      name: "doc.txt",
      md5Checksum: "xyz",
      modifiedTime: "2026-01-01T00:00:00Z",
    };
    mockDriveClient.files.update.mockResolvedValue({ data: mockResult });

    const result = await uploadFile(
      mockDriveClient,
      "/local/doc.txt",
      "doc.txt",
      "parent_id",
      "existing_id",
    );

    expect(mockDriveClient.files.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "existing_id" }),
    );
    expect(result).toEqual(mockResult);
    expect(mockDriveClient.files.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ensureFolder', () => {
  beforeEach(() => {
    mockDriveClient.files.list.mockReset();
    mockDriveClient.files.create.mockReset();
  });

  it("returns the existing folder ID without creating a new folder", async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: { files: [{ id: "existing_folder", name: "docs" }] },
    });

    const id = await ensureFolder(mockDriveClient, "docs", "parent_id");

    expect(id).toBe("existing_folder");
    expect(mockDriveClient.files.create).not.toHaveBeenCalled();
  });

  it("creates a new folder when none exists and returns its ID", async () => {
    mockDriveClient.files.list.mockResolvedValue({ data: { files: [] } });
    mockDriveClient.files.create.mockResolvedValue({
      data: { id: "new_folder_id" },
    });

    const id = await ensureFolder(mockDriveClient, "assets", "parent_id");

    expect(id).toBe("new_folder_id");
    expect(mockDriveClient.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: "assets",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["parent_id"],
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('createRootFolder', () => {
  beforeEach(() => {
    mockDriveClient.files.create.mockReset();
  });

  it('creates a folder at the root of My Drive and returns its metadata', async () => {
    const mockResult = {
      id: 'root_folder_id',
      name: 'My Project',
      webViewLink: 'https://drive.google.com/drive/folders/root_folder_id',
    };
    mockDriveClient.files.create.mockResolvedValue({ data: mockResult });

    const result = await createRootFolder(mockDriveClient, 'My Project');

    expect(mockDriveClient.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: 'My Project',
          mimeType: 'application/vnd.google-apps.folder',
        }),
        fields: 'id, name, webViewLink',
      })
    );
    expect(result).toEqual(mockResult);
  });

  it('does not pass a parents array — folder is created in My Drive root', async () => {
    mockDriveClient.files.create.mockResolvedValue({
      data: { id: 'x', name: 'Test', webViewLink: '' },
    });

    await createRootFolder(mockDriveClient, 'Test');

    const callArg = mockDriveClient.files.create.mock.calls[0][0];
    expect(callArg.requestBody).not.toHaveProperty('parents');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getRevisions', () => {
  it("returns the revisions array from the API response", async () => {
    const revisions = [
      { id: "rev1", modifiedTime: "2026-01-01T00:00:00Z", size: "1024" },
      { id: "rev2", modifiedTime: "2026-02-01T00:00:00Z", size: "2048" },
    ];
    mockDriveClient.revisions.list.mockResolvedValue({ data: { revisions } });

    const result = await getRevisions(mockDriveClient, "file_id");
    expect(result).toEqual(revisions);
  });

  it("returns an empty array when the revisions field is absent", async () => {
    mockDriveClient.revisions.list.mockResolvedValue({ data: {} });
    const result = await getRevisions(mockDriveClient, "file_id");
    expect(result).toEqual([]);
  });

  it("passes the correct fileId to the revisions.list API call", async () => {
    mockDriveClient.revisions.list.mockResolvedValue({
      data: { revisions: [] },
    });
    await getRevisions(mockDriveClient, "target_file");
    expect(mockDriveClient.revisions.list).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "target_file" }),
    );
  });
});