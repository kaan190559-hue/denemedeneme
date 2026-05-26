const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "node_modules", "playwright", "cli.js");
const browserPath = path.join(root, ".playwright-browsers");

const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserPath
  }
});

if (result.error) throw result.error;
process.exit(result.status || 0);
