// Loads the extension's plain-script sources into an isolated realm so they can
// be exercised from tests.
//
// Why this exists, and why it is not "just import the file":
//
// Every file in src/ is a classic <script>. It declares top-level `const` and
// `function` and expects to see them as globals, with load order supplied by the
// <script> tags in the page's HTML. There is no module graph, so `import` cannot
// express the dependency ("matcher.js uses FIELD_DICTIONARY from schema.js") and
// would give each file its own scope, breaking exactly the behavior under test.
//
// node:vm reproduces the browser's semantics instead: one shared context per page,
// scripts evaluated in order, top-level `const` landing in the context's global
// lexical scope (visible to later scripts, invisible from outside) and duplicate
// `function` declarations silently overwriting. That last property is worth
// having, because two extension scripts really do declare the same function name
// (requiredOrigins() exists in both providers.js and gmail.js) and the browser
// resolves it the same way this does.
//
// Nothing here reaches the network, reads the user's real profile, or writes to
// disk outside the fixtures.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * The browser/extension globals the sources touch, as cheap stand-ins.
 *
 * The point is that a test can *fail loudly* if a module reaches for something
 * here that it should not: fetch and chrome.* are strict spies rather than
 * permissive no-ops, so a test that forgets to stub them sees an obvious error
 * instead of a silent pass.
 */
function baseSandbox({ fetchImpl } = {}) {
  const noStorage = async () => {
    throw new Error("chrome.storage.local called without a test double");
  };

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    Date,
    Math,
    JSON,
    Promise,
    // btoa/atob operate on binary strings in the browser; Buffer gives the same
    // byte-for-byte behaviour for the ASCII paths these sources use.
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error("fetch called without a test double");
      }),
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://testextensionid/${String(p).replace(/^\/+/, "")}`,
        sendMessage: async () => undefined,
        onMessage: { addListener() {}, removeListener() {} },
        lastError: null
      },
      storage: {
        local: { get: noStorage, set: noStorage, remove: noStorage, clear: noStorage },
        onChanged: { addListener() {}, removeListener() {} }
      },
      tabs: {
        query: async () => [],
        sendMessage: async () => undefined,
        create: () => undefined,
        onUpdated: { addListener() {} }
      },
      scripting: {
        executeScript: async () => [],
        insertCSS: async () => undefined
      },
      sidePanel: { setOptions: async () => undefined, open: async () => undefined },
      alarms: {
        create() {},
        clear: async () => true,
        onAlarm: { addListener() {} }
      },
      identity: { getRedirectURL: (p) => `https://testextensionid.chromiumapp.org/${p || ""}` },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      i18n: { getMessage: (k) => k },
      permissions: { contains: async () => false, request: async () => false }
    }
  };

  return sandbox;
}

/**
 * A fake chrome.storage.local backed by a plain object, with optional hooks so a
 * test can simulate a failing or unavailable storage area.
 *
 * The get/set shapes mimic the real callback-and-promise hybrid loosely enough for
 * these sources, which only ever `await` them.
 */
export function memoryStorage(initial = {}, { failOn = [] } = {}) {
  const data = { ...initial };
  const guard = (op) => {
    if (failOn.includes(op)) throw new Error(`storage.${op} failed`);
  };
  return {
    data,
    get(keys) {
      guard("get");
      if (keys == null) return Promise.resolve({ ...data });
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return Promise.resolve(out);
    },
    set(items) {
      guard("set");
      Object.assign(data, structuredClone(items));
      return Promise.resolve();
    },
    remove(keys) {
      guard("remove");
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      return Promise.resolve();
    },
    clear() {
      guard("clear");
      for (const k of Object.keys(data)) delete data[k];
      return Promise.resolve();
    }
  };
}

/**
 * Evaluates a list of extension source files into one shared realm, then reads the
 * named globals back out.
 *
 * `names` are collected by a trailing script evaluated *inside* the context, which
 * is the only way to see top-level `const`/`class` bindings — they are not
 * properties of the global object.
 *
 * @param {string[]} files      repo-relative paths, in the order the page loads them
 * @param {string[]} names      globals to read back out of the realm
 * @param {object}   [options]  { fetchImpl, storage, sandbox }
 */
export function loadFiles(files, names, options = {}) {
  const sandbox = { ...baseSandbox(options), ...(options.sandbox || {}) };

  if (options.storage) {
    sandbox.chrome.storage.local = options.storage;
  }

  vm.createContext(sandbox);

  // Inside the realm, window/self are the global object, as in a browser. Done
  // with a script rather than as sandbox properties so they refer to the
  // contextified global rather than to the raw sandbox object.
  vm.runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", sandbox);

  for (const file of files) {
    const code = readSource(file);
    try {
      vm.runInContext(code, sandbox, { filename: file, displayErrors: true });
    } catch (err) {
      err.message = `while loading ${file}: ${err.message}`;
      throw err;
    }
  }

  if (!names.length) return {};

  // Read the requested bindings back out. This has to run *inside* the context:
  // top-level `const`/`class` declarations live in the global lexical
  // environment, which is not an object this realm can enumerate from outside.
  // The typeof guard turns a name the module no longer declares into a clean
  // `undefined` that fails as an assertion, instead of a ReferenceError thrown
  // from here and reported against the collector.
  const collected = {};
  for (const name of names) {
    collected[name] = vm.runInContext(
      `typeof ${name} === "undefined" ? undefined : ${name}`,
      sandbox,
      { filename: `<collect ${name}>` }
    );
  }
  return collected;
}

/**
 * Loads one library and returns the named globals.
 *
 * `loadLib("matcher.js", ["normalizeLabel"])` — `lib/` is implied, and the real
 * dependency (schema.js, which defines FIELD_DICTIONARY) is loaded first because
 * every matcher entry point dereferences it.
 */
const LIB_DEPS = {
  "matcher.js": ["schema.js"],
  "learned.js": ["schema.js", "matcher.js"],
  "draft.js": ["schema.js", "matcher.js"],
  "resume-tailor.js": ["schema.js", "providers.js"],
  "mail-import.js": ["schema.js", "providers.js", "tracker.js"],
  "discover.js": ["schema.js", "providers.js", "tracker.js", "mail-import.js", "resume-tailor.js", "page-scripts.js"],
  "registry.js": [
    "generic.js",
    "workday.js",
    "linkedin.js",
    "greenhouse.js",
    "lever.js",
    "google-forms.js"
  ]
};

function expandLib(libName) {
  const ats = libName === "registry.js";
  const dir = ats ? "src/lib/ats/" : "src/lib/";
  const deps = LIB_DEPS[libName] || [];
  // registry.js's dependencies are sibling adapters in ats/, not src/lib files.
  const prefixed = ats ? deps : deps.map((d) => "src/lib/" + d);
  return [...prefixed, dir + libName];
}

export function loadLib(libName, names, options = {}) {
  return loadFiles(expandLib(libName), names, options);
}

/**
 * Loads a page's full script list, exactly as its <script> tags declare, so a
 * load-order or redeclaration regression shows up as a test failure rather than a
 * blank screen in Chrome.
 */
export function loadPage(pageName, names = [], options = {}) {
  const html = fs.readFileSync(path.join(ROOT, "src", pageName, `${pageName}.html`), "utf8");
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) =>
    path.posix.normalize(path.posix.join(`src/${pageName}`, m[1]))
  );
  return { sources: srcs, exports: loadFiles(srcs, names, options) };
}
