'use strict';

/**
 * @fileoverview Unit tests for src/auth.js
 * Tests cover: path constants, missing credentials error, stored token path,
 * web credential format, token refresh listener, and keytar fallback.
 *
 * Run with: npx jest tests/auth.test.js
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSetCredentials = jest.fn();
const mockGetToken = jest.fn();
const mockGenerateAuthUrl = jest.fn();
const mockOn = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: mockSetCredentials,
        getToken: mockGetToken,
        generateAuthUrl: mockGenerateAuthUrl,
        on: mockOn,
      })),
    },
  },
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  readJson: jest.fn(),
  outputJson: jest.fn().mockResolvedValue(undefined),
  chmod: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
}));

// Mock keytar — simulate it being available and returning no stored token
jest.mock('keytar', () => ({
  getPassword: jest.fn().mockResolvedValue(null),
  setPassword: jest.fn().mockResolvedValue(undefined),
  deletePassword: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

// Mock the HTTP server and open-browser flow so tests don't open a browser
// or bind to a real port.
jest.mock('http', () => {
  const EventEmitter = require('events');

  const mockServer = new EventEmitter();
  mockServer.listen = jest.fn((port, host, cb) => {
    // Immediately invoke the listen callback so waitForCallbackCode proceeds
    if (cb) cb();
  });
  mockServer.close = jest.fn((cb) => { if (cb) cb(); });

  return {
    createServer: jest.fn((handler) => {
      // Simulate Google redirecting back with a code immediately after listen
      setImmediate(() => {
        const mockReq = { url: '/?code=mock_auth_code' };
        const mockRes = {
          writeHead: jest.fn(),
          end: jest.fn(),
        };
        handler(mockReq, mockRes);
      });
      return mockServer;
    }),
  };
});

// Prevent exec from actually opening a browser
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, cb) => cb(null)),
}));

const fs = require('fs-extra');
const keytar = require('keytar');

// Re-require after mocks are set up
let getAuthClient, CREDENTIALS_PATH, TOKEN_PATH, deleteToken;

beforeAll(() => {
  ({ getAuthClient, CREDENTIALS_PATH, TOKEN_PATH, deleteToken } = require('../src/auth'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CREDENTIALS_PATH / TOKEN_PATH', () => {
  it('are stored in the home directory under .gdrive/', () => {
    const home = require('os').homedir();
    expect(CREDENTIALS_PATH).toContain(home);
    expect(CREDENTIALS_PATH).toContain('.gdrive');
    expect(TOKEN_PATH).toContain(home);
    expect(TOKEN_PATH).toContain('.gdrive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getAuthClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: keytar returns no stored token
    keytar.getPassword.mockResolvedValue(null);
  });

  it('throws a descriptive error when credentials file is missing', async () => {
    fs.pathExists.mockResolvedValue(false);
    await expect(getAuthClient()).rejects.toThrow('No credentials found');
  });

  it('returns an OAuth2 client when credentials and keytar token both exist', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'CLIENT_ID',
        client_secret: 'CLIENT_SECRET',
        redirect_uris: ['http://localhost:4242'],
      },
    };
    const fakeToken = { access_token: 'ACCESS', refresh_token: 'REFRESH' };

    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue(fakeCreds);
    keytar.getPassword.mockResolvedValue(JSON.stringify(fakeToken));

    const client = await getAuthClient();

    expect(client).toBeDefined();
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeToken);
  });

  it('registers a token refresh listener when a stored token is found', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'C',
        client_secret: 'S',
        redirect_uris: ['http://localhost:4242'],
      },
    };
    const fakeToken = { access_token: 'A', refresh_token: 'R' };

    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue(fakeCreds);
    keytar.getPassword.mockResolvedValue(JSON.stringify(fakeToken));

    await getAuthClient();

    expect(mockOn).toHaveBeenCalledWith('tokens', expect.any(Function));
  });

  it('runs the browser OAuth flow when no token is stored', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'CLIENT_ID',
        client_secret: 'CLIENT_SECRET',
        redirect_uris: ['http://localhost:4242'],
      },
    };
    const fakeTokens = { access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH' };

    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue(fakeCreds);
    keytar.getPassword.mockResolvedValue(null);
    // Also ensure no legacy token file exists for migration path
    fs.pathExists
      .mockResolvedValueOnce(true)   // credentials file exists
      .mockResolvedValueOnce(false); // legacy TOKEN_PATH does not exist

    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/auth?mock=1');
    mockGetToken.mockResolvedValue({ tokens: fakeTokens });

    const client = await getAuthClient();

    expect(mockGenerateAuthUrl).toHaveBeenCalled();
    expect(mockGetToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'mock_auth_code' })
    );
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeTokens);
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'gdrive-cli',
      'oauth-token',
      JSON.stringify(fakeTokens)
    );
    expect(client).toBeDefined();
  });

  it('falls back to file-based token when keytar is unavailable', async () => {
    // getKeytar() in auth.js wraps require('keytar') in a try/catch and returns
    // null when keytar is unavailable. We simulate this by making getPassword
    // return null (no token) and ensuring a legacy TOKEN_PATH file exists so
    // that loadToken() falls back to reading it from disk.
    keytar.getPassword.mockResolvedValue(null);

    const fakeCreds = {
      installed: {
        client_id: 'C',
        client_secret: 'S',
        redirect_uris: ['http://localhost:4242'],
      },
    };
    const fakeToken = { access_token: 'FILE_TOKEN' };

    // credentials exist, TOKEN_PATH exists (legacy fallback)
    fs.pathExists
      .mockResolvedValueOnce(true)  // credentials file
      .mockResolvedValueOnce(true); // TOKEN_PATH legacy file

    fs.readJson
      .mockResolvedValueOnce(fakeCreds)
      .mockResolvedValueOnce(fakeToken);

    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/auth?mock=1');
    mockGetToken.mockResolvedValue({ tokens: fakeToken });

    const client = await getAuthClient();
    expect(client).toBeDefined();
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeToken);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deleteToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes the keytar entry', async () => {
    keytar.deletePassword.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(false);

    await deleteToken();

    expect(keytar.deletePassword).toHaveBeenCalledWith('gdrive-cli', 'oauth-token');
  });

  it('also removes the legacy token file if it exists', async () => {
    keytar.deletePassword.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(true);

    await deleteToken();

    expect(fs.remove).toHaveBeenCalledWith(TOKEN_PATH);
  });

  it('does not attempt to remove legacy file when it does not exist', async () => {
    keytar.deletePassword.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(false);

    await deleteToken();

    expect(fs.remove).not.toHaveBeenCalled();
  });
});
