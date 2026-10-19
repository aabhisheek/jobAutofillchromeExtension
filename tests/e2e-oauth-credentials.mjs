// Real-browser test for the bundled Gmail OAuth client.
//
// Boots the actual unpacked extension in headless Chrome (via the
// Extensions.loadUnpacked CDP command — a bare --load-extension can silently
// no-op on stable Chrome) against a FRESH profile whose chrome.storage.local
// holds nothing but the flags that keep the page quiet. That is exactly the
// state a reload or a new profile leaves behind.
//
// The point of the test: the OAuth client is not a field anyone types. It ships
// in src/data/google-oauth.json, gmail.js resolves it from there, and the panel
// offers nothing but "Connect Gmail". So the assertions are (1) gmail.js really
// reads the client out of the bundled file with empty storage, and (2) the
// dashboard renders no credential inputs and leaves Connect enabled.
//
// Not part of `npm test` (it needs Chrome on this machine):
//   node tests/e2e-oauth-credentials.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const OAUTH_FILE = path.join(ROOT, "src/data/google-oauth.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url) {
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}

function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = async (method, params = {}) => {
    await ready;
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, close: () => { try { ws.close(); } catch {} } };
}

async function evalIn(handle, expression) {
  const out = await handle.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description || "evaluation failed");
  }
  return out.result.value;
}

async function poll(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ""}`);
}

let chromeProc;
let profileDir;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

try {
  const bundled = JSON.parse(await readFile(OAUTH_FILE, "utf8"));
  const expectedClientId = (bundled.web || bundled).client_id || "";

  profileDir = await mkdtemp(path.join(tmpdir(), "oauth-credentials-"));
  chromeProc = spawn(CHROME, [
    "--headless",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--enable-unsafe-extension-debugging",
    "about:blank"
  ], { detached: true, stdio: "ignore" });
  chromeProc.unref();

  const version = await poll(() => http("GET", `http://127.0.0.1:${PORT}/json/version`), 15000, "Chrome DevTools endpoint");

  const browser = openCdp(version.webSocketDebuggerUrl);
  let extId;
  try {
    const loaded = await browser.send("Extensions.loadUnpacked", { path: ROOT });
    extId = loaded.id;
    console.log(`loaded unpacked: ${extId}`);
  } catch (err) {
    console.log(`Extensions.loadUnpacked unavailable (${err.message}); relying on the default id`);
  }
  const runtimeId = extId || "bcjbdkbljaeklilndemhmgppdoenkbdd";

  async function openExtPage(pagePath) {
    const tab = await http("PUT", `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(
      `chrome-extension://${runtimeId}/${pagePath}`
    )}`);
    const page = openCdp(tab.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await poll(() => evalIn(page, "location.protocol === 'chrome-extension:'"), 10000, `${pagePath} to load as an extension page`);
    return page;
  }

  // Seed only the flags that stop a live job search / mail sync on open. The
  // credentials are deliberately NOT written: an empty chrome.storage.local is
  // the whole point — the bundled file has to supply them on its own.
  const seedPage = await openExtPage("src/options/options.html");
  const stored = await evalIn(seedPage, `(async () => {
    await chrome.storage.local.set({ settings: { discoverAuto: false, emailSyncEnabled: false } });
    const back = await chrome.storage.local.get("settings");
    return JSON.stringify(back.settings);
  })()`);
  const storedSettings = JSON.parse(stored);
  check(!("gmailClientId" in storedSettings), "storage holds no client id (fresh-profile state)");
  check(!("gmailClientSecret" in storedSettings), "storage holds no client secret");
  seedPage.close();

  const page = await openExtPage("src/dashboard/dashboard.html");

  // gmail.js is loaded on this page, so its resolver can be exercised directly.
  // This is the real code path connect() uses.
  const resolved = await poll(async () => {
    const value = await evalIn(page, `(async () => {
      if (typeof Gmail === "undefined" || typeof Gmail.resolveCredentials !== "function") return null;
      const creds = await Gmail.resolveCredentials({});
      return JSON.stringify(creds);
    })()`);
    return value ? JSON.parse(value) : null;
  }, 15000, "Gmail.resolveCredentials to answer");

  const panel = await evalIn(page, `(() => ({
    hasClientIdInput: !!document.getElementById("mail-client-id"),
    hasSecretInput: !!document.getElementById("mail-client-secret"),
    hasSetupBlock: !!document.getElementById("mail-setup"),
    connectDisabled: (document.getElementById("mail-connect") || {}).disabled
  }))()`);

  console.log("\nwhat the dashboard shows with empty storage:");
  console.log(`  resolved client id: ${resolved.clientId}`);
  console.log(`  client id field   : ${panel.hasClientIdInput ? "present" : "none"}`);
  console.log(`  secret field      : ${panel.hasSecretInput ? "present" : "none"}\n`);

  check(resolved.clientId === expectedClientId,
    `the bundled client id is resolved with empty storage (got "${resolved.clientId}")`);
  check((resolved.clientSecret || "").length > 0,
    "the bundled client secret is resolved too");
  check(panel.hasClientIdInput === false, "no client id input is rendered");
  check(panel.hasSecretInput === false, "no client secret input is rendered");
  check(panel.hasSetupBlock === false, "no Google Cloud setup block is rendered");
  check(panel.connectDisabled === false, "Connect is enabled without any stored credentials");

  page.close();
  browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nPASS");
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  console.error("FAIL ", err.message);
  process.exitCode = 1;
} finally {
  if (chromeProc) {
    try { process.kill(-chromeProc.pid); } catch {}
    try { chromeProc.kill("SIGKILL"); } catch {}
  }
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
}
