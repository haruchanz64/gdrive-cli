'use strict';

const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');

/**
 * Build an authenticated Drive API client.
 */
function getDriveClient(auth) {
  return google.drive({ version: 'v3', auth });
}

/**
 * Extract a folder ID from a Drive URL or raw ID.
 * Supports:
 *   https://drive.google.com/drive/folders/FOLDER_ID
 *   https://drive.google.com/drive/u/0/folders/FOLDER_ID
 *   Raw FOLDER_ID strings
 */
function parseFolderId(input) {
  const match = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Assume raw ID
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  throw new Error(`Cannot parse folder ID from: ${input}`);
}

/**
 * List all files (non-trashed) in a Drive folder, recursively.
 * Returns flat array of { id, name, mimeType, md5Checksum, modifiedTime, parents, relativePath }
 */
async function listFilesRecursive(drive, folderId, relativePath = '') {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        'nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, parents)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files) {
      const filePath = relativePath ? `${relativePath}/${file.name}` : file.name;

      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Recurse into sub-folder
        const children = await listFilesRecursive(drive, file.id, filePath);
        files.push(...children);
      } else {
        files.push({ ...file, relativePath: filePath });
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Download a file from Drive to a local path.
 */
async function downloadFile(drive, fileId, destPath) {
  await fs.ensureDir(path.dirname(destPath));

  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    res.data
      .on('error', reject)
      .pipe(dest)
      .on('finish', resolve)
      .on('error', reject);
  });
}

/**
 * Upload a local file to Drive, updating an existing file or creating a new one.
 */
async function uploadFile(drive, localPath, fileName, parentFolderId, existingFileId = null) {
  const media = {
    body: fs.createReadStream(localPath),
  };

  if (existingFileId) {
    // Update existing
    const res = await drive.files.update({
      fileId: existingFileId,
      media,
      fields: 'id, name, md5Checksum, modifiedTime',
    });
    return res.data;
  } else {
    // Create new
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media,
      fields: 'id, name, md5Checksum, modifiedTime',
    });
    return res.data;
  }
}

/**
 * Create a folder in Drive (or return existing).
 */
async function ensureFolder(drive, folderName, parentFolderId) {
  // Check if it exists
  const res = await drive.files.list({
    q: `name = '${folderName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });
  return created.data.id;
}

/**
 * Create a new folder at the root of the user's Drive (My Drive).
 */
async function createRootFolder(drive, folderName) {
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

/**
 * Get file revision history.
 */
async function getRevisions(drive, fileId) {
  const res = await drive.revisions.list({
    fileId,
    fields: 'revisions(id, modifiedTime, lastModifyingUser, size)',
  });
  return res.data.revisions || [];
}

module.exports = {
  getDriveClient,
  parseFolderId,
  listFilesRecursive,
  downloadFile,
  uploadFile,
  ensureFolder,
  createRootFolder,
  getRevisions,
};