// Cross-origin form frames.
//
// The bug this covers: chargepoint.com serves a careers page whose entire
// content is an <iframe> pointing at job-boards.greenhouse.io. The scan used to
// read only the top document, found none of the application's fields, and
// reported it as a page that was still rendering — six rescans, then "0 fields
// found" with the real cause mentioned only in passing.
//
// popup.js cannot be loaded whole (it renders into a DOM on import), so the
// FRAMES section is lifted out of it the way verify-alarm.js lifts the
// scheduling helpers out of background.js. describeFrames comes out of
// page-scripts.js the same way and is run against a stub document, so the
// shipped source is what is under test.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, expect } = require("./harness");

// ---- describeFrames, run against a stub document ----

const pageScripts = fs.readFileSync(path.join(ROOT, "src/lib/page-scripts.js"), "utf8");
const describeSrc = pageScripts.slice(
  pageScripts.indexOf("function describeFrames()"),
  pageScripts.indexOf("// ============================================================\n// WAIT FOR FORM READY")
);

// document.querySelectorAll returns whatever the stub hands back, and
// window.top === window is how the function recognizes the top document.
const makeFrameCtx = ({ controls, frames, origin, isTop }) => {
  const doc = {
    readyState: "complete",
    querySelectorAll: (selector) => (selector.includes("iframe") ? frames : controls)
  };
  // An opaque-origin frame (a sandboxed embed) can throw on access rather than
  // return "null", which is what the try/catch in describeFrames is there for.
  const location = origin === "throw"
    ? { get origin() { throw new Error("blocked"); } }
    : { origin };
  const win = {};
  const ctx = vm.createContext({ document: doc, location, window: win, console });
  win.top = isTop ? win : {};
  vm.runInContext(describeSrc, ctx, { filename: "describeFrames" });
  return vm.runInContext("describeFrames", ctx)();
};

const { eq, ok, done } = expect("frames");

const embedded = makeFrameCtx({
  controls: [1, 2, 3],
  frames: [1],
  origin: "https://job-boards.greenhouse.io",
  isTop: false
});

eq("counts controls and nested frames", {
  controls: embedded.controls,
  frames: embedded.frames,
  top: embedded.top,
  origin: embedded.origin
}, { controls: 3, frames: 1, top: false, origin: "https://job-boards.greenhouse.io" });

ok("the top document reports itself as top", makeFrameCtx({
  controls: [],
  frames: [],
  origin: "https://chargepoint.com",
  isTop: true
}).top === true);

ok("a nested frame does not", makeFrameCtx({
  controls: [],
  frames: [],
  origin: "https://job-boards.greenhouse.io",
  isTop: false
}).top === false);

eq("an unreadable origin is null, not a crash", makeFrameCtx({
  controls: [],
  frames: [],
  origin: "throw",
  isTop: false
}).origin, null);

// ---- shadow DOM: the scanner's blind spot on SmartRecruiters ----
//
// SmartRecruiters builds its application form from custom elements whose real
// inputs live in multi-layered shadow roots — one component nested inside
// another — while the <label>s sit in the light DOM beside the outermost
// host. document.querySelectorAll sees none of it, which is how the scan used
// to report "0 fields found" on pages that plainly have a form.
//
// The fixture is that exact shape: a light input labelled the ordinary way, a
// two-layer shadow input labelled through the outer host's `label` attribute,
// a two-layer shadow input whose label is a light-DOM <label for> pointing at
// the outer host's id, and a type=hidden input two layers deep carrying a
// stale stamp (the clear pass has to reach it too).

function makeShadowFixture() {
  // A query scope: the document for light DOM, a shadow root otherwise.
  const makeScope = (props = {}) => {
    const scope = {
      _isRoot: true,
      _all: [],
      readyState: "complete",
      host: props.host || null,
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { return this._all.filter((node) => match(node, sel)); },
      getElementById(id) { return this._all.find((node) => node.getAttribute("id") === id) || null; }
    };
    if (props.host) props.host.shadowRoot = scope;
    return scope;
  };

  // Only the selectors the scanner's basic path uses. Anything the fixture
  // never matches (choice groups, ARIA custom controls) is meant to find
  // nothing here, so a plain `false` is the honest answer.
  function matchOne(node, sel) {
    if (sel === "*") return true;
    const labelFor = /^label\[for="(.*)"\]$/.exec(sel);
    if (labelFor) return node.tagName === "LABEL" && node.getAttribute("for") === labelFor[1];
    if (sel === "[data-autofill-uid]") return node.hasAttribute("data-autofill-uid");
    const stamped = /^\[data-autofill-uid="(.*)"\]$/.exec(sel);
    if (stamped) return node.getAttribute("data-autofill-uid") === stamped[1];
    if (/^[a-z]+$/.test(sel)) return node.tagName.toLowerCase() === sel;
    return false;
  }
  function match(node, selector) {
    return String(selector).split(",").some((sel) => matchOne(node, sel.trim()));
  }

  const documentStub = makeScope();
  documentStub.body = { innerText: "x".repeat(300) };

  const makeEl = (tag, attrs = {}, props = {}) => ({
    tagName: tag.toUpperCase(),
    _attrs: { ...attrs },
    _root: props.root || documentStub,
    _style: props.style || { display: "block", visibility: "visible" },
    parentElement: props.parentElement || null,
    shadowRoot: null,
    textContent: props.textContent || "",
    offsetParent: "offsetParent" in props ? props.offsetParent : {},
    offsetWidth: "offsetWidth" in props ? props.offsetWidth : 10,
    offsetHeight: "offsetHeight" in props ? props.offsetHeight : 10,
    isConnected: true,
    get id() { return this._attrs.id || ""; },
    get placeholder() { return this._attrs.placeholder || ""; },
    get name() { return this._attrs.name || ""; },
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return n in this._attrs; },
    removeAttribute(n) { delete this._attrs[n]; },
    matches(sel) { return match(this, sel); },
    closest(sel) {
      let node = this;
      while (node) {
        if (match(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(sel) { return this._root.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return this._root.querySelectorAll(sel); },
    getRootNode() { return this._root; }
  });

  // Field 1: ordinary light-DOM input with a <label for>.
  const lightEmail = makeEl("input", { type: "text", id: "email1" }, { root: documentStub });
  const labelEmail = makeEl("label", { for: "email1" }, { root: documentStub, textContent: "Email Address" });

  // Field 2: two shadow layers; the label is an attribute on the outer host.
  const hostA = makeEl("spl-input", { label: "First Name*" }, { root: documentStub });
  const shadowA = makeScope({ host: hostA });
  const hostB = makeEl("spl-internal", {}, { root: shadowA });
  const shadowB = makeScope({ host: hostB });
  const first = makeEl("input", { type: "text" }, {
    root: shadowB,
    offsetParent: null, offsetWidth: 0, offsetHeight: 0
  });
  const hidden = makeEl("input", { type: "hidden" }, {
    root: shadowB,
    offsetParent: null, offsetWidth: 0, offsetHeight: 0
  });
  shadowA._all = [hostB];
  shadowB._all = [first, hidden];

  // Field 3: two shadow layers; the label is a light-DOM <label for> naming
  // the outer host's id — the component copies the id onto its inner input.
  const hostC = makeEl("oc-input", { id: "phoneField" }, { root: documentStub });
  const shadowC = makeScope({ host: hostC });
  const phone = makeEl("input", { type: "text" }, {
    root: shadowC,
    style: { display: "none", visibility: "visible" }
  });
  shadowC._all = [phone];
  const labelPhone = makeEl("label", { for: "phoneField" }, { root: documentStub, textContent: "Phone Number" });

  documentStub._all = [lightEmail, labelEmail, hostA, hostC, labelPhone];

  return {
    document: documentStub,
    lightEmail, labelEmail, hostA, first, hidden, phone
  };
}

const fixture = makeShadowFixture();

// describeFrames reads counts, not contents — but a count that cannot see the
// shadow inputs is what made every SmartRecruiters page look like it was still
// rendering, so the count has to pierce too.
const shadowFrameCtx = vm.createContext({
  document: fixture.document,
  location: { origin: "https://jobs.smartrecruiters.com" },
  window: {},
  console
});
shadowFrameCtx.window.top = shadowFrameCtx.window;
vm.runInContext(describeSrc, shadowFrameCtx, { filename: "describeFrames-shadow" });
const shadowDesc = vm.runInContext("describeFrames", shadowFrameCtx)();

eq("describeFrames counts controls inside shadow roots", shadowDesc.controls, 4);
eq("the top document still reports as top", shadowDesc.top, true);
eq("and the fixture has no iframes to count", shadowDesc.frames, 0);

// ---- every injected entry point carries the same shadow-piercing helper ----
//
// scanFormFields, describeFrames, waitForFormReady, probePageState,
// fillFormFields, highlightReviewFields, fillResumeFile, fillResumeByDrop and
// advanceStep are serialized one function at a time, so each carries its own
// copy of querySelectorDeep. Copies that drift would fix one path and leave
// the others blind, so they are compared byte for byte.
const helperCopies = [];
for (
  let at = pageScripts.indexOf("function querySelectorDeep(selector) {");
  at !== -1;
  at = pageScripts.indexOf("function querySelectorDeep(selector) {", at + 1)
) {
  let depth = 0;
  let end = -1;
  for (let i = pageScripts.indexOf("{", at); i < pageScripts.length; i++) {
    if (pageScripts[i] === "{") depth += 1;
    else if (pageScripts[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  helperCopies.push(pageScripts.slice(at, end));
}

eq("nine copies of querySelectorDeep ship", helperCopies.length, 9);
ok("and every copy is byte-identical", helperCopies.every((copy) => copy === helperCopies[0]));

// ---- The popup's frame plumbing, over a fake tab ----

const popup = fs.readFileSync(path.join(ROOT, "src/popup/popup.js"), "utf8");
const section = popup.slice(
  popup.indexOf("function frameTarget("),
  popup.indexOf("// The scan is not ready to be trusted")
);

// The employer's careers page: generic adapter, and the only inputs on it are
// the site's own navigation.
const HOST = {
  frameId: 0,
  top: true,
  origin: "https://chargepoint.com",
  readyState: "complete",
  controls: 2,
  frames: 1,
  fields: [
    { uid: "af-0", label: "Enter a location", tagName: "input", inputType: "text" },
    { uid: "af-1", label: "Search", tagName: "input", inputType: "search" }
  ]
};

// The application, in a cross-origin frame on the Greenhouse board.
const FORM = {
  frameId: 3,
  top: false,
  origin: "https://job-boards.greenhouse.io",
  readyState: "complete",
  controls: 12,
  frames: 0,
  fields: [
    { uid: "af-0", label: "First Name", tagName: "input", inputType: "text" },
    { uid: "af-1", label: "Email Address", tagName: "input", inputType: "email" },
    { uid: "af-2", label: "Resume", tagName: "input", inputType: "file" }
  ]
};

const TREE = [HOST, FORM];

// Frame ids the fake tab refuses to let us read, standing in for a sandboxed or
// opaque-origin frame.
const unreadable = new Set();
let samples = 0;

const atsVendor = (url) => (/greenhouse/.test(url || "") ? "greenhouse" : "other");

// The page-side functions popup.js names in its injections, stubbed here so the
// fake tab can tell them apart.
const injected = {
  describeFrames: () => ({}),
  waitForFormReady: () => ({}),
  scanFormFields: () => ({}),
  probePageState: () => ({}),
  // Clears the review highlight. A scan injects it into every previously-known
  // frame before reading them, so a frame that has gone away rejects that
  // injection — which is the branch this stub exists to keep from being a crash.
  highlightReviewFields: () => ({ marked: 0, labels: [] })
};

const chrome = {
  scripting: {
    executeScript: async ({ target, func }) => {
      const wanted = target.allFrames
        ? TREE
        : TREE.filter((f) => f.frameId === (target.frameIds || [0])[0]);

      if (!wanted.length) throw new Error("Cannot access contents of the page");

      if (func === injected.describeFrames) {
        samples += 1;
        return wanted.map((f) => ({ frameId: f.frameId, result: { ...f, fields: undefined } }));
      }
      if (func === injected.waitForFormReady) return wanted.map(() => ({ result: { settled: true } }));
      if (func === injected.scanFormFields) {
        // An unreadable frame rejects the whole injection for that frame only.
        if (wanted.some((f) => unreadable.has(f.frameId))) {
          throw new Error("Cannot access contents of the page");
        }
        return wanted.map((f) => ({ result: f.fields }));
      }
      return wanted.map(() => ({ result: {} }));
    }
  }
};

// The Greenhouse adapter declares a value override, so which adapter a field was
// matched with is visible in the merged rows.
const OVERRIDE = { "answers.email": "greenhouse@example.com" };

const ctx = vm.createContext({
  chrome,
  console,
  Date,
  JSON,
  setTimeout,
  clearTimeout,
  describeFrames: injected.describeFrames,
  waitForFormReady: injected.waitForFormReady,
  scanFormFields: injected.scanFormFields,
  probePageState: injected.probePageState,
  highlightReviewFields: injected.highlightReviewFields,
  atsVendor,
  currentAdapter: { id: "generic", pageConfig: { tag: "generic" } },
  AtsRegistry: {
    resolve: (origin) => (atsVendor(origin) === "greenhouse"
      ? { id: "greenhouse", pageConfig: { tag: "greenhouse", valueOverrides: OVERRIDE } }
      : { id: "generic", pageConfig: { tag: "generic" } })
  },
  currentProfile: {},
  currentFrames: [],
  currentScanSettled: true,
  currentScannedFields: null,
  currentMatchedRows: null,
  learnedRules: () => [],
  matchFields: (fields) => fields.map((f) => ({
    uid: f.uid,
    label: f.label,
    tagName: f.tagName,
    inputType: f.inputType,
    options: [],
    value: "from-profile",
    matchedPath: "answers.email",
    accepts: [],
    status: "auto",
    include: true
  }))
});

vm.runInContext(section, ctx, { filename: "popup-frames" });

const P = (expr) => vm.runInContext(expr, ctx);

// ---- uids: page uids repeat per frame, the panel's must not ----

eq("a field's uid carries its frame", P("frameUid(3, 'af-2')"), "f3-af-2");
eq("splitting it gives both halves back", P("splitFrameUid('f3-af-2')"), { frameId: 3, uid: "af-2" });
eq("an unqualified uid reads as the top frame", P("splitFrameUid('af-2')"), { frameId: 0, uid: "af-2" });

// ---- settling ----

const settledWith = (frames, stable) => P(`framesAreSettled(${JSON.stringify(frames)}, ${stable})`);
const F = (extra = {}) => ({ frameId: 0, top: true, readyState: "complete", controls: 0, frames: 0, ...extra });

eq("one frame, held still: settled", settledWith([F()], 2), true);
eq("one frame, one sample: not yet", settledWith([F()], 1), false);
eq("a frame still parsing: not settled", settledWith([F(), { frameId: 1, readyState: "loading" }], 2), false);
eq("a frame that has not reported: not settled", settledWith([F({ frames: 1 })], 2), false);
eq("every frame reporting and still: settled", settledWith([F({ frames: 1 }), { frameId: 1 }], 2), true);

// A frame the tree declares that never reports — an about:blank widget frame
// like the LinkedIn apply button's on a SmartRecruiters page — used to hold
// readFrames to its full deadline and then hand back "not settled", which sent
// the scan into six rescans of a page whose answer was not going to change.
eq("a fresh shortfall is not yet settled", settledWith([F({ frames: 1 })], 6), false);
eq("…but the same shortfall has settled once it holds still", settledWith([F({ frames: 1 })], 7), true);
eq("a frame still parsing blocks however stable the rest is", settledWith([
  F({ frames: 1 }),
  { frameId: 1, readyState: "loading" }
], 9), false);

// ---- scanning a page whose form is in a frame ----

(async () => {
  // An ordinary page with no <iframe> pays nothing for frame support.
  TREE.length = 1;
  HOST.frames = 0;
  samples = 0;
  const plain = await P("readFrames")(1, 500);
  eq("a frame-less page is settled on the first sample", plain.settled, true);
  eq("…without polling for it", samples, 1);

  // A frame the tree declares that never reports: bounded by stability, not
  // by the deadline — ~7 polls instead of the full timeout, and the verdict
  // is "settled" rather than "still rendering".
  HOST.frames = 1;
  samples = 0;
  const shortfall = await P("readFrames")(1, 5000);
  eq("a permanent shortfall settles", shortfall.settled, true);
  eq("after a bounded number of polls, not the deadline", samples >= 8 && samples <= 9, true);

  HOST.frames = 1;
  TREE.push(FORM);

  const rows = await P("scanCurrentTab")(42);
  const uids = rows.map((r) => r.uid);

  eq("fields from the frame and the page are both returned", uids.sort(), [
    "f0-af-0", "f0-af-1", "f3-af-0", "f3-af-1", "f3-af-2"
  ]);
  eq("two frames numbering from af-0 do not collide", new Set(uids).size, uids.length);

  // The page's own fields keep the profile's value; the form frame's are
  // rewritten by the Greenhouse adapter's override, which is only reachable if
  // each frame was matched with its own adapter rather than the host page's.
  eq("each frame is matched (and overridden) with its own adapter", rows.map((r) => r.value), [
    "from-profile",
    "from-profile",
    "greenhouse@example.com",
    "greenhouse@example.com",
    "greenhouse@example.com"
  ]);
  eq("the scan is reported settled", P("currentScanSettled"), true);
  eq("each frame is recorded with its contribution", P("currentFrames.map(f => [f.frameId, f.adapter.id, f.fieldCount])"), [
    [0, "generic", 2],
    [3, "greenhouse", 3]
  ]);
  eq("a fill is routed to the frame that scanned it", P("pageConfigForFrame(3).tag"), "greenhouse");
  eq("an unknown frame falls back to the tab's adapter", P("pageConfigForFrame(99).tag"), "generic");

  const probe = await P("probeCurrentTab")(42);
  eq("the probe reads every frame", probe.frames, { scanned: 2, read: 2, loading: 0 });

  // A frame that cannot be read must not cost the fields in the ones that can.
  unreadable.add(3);
  const partial = await P("scanCurrentTab")(42);
  eq("an unreadable frame is skipped, the rest still scanned", partial.map((r) => r.uid), ["f0-af-0", "f0-af-1"]);
  eq("…but it is still listed, so the message can name it", P("currentFrames.map(f => f.fieldCount)"), [2, 0]);

  // Nothing readable at all is still an error, as before frames existed.
  unreadable.add(0);
  let threw = null;
  try {
    await P("scanCurrentTab")(42);
  } catch (err) {
    threw = err;
  }
  ok("an unreadable page throws rather than reporting 0 fields", threw && /Cannot access/.test(threw.message));

  // ---- the real scanner against the SmartRecruiters-shaped shadow page ----
  //
  // Everything above runs stubs; this runs the shipped scanFormFields() and
  // probePageState() against the shadow fixture built earlier, end to end.
  const scanSrc = pageScripts.slice(
    pageScripts.indexOf("function scanFormFields"),
    pageScripts.indexOf("function describeFrames()")
  );
  const probeSrc = pageScripts.slice(
    pageScripts.indexOf("function probePageState"),
    pageScripts.indexOf("async function fillFormFields(payload")
  );

  const scanCtx = vm.createContext({
    document: fixture.document,
    window: { getComputedStyle: (node) => node._style },
    CSS: { escape: (value) => String(value) },
    location: { href: "https://jobs.smartrecruiters.com/oneclick-ui/x", origin: "https://jobs.smartrecruiters.com" },
    console
  });
  vm.runInContext(`${scanSrc}\n${probeSrc}`, scanCtx, { filename: "scan-shadow" });

  const fields = vm.runInContext('scanFormFields({})', scanCtx);
  eq("the shadow form is read: three fields", fields.map((f) => f.label), [
    "Email Address",
    "First Name",
    "Phone Number"
  ]);
  eq("uid numbering is stable", fields.map((f) => f.uid), ["af-0", "af-1", "af-2"]);
  ok("the shadow input is stamped where the fill will look for it",
    fixture.first.hasAttribute("data-autofill-uid"));

  // A stale stamp on a control the scanner skips (type=hidden) must still be
  // cleared: the clear pass has to reach inside the shadow root, or a second
  // scan would read the stale uid as "already handled" and drop the field.
  fixture.hidden.setAttribute("data-autofill-uid", "stale-99");
  const again = vm.runInContext('scanFormFields({})', scanCtx);
  eq("a second scan re-reads the same three fields", again.length, 3);
  ok("and clears a stale stamp buried two shadow layers deep",
    !fixture.hidden.hasAttribute("data-autofill-uid"));

  const shadowProbe = vm.runInContext('probePageState({})', scanCtx);
  eq("the probe counts controls inside shadow roots", shadowProbe.total, 4);
  eq("…and reads them as visible through their hosts", shadowProbe.visible, 4);

  process.exit(done() ? 1 : 0);
})();