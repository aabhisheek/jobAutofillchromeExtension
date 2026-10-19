// Boots the Tailor Resume page (src/resume/resume.html) in a minimal DOM shim
// and checks that the resume PDF the extension has actually becomes the
// tailoring source: read once, converted to LaTeX, stored, and reused — and
// that when there is no resume at all the page says which things it tried
// instead of naming one file that was never the real problem.
//
// The bug this guards: loadPdfJs() never set script.src, so pdf.js never
// loaded, every PDF conversion failed, and "Analyze & Tailor" fell through to
// a resume.tex that does not exist in the extension.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, makeChrome, makeStorage, makeContext, load, expect } = require("./harness");

const html = fs.readFileSync(path.join(ROOT, "src/resume/resume.html"), "utf8");
const { eq, ok, done } = expect("resume-source");

// ---- minimal DOM ----------------------------------------------------------
function makeEl(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    dataset: {},
    style: {},
    children: [],
    _l: {},
    appendChild(child) { el.children.push(child); return child; },
    remove() {},
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
    addEventListener(type, fn) { (el._l[type] = el._l[type] || []).push(fn); }
  };
  return el;
}

// Every id the real markup has, so an element the page code reaches for is
// either there or a loud failure here rather than a silent null in the browser.
const registry = new Map();
for (const [, tag, id] of html.matchAll(/<([a-z0-9]+)[^>]*\sid="([^"]+)"/gi)) registry.set(id, makeEl(tag, id));

// What pdf.js would expose once its bundle has run in the page. Enough of the
// surface extractPdfToTex touches: one page of four positioned text runs.
const fakePdfjsLib = {
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument() {
    return {
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: async () => ({
            items: [
              { str: "Abhishek Anand", transform: [11, 0, 0, 11, 72, 720], width: 90, fontName: "g_d0_f1" },
              { str: "Backend Developer", transform: [11, 0, 0, 11, 72, 706], width: 110, fontName: "g_d0_f1" },
              { str: "EXPERIENCE", transform: [10, 0, 0, 10, 72, 660], width: 70, fontName: "g_d0_f1" },
              { str: "- Built REST APIs in Java", transform: [10, 0, 0, 10, 80, 640], width: 130, fontName: "g_d0_f1" }
            ]
          }),
          cleanup() {}
        }),
        destroy() {}
      })
    };
  }
};

// Script tags the page code inserts (pdf.js and its worker). A tag with no src
// loads nothing — that is the regression — so it is answered with onerror,
// which is what a caller has to cope with when the bundle never arrives.
const appendedScripts = [];
const windowShim = { addEventListener() {} };
const documentShim = {
  getElementById(id) {
    if (!registry.has(id)) throw new Error(`getElementById("${id}") -> null (element missing from resume.html)`);
    return registry.get(id);
  },
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  head: {
    appendChild(script) {
      appendedScripts.push(script);
      const src = script.src || "";
      if (src.endsWith("pdf.min.js")) {
        windowShim.pdfjsLib = fakePdfjsLib;
        if (script.onload) script.onload();
      } else if (src.endsWith("pdf.worker.min.js")) {
        windowShim.pdfjsWorker = {};
        if (script.onload) script.onload();
      } else if (script.onerror) {
        // No src, or an unknown bundle: nothing loads. This is what a caller
        // has to cope with when pdf.js never arrives.
        script.onerror();
      }
    }
  },
  body: makeEl("body"),
  addEventListener() {}
};

// ---- chrome + bundled files ----------------------------------------------
const store = makeStorage();
const bundledSettings = {
  useLLM: false,
  analyticsEnabled: false,
  resumePdfPath: "src/data/go (4) (1).pdf",
  resumeTexPath: "src/data/resume.tex",
  contextFilePath: "src/data/context.md"
};

// resumeTexPath points at a file the extension does not ship, which is exactly
// the state the page has to survive: the .tex fetch 404s, and the PDF is
// whatever storage/settings say.
async function fakeFetch(url) {
  const u = String(url);
  if (u.includes("settings.json")) {
    return { ok: true, status: 200, json: async () => ({ ...bundledSettings }) };
  }
  if (u.endsWith(".tex")) return { ok: false, status: 404, text: async () => "" };
  if (u.endsWith(".pdf")) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  if (u.includes("profile.json")) return { ok: true, status: 200, json: async () => ({}) };
  throw new Error(`unexpected fetch ${u}`);
}

// Stand-ins for the PDF converter, so the source lookup itself is under test
// rather than the parser. Counted on the host side, so a conversion happening
// twice cannot hide behind the context.
const TEX = "\\documentclass[9pt,a4paper]{article}\n\\begin{document}\nAbhishek Anand\n\\end{document}";
let conversions = 0;
async function extractOk() {
  conversions += 1;
  return { tex: TEX, lines: [], warnings: [], stats: { pages: 1, lines: 1, sections: 0, bullets: 0 } };
}
async function extractFails() {
  throw new Error("pdf.js did not finish loading");
}

const chrome = makeChrome({ storage: store, overrides: { fetch: fakeFetch } });
const ctx = makeContext({
  chrome,
  document: documentShim,
  globals: {
    window: windowShim,
    performance,
    File,
    navigator: { clipboard: { writeText: async () => {} } },
    __extractOk: extractOk,
    __extractFails: extractFails
  }
});

// The scripts resume.html loads, in its order. They are the real files: what
// is under test is the shipped wiring, not a copy.
for (const f of [
  "src/lib/schema.js",
  "src/lib/providers.js",
  "src/lib/resume-tailor.js",
  "src/lib/resume-rewriter.js",
  "src/lib/latex-preview.js",
  "src/lib/pdf-extract.js",
  "src/lib/analytics.js",
  "src/resume/resume.js"
]) {
  load(ctx, f);
}

const run = (expr) => vm.runInContext(expr, ctx);
const attempt = async (expr) => {
  try {
    return { ok: true, value: await run(expr) };
  } catch (err) {
    return { ok: false, error: err };
  }
};
const SEED_PDF = () => {
  store.store.resumePdf = {
    base64: btoa("FAKEPDF"),
    filename: "go (4) (1).pdf",
    mimeType: "application/pdf",
    size: 7,
    savedAt: 1
  };
};

async function main() {
  // The page's own startup (settings load + background PDF pickup) is kicked
  // off by resume.js; wait for it so nothing below races it.
  await run("whenSourceReady()");
  await new Promise((resolve) => setTimeout(resolve, 10));

  // ---- 1. pdf.js is really loaded ---------------------------------------
  // The regression: a <script> with no src never brings pdf.js in, so this
  // either fails outright or every downstream source lookup fails.
  const real = await attempt("extractPdfToTex(new Uint8Array([1, 2, 3]).buffer)");
  ok(`extractPdfToTex succeeds (${real.ok ? "ok" : (real.error && real.error.message)})`, real.ok);
  if (real.ok) ok("extracted text is a LaTeX document", /\\begin\{document\}/.test(real.value.tex));

  const script = appendedScripts[0];
  ok("pdf.js script tag was appended", !!script);
  eq(
    "pdf.js script tag has a src",
    script ? script.src : "",
    "chrome-extension://testextensionid/src/lib/vendor/pdf.min.js"
  );

  // ---- 2. the PDF becomes the source, and is stored for next time --------
  conversions = 0;
  run("extractPdfToTex = __extractOk");
  run("overrideSource = null");
  SEED_PDF();

  const first = await attempt("loadResumeText()");
  ok("loadResumeText resolves", first.ok);
  eq("source is the PDF", first.ok && first.value.source, "go (4) (1).pdf (PDF → LaTeX)");
  eq("text is the converted LaTeX", first.ok && first.value.text, TEX);

  // The "text file" the page creates for itself, keyed to the PDF it came from.
  const cached = store.store.resumePdfTex;
  ok("conversion was stored for reuse", !!cached && !!cached.tex);
  eq("stored conversion is keyed to the PDF", cached && cached.pdfKey, "go (4) (1).pdf:7");
  eq("conversion ran once", conversions, 1);

  run("overrideSource = null");
  const second = await attempt("loadResumeText()");
  ok("second run resolves", second.ok);
  eq("second run uses the stored conversion", second.ok && second.value.text, TEX);
  eq("second run did not convert again", conversions, 1);

  // ---- 3. nothing to read at all ----------------------------------------
  store.clear();
  run("overrideSource = null");
  const none = await attempt("loadResumeText()");
  ok("no resume at all rejects", !none.ok);
  const noneMessage = none.ok ? "" : none.error.message;
  ok(`the message says no resume is available: "${noneMessage}"`, /No resume available/.test(noneMessage));
  ok("it names the PDF it tried", /resume PDF:/.test(noneMessage));
  ok("it names the LaTeX file it tried", /LaTeX file:/.test(noneMessage));
  ok("it says how to fix it", /Upload your resume PDF/.test(noneMessage));
  ok("it does not send the user to git", !/git checkout/.test(noneMessage));

  // ---- 4. a PDF that cannot be converted is reported as such ------------
  SEED_PDF();
  run("extractPdfToTex = __extractFails");
  const broken = await attempt("loadResumeText()");
  ok("an unreadable PDF rejects", !broken.ok);
  const brokenMessage = broken.ok ? "" : broken.error.message;
  ok(
    `the message blames the PDF, not a missing file: "${brokenMessage}"`,
    /resume PDF: could not read go \(4\) \(1\)\.pdf: pdf\.js did not finish loading/.test(brokenMessage)
  );
  ok("it still says how to fix it", /Upload your resume PDF/.test(brokenMessage));

  process.exit(done());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
