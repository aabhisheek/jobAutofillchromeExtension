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
    // textContent derived from children, the way a real element behaves. Without
    // this the shim returns whatever was last assigned, so appending a heading and
    // some lines would read as empty and every content assertion would fail for
    // reasons that have nothing to do with the code under test.
    // Children win when present, matching the real DOM: assigning textContent
    // sets the text, and appendChild afterwards makes the children the content.
    get textContent() {
      if (this.children && this.children.length) {
        return this.children.map((c) => c.textContent).join(" ");
      }
      return this._text || "";
    },
    set textContent(value) {
      this._text = String(value);
      if (this._text === "") this.children = [];
    },
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

// <input id="mail-lookback" type="number"> — a free day count, so nothing needs
// seeding here; the shim's value is whatever the code writes to it.

// Elements carrying data-copy are found only by querySelectorAll, so they have to
// come from the real markup too -- otherwise the copy-button assertions would run
// against an empty list and pass without proving anything.
const COPY_BUTTONS = [...html.matchAll(/<button[^>]*\sdata-copy="([^"]+)"/gi)].map(
  ([, target]) => {
    const el = makeEl("button");
    el.dataset.copy = target;
    el.textContent = "Copy";
    return el;
  }
);

let copied = [];
const documentShim = {
  getElementById: (id) => {
    if (!registry.has(id)) throw new Error(`getElementById("${id}") -> null (element missing from dashboard.html)`);
    return registry.get(id);
  },
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (selector) => (selector === "[data-copy]" ? COPY_BUTTONS : []),
  // The Clipboard API path. Recorded rather than stubbed to nothing, so the
  // assertion is about what would reach Google's console.
  body: makeEl("body"),
  execCommand: () => true,
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
    // A real-shaped id, because the panel derives the expected redirect URI from
    // it and a placeholder would make the assertion vacuous.
    id: "abcdefghijklmnopabcdefghijklmnop",
    getURL: (p) => `chrome-extension://fake/${p}`,
    getManifest: () => ({ version: "0.2.0" }),
    async sendMessage(msg) {
      if (msg.type === "mail:reschedule") return { ok: true, when: Date.now() + 3600_000 };
      if (msg.type === "naukri:reschedule") return { ok: true, when: Date.now() + 3600_000 };
      if (msg.type === "naukri:run") return { ok: true, edited: true, saved: true, reason: "" };
      if (msg.type === "cloud:reschedule") return { ok: true, armed: false };
      if (msg.type === "cloud:sync") return { ok: false, notes: ["not signed in"] };
      throw new Error("unexpected message " + msg.type);
    }
  },
  permissions: { async request() { return true; } },
  // Derived from runtime.id, as Chrome does. A hardcoded host that disagreed
  // with the id would make the redirect-URI assertion meaningless.
  identity: {
    getRedirectURL: (p) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${p || ""}`,
    // The extension's own Google sign-in goes through launchWebAuthFlow; returns
    // a code so the flow would reach the token exchange if the client were set.
    launchWebAuthFlow: async () => "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?code=fake"
  }
};

let connected = false;
let connectCalls = 0;
let settingsWrites = 0;

// Records what the copy buttons hand to the clipboard.
copied = [];

// What fetch() answers for the bundled src/data/settings.json. Empty for most
// of the run so the storage-backed assertions stand alone; the credentials
// section at the bottom fills it in to prove the file's values land on screen.
let bundledFile = {};

const ctx = vm.createContext({
  chrome: chromeMock,
  console,
  document: documentShim,
  confirm: () => true,
  location: { href: "chrome-extension://fake/dashboard.html" },
  navigator: {
    clipboard: {
      async writeText(value) {
        copied.push(value);
      }
    }
  },
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
  AbortController,
  AbortSignal,
  Blob: class {},
  crypto,
  btoa,
  atob,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  fetch: async (url, init = {}) => {
    const u = String(url);
    if (u.includes("settings.json")) return { ok: true, json: async () => bundledFile };
    if (u.includes("/chat/completions")) {
      // A minimal, well-formed AI answer: it echoes each `=== ref: eN ===` tag
      // with no fields, so mergeAiFields keeps the local parse — the panel's
      // card assertions are about those local values — while the email still
      // counts as AI-read, which the default (AI-only cards) requires before a
      // card is allowed onto the board.
      const body = JSON.parse(init.body || "{}");
      const content = String((body.messages && body.messages[0] && body.messages[0].content) || "");
      const refs = [...content.matchAll(/=== ref: (\S+) ===/g)].map((m) => m[1]);
      const reply = refs.length
        ? refs.map((ref) => ({ ref }))
        : {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }] })
      };
    }
    throw new Error("unexpected fetch " + url);
  }
});

for (const f of ["src/lib/schema.js", "src/lib/providers.js", "src/lib/tracker.js", "src/lib/scheduler-state.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}

ctx.Gmail = {
  async getConnection() { return connected ? { connected: true, email: "me@gmail.com" } : { connected: false, email: "" }; },
  async hasCredentials() { return true; },
  async connect() { connected = true; connectCalls++; return { connected: true, email: "me@gmail.com" }; },
  async disconnect() { connected = false; }
};
// The cloud sign-in lib loads right after gmail.js in the real page (it reuses
// Gmail's client resolution), so it is loaded here too. Without it dashboard.js's
// initAccountPanel would fail on an undefined Cloud — which is exactly the class
// of breakage this file exists to catch.
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/lib/cloud.js"), "utf8"), ctx, { filename: "cloud.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/lib/supabase.js"), "utf8"), ctx, { filename: "supabase.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/lib/cloud-sync.js"), "utf8"), ctx, { filename: "cloud-sync.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "src/lib/mail-import.js"), "utf8"), ctx, { filename: "mail-import.js" });

// Discovery's dependencies, in the order dashboard.html loads them: the
// keyword/match logic the scorer uses, the injectable listing reader, then the
// engine. discover.js is what makes initDiscoverPanel do anything at all.
for (const f of ["src/lib/resume-tailor.js", "src/lib/page-scripts.js", "src/lib/discover.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}

// One message, so the sync has something real to do without a Gmail mock.
ctx.Gmail.listMessageIds = async () => ["m1"];
ctx.Gmail.listAllMessageIds = async () => ["m1"];
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
  // No stored credentials are needed to connect: the OAuth client is bundled.
  eq("connect is enabled with no stored credentials", el("mail-connect").disabled, false);

  // The credential fields are gone from the UI entirely. The client id and
  // secret live in src/data/google-oauth.json, so there is nothing for a user
  // to type and nothing to keep in sync with Google Cloud from this panel.
  console.log("--- no credential fields are rendered ---");
  for (const id of [
    "mail-setup",
    "mail-client-id",
    "mail-client-secret",
    "mail-ext-id",
    "mail-redirect-uri",
    "mail-cred-note",
    "mail-save-client",
    "mail-setup-msg"
  ]) {
    eq(`no #${id} in the markup`, html.includes(`id="${id}"`), false);
  }

  // The remaining diagnostics. The build stamp is what proves the current code
  // is running behind a cached page.
  console.log("--- diagnostics shown ---");
  const stamp = el("mail-build").textContent;
  ok("build stamp rendered (proves current code is running)", !!stamp && stamp.length > 4);
  eq("AI toggle available (a provider key is configured)", el("mail-use-ai").disabled, false);
  eq("AI toggle on by default", el("mail-use-ai").checked, true);
  eq("AI-only toggle on by default", el("mail-require-ai").checked, true);
  eq("daily toggle on by default", el("mail-enabled").checked, true);
  eq("frequency defaulted to every 2 hours", el("mail-every").value, "2h");
  eq("daily time row hidden on an interval schedule",
     el("mail-time-row").className.includes("hidden"), true);
  eq("query prefilled from defaults", el("mail-query").value.includes("application received"), true);
  eq("lookback defaulted to 30", el("mail-lookback").value, "30");
  ok("last run line exists", el("mail-last-run").textContent.length > 0);
  ok("dedicated AI tally row exists in the panel", html.includes('id="mail-ai-stats"'));

  console.log("--- connecting ---");
  await el("mail-connect").fire("click");
  eq("connected pill", el("mail-conn-state").textContent, "Connected · me@gmail.com");
  eq("pill styled as on", el("mail-conn-state").className, "pill on");
  eq("connect button hidden", el("mail-connect").className, "hidden");
  eq("disconnect shown", el("mail-disconnect").className, "");
  // The first import runs itself once the grant is done — asking for one more
  // click to see your own history is the bug this replaced.
  ok("the first import ran itself, no Sync now click", /added/i.test(el("mail-status-msg").textContent));
  // The AI tally is its own always-visible row, not just the passing status text.
  ok("AI tally shows the live counts", /AI: \d+ enriched/.test(el("mail-ai-stats").textContent));
  ok("AI tally is not hidden after the run", !el("mail-ai-stats").className.includes("hidden"));

  console.log("--- saving schedule settings ---");
  // The time row follows the frequency: on until "Once a day" is chosen, off
  // again for the interval schedules where the time only anchors the first run.
  el("mail-every").value = "daily";
  await el("mail-every").fire("change");
  eq("choosing daily reveals the time row",
     el("mail-time-row").className.includes("hidden"), false);
  el("mail-every").value = "2h";
  await el("mail-every").fire("change");
  eq("every-2-hours hides it again",
     el("mail-time-row").className.includes("hidden"), true);
  el("mail-enabled").checked = true;
  el("mail-time").value = "07:15";
  el("mail-lookback").value = "123";
  el("mail-query").value = 'newer_than:14d {"application received"}';
  el("mail-use-ai").checked = false;
  el("mail-require-ai").checked = false;
  await el("mail-save").fire("click");
  eq("frequency persisted", store.settings.emailSyncEvery, "2h");
  eq("time persisted", store.settings.emailSyncTime, "07:15");
  eq("enabled persisted", store.settings.emailSyncEnabled, true);
  eq("an arbitrary day count persists (not snapped to a preset)", store.settings.emailLookbackDays, 123);
  eq("query persisted", store.settings.emailSyncQuery, 'newer_than:14d {"application received"}');
  eq("useAi persisted", store.settings.emailUseAi, false);
  eq("AI-only persisted", store.settings.emailRequireAi, false);
  eq("provider key survived the save", store.settings.groqApiKey, "gsk_test");
  ok("status quotes the rhythm", /every 2 hours/.test(el("mail-status-msg").textContent));

  console.log("--- the look-back count is clamped and defaults sanely ---");
  el("mail-lookback").value = "0";
  await el("mail-save").fire("click");
  eq("a non-positive count falls back to 30", store.settings.emailLookbackDays, 30);
  el("mail-lookback").value = "999999";
  await el("mail-save").fire("click");
  eq("an absurd count is capped at ten years", store.settings.emailLookbackDays, 3650);
  el("mail-lookback").value = "";
  await el("mail-save").fire("click");
  eq("a blank box falls back to 30", store.settings.emailLookbackDays, 30);

  console.log("--- syncing now ---");
  el("mail-sync-now").disabled = false;
  await el("mail-sync-now").fire("click");
  // The connect step already imported m1, so this run's honest answer is that
  // there is nothing new — which is also the proof that the ledger held.
  ok("sync reported the run", /already imported/i.test(el("mail-status-msg").textContent), );
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

  console.log("--- reset & rebuild wipes the board and re-imports from mail ---");
  // A hand-added card rides along, so the wipe is shown to clear everything —
  // not just the rows that came from email.
  await T().save({ title: "Hand added", company: "Manual Co", status: "saved" });
  eq("two cards before the rebuild", (await T().list()).length, 2);
  el("mail-lookback").value = "45";
  await vm.runInContext("rebuildFromMail()", ctx);
  const rebuilt = await T().list();
  eq("the board was rebuilt from mail alone", rebuilt.length, 1);
  eq("the hand-added card was removed too", rebuilt.every((row) => row.title !== "Hand added"), true);
  eq("and the imported card is back", rebuilt[0].sourceEmailId, "m1");
  eq("the window used is the one in the box", store.settings.emailLookbackDays, 45);

  console.log("--- reopening the dashboard syncs without a click ---");
  el("mail-status-msg").textContent = "";
  await vm.runInContext("initMailPanel()", ctx);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && /Checking your mail/.test(el("mail-status-msg").textContent)) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ok("the auto-sync on open reported its run",
     /already imported|Nothing new/i.test(el("mail-status-msg").textContent));
  eq("still one card after the auto-sync", (await T().list()).length, 1);

  // The state the dashboard was actually showing before this: the bug being
  // guarded is one where "5 unreadable" appeared with the reason never shown.
  console.log("--- unreadable emails show their reason, not just a count ---");
  store.emailSyncState = {
    at: Date.now(),
    ok: true,
    notes: [
      "Could not read one message: document is not defined",
      "Could not read one message: Gmail request failed (500): backend error",
      "Could not read one message: document is not defined"
    ],
    scanned: 5, added: 0, updated: 0, skipped: 0, failed: 3, aiEnriched: 0, aiSkipped: 0, aiFailed: 0
  };
  for (const fn of listeners) fn({ emailSyncState: { newValue: store.emailSyncState } }, "local");
  await new Promise((r) => setTimeout(r, 20));

  const failBox = el("mail-last-run-errors");
  ok("summary still counts them", /3 unreadable/.test(el("mail-last-run").textContent));
  eq("reason box is shown", failBox.className.includes("hidden"), false);
  const failText = failBox.textContent;
  ok("the actual cause is on screen", /document is not defined/.test(failText));
  ok("the second cause too", /backend error/.test(failText));
  ok("headed so it reads as a list of reasons", /could not be read/i.test(failText));
  ok("the leading 'Could not read one message:' preamble is stripped from each line",
     !/Could not read one message: document/.test(failText));

  console.log("--- a clean sync clears the stale reasons ---");
  store.emailSyncState = {
    at: Date.now(), ok: true, notes: [], scanned: 2, added: 2, updated: 0,
    skipped: 0, failed: 0, aiEnriched: 0, aiSkipped: 0, aiFailed: 0
  };
  for (const fn of listeners) fn({ emailSyncState: { newValue: store.emailSyncState } }, "local");
  await new Promise((r) => setTimeout(r, 20));
  eq("reason box hidden again", el("mail-last-run-errors").className.includes("hidden"), true);
  eq("and emptied", el("mail-last-run-errors").textContent, "");
  ok("summary reports the additions", /2 new/.test(el("mail-last-run").textContent));

  console.log("--- deferred emails are shown as waiting, not as silently dropped ---");
  store.emailSyncState = {
    at: Date.now(), ok: true, notes: [], scanned: 4, added: 1, updated: 0,
    skipped: 0, failed: 0, aiEnriched: 1, aiSkipped: 2, aiFailed: 0,
    deferred: 2, aiOn: true, aiRequired: true
  };
  for (const fn of listeners) fn({ emailSyncState: { newValue: store.emailSyncState } }, "local");
  await new Promise((r) => setTimeout(r, 20));
  ok("summary counts the waiting cards", /2 waiting for AI/.test(el("mail-last-run").textContent));
  ok("the AI-only run words a cap skip as 'over the AI limit', not a local fallback",
     /2 over the AI limit/.test(el("mail-last-run").textContent));
  ok("the dedicated tally also shows the waiting count",
     /2 waiting for AI/.test(el("mail-ai-stats").textContent));

  console.log("--- a storage change from the worker re-renders the last-run line ---");
  store.emailSyncState = { at: Date.now(), ok: false, notes: ["Gmail is not connected. Press Connect Gmail first."], scanned: 0, added: 0, updated: 0, skipped: 0, failed: 0, aiEnriched: 0, aiSkipped: 0 };
  for (const fn of listeners) fn({ emailSyncState: { newValue: store.emailSyncState } }, "local");
  await new Promise((r) => setTimeout(r, 20));
  ok("failure surfaced", /not connected/i.test(el("mail-last-run").textContent));

  console.log("--- disconnect ---");
  await el("mail-disconnect").fire("click");
  eq("back to not connected", el("mail-conn-state").textContent, "Not connected");
  eq("connect visible again", el("mail-connect").className, "");

  // ---- job discovery ------------------------------------------------------
  // The panel boots with the dashboard. With no target roles configured the
  // automatic run has nothing to search for, and the honest outcome is a
  // message that says exactly that — not a silent no-op, and not a crawl of
  // unrelated listings.
  console.log("--- discovery panel boots and reports the empty-roles run ---");
  eq("build stamped on the discover panel",
     el("discover-build").textContent, vm.runInContext("DASHBOARD_BUILD", ctx));
  const discoverDeadline = Date.now() + 2000;
  while (Date.now() < discoverDeadline && !el("discover-status-msg").textContent) {
    await new Promise((r) => setTimeout(r, 10));
  }
  eq("the auto-run on open reported",
     el("discover-status-msg").textContent,
     "No roles to search for — add them on the Discover panel.");
  eq("reported as an error, not a success", el("discover-status-msg").className.includes("err"), true);
  eq("roles prefilled from settings", el("discover-roles").value, "");
  eq("max prefilled from defaults", el("discover-max").value, "20");
  eq("auto-run on by default", el("discover-auto").checked, true);
  eq("AI toggle enabled (a provider key is configured)", el("discover-use-ai").disabled, false);
  eq("AI toggle on by default", el("discover-use-ai").checked, true);
  ok("last-run line exists", /Last searched/.test(el("discover-last-run").textContent));
  eq("run button re-enabled after the run", el("discover-run").disabled, false);

  console.log("--- saving discovery settings ---");
  el("discover-roles").value = "Backend Engineer, SRE";
  el("discover-location").value = "Bangalore";
  el("discover-max").value = "15";
  el("discover-auto").checked = false;
  el("discover-use-ai").checked = false;
  await el("discover-save").fire("click");
  eq("roles stored as an array", store.settings.discoverRoles, ["Backend Engineer", "SRE"]);
  eq("location stored", store.settings.discoverLocations, "Bangalore");
  eq("max stored as a number", store.settings.discoverMaxJobs, 15);
  eq("auto stored", store.settings.discoverAuto, false);
  eq("ai stored", store.settings.discoverUseAi, false);
  eq("provider key survived the save", store.settings.groqApiKey, "gsk_test");
  ok("saved status shown", /^Saved/.test(el("discover-status-msg").textContent));

  // The page-head button is the one labelled "jobs" anywhere on the dashboard,
  // so its wiring is the whole point of the visibility fix: it must open the
  // panel and run the same search. The boards are canned here — two LinkedIn
  // listings, returned for every LinkedIn search URL, so the engine's own
  // dedupe is what has to collapse them into one pool.
  console.log("--- the Find jobs button runs a search ---");
  const discoverTabs = new Map();
  let discoverTabSeq = 0;
  chromeMock.tabs = {
    query: async () => [],
    sendMessage: async () => undefined,
    create: async ({ url, active }) => {
      const id = ++discoverTabSeq;
      discoverTabs.set(id, { id, url, active });
      return { id, url };
    },
    get: async (id) => {
      if (!discoverTabs.has(id)) throw new Error(`tab ${id} is gone`);
      return { id, status: "complete" };
    },
    remove: async (id) => { discoverTabs.delete(id); }
  };
  chromeMock.scripting = {
    executeScript: async ({ target }) => {
      const tab = discoverTabs.get(target.tabId);
      const url = (tab && tab.url) || "";
      if (!url.includes("linkedin")) return [{ result: [] }];
      return [{
        result: [
          { url: "https://www.linkedin.com/jobs/view/mock-1", title: "Backend Engineer", company: "MockCo", location: "", snippet: "Node.js role" },
          { url: "https://www.linkedin.com/jobs/view/mock-2", title: "Backend Engineer II", company: "MockCo", location: "", snippet: "" }
        ]
      }];
    }
  };

  el("discover-status-msg").textContent = "";
  await el("find-jobs").fire("click");
  eq("the panel opened for the run", el("discover-panel").open, true);
  // The click hands back before the async search finishes; wait for the busy
  // line to be replaced by the result rather than for the line to appear.
  const findDeadline = Date.now() + 2000;
  while (Date.now() < findDeadline && /Searching|…/.test(el("discover-status-msg").textContent)) {
    await new Promise((r) => setTimeout(r, 10));
  }
  eq("the run reported its result",
     el("discover-status-msg").textContent, "Found 2 listings — 2 added.");
  eq("the button was re-enabled", el("discover-run").disabled, false);
  const discovered = (await T().list()).filter((row) => row.status === "saved");
  eq("two Saved cards landed on the board", discovered.length, 2);
  ok("they carry a rating", discovered.every((row) => row.match && row.match.pct >= 0));
  ok("last-run line updated", /2 listings found/.test(el("discover-last-run").textContent));

  console.log("--- a discovered card wears its rating on the board ---");
  store.applications = [
    ...store.applications,
    {
      id: "job_discover_1",
      title: "Backend Engineer",
      company: "Example Co",
      status: "saved",
      url: "https://jobs.example.com/posting/1",
      source: "LinkedIn",
      savedAt: Date.now(),
      updatedAt: Date.now(),
      match: {
        pct: 80,
        stars: 4,
        shortlist: 70,
        reasons: ["exact role match", "covers 3 of 5 skills"],
        scoredAt: Date.now()
      }
    }
  ];
  await vm.runInContext("refresh()", ctx);
  const boardHtml = el("board").innerHTML;
  ok("stars and percentage rendered", boardHtml.includes("★★★★☆ 80%"));
  ok("rating span present", boardHtml.includes('class="rating"'));
  ok("hover breaks down match, shortlist and reasons",
     boardHtml.includes("Match 80% — shortlist chance 70% — exact role match · covers 3 of 5 skills"));
  ok("source labelled", boardHtml.includes(">LinkedIn<"));

  console.log("--- the board ranks jobs by score, best first ---");
  // Recency order and score order are made to disagree on purpose: updatedAt
  // counts down as the rating climbs, so a board that just rendered
  // listByRecency would show these exactly backwards.
  const sortedNow = Date.now();
  const savedJob = (id, updatedAt, match) => ({
    id,
    title: `Role ${id}`,
    company: `Co ${id}`,
    status: "saved",
    url: `https://jobs.example.com/${id}`,
    source: "LinkedIn",
    savedAt: updatedAt,
    updatedAt,
    match
  });
  store.applications = [
    savedJob("manual", sortedNow, undefined),
    savedJob("mid-b", sortedNow - 1, { pct: 70, shortlist: 70 }),
    savedJob("mid-a", sortedNow - 2, { pct: 70, shortlist: 70 }),
    savedJob("ai", sortedNow - 3, { pct: 60, shortlist: 88 }),
    savedJob("low", sortedNow - 4, { pct: 41, shortlist: 41 }),
    savedJob("high", sortedNow - 5, { pct: 95, shortlist: 95 })
  ];
  await vm.runInContext("refresh()", ctx);
  const cardOrder = [...el("board").innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  eq("highest displayed percentage on top", cardOrder[0], "high");
  eq("equal percentages keep the recency order they arrived in (newest first)",
     cardOrder.slice(1, 3), ["mid-b", "mid-a"]);
  eq("a hidden shortlist chance of 88 does not lift a 60% card above the 70s",
     cardOrder[3], "ai");
  eq("low score sinks", cardOrder[4], "low");
  eq("an unrated manual save goes to the bottom", cardOrder[5], "manual");

  console.log("--- auto-run is gated ---");
  // Auto off in settings: re-initialising must not fire a search at all.
  el("discover-status-msg").textContent = "";
  await vm.runInContext("initDiscoverPanel()", ctx);
  eq("auto off means no search on open", el("discover-status-msg").textContent, "");
  // Auto back on, but the boot run wrote a fresh last-run state — the 12h
  // throttle must keep the second open from crawling again.
  store.settings.discoverAuto = true;
  await vm.runInContext("initDiscoverPanel()", ctx);
  eq("throttled inside the interval", el("discover-status-msg").textContent, "");
  eq("settings repopulated the fields on re-init",
     el("discover-roles").value, "Backend Engineer, SRE");

  // ---- credentials are no longer panel state -------------------------------
  // The OAuth client ships in src/data/google-oauth.json and is resolved by
  // gmail.js at connect time. The panel therefore has no client id or secret to
  // render or persist, and connecting must never depend on anything saved here.
  console.log("--- the panel needs no stored credentials ---");
  delete store.settings.gmailClientId;
  delete store.settings.gmailClientSecret;
  await vm.runInContext("initMailPanel()", ctx);
  eq("connect stays enabled on a fresh profile", el("mail-connect").disabled, false);
  eq("no client id is written back into storage", store.settings.gmailClientId, undefined);
  ok("the markup carries no credential fields", !html.includes('id="mail-client-id"'));

  console.log("--- the Naukri profile refresh panel ---");
  // Re-run the init the way the mail section does: the point of the test is
  // that every listener binds to an element the real markup provides, and a
  // listener that vanished with a typo'd id would otherwise pass silently.
  await vm.runInContext("initNaukriPanel()", ctx);
  eq("switch shows the shipped default", el("naukri-enabled").checked, true);
  eq("time shows the shipped default", el("naukri-time").value, "08:00");

  el("naukri-enabled").checked = true;
  el("naukri-time").value = "07:45";
  await el("naukri-save").fire("click");
  eq("refresh enabled stored", store.settings.naukriRefreshEnabled, true);
  eq("refresh time stored", store.settings.naukriRefreshTime, "07:45");
  ok("save confirmed", /^Saved/.test(el("naukri-status-msg").textContent));
  ok("status marked ok", el("naukri-status-msg").className.includes("ok"));
  ok("quotes the saved time", el("naukri-status-msg").textContent.includes("07:45"));

  el("naukri-enabled").checked = false;
  await el("naukri-save").fire("click");
  eq("switch off stored", store.settings.naukriRefreshEnabled, false);
  ok("off is stated plainly", el("naukri-status-msg").textContent.includes("off"));

  // "Refresh now" reports the content script's own outcome verbatim — the
  // button must end re-enabled no matter what the worker answered.
  await el("naukri-run").fire("click");
  ok("run result shown", el("naukri-status-msg").textContent.includes("Done — the resume headline was toggled"));
  ok("status marked ok after the run", el("naukri-status-msg").className.includes("ok"));
  eq("button re-enabled", el("naukri-run").disabled, false);

  // The page-head button runs the identical flow without expanding the panel,
  // so it must bind to a real element and behave the same as "Refresh now".
  el("naukri-panel").open = false;
  await el("update-naukri").fire("click");
  ok("header run reports the same outcome", el("naukri-status-msg").textContent.includes("Done — the resume headline was toggled"));
  eq("header run opened the panel", el("naukri-panel").open, true);
  eq("panel button re-enabled after the header run", el("naukri-run").disabled, false);

  console.log("--- cloud account panel ---");
  // Signed out at boot is the whole panel's default view; the board works
  // without an account, so nothing here may gate it.
  eq("says signed out", el("account-state").textContent, "Signed out");
  eq("sign-in button is shown", el("account-signin").classList.contains("hidden"), false);
  eq("sign-out button is hidden", el("account-signout").classList.contains("hidden"), true);
  // No bundled project on this build: an unset URL/key stays blank rather than
  // silently pointing the sync at a project the user did not choose.
  eq("supabase URL starts blank", el("account-supabase-url").value, "");
  eq("supabase anon key starts blank", el("account-supabase-key").value, "");

  // The panel persists an override into the same settings record the rest of
  // the page reads.
  el("account-supabase-url").value = "https://custom.supabase.co";
  el("account-supabase-key").value = "anon-key-1234567890";
  await el("account-save").fire("click");
  eq("saves the supabase URL", store.settings.supabaseUrl, "https://custom.supabase.co");
  eq("saves the supabase anon key", store.settings.supabaseAnonKey, "anon-key-1234567890");
  ok("acknowledges the save", /Saved/i.test(el("account-status-msg").textContent));

  // Proves the sign-in listener is bound to a real element: the Google flow
  // needs the extension's own Google client (Gmail.resolveCredentials), which
  // this harness does not provide, so the panel reports that rather than
  // silently doing nothing.
  await el("account-signin").fire("click");
  ok("sign-in reports the missing Google client", /Google client|sign-in/i.test(el("account-status-msg").textContent));

  console.log("--- stopping a sync in progress ---");
  // The run is driven through runMailSync directly rather than the button's
  // click listener: the "reopening the dashboard" test above calls
  // initMailPanel() a second time, which (as a real page reload would not in
  // the same context) leaves two click listeners on the button, and firing it
  // would start a second run. Calling the run entry point keeps this test
  // about Stop, not about that listener-accumulation artifact of simulating a
  // reload inside one context.
  //
  // The listing step is held open so the run is genuinely in flight when Stop
  // is pressed — the only way to prove the button is shown during a live run
  // and that pressing it cancels that run rather than a later one. The signal
  // is read after the listing resolves, so the hold alone is determinative.
  const realListAll = ctx.Gmail.listAllMessageIds;
  let releaseList = null;
  ctx.Gmail.listAllMessageIds = () => new Promise((resolve) => { releaseList = () => resolve([]); });

  eq("stop button hidden when idle", el("mail-sync-stop").hidden, true);
  connected = true;
  const pendingRun = vm.runInContext("runMailSync({ force: true, full: true })", ctx);
  const reached = Date.now() + 2000;
  while (!releaseList && Date.now() < reached) await new Promise((r) => setTimeout(r, 5));
  eq("the run reached the read step", !!releaseList, true);
  eq("stop button shown during a run", el("mail-sync-stop").hidden, false);
  eq("read button disabled during a run", el("mail-sync-now").disabled, true);

  await el("mail-sync-stop").fire("click");
  eq("stop disables itself", el("mail-sync-stop").disabled, true);

  releaseList();
  const report = await pendingRun;
  eq("the run reports the stop, not a failure", report.aborted, true);
  eq("the stopped run is still a finished run", report.ok, true);
  eq("stop button hidden again once the run ends", el("mail-sync-stop").hidden, true);
  eq("read button usable again", el("mail-sync-now").disabled, false);
  ok("status reports the stop", /Stopped/i.test(el("mail-status-msg").textContent));
  ctx.Gmail.listAllMessageIds = realListAll;

  process.exitCode = done() ? 1 : 0;
})();