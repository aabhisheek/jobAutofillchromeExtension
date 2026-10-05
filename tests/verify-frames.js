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
  probePageState: () => ({})
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

// ---- scanning a page whose form is in a frame ----

(async () => {
  // An ordinary page with no <iframe> pays nothing for frame support.
  TREE.length = 1;
  HOST.frames = 0;
  samples = 0;
  const plain = await P("readFrames")(1, 500);
  eq("a frame-less page is settled on the first sample", plain.settled, true);
  eq("…without polling for it", samples, 1);

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

  process.exit(done() ? 1 : 0);
})();