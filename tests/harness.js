// Shared test harness.
//
// The extension is buildless and dependency-free, so these tests run the real
// source files inside a node `vm` with `chrome.*` stubbed. That keeps them
// honest: they exercise the shipped files, not a copy.
//
// Usage from any test file:
//   const { ROOT, makeChrome, makeContext, load, expect } = require("./harness");
//   const { eq, summary } = expect("mail-import");
//
// Run them all with:  node tests/run.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Resolved relative to this file so the tests survive the repo moving, and
// running from any working directory.
const ROOT = path.resolve(__dirname, "..");

// An in-memory `chrome.storage.local`. `store` is handed back so a test can
// seed or inspect it directly.
function makeStorage(initial) {
  const store = { ...(initial || {}) };
  return {
    store,
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get(key) {
      if (key == null) return Promise.resolve({ ...store });
      if (typeof key === "string") return Promise.resolve({ [key]: store[key] });
      const out = {};
      for (const k of key) out[k] = store[k];
      return Promise.resolve(out);
    },
    set(obj) { Object.assign(store, obj); return Promise.resolve(); },
    remove(key) {
      if (Array.isArray(key)) { for (const k of key) delete store[k]; }
      else delete store[key];
      return Promise.resolve();
    }
  };
}

// A chrome mock covering only what the extension actually calls. `storage` may
// be a makeStorage() result; `overrides` lets a test swap in a fetch stub or a
// connect() flow without rebuilding the rest.
function makeChrome({ storage, overrides } = {}) {
  const s = storage || makeStorage();
  const base = {
    storage: {
      local: s,
      onChanged: { addListener() {} }
    },
    runtime: {
      id: "testextensionid",
      getURL: (p) => `chrome-extension://testextensionid/${p}`,
      getManifest: () => ({ version: "0.2.0" }),
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null
    },
    permissions: { async request() { return true; } },
    identity: {
      // Mirrors Chrome: the optional path is appended to the origin. Honouring the
      // argument matters, because the redirect_uri regression this file guards is
      // entirely about whether a path is present.
      getRedirectURL: (p) => `https://testextensionid.chromiumapp.org/${p || ""}`,
      launchWebAuthFlow: async () => "https://testextensionid.chromiumapp.org/?code=fake"
    },
    alarms: {
      create() {}, clear() {},
      getAll: async () => [],
      onAlarm: { addListener() {} }
    },
    tabs: { async query() { return []; }, async sendMessage() {} },
    fetch: async () => ({ ok: false, status: 500, text: async () => "" })
  };
  return Object.assign(base, overrides || {});
}

// The globals the extension source expects to find. Deliberately an allow-list
// rather than the real global object: if a lib starts using a global that is
// not listed here, the test fails loudly instead of silently depending on
// whatever node happens to expose.
function makeContext(extra = {}) {
  return vm.createContext({
    chrome: extra.chrome || makeChrome(),
    console,
    atob, btoa,
    TextDecoder, TextEncoder, Uint8Array,
    URL, URLSearchParams,
    fetch: (extra.chrome || makeChrome()).fetch,
    crypto,
    // `document` is opt-in and deliberately not defaulted to a stub. A lib that
    // reaches for the DOM must fail loudly here: src/lib/gmail.js runs in the
    // service worker, where `document` is genuinely undefined, and a test that
    // quietly supplied one would hide exactly that class of bug.
    ...(extra.document === undefined ? {} : { document: extra.document }),
    setTimeout, clearTimeout,
    Date, Math, JSON, RegExp,
    String, Number, Boolean, Object, Array, Promise, Error, Map, Set,
    ...extra.globals
  });
}

// Load one repo file into a context as if it were a <script> tag.
function load(ctx, relativePath) {
  const abs = path.join(ROOT, relativePath);
  vm.runInContext(fs.readFileSync(abs, "utf8"), ctx, { filename: relativePath });
  return ctx;
}

// Load several, in order.
function loadAll(ctx, relativePaths) {
  relativePaths.forEach((p) => load(ctx, p));
  return ctx;
}

// Pull values out of a context. Top-level `const` lives in the context's
// global lexical scope rather than on the sandbox object, so the names have to
// be evaluated as an expression.
function take(ctx, namesExpr) {
  return vm.runInContext(namesExpr, ctx);
}

// Assertion counters plus the summary line. Returns { eq, ok, done }.
function expect(name) {
  let pass = 0;
  let fail = 0;

  const eq = (label, got, want) => {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (same) {
      pass += 1;
      return true;
    }
    fail += 1;
    console.log(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
    return false;
  };

  const ok = (label, value) => eq(label, !!value, true);

  const done = () => {
    const line = `${name}: ${pass} passed, ${fail} failed`;
    console.log(line);
    return fail;
  };

  return { eq, ok, done, counts: () => ({ pass, fail }) };
}

module.exports = { ROOT, makeStorage, makeChrome, makeContext, load, loadAll, take, expect };
