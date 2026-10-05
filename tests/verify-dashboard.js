// Boots dashboard.html's real markup in a minimal DOM shim, runs dashboard.js
// against it with mocked chrome.*/Gmail, and checks the panel renders,
// connects, saves, syncs and re-renders. Catches the class of bug that
// `node --check` cannot: a listener bound to an element not in the document.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, expect } = require("./harness");

const html = fs.readFileSync(path.join(ROOT, "src/dashboard/dashboard.html"), "utf8");

// ---- minimal DOM ---------------------------------------------------------
function makeEl(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    value: "",
    checked: false,
    disabled: false,
    className: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    options: [],
    selectedIndex: 0,
    open: false,
    appendChild(child) { (this.children = this.children || []).push(child); return child; },
    // A real classList: the panel shows and hides elements through it, and a
    // no-op stub would make every show/hide assertion vacuously pass.
    classList: {
      add(...names) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.add(n));
        el.className = [...set].join(" ");
      },
      remove(...names) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.delete(n));
        el.className = [...set].join(" ");
      },
      contains(name) { return el.className.split(/\s+/).includes(name); },
      toggle(name, force) {
        const on = force === undefined ? !el.classList.contains(name) : !!force;
        if (on) el.classList.add(name); else el.classList.remove(name);
        return on;
      }
    },
    closest() { return null; },
    addEventListener(type, fn) { (this._l[type] = this._l[type] || []).push(fn); },
    _l: {},
    async fire(type, event = {}) {
      const fns = this._l[type] || [];
      for (const fn of fns) await fn({ preventDefault() {}, target: this, ...event });
    }
  };
  return el;
}

// Elements the dashboard touches, seeded straight from the real HTML so a
// missing id fails loudly here instead of silently in the browser.
const NEEDED = [...html.matchAll(/<([a-z0-9]+)[^>]*\sid="([^"]+)"/gi)];
const registry = new Map();
for (const [, tag, id] of NEEDED) registry.set(id, makeEl(tag, id));

// <select id="mail-lookback"> needs its options for the "closest option" logic.
registry.get("mail-lookback").options = [7, 30, 90].map((v) => ({ value: String(v) }));

const documentShim = {
  getElementById: (id) => {
    if (!registry.has(id)) throw new Error(`getElementById("${id}") -> null (element missing from dashboard.html)`);
    return registry.get(id);
  },
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  addEventListener() {}
};

// ---- chrome + lib mocks --------------------------------------------------
const store = { settings: { groqApiKey: "gsk_test" } };
const listeners = [];
const chromeMock = {
  storage: {
    local: {
      async get(key) {
        if (key == null) return structuredClone(store);
        if (typeof key === "string") return { [key]: structuredClone(store[key]) };
        const out = {}; for (const k of key) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v); },
      async remove(key) { delete store[key]; }
    },
    onChanged: { addListener: (fn) => listeners.push(fn) }
  },
  runtime: {
    getURL: (p) => `chrome-extension://fake/${p}`,
    getManifest: () => ({ version: "0.2.0" }),
    async sendMessage(msg) {
      if (msg.type === "mail:reschedule") return { ok: true, when: Date.now() + 3600_000 };
      throw new Error("unexpected message " + msg.type);
    }
  },
  permissions: { async request() { return true; } },
  identity: { getRedirectURL: () => "https://fake.chromiumapp.org/oauth2" }
};

let connected = false;
let connectCalls = 0;
let settingsWrites = 0;

const ctx = vm.createContext({
  chrome: chromeMock,
  console,
  document: documentShim,
  confirm: () => true,
  location: { href: "chrome-extension://fake/dashboard.html" },
  setTimeout,
  Date,
  URL,
  URLSearchParams,
  RegExp,
  String,
  Number,
  JSON,
  Object,
  Array,
  Promise,
  Boolean,
  structuredClone,
  Blob: class {},
  fetch: async (url) => {
    if (String(url).includes("settings.json")) return { ok: true, json: async () => ({}) };
    throw new Error("unexpected fetch " + url);
  }
});

for (const f of ["src/lib/schema.js", "src/lib/providers.js", "src/lib/tracker.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}

ctx.Gmail = {
  async getConnection() { return connected ? { connected: true, email: "me@gmail.com" } : { connected: false, email: "" }; },
  async connect() { connected = true; connectCalls++; return { connected: true, email: "me@gmail.com" }; },
  async disconnect() { connected = false; }
};
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/lib/mail-import.js"), "utf8"), ctx, { filename: "mail-import.js" });

// One message, so the sync has something real to do without a Gmail mock.
ctx.Gmail.listMessageIds = async () => ["m1"];
ctx.Gmail.getMessage = async () => ({
  id: "m1",
  subject: "Your application for Backend Engineer at Acme Corp",
  from: { name: "Acme Careers", address: "careers@acme.com", domain: "acme.com" },
  snippet: "We have received your application",
  body: "Thanks!",
  links: []
});

vm.runInContext(fs.readFileSync(path.join(ROOT, "src/dashboard/dashboard.js"), "utf8"), ctx, { filename: "dashboard.js" });

const el = (id) => registry.get(id);
const T = () => vm.runInContext("Tracker", ctx);

const { eq, done } = expect("dashboard");
const ok = (l, cond) => eq(l, !!cond, true);

(async () => {
  await new Promise((r) => setTimeout(r, 30));

  console.log("--- initial state ---");
  eq("panel says not connected", el("mail-conn-state").textContent, "Not connected");
  eq("setup visible (no client id)", el("mail-setup").className, "");
  eq("connect disabled with no client id", el("mail-connect").disabled, true);
  eq("AI toggle available (a provider key is configured)", el("mail-use-ai").disabled, false);
  eq("AI toggle on by default", el("mail-use-ai").checked, true);
  eq("daily toggle off by default", el("mail-enabled").checked, false);
  eq("query prefilled from defaults", el("mail-query").value.includes("application received"), true);
  eq("lookback defaulted to 30", el("mail-lookback").value, "30");
  ok("last run line exists", el("mail-last-run").textContent.length > 0);

  console.log("--- saving a bad client id is rejected ---");
  el("mail-client-id").value = "nonsense";
  await el("mail-save-client").fire("click");
  ok("bad id rejected", /apps\.googleusercontent/i.test(el("mail-setup-msg").textContent));
  eq("setup error class", el("mail-setup-msg").className.includes("err"), true);

  console.log("--- saving a good client id ---");
  el("mail-client-id").value = "123.apps.googleusercontent.com";
  await el("mail-save-client").fire("click");
  ok("saved", /Saved/i.test(el("mail-setup-msg").textContent));
  eq("connect now enabled", el("mail-connect").disabled, false);
  eq("setup collapsed away", el("mail-setup").className, "hidden");

  console.log("--- connecting ---");
  await el("mail-connect").fire("click");
  eq("connected pill", el("mail-conn-state").textContent, "Connected · me@gmail.com");
  eq("pill styled as on", el("mail-conn-state").className, "pill on");
  eq("connect button hidden", el("mail-connect").className, "hidden");
  eq("disconnect shown", el("mail-disconnect").className, "");
  ok("status mentions sync now", /Sync now/i.test(el("mail-status-msg").textContent));

  console.log("--- saving schedule settings ---");
  el("mail-enabled").checked = true;
  el("mail-time").value = "07:15";
  el("mail-lookback").value = "90";
  el("mail-query").value = 'newer_than:14d {"application received"}';
  el("mail-use-ai").checked = false;
  await el("mail-save").fire("click");
  eq("time persisted", store.settings.emailSyncTime, "07:15");
  eq("enabled persisted", store.settings.emailSyncEnabled, true);
  eq("lookback persisted as a number", store.settings.emailLookbackDays, 90);
  eq("query persisted", store.settings.emailSyncQuery, 'newer_than:14d {"application received"}');
  eq("useAi persisted", store.settings.emailUseAi, false);
  eq("provider key survived the save", store.settings.groqApiKey, "gsk_test");
  ok("status quotes the time", /07:15/.test(el("mail-status-msg").textContent));

  console.log("--- syncing now ---");
  el("mail-sync-now").disabled = false;
  await el("mail-sync-now").fire("click");
  ok("sync reported success", /added/i.test(el("mail-status-msg").textContent), );
  eq("button re-enabled", el("mail-sync-now").disabled, false);
  const rows = await T().list();
  eq("one card imported", rows.length, 1);
  eq("card title", rows[0].title, "Backend Engineer");
  eq("card company", rows[0].company, "Acme Corp");
  eq("card stage", rows[0].status, "applied");
  eq("card marked as imported", rows[0].sourceEmailId, "m1");
  ok("board rendered the card", el("board").innerHTML.includes("Backend Engineer"));
  ok("last-run line updated", /Last synced/.test(el("mail-last-run").textContent));

  console.log("--- second sync is a no-op ---");
  await el("mail-sync-now").fire("click");
  eq("still one card", (await T().list()).length, 1);
  ok("reported as already imported", /already imported/i.test(el("mail-status-msg").textContent));

  console.log("--- a storage change from the worker re-renders the last-run line ---");
  store.emailSyncState = { at: Date.now(), ok: false, notes: ["Gmail is not connected. Press Connect Gmail first."], scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0, aiEnriched: 0, aiSkipped: 0 };
  for (const fn of listeners) fn({ emailSyncState: { newValue: store.emailSyncState } }, "local");
  await new Promise((r) => setTimeout(r, 20));
  ok("failure surfaced", /not connected/i.test(el("mail-last-run").textContent));

  console.log("--- disconnect ---");
  await el("mail-disconnect").fire("click");
  eq("back to not connected", el("mail-conn-state").textContent, "Not connected");
  eq("connect visible again", el("mail-connect").className, "");

  process.exit(done() ? 1 : 0);
})();