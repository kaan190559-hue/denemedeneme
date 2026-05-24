const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  return body;
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(values)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function main() {
  loadEnv();
  const clientId = process.env.MS_CLIENT_ID;
  const tenant = process.env.MS_TENANT_ID || "consumers";
  const scope = process.env.MS_GRAPH_SCOPES || "offline_access Files.ReadWrite User.Read";

  if (!clientId) {
    throw new Error(".env icinde MS_CLIENT_ID gerekli. Microsoft Entra uygulama id'sini yaz.");
  }

  const tokenBase = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  const { response: deviceResponse, payload: device } = await postForm(`${tokenBase}/devicecode`, {
    client_id: clientId,
    scope
  });

  if (!deviceResponse.ok) {
    throw new Error(`Device code alinamadi: ${device.error_description || device.error || deviceResponse.status}`);
  }

  console.log("");
  console.log("Microsoft girisi gerekli:");
  console.log(device.message);
  console.log("");
  console.log("Bekliyorum... Bu cikti gizlidir; refresh tokeni kimseyle paylasma.");

  const startedAt = Date.now();
  const timeoutMs = Number(device.expires_in || 900) * 1000;
  const intervalMs = Number(device.interval || 5) * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const { response, payload } = await postForm(`${tokenBase}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: device.device_code
    });

    if (response.ok) {
      console.log("");
      console.log("Tamam. .env veya Render Environment icine sunlari koy:");
      console.log(`MS_TENANT_ID=${tenant}`);
      console.log(`MS_CLIENT_ID=${clientId}`);
      console.log(`MS_REFRESH_TOKEN=${payload.refresh_token}`);
      console.log(`MS_GRAPH_SCOPES=${scope}`);
      console.log("EXCEL_CENTER_ENABLED=1");
      console.log("EXCEL_CENTER_PRIMARY=0");
      console.log("");
      console.log("Excel dosyasinin OneDrive paylasim linkini EXCEL_WORKBOOK_SHARE_URL olarak ekle.");
      return;
    }

    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") continue;
    throw new Error(`Token alinamadi: ${payload.error_description || payload.error || response.status}`);
  }

  throw new Error("Microsoft girisi zaman asimina ugradi. Komutu tekrar calistir.");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
