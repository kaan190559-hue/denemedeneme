const fs = require("node:fs");
const path = require("node:path");

const envPath = path.join(__dirname, "..", ".env");

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const { initStorage, applyDashboardOperation } = require("../storage");

const VAULT_KEYS = ["atlas", "ecem", "aslan", "ares"];

function resolveVaultKey(input) {
  const raw = String(input || "").trim().toLocaleLowerCase("tr-TR");
  const aliases = {
    atlas: "atlas",
    ecem: "ecem",
    aslan: "aslan",
    ares: "ares",
    "atlas kasa": "atlas",
    "ecem kasa": "ecem",
    "aslan kasa": "aslan",
    "ares kasa": "ares"
  };
  return aliases[raw] || (VAULT_KEYS.includes(raw) ? raw : "");
}

function renderBaseUrl() {
  const raw = process.env.BOZOK_PUBLIC_URL
    || process.env.RENDER_EXTERNAL_URL
    || process.env.DASHBOARD_STATE_URL
    || "https://bozok-financial-dashboard.onrender.com";
  return String(raw).replace(/\/api\/dashboard-state\/?$/, "").replace(/\/+$/, "");
}

async function postToRender(operation) {
  const response = await fetch(`${renderBaseUrl()}/api/dashboard-operation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...operation, actor: "CLI" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Render isteği başarısız (${response.status})`);
  }
  return data;
}

function usage() {
  console.log([
    "Kullanım:",
    "  node tools/move-set.js <kaynak_kasa> <hedef_kasa> [set_adi] [--render]",
    "",
    "Örnekler:",
    "  node tools/move-set.js ecem aslan",
    "  node tools/move-set.js ecem aslan \"Beritan Yıldız\"",
    "  npm run set:devir -- ecem aslan",
    "",
    "Set adı verilmezse kaynak kasadaki tüm setler hedefe devredilir.",
    "--render ile doğrudan Render sunucusuna yazar; yoksa yerel DB/dosya kullanılır."
  ].join("\n"));
}

async function main() {
  const argv = process.argv.slice(2);
  const useRender = argv.includes("--render");
  const args = argv.filter(arg => arg !== "--render");

  if (!args.length || args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(args.length ? 0 : 1);
  }

  if (args.length < 2) {
    usage();
    process.exit(1);
  }

  const fromVault = resolveVaultKey(args[0]);
  const toVault = resolveVaultKey(args[1]);
  const owner = args.slice(2).join(" ").trim();

  if (!fromVault || !toVault) {
    throw new Error("Geçersiz kasa. atlas, ecem, aslan, ares kullanın.");
  }
  if (fromVault === toVault) {
    throw new Error("Kaynak ve hedef kasa aynı olamaz.");
  }

  const version = Date.now();
  const operation = owner
    ? { op: "move-set", vaultKey: fromVault, toVaultKey: toVault, owner, version }
    : { op: "move-vault-sets", vaultKey: fromVault, toVaultKey: toVault, version };

  if (useRender) {
    await postToRender(operation);
  } else {
    await initStorage();
    await applyDashboardOperation({ ...operation, actor: "CLI" });
  }

  if (owner) {
    console.log(`Set devredildi: ${owner} (${fromVault} -> ${toVault})`);
  } else {
    console.log(`Tüm setler devredildi: ${fromVault} -> ${toVault}`);
  }
  if (useRender) {
    console.log(`Render: ${renderBaseUrl()}`);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
