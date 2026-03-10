'use strict';

/**
 * @fileoverview Google Drive API client helpers for gdrive-cli.
 * Wraps the Drive v3 REST API with utilities for listing, downloading,
 * uploading, folder management, and revision history.
 */

const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');

/**
 * Build an authenticated Drive v3 API client.
 *
 * @param {import('google-auth-library').OAuth2Client} auth - Authenticated OAuth2 client.
 * @returns {import('googleapis').drive_v3.Drive}
 */
function getDriveClient(auth) {
  return google.drive({ version: 'v3', auth });
}

/**
 * Extract a Drive folder ID from a full folder URL or a raw ID string.
 *
 * Supported formats:
 * - `https://drive.google.com/drive/folders/FOLDER_ID`
 * - `https://drive.google.com/drive/u/0/folders/FOLDER_ID`
 * - Raw folder ID (alphanumeric, `_`, `-`, minimum 10 characters)
 *
 * @param {string} input - Drive folder URL or raw folder ID.
 * @returns {string} The extracted folder ID.
 * @throws {Error} When no valid folder ID can be parsed from the input.
 */
function parseFolderId(input) {
  const match = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  throw new Error(`Cannot parse folder ID from: ${input}`);
}

/**
 * Recursively list all non-trashed files within a Drive folder.
 * Folders are traversed but not included in the result; only files are returned.
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} folderId - ID of the Drive folder to traverse.
 * @param {string} [relativePath=''] - Path prefix accumulated during recursion.
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   mimeType: string,
 *   md5Checksum: string|undefined,
 *   modifiedTime: string,
 *   parents: string[],
 *   relativePath: string
 * }>>} Flat array of file metadata objects with a `relativePath` property.
 */
async function listFilesRecursive(drive, folderId, relativePath = '') {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, parents)",
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files) {
      const filePath = relativePath ? `${relativePath}/${file.name}` : file.name;

      if (file.mimeType === "application/vnd.google-apps.folder") {
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
 * Download a Drive file to a local path, creating intermediate directories
 * as needed.
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} fileId   - Drive file ID to download.
 * @param {string} destPath - Absolute local path to write the file to.
 * @returns {Promise<void>}
 * @throws {Error} On network errors or write failures.
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
 * Upload a local file to Drive.
 * - When `existingFileId` is provided, updates the file content in-place.
 * - Otherwise creates a new file under `parentFolderId`.
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} localPath       - Absolute path to the local file to upload.
 * @param {string} fileName        - Display name to use on Drive.
 * @param {string} parentFolderId  - Drive folder ID to create the file in.
 * @param {string|null} [existingFileId=null] - Drive file ID to update, or `null` to create.
 * @returns {Promise<{ id: string, name: string, md5Checksum: string, modifiedTime: string }>}
 *   Metadata of the created or updated Drive file.
 */
async function uploadFile(drive, localPath, fileName, parentFolderId, existingFileId = null) {
  const media = {
    body: fs.createReadStream(localPath),
  };

  if (existingFileId) {
    const res = await drive.files.update({
      fileId: existingFileId,
      media,
      fields: "id, name, md5Checksum, modifiedTime",
    });
    return res.data;
  } else {
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media,
      fields: "id, name, md5Checksum, modifiedTime",
    });
    return res.data;
  }
}

/**
 * Return the Drive folder ID for a named sub-folder inside `parentFolderId`,
 * creating it if it does not already exist.
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} folderName      - Name of the folder to look up or create.
 * @param {string} parentFolderId  - ID of the parent folder to search within.
 * @returns {Promise<string>} The folder ID (existing or newly created).
 */
async function ensureFolder(drive, folderName, parentFolderId) {
  const res = await drive.files.list({
    q: `name = '${folderName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });
  return created.data.id;
}

/**
 * Create a new folder at the root of the authenticated user's Drive (My Drive).
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} folderName - Display name for the new folder.
 * @returns {Promise<{ id: string, name: string, webViewLink: string }>}
 *   Metadata of the created folder.
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
 * Retrieve the full revision history for a Drive file.
 * Note: Native Google Workspace files (Docs, Sheets, Slides) may return an
 * empty array as their revisions are managed separately by Google.
 *
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client.
 * @param {string} fileId - Drive file ID to fetch revisions for.
 * @returns {Promise<Array<{
 *   id: string,
 *   modifiedTime: string,
 *   lastModifyingUser: { displayName: string },
 *   size: string|undefined
 * }>>} Array of revision objects ordered oldest-first, or an empty array.
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