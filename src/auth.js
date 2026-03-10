"use strict";

/**
 * @fileoverview Authentication module for gdrive-cli.
 * Handles OAuth2 credential loading, token persistence via the OS credential
 * store (keytar), the browser-based consent flow, and token lifecycle management.
 */

const fs = require("fs-extra");
const http = require("http");
const { google } = require("googleapis");
const chalk = require("chalk");
const path = require("path");
const os = require("os");

const CREDENTIALS_PATH = path.join(os.homedir(), ".gdrive", "credentials.json");
/** @deprecated Used for migration and logout fallback only. Prefer OS keychain. */
const TOKEN_PATH = path.join(os.homedir(), ".gdrive", "token.json");

const KEYTAR_SERVICE = "gdrive-cli";
const KEYTAR_ACCOUNT = "oauth-token";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const CALLBACK_PORT = 4242;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}`;

// ── Keytar ────────────────────────────────────────────────────────────────────

/**
 * Lazily require `keytar` so the application still starts if the native
 * module has not been compiled (e.g. missing build tools).
 *
 * @returns {import('keytar') | null} The keytar module, or `null` if unavailable.
 */
function getKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

// ── Token persistence ─────────────────────────────────────────────────────────

/**
 * Persist OAuth2 tokens to the OS credential store.
 * Falls back to a JSON file (`TOKEN_PATH`) when keytar is unavailable,
 * restricting the file to owner-only permissions on non-Windows platforms.
 *
 * @param {import('google-auth-library').Credentials} tokens - OAuth2 token object.
 * @returns {Promise<void>}
 */
async function saveToken(tokens) {
  const keytar = getKeytar();
  if (keytar) {
    await keytar.setPassword(
      KEYTAR_SERVICE,
      KEYTAR_ACCOUNT,
      JSON.stringify(tokens),
    );
  } else {
    console.warn(
      chalk.yellow(
        "keytar unavailable — falling back to file-based token storage.",
      ),
    );
    await fs.outputJson(TOKEN_PATH, tokens, { spaces: 2 });
    if (process.platform !== "win32") {
      await fs.chmod(TOKEN_PATH, 0o600);
    }
  }
}

/**
 * Load OAuth2 tokens from the OS credential store.
 * If keytar is available but no token is stored there, attempts a one-time
 * migration from the legacy `TOKEN_PATH` JSON file.
 * Falls back to reading `TOKEN_PATH` directly when keytar is unavailable.
 *
 * @returns {Promise<import('google-auth-library').Credentials | null>}
 *   The stored token object, or `null` if none exists.
 */
async function loadToken() {
  const keytar = getKeytar();
  if (keytar) {
    const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    if (raw) return JSON.parse(raw);

    // One-time migration: move existing file token into keychain then delete it
    if (await fs.pathExists(TOKEN_PATH)) {
      console.log(chalk.dim("  Migrating token from file to OS credential store..."));
      const fileToken = await fs.readJson(TOKEN_PATH);
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(fileToken));
      await fs.remove(TOKEN_PATH);
      console.log(chalk.green("Migration complete.\n"));
      return fileToken;
    }
    return null;
  }

  if (await fs.pathExists(TOKEN_PATH)) {
    return fs.readJson(TOKEN_PATH);
  }
  return null;
}

/**
 * Remove the stored OAuth2 token from the OS credential store and delete
 * the legacy token file if it still exists on disk.
 *
 * @returns {Promise<void>}
 */
async function deleteToken() {
  const keytar = getKeytar();
  if (keytar) {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  }
  if (await fs.pathExists(TOKEN_PATH)) {
    await fs.remove(TOKEN_PATH);
  }
}

// ── Auth client ───────────────────────────────────────────────────────────────

/**
 * Build and return an authenticated `OAuth2Client`.
 *
 * - Reads the OAuth2 app credentials from `CREDENTIALS_PATH`.
 * - Restricts the credentials file to owner-only permissions (non-Windows).
 * - If a token already exists, injects it and registers an auto-refresh listener.
 * - If no token exists, starts the browser-based consent flow via `runBrowserFlow`.
 *
 * @throws {Error} When `CREDENTIALS_PATH` does not exist.
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 */
async function getAuthClient() {
  if (!(await fs.pathExists(CREDENTIALS_PATH))) {
    throw new Error(
      `No credentials found at ${CREDENTIALS_PATH}.\n` +
        `Run ${chalk.cyan("gdrive auth setup")} first.\n\n` +
        `Steps:\n` +
        `  1. Go to https://console.cloud.google.com\n` +
        `  2. Enable the Drive API\n` +
        `  3. Create OAuth2 credentials (Desktop app)\n` +
        `  4. Download the JSON and save it to ${CREDENTIALS_PATH}`,
    );
  }

  if (process.platform !== "win32") {
    await fs.chmod(CREDENTIALS_PATH, 0o600);
  }

  const creds = await fs.readJson(CREDENTIALS_PATH);
  const { client_id, client_secret } = creds.installed || creds.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    REDIRECT_URI,
  );

  const token = await loadToken();
  if (token) {
    oauth2Client.setCredentials(token);
    /**
     * Automatically persist any refreshed tokens issued by Google so that
     * the stored credentials never fall out of date.
     */
    oauth2Client.on("tokens", async (newTokens) => {
      const existing = (await loadToken()) ?? {};
      await saveToken({ ...existing, ...newTokens });
    });
    return oauth2Client;
  }

  return runBrowserFlow(oauth2Client);
}

// ── Browser OAuth flow ────────────────────────────────────────────────────────

/**
 * Start the OAuth2 browser consent flow.
 * Generates the authorization URL, opens the user's browser, waits for the
 * redirect callback, exchanges the code for tokens, and persists them.
 *
 * @param {import('google-auth-library').OAuth2Client} oauth2Client
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 *   The same client with credentials set.
 */
async function runBrowserFlow(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    prompt: "consent",
  });

  console.log(chalk.bold.cyan("\nAuthenticating with Google Drive\n"));

  const code = await waitForCallbackCode(authUrl);
  const { tokens } = await oauth2Client.getToken({
    code,
    redirect_uri: REDIRECT_URI,
  });
  oauth2Client.setCredentials(tokens);

  await saveToken(tokens);
  console.log(chalk.green("\nAuthentication successful."));

  return oauth2Client;
}

/**
 * Spin up a temporary local HTTP server on `CALLBACK_PORT`, open the browser
 * at `authUrl`, and resolve with the `code` query parameter once Google
 * redirects back.
 *
 * @param {string} authUrl - The Google authorization URL to open.
 * @returns {Promise<string>} The one-time authorization code from Google.
 * @throws {Error} On OAuth errors, missing code, or port conflicts.
 */
function waitForCallbackCode(authUrl) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          htmlPage(
            "Authentication Failed",
            `Authorization was denied: ${error}.`,
            false,
          ),
        );
        server.close(() => reject(new Error(`OAuth error: ${error}`)));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          htmlPage(
            "Missing Authorization Code",
            "No authorization code was received.",
            false,
          ),
        );
        server.close(() => reject(new Error("No code in callback")));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        htmlPage(
          "Authentication Successful",
          "You may close this tab and return to the terminal.",
        ),
      );
      server.close(() => resolve(code));
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", async () => {
      console.log(
        chalk.dim(
          `  Listening on ${chalk.white(`http://localhost:${CALLBACK_PORT}`)}\n`,
        ),
      );
      console.log(`  ${chalk.dim("Opening browser...")}`);
      try {
        await openBrowser(authUrl);
        console.log(
          chalk.dim(
            `\n  If the browser did not open, visit this URL manually:\n`,
          ) + chalk.cyan(`  ${authUrl}\n`),
        );
      } catch {
        console.log(chalk.yellow("\n  Could not open browser automatically."));
        console.log(chalk.cyan(`  ${authUrl}\n`));
      }
      console.log(chalk.dim("  Waiting for Google to redirect back..."));
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${CALLBACK_PORT} is already in use.\n` +
              `  Windows: netstat -ano | findstr :${CALLBACK_PORT}\n` +
              `  Linux/macOS: lsof -i :${CALLBACK_PORT}`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Open a URL in the user's default browser in a cross-platform manner.
 * Uses `start` on Windows, `open` on macOS, and `xdg-open` on Linux.
 *
 * @param {string} url - The URL to open.
 * @returns {Promise<void>}
 * @throws {Error} When the platform command fails to execute.
 */
async function openBrowser(url) {
  const { exec } = require("child_process");
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

// ── HTML callback page ────────────────────────────────────────────────────────

/**
 * Generate a minimal, plain HTML page displayed in the browser after the
 * OAuth2 redirect. Uses no external resources or JavaScript.
 *
 * @param {string}  title   - Page heading.
 * @param {string}  message - Body message shown beneath the heading.
 * @param {boolean} [success=true] - Controls the heading colour (green / red).
 * @returns {string} A complete HTML document as a string.
 */
function htmlPage(title, message, success = true) {
  const headingColor = success ? "#1a6b35" : "#a0200f";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>gdrive-cli — ${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f7f7f7;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    main {
      background: #ffffff;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      padding: 40px 48px;
      max-width: 480px;
      width: 100%;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: ${headingColor};
      margin-bottom: 12px;
    }
    p { color: #444; }
    footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #e8e8e8;
      font-size: 12px;
      color: #888;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <footer>gdrive-cli</footer>
  </main>
</body>
</html>`;
}

module.exports = { getAuthClient, CREDENTIALS_PATH, TOKEN_PATH, deleteToken };
