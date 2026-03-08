'use strict';

/**
 * tests/auth.test.js
 * Unit tests for src/auth.js
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
}));

// Mock readline so tests don't hang waiting for stdin
jest.mock('readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn((q, cb) => cb('mock_auth_code')),
    close: jest.fn(),
  }),
}));

const fs = require('fs-extra');
const { getAuthClient, CREDENTIALS_PATH, TOKEN_PATH } = require('../src/auth');

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
  });

  it('throws a descriptive error when credentials file is missing', async () => {
    fs.pathExists.mockResolvedValue(false);
    await expect(getAuthClient()).rejects.toThrow('No credentials found');
  });

  it('returns an OAuth2 client when credentials + token both exist', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'CLIENT_ID',
        client_secret: 'CLIENT_SECRET',
        redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
      },
    };
    const fakeToken = { access_token: 'ACCESS', refresh_token: 'REFRESH' };

    // pathExists: credentials → true, token → true
    fs.pathExists
      .mockResolvedValueOnce(true)  // CREDENTIALS_PATH
      .mockResolvedValueOnce(true); // TOKEN_PATH

    fs.readJson
      .mockResolvedValueOnce(fakeCreds)  // credentials
      .mockResolvedValueOnce(fakeToken); // token

    const client = await getAuthClient();

    expect(client).toBeDefined();
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeToken);
  });

  it('runs the OAuth flow and saves a token when no token file exists', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'CLIENT_ID',
        client_secret: 'CLIENT_SECRET',
        redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
      },
    };
    const fakeTokens = { access_token: 'NEW_ACCESS', refresh_token: 'NEW_REFRESH' };

    // pathExists: credentials → true, token → false
    fs.pathExists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    fs.readJson.mockResolvedValueOnce(fakeCreds);
    mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/auth?mock=1');
    mockGetToken.mockResolvedValue({ tokens: fakeTokens });

    const client = await getAuthClient();

    expect(mockGenerateAuthUrl).toHaveBeenCalled();
    expect(mockGetToken).toHaveBeenCalledWith('mock_auth_code');
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeTokens);
    expect(fs.outputJson).toHaveBeenCalledWith(TOKEN_PATH, fakeTokens, { spaces: 2 });
    expect(client).toBeDefined();
  });

  it('supports credentials in "web" format (not just "installed")', async () => {
    const fakeCreds = {
      web: {
        client_id: 'WEB_ID',
        client_secret: 'WEB_SECRET',
        redirect_uris: ['http://localhost'],
      },
    };
    const fakeToken = { access_token: 'WEB_TOKEN' };

    fs.pathExists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    fs.readJson
      .mockResolvedValueOnce(fakeCreds)
      .mockResolvedValueOnce(fakeToken);

    const client = await getAuthClient();
    expect(client).toBeDefined();
    expect(mockSetCredentials).toHaveBeenCalledWith(fakeToken);
  });

  it('registers a token refresh listener when a stored token is found', async () => {
    const fakeCreds = {
      installed: {
        client_id: 'C', client_secret: 'S', redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
      },
    };
    const fakeToken = { access_token: 'A', refresh_token: 'R' };

    fs.pathExists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    fs.readJson.mockResolvedValueOnce(fakeCreds).mockResolvedValueOnce(fakeToken);

    await getAuthClient();

    expect(mockOn).toHaveBeenCalledWith('tokens', expect.any(Function));
  });
});
