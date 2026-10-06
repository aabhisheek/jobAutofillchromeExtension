// Real-browser test for board ordering.
//
// Boots the actual unpacked extension in headless Chrome (explicitly, via the
// Extensions.loadUnpacked CDP command — a bare --load-extension can silently
// no-op on stable Chrome), writes eight rated jobs straight into
// chrome.storage.local in an order where recency and score disagree (the exact
// shape of the bug report: 25 45 0 45 25 25 50 70 seen top to bottom), opens
// the real dashboard, and reads the painted card order out of the DOM. If the
// board is not sorted 70 50 45 45 25 25 25 0, this fails — no shims, no
// mocked tracker, no mocked storage.
//
// Not part of `npm test` (it needs Chrome on this machine):
//   node tests/e2e-board-order.mjs

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

// The percentages from the bug report, in the order they were seen on screen.
const PCTS = [25, 45, 0, 45, 25, 25, 50, 70];
const EXPECTED = [70, 50, 45, 45, 25, 25, 25, 0];

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
  profileDir = await mkdtemp(path.join(tmpdir(), "board-order-"));
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

  // Load the unpacked extension explicitly; on current stable Chrome the
  // --load-extension switch can be silently ignored, and then every assertion
  // below would be made against somebody else's extension page.
  const browser = openCdp(version.webSocketDebuggerUrl);
  let extId;
  try {
    const loaded = await browser.send("Extensions.loadUnpacked", { path: ROOT });
    extId = loaded.id;
    console.log(`loaded unpacked: ${extId}`);
  } catch (err) {
    console.log(`Extensions.loadUnpacked unavailable (${err.message}); relying on --load-extension`);
  }

  // Whichever loader worked, the dashboard must come up as a real extension
  // page — not chrome-error://, which is what a wrong or missing id paints.
  async function openExtPage(pagePath) {
    const id = extId || "bcjbdkbljaeklilndemhmgppdoenkbdd";
    const tab = await http("PUT", `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(
      `chrome-extension://${id}/${pagePath}`
    )}`);
    const page = openCdp(tab.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await poll(() => evalIn(page, "location.protocol === 'chrome-extension:'"), 10000, `${pagePath} to load as an extension page`);
    return page;
  }

  // Seed from a real extension page: real chrome.storage.local, real
  // structured clone, nothing intercepted. updatedAt counts down as the score
  // climbs, so recency order alone is the wrong answer — and shortlist is
  // deliberately inverted (90, 89, 88 …) so a comparator ranking by the AI's
  // hidden shortlist chance would paint the exact unsorted sequence from the
  // bug report: 25 45 0 45 25 25 50 70. Settings disable auto-discovery so
  // opening the dashboard doesn't fire a live job search.
  const seedPage = await openExtPage("src/options/options.html");
  const seeded = await evalIn(seedPage, `(async () => {
    const pcts = ${JSON.stringify(PCTS)};
    const base = Date.now();
    const applications = pcts.map((pct, i) => ({
      id: "e2e-" + i,
      title: "Role " + pct + "-" + i,
      company: "Co " + i,
      url: "https://jobs.example.com/" + i,
      source: "LinkedIn",
      status: "saved",
      notes: "",
      sourceEmailId: "",
      match: { pct, stars: Math.max(1, Math.round(pct / 20)), shortlist: 90 - i,
               reasons: ["seeded"], scoredAt: base },
      savedAt: base - i,
      updatedAt: base - i,
      appliedAt: null,
      rejectedAt: null
    }));
    await chrome.storage.local.set({
      settings: { discoverAuto: false, emailSyncEnabled: false },
      applications
    });
    const back = await chrome.storage.local.get("applications");
    return back.applications.length;
  })()`);
  check(seeded === 8, `seeded eight rated jobs through chrome.storage.local (got ${seeded})`);
  seedPage.close();

  // Open the real dashboard in its own tab.
  const page = await openExtPage("src/dashboard/dashboard.html");

  const painted = await poll(async () => {
    const snapshot = await evalIn(page, `(() => {
      const columns = [...document.querySelectorAll("#board .column")];
      if (!columns.length) return null;
      return columns.map((col) => ({
        head: (col.querySelector(".column-head")?.textContent || "").replace(/\\s+/g, " ").trim(),
        cards: [...col.querySelectorAll(".app-card")].map((card) => {
          const rating = card.querySelector(".rating")?.textContent || "";
          const match = rating.match(/(\\d+)%/);
          return { id: card.dataset.id, pct: match ? Number(match[1]) : null };
        })
      }));
    })()`);
    const total = snapshot ? snapshot.reduce((n, c) => n + c.cards.length, 0) : 0;
    return total >= 8 ? snapshot : null;
  }, 15000, "the dashboard to paint eight cards");

  console.log("\nwhat the dashboard actually shows, per column:");
  for (const col of painted) {
    console.log(`  ${col.head}: ${col.cards.map((c) => c.pct).join("  ")}`);
  }
  console.log("");

  const saved = painted.find((c) => c.head.startsWith("Saved")) || painted[0];
  const order = saved.cards.map((c) => c.pct);

  check(order.length === 8, `all eight cards landed in one column (got ${order.length})`);
  check(JSON.stringify(order) === JSON.stringify(EXPECTED),
    `column reads highest first: [${order}] expected [${EXPECTED}]`);
  check(order.every((v, i) => i === 0 || order[i - 1] >= v), "every step down the column is <= the one above");

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
