'use strict';

/**
 * tests/drive.test.js
 * Unit tests for src/drive.js
 *
 * Run with: npx jest tests/drive.test.js
 */

const path = require('path');
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

// Build a reusable mock Drive client
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
  getRevisions,
  getDriveClient,
} = require('../src/drive');

// ── Helper ───────────────────────────────────────────────────────────────────
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
  it('calls google.drive with v3 and the supplied auth', () => {
    const { google } = require('googleapis');
    const fakeAuth = { token: 'fake' };
    getDriveClient(fakeAuth);
    expect(google.drive).toHaveBeenCalledWith({ version: 'v3', auth: fakeAuth });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('parseFolderId', () => {
  it('extracts ID from a standard Drive folder URL', () => {
    const url = 'https://drive.google.com/drive/folders/1ABC_defGHI-jkl';
    expect(parseFolderId(url)).toBe('1ABC_defGHI-jkl');
  });

  it('extracts ID from a /u/0/ style URL', () => {
    const url = 'https://drive.google.com/drive/u/0/folders/XYZ123abcdef';
    expect(parseFolderId(url)).toBe('XYZ123abcdef');
  });

  it('returns raw ID when a plain folder ID is passed', () => {
    expect(parseFolderId('1xYzABCDEFGHIJ')).toBe('1xYzABCDEFGHIJ');
  });

  it('throws on a short / invalid string', () => {
    expect(() => parseFolderId('bad')).toThrow('Cannot parse folder ID');
  });

  it('throws on an empty string', () => {
    expect(() => parseFolderId('')).toThrow('Cannot parse folder ID');
  });

  it('handles folder IDs with hyphens and underscores', () => {
    expect(parseFolderId('abc-def_GHI123xyz')).toBe('abc-def_GHI123xyz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('listFilesRecursive', () => {
  beforeEach(() => {
    mockDriveClient.files.list.mockReset();
  });

  it('returns flat list of files in a single page', async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: {
        files: [makeFile({ id: 'f1', name: 'a.txt' }), makeFile({ id: 'f2', name: 'b.txt' })],
        nextPageToken: null,
      },
    });

    const result = await listFilesRecursive(mockDriveClient, 'root_folder_id');

    expect(result).toHaveLength(2);
    expect(result[0].relativePath).toBe('a.txt');
    expect(result[1].relativePath).toBe('b.txt');
  });

  it('prepends relativePath prefix for nested calls', async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: { files: [makeFile({ id: 'f1', name: 'note.md' })], nextPageToken: null },
    });

    const result = await listFilesRecursive(mockDriveClient, 'sub_id', 'docs');
    expect(result[0].relativePath).toBe('docs/note.md');
  });

  it('recurses into sub-folders', async () => {
    // First call → returns a folder + a file
    mockDriveClient.files.list
      .mockResolvedValueOnce({
        data: {
          files: [
            makeFile({ id: 'dir1', name: 'subdir', mimeType: 'application/vnd.google-apps.folder' }),
            makeFile({ id: 'f1', name: 'root.txt' }),
          ],
          nextPageToken: null,
        },
      })
      // Second call (recursion into subdir) → returns one file
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: 'f2', name: 'child.txt' })],
          nextPageToken: null,
        },
      });

    const result = await listFilesRecursive(mockDriveClient, 'root');

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.relativePath)).toEqual(
      expect.arrayContaining(['subdir/child.txt', 'root.txt'])
    );
  });

  it('handles pagination via nextPageToken', async () => {
    mockDriveClient.files.list
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: 'f1', name: 'page1.txt' })],
          nextPageToken: 'token_page2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [makeFile({ id: 'f2', name: 'page2.txt' })],
          nextPageToken: null,
        },
      });

    const result = await listFilesRecursive(mockDriveClient, 'folder_id');
    expect(result).toHaveLength(2);
    expect(result[1].relativePath).toBe('page2.txt');
  });

  it('returns empty array for an empty folder', async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: { files: [], nextPageToken: null },
    });
    const result = await listFilesRecursive(mockDriveClient, 'empty_folder');
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('downloadFile', () => {
  it('creates the destination directory and resolves on stream finish', async () => {
    const fs = require('fs-extra');

    // Fake readable stream
    const readable = new PassThrough();
    // Fake writable stream
    const writable = new PassThrough();
    writable.on('data', () => {});

    fs.createWriteStream.mockReturnValue(writable);
    mockDriveClient.files.get.mockResolvedValue({ data: readable });

    const promise = downloadFile(mockDriveClient, 'file_id', '/tmp/test/out.txt');

    // Simulate data flowing and finishing
    readable.end('hello');
    writable.emit('finish');

    await promise;

    expect(fs.ensureDir).toHaveBeenCalledWith('/tmp/test');
    expect(mockDriveClient.files.get).toHaveBeenCalledWith(
      { fileId: 'file_id', alt: 'media' },
      { responseType: 'stream' }
    );
  });

  it('rejects when the stream emits an error', async () => {
    const fs = require('fs-extra');
    const readable = new PassThrough();
    const writable = new PassThrough();

    fs.createWriteStream.mockReturnValue(writable);
    mockDriveClient.files.get.mockResolvedValue({ data: readable });

    const promise = downloadFile(mockDriveClient, 'file_id', '/tmp/fail.txt');

    // downloadFile has two awaits (ensureDir + files.get) before listeners are
    // attached. A single Promise.resolve() only drains one microtask tick.
    // setImmediate fires after ALL pending microtasks have flushed, ensuring
    // the .on('error', reject) handler is in place before we emit.
    await new Promise((r) => setImmediate(r));
    readable.emit('error', new Error('network error'));

    await expect(promise).rejects.toThrow('network error');
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
    const mockResult = { id: 'new_id', name: 'doc.txt', md5Checksum: 'xyz', modifiedTime: '2026-01-01T00:00:00Z' };
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

  it('calls files.update when existingFileId is provided', async () => {
    const mockResult = { id: 'existing_id', name: 'doc.txt', md5Checksum: 'xyz', modifiedTime: '2026-01-01T00:00:00Z' };
    mockDriveClient.files.update.mockResolvedValue({ data: mockResult });

    const result = await uploadFile(mockDriveClient, '/local/doc.txt', 'doc.txt', 'parent_id', 'existing_id');

    expect(mockDriveClient.files.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'existing_id' })
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

  it('returns existing folder ID without creating a new one', async () => {
    mockDriveClient.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing_folder', name: 'docs' }] },
    });

    const id = await ensureFolder(mockDriveClient, 'docs', 'parent_id');

    expect(id).toBe('existing_folder');
    expect(mockDriveClient.files.create).not.toHaveBeenCalled();
  });

  it('creates a new folder when it does not exist and returns its ID', async () => {
    mockDriveClient.files.list.mockResolvedValue({ data: { files: [] } });
    mockDriveClient.files.create.mockResolvedValue({ data: { id: 'new_folder_id' } });

    const id = await ensureFolder(mockDriveClient, 'assets', 'parent_id');

    expect(id).toBe('new_folder_id');
    expect(mockDriveClient.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: 'assets',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['parent_id'],
        }),
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getRevisions', () => {
  it('returns revisions array from the API', async () => {
    const revisions = [
      { id: 'rev1', modifiedTime: '2026-01-01T00:00:00Z', size: '1024' },
      { id: 'rev2', modifiedTime: '2026-02-01T00:00:00Z', size: '2048' },
    ];
    mockDriveClient.revisions.list.mockResolvedValue({ data: { revisions } });

    const result = await getRevisions(mockDriveClient, 'file_id');
    expect(result).toEqual(revisions);
  });

  it('returns an empty array when revisions is undefined', async () => {
    mockDriveClient.revisions.list.mockResolvedValue({ data: {} });
    const result = await getRevisions(mockDriveClient, 'file_id');
    expect(result).toEqual([]);
  });

  it('passes the correct fileId and fields to the API', async () => {
    mockDriveClient.revisions.list.mockResolvedValue({ data: { revisions: [] } });
    await getRevisions(mockDriveClient, 'target_file');
    expect(mockDriveClient.revisions.list).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'target_file' })
    );
  });
});