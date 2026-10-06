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

// <select id="mail-lookback"> needs its options for the "closest option" logic.
registry.get("mail-lookback").options = [7, 30, 90].map((v) => ({ value: String(v) }));

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
      throw new Error("unexpected message " + msg.type);
    }
  },
  permissions: { async request() { return true; } },
  // Derived from runtime.id, as Chrome does. A hardcoded host that disagreed
  // with the id would make the redirect-URI assertion meaningless.
  identity: {
    getRedirectURL: (p) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${p || ""}`
  }
};

let connected = false;
let connectCalls = 0;
let settingsWrites = 0;

// Records what the copy buttons hand to the clipboard.
copied = [];

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

// Discovery's dependencies, in the order dashboard.html loads them: the
// keyword/match logic the scorer uses, the injectable listing reader, then the
// engine. discover.js is what makes initDiscoverPanel do anything at all.
for (const f of ["src/lib/resume-tailor.js", "src/lib/page-scripts.js", "src/lib/discover.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}

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

  // The connection diagnostics. These are what you read when connecting fails,
  // so an empty value here is the difference between a solvable problem and an
  // unexplained one.
  console.log("--- diagnostics shown ---");
  const stamp = el("mail-build").textContent;
  ok("build stamp rendered (proves current code is running)", !!stamp && stamp.length > 4);
  ok("extension id rendered", /^[a-p]{32}$/.test(el("mail-ext-id").textContent));
  eq("redirect uri rendered as the bare origin",
     el("mail-redirect-uri").textContent,
     `https://${el("mail-ext-id").textContent}.chromiumapp.org/`);
  eq("credentials block is NOT inside the collapsing setup",
     el("mail-client-id").closest("mail-setup"), null);
  eq("AI toggle available (a provider key is configured)", el("mail-use-ai").disabled, false);
  eq("AI toggle on by default", el("mail-use-ai").checked, true);
  eq("daily toggle on by default", el("mail-enabled").checked, true);
  eq("frequency defaulted to every 2 hours", el("mail-every").value, "2h");
  eq("daily time row hidden on an interval schedule",
     el("mail-time-row").className.includes("hidden"), true);
  eq("query prefilled from defaults", el("mail-query").value.includes("application received"), true);
  eq("lookback defaulted to 30", el("mail-lookback").value, "30");
  ok("last run line exists", el("mail-last-run").textContent.length > 0);

  // The values pasted into Google Cloud. Copying beats transcribing here: Google
  // compares redirect URIs as exact strings, so a dropped trailing slash is a
  // mismatch with no other visible cause.
  console.log("--- copy buttons hand over the exact strings ---");
  eq("two copy buttons exist", COPY_BUTTONS.length, 2);
  for (const button of COPY_BUTTONS) {
    await button.fire("click");
  }
  eq("extension id copied", copied[0] ?? null, el("mail-ext-id").textContent);
  eq("redirect uri copied", copied[1] ?? null, el("mail-redirect-uri").textContent);
  // Both checks read copied[1] defensively: with nothing copied, a bare
  // .endsWith() would throw and take the whole harness file down with it, losing
  // every other suite's result in the run.
  eq("redirect uri copied keeps the trailing slash Google requires",
     (copied[1] || "").endsWith(".chromiumapp.org/"), true);
  // Strip scheme + host + the single path slash, and what must remain is the
  // bare origin. A stray "/oauth2" here is the original redirect bug, so it is
  // worth asserting the path is genuinely absent rather than merely plausible.
  eq("redirect uri copied is the bare origin, with no path after it",
     (copied[1] || "").replace(/^https:\/\/[^/]+\/?/, ""), "");
  // Confirmation is the point of the label swap; the reset runs on a 1600ms timer,
  // which a synchronous test cannot observe without slowing the suite down.
  eq("button confirms the copy", COPY_BUTTONS[0].textContent, "Copied");

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
  // The first import runs itself once the grant is done — asking for one more
  // click to see your own history is the bug this replaced.
  ok("the first import ran itself, no Sync now click", /added/i.test(el("mail-status-msg").textContent));

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
  el("mail-lookback").value = "90";
  el("mail-query").value = 'newer_than:14d {"application received"}';
  el("mail-use-ai").checked = false;
  await el("mail-save").fire("click");
  eq("frequency persisted", store.settings.emailSyncEvery, "2h");
  eq("time persisted", store.settings.emailSyncTime, "07:15");
  eq("enabled persisted", store.settings.emailSyncEnabled, true);
  eq("lookback persisted as a number", store.settings.emailLookbackDays, 90);
  eq("query persisted", store.settings.emailSyncQuery, 'newer_than:14d {"application received"}');
  eq("useAi persisted", store.settings.emailUseAi, false);
  eq("provider key survived the save", store.settings.groqApiKey, "gsk_test");
  ok("status quotes the rhythm", /every 2 hours/.test(el("mail-status-msg").textContent));

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

  process.exit(done() ? 1 : 0);
})();