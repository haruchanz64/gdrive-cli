"use strict";

const fs = require("fs-extra");
const http = require("http");
const { google } = require("googleapis");
const chalk = require("chalk");

const CREDENTIALS_PATH = require("path").join(
  require("os").homedir(),
  ".gdrive",
  "credentials.json",
);
const TOKEN_PATH = require("path").join(
  require("os").homedir(),
  ".gdrive",
  "token.json",
);

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const CALLBACK_PORT = 4242;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}`;

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

  const creds = await fs.readJson(CREDENTIALS_PATH);
  const { client_id, client_secret } = creds.installed || creds.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    REDIRECT_URI,
  );

  if (await fs.pathExists(TOKEN_PATH)) {
    const token = await fs.readJson(TOKEN_PATH);
    oauth2Client.setCredentials(token);
    oauth2Client.on("tokens", async (tokens) => {
      const existing = await fs.readJson(TOKEN_PATH).catch(() => ({}));
      await fs.outputJson(
        TOKEN_PATH,
        { ...existing, ...tokens },
        { spaces: 2 },
      );
    });
    return oauth2Client;
  }
  console.log("Redirect URI:", REDIRECT_URI);
  return runBrowserFlow(oauth2Client);
}

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

  await fs.outputJson(TOKEN_PATH, tokens, { spaces: 2 });
  console.log(chalk.green("\n✔ Authentication successful!"));

  return oauth2Client;
}

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
            `Google returned: <b>${error}</b>`,
            "#c0392b",
          ),
        );
        server.close(() => reject(new Error(`OAuth error: ${error}`)));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          htmlPage(
            "Missing Code",
            "No authorization code received.",
            "#c0392b",
          ),
        );
        server.close(() => reject(new Error("No code in callback")));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        htmlPage(
          "Authenticated!",
          "You can close this tab and return to the terminal.",
          "#27ae60",
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
            `\n  If the browser didn't open, visit this URL manually:\n`,
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
            `Port ${CALLBACK_PORT} is already in use.\n  Windows: netstat -ano | findstr :${CALLBACK_PORT}`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

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

function htmlPage(title, message, color = "#2c3e50") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>gdrive-cli</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           display:flex; align-items:center; justify-content:center;
           min-height:100vh; background:#f5f5f5 }
    .card { background:white; border-radius:12px; padding:48px 56px;
            box-shadow:0 4px 24px rgba(0,0,0,.08); text-align:center; max-width:420px; width:90% }
    .icon { font-size:48px; margin-bottom:16px }
    h1 { font-size:24px; color:${color}; margin-bottom:12px }
    p { color:#666; font-size:15px; line-height:1.5 }
    .brand { margin-top:32px; font-size:12px; color:#aaa }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="brand">gdrive-cli</p>
  </div>
</body>
</html>`;
}

module.exports = { getAuthClient, CREDENTIALS_PATH, TOKEN_PATH };
