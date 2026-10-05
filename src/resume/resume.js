const BUNDLED_PROFILE_URL = chrome.runtime.getURL("src/data/profile.json");
const BUNDLED_SETTINGS_URL = chrome.runtime.getURL("src/data/settings.json");

let latestResult = null;

// The resume this page is working on, when the user supplied it themselves: a PDF
// converted to LaTeX, or a .tex they picked/pasted. { kind, text, label }.
// Kept in memory only — it is a scratch source, not a replacement for the bundled
// default, so nothing is written to storage and "Download Tailored .tex" is how it
// becomes permanent.
let overrideSource = null;

// Resolves once the startup PDF conversion has settled (see whenSourceReady).
let sourceReady = null;

// Which conversion is still wanted: the newest one started wins.
let pdfConvertSeq = 0;

Analytics.init("resume");

// Fetched once and shared: the tailoring run and the PDF status line both need
// the merged settings, and two concurrent fetches of the same bundled file (plus
// a second storage read) is how the two halves of this page end up disagreeing
// about which files are configured.
const settingsReady = (async () => {
  try {
    const res = await fetch(BUNDLED_SETTINGS_URL);
    const bundled = res.ok ? await res.json() : {};
    const { settings } = await chrome.storage.local.get("settings");
    // mergeSettings, not a raw read: src/data/settings.json is the base default
    // and stored values override it per key, which is what makes a path edited
    // in settings.json take effect here. Matches how the popup reads settings.
    return mergeSettings(bundled, settings);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
})();

async function loadProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile) return profile;
  const res = await fetch(BUNDLED_PROFILE_URL);
  return res.ok ? res.json() : DEFAULT_PROFILE;
}

async function loadSettings() {
  return settingsReady;
}

// The LaTeX source to tailor, and where it came from. Resolution order:
//   1. what this page was given — an uploaded PDF (converted to LaTeX) or a .tex
//      from the "Use a .tex file instead" box
//   2. resumeTex already in chrome.storage.local
//   3. the bundled file named by settings.resumeTexPath (see src/data/settings.json)
//      — the same single place resumePdfPath lives, so one file configures both.
// A PDF is a real source, not just something to attach: it is converted once on
// upload, and everything downstream works on the resulting LaTeX.
async function loadResumeText() {
  const override = overrideSource;
  if (override && override.text.trim()) {
    return { text: override.text, source: override.label };
  }

  const { resumeTex } = await chrome.storage.local.get("resumeTex");
  if (resumeTex) return { text: resumeTex, source: "stored resumeTex" };

  const settings = await settingsReady;
  const resolved = bundledFileUrl(
    settings.resumeTexPath,
    "resumeTexPath",
    [".tex"]
  );

  if (resolved.error) {
    throw new Error(resolved.error);
  }

  // A missing bundled file makes fetch() reject with a bare "Failed to fetch",
  // which says nothing — name the file and the two ways out.
  let res;
  try {
    res = await fetch(resolved.url);
  } catch {
    throw new Error(
      `"${resolved.path}" is missing from the extension. Restore it (git checkout -- ${resolved.path}) ` +
        'or upload your resume PDF above (or a .tex in the "Use a .tex file instead" box).'
    );
  }
  if (!res.ok) {
    throw new Error(
      `Could not read "${resolved.path}" from the extension (HTTP ${res.status}) — is the file actually there?`
    );
  }
  return { text: await res.text(), source: resolved.path };
}

// Which file the "current" side is showing, on both the rendered and the source
// pane labels — the whole point of the override box is that you can forget which
// one you typed.
function renderCurrentSourceLabels(source) {
  document.getElementById("old-source-label").textContent = `— ${source}`;
  document.getElementById("old-source-label-tex").textContent = `— ${source}`;
}

function renderChips(containerId, items, cls) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  if (items.length === 0) {
    el.innerHTML = `<span class="muted">None</span>`;
    return;
  }
  items.forEach((text) => {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    chip.textContent = text;
    el.appendChild(chip);
  });
}

// ---- Rendered A4 preview ---------------------------------------------------
// A render is needed but was skipped (or was for a different engine/view).
let pendingPreview = false;

function selectedEngine() {
  return document.getElementById("engine-select").value === "latexjs" ? "latexjs" : "fast";
}

function setPreviewStatus(text) {
  document.getElementById("preview-status").textContent = text;
}

// Resolves with the measured document once the frame has laid it out.
function loadDocIntoFrame(frame, doc) {
  return new Promise((resolve) => {
    frame.addEventListener("load", () => resolve(frame.contentDocument), { once: true });
    frame.srcdoc = doc;
  });
}

// Fits a full A4 sheet into its column with a CSS transform. A transform leaves
// layout untouched, so the sheets keep exactly the line breaking that was
// measured for pagination — `zoom` would re-scale the layout box and change it.
function mountSheet(container, doc, index, pageCount, layout) {
  const width = paperWidthPx(layout);
  const height = paperHeightPx(layout);

  const frame = document.createElement("iframe");
  frame.title = `Page ${index + 1} of ${pageCount}`;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.border = "none";
  frame.style.transformOrigin = "top left";

  const available = container.clientWidth - 24;
  const scale = Math.min(1, available > 0 ? available / width : 1);
  if (scale < 1) frame.style.transform = `scale(${round(scale, 4)})`;

  const holder = document.createElement("div");
  holder.style.width = `${round(width * scale, 1)}px`;
  holder.style.height = `${round(height * scale, 1)}px`;
  holder.appendChild(frame);
  container.appendChild(holder);

  loadDocIntoFrame(frame, doc);
}

// The last successful render per column, so a window resize only re-scales and
// re-mounts the sheets already built instead of re-running the typesetter.
let mountedSheets = {};

function mountSheets(id, sheets) {
  const container = document.getElementById(id);
  container.innerHTML = "";
  sheets.pageDocs.forEach((doc, index) => mountSheet(container, doc, index, sheets.pageCount, sheets.layout));
}

function remountSheets() {
  Object.entries(mountedSheets).forEach(([id, sheets]) => {
    if (!sheets) return;
    const container = document.getElementById(id);
    container.innerHTML = "";
    mountSheets(id, sheets);
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!pendingPreview && !document.getElementById("pages-grid").classList.contains("hidden")) remountSheets();
  }, 200);
});

function round(value, digits) {
  const factor = Math.pow(10, digits || 2);
  return Math.round(value * factor) / factor;
}

// Lays `tex` out as A4 sheets: one iframe per sheet, scaled to fit the column.
// The library does render → highlight → measure → split; `containerId` is only
// where the measuring iframe is parked and the sheets are mounted.
async function renderPaperPages(containerId, tex, highlightText) {
  const engine = selectedEngine();
  const layout = parseLatexLayout(tex);

  const probe = document.createElement("iframe");
  probe.className = "measuring";
  probe.style.width = `${paperWidthPx(layout)}px`;
  probe.style.height = `${paperHeightPx(layout)}px`;
  document.getElementById(containerId).appendChild(probe);

  let info;
  try {
    info = await paginatePaperPages({
      tex,
      engine,
      layout,
      highlightText,
      loadDoc: (doc) => loadDocIntoFrame(probe, doc)
    });
  } finally {
    probe.remove();
  }

  mountSheets(containerId, info);
  return info;
}

function showPreviewError(container, message) {
  container.innerHTML = "";
  const note = document.createElement("div");
  note.className = "page-error";
  note.textContent = `Preview failed: ${message} — the LaTeX source view still works.`;
  container.appendChild(note);
}

async function refreshPreviews() {
  if (!latestResult) return;
  if (document.getElementById("pages-grid").classList.contains("hidden")) {
    // Sheets are measured and scaled against a laid-out column; rendering them
    // into a display:none grid would measure a zero-width page.
    pendingPreview = true;
    return;
  }
  pendingPreview = false;
  const startedAt = performance.now();

  const jobs = [
    { id: "old-pages", tex: latestResult.originalText, highlight: "" },
    {
      id: "new-pages",
      tex: latestResult.tailoredText,
      highlight: latestResult.addedKeywords.length ? ADDED_KEYWORDS_LABEL : ""
    }
  ];

  setPreviewStatus("Rendering pages…");
  mountedSheets = {};
  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        const info = await renderPaperPages(job.id, job.tex, job.highlight);
        mountedSheets[job.id] = info;
        return info;
      } catch (err) {
        showPreviewError(document.getElementById(job.id), err.message);
        return { error: err.message, warnings: [], pageCount: 0 };
      }
    })
  );

  const failed = results.filter((r) => r.error);
  const warnings = results.flatMap((r) => r.warnings || []);
  const pages = results.map((r) => r.pageCount).join(" / ");
  const warningNote = warnings.length ? ` (dropped unsupported: ${[...new Set(warnings)].join(", ")})` : "";
  const errorNote = failed.length ? ` (${failed.map((r) => r.error).join("; ")})` : "";
  setPreviewStatus(`${selectedEngine()} · ${pages} pages${warningNote}${errorNote}`);

  Analytics.trackTimed("Resume Preview Rendered", startedAt, {
    engine: selectedEngine(),
    old_pages: results[0].pageCount,
    new_pages: results[1].pageCount
  });
}

// Line-level diff for an additive-only change (tailoring only ever inserts
// lines, never edits/removes existing ones): find the longest common prefix
// and suffix by line, everything left in the middle of the new text is the
// added block.
function renderDiffPane(paneId, oldText, newText) {
  const pane = document.getElementById(paneId);
  pane.innerHTML = "";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const addedStart = prefixLen;
  const addedEnd = newLines.length - suffixLen;

  newLines.forEach((line, idx) => {
    const span = document.createElement("span");
    span.textContent = line + "\n";
    if (idx >= addedStart && idx < addedEnd) {
      span.className = "diff-added";
    }
    pane.appendChild(span);
  });
}

async function handleAnalyze() {
  const status = document.getElementById("status");
  const jdText = document.getElementById("jd-input").value.trim();

  if (!jdText) {
    status.textContent = "Paste a job description first.";
    return;
  }

  const startedAt = performance.now();
  status.textContent = "Analyzing…";
  document.getElementById("results").classList.add("hidden");

  try {
    // A PDF may still be converting into LaTeX in the background; analyzing the
    // bundled .tex instead would quietly compare against the wrong resume.
    await whenSourceReady();
    const [profile, settings, current] = await Promise.all([loadProfile(), loadSettings(), loadResumeText()]);
    const result = await buildTailoredResume(current.text, jdText, profile, settings);
    latestResult = result;

    renderChips("matched-chips", result.matched, "matched");
    renderChips("missing-chips", result.missing, "missing");

    document.getElementById("old-pane").textContent = result.originalText;
    renderDiffPane("new-pane", result.originalText, result.tailoredText);
    renderCurrentSourceLabels(current.source);
    // Carried into the print job so "Save as PDF" names the file after the
    // resume it came from, not after this page.
    latestResult.sourceLabel = current.source;

    const addedNote = result.addedKeywords.length
      ? `Added ${result.addedKeywords.length} keyword(s) not already in the resume text.`
      : "All matched keywords were already present in the resume text — nothing added.";
    status.textContent = `${result.matched.length} matched, ${result.missing.length} gap(s). ${addedNote}`;

    document.getElementById("results").classList.remove("hidden");
    // After the results are on screen, not before: the preview measures its own
    // sheets inside iframes and needs the columns laid out to size them. Its own
    // failure must not turn a successful tailoring run into an error.
    try {
      await refreshPreviews();
    } catch (err) {
      setPreviewStatus(`Preview failed: ${err.message} — the LaTeX source view still works.`);
    }

    // Counts only. Neither the job description, the matched keywords, nor any
    // resume text leaves the machine here.
    Analytics.trackTimed("Resume Tailored", startedAt, {
      jd_length: jdText.length,
      matched_count: result.matched.length,
      missing_count: result.missing.length,
      added_count: result.addedKeywords.length,
      use_llm: !!settings.useLLM
    });
  } catch (err) {
    status.textContent = `Could not analyze: ${err.message}`;
    Analytics.trackTimed("Resume Tailoring Failed", startedAt, { jd_length: jdText.length, error: err.message });
  }
}

document.getElementById("copy-btn").addEventListener("click", async () => {
  const saveStatus = document.getElementById("save-status");
  if (!latestResult) return;
  try {
    await navigator.clipboard.writeText(latestResult.tailoredText);
    saveStatus.textContent = "Copied — paste into Overleaf and Recompile.";
    Analytics.track("Tailored Resume Exported", { method: "copy", added_count: latestResult.addedKeywords.length });
  } catch (err) {
    saveStatus.textContent = `Copy failed: ${err.message}`;
    Analytics.track("Tailored Resume Export Failed", { method: "copy", error: err.message });
  }
});

document.getElementById("download-btn").addEventListener("click", () => {
  const saveStatus = document.getElementById("save-status");
  if (!latestResult) return;
  const blob = new Blob([latestResult.tailoredText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "resume.tex";
  a.click();
  URL.revokeObjectURL(url);
  saveStatus.textContent = "Downloaded — replace src/data/resume.tex with this file to make it the new bundled default, or compile it directly.";
  Analytics.track("Tailored Resume Exported", { method: "download", added_count: latestResult.addedKeywords.length });
});

document.getElementById("analyze-btn").addEventListener("click", handleAnalyze);

// ---- Resume source: an uploaded PDF, or a .tex ---------------------------
// Scratch source only: it lives in memory for this tab, is named in the pane
// labels, and is dropped by the clear button or a reload. Making it permanent
// stays a deliberate act (Download Tailored .tex → replace src/data/resume.tex,
// or edit resumeTexPath), so the preview can never silently become the source of
// truth. Both inputs write the same slot: whichever was used last is in play.
function setOverrideSource(kind, text, label, statusText) {
  const status = document.getElementById(kind === "pdf" ? "pdf-source-status" : "tex-status");
  const trimmed = (text || "").trim();

  if (!trimmed) {
    overrideSource = null;
    status.textContent = statusText || "No file loaded — using the bundled resume.tex.";
    return;
  }

  if (!/\\begin\s*\{document\}/.test(trimmed)) {
    status.textContent =
      "That doesn't look like a LaTeX document (no \\begin{document}) — using the bundled resume.tex instead.";
    overrideSource = null;
    return;
  }

  overrideSource = { kind, text: trimmed, label };
  status.textContent = statusText;
}

function setOverrideTex(text, label, statusText) {
  setOverrideSource("tex", text, label, statusText);
}

// What the file input last loaded, so the pane label can name the file even after
// the user has edited the text in the textarea.
let texFileName = "";
let texFileText = "";

document.getElementById("tex-file-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const status = document.getElementById("tex-status");
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    document.getElementById("tex-text-input").value = text;
    texFileName = file.name;
    texFileText = text;
    setOverrideTex(text, file.name, `Loaded ${file.name} (${Math.round(file.size / 1024)} KB) — Analyze to compare against it.`);
  };
  reader.onerror = () => {
    status.textContent = `Could not read file: ${reader.error?.message || "unknown error"}`;
  };
  reader.readAsText(file);
});

document.getElementById("tex-use-btn").addEventListener("click", () => {
  const pasted = document.getElementById("tex-text-input").value;
  const label = texFileName && pasted === texFileText ? texFileName : "pasted .tex";
  setOverrideTex(pasted, label, `Using ${label} — Analyze to compare against it.`);
});

document.getElementById("tex-clear-btn").addEventListener("click", () => {
  document.getElementById("tex-text-input").value = "";
  document.getElementById("tex-file-input").value = "";
  texFileName = "";
  texFileText = "";
  // One slot, so clearing drops whichever source is in play, PDF included.
  const was = overrideSource;
  overrideSource = null;
  const note = "Back to the bundled resume.tex — Analyze to refresh.";
  document.getElementById("tex-status").textContent = note;
  document.getElementById("pdf-source-status").textContent = was && was.kind === "pdf" ? `Cleared ${was.label}. ${note}` : "";
});

// ---- View / engine / print controls ---------------------------------------
function setPreviewView(view) {
  document.getElementById("pages-grid").classList.toggle("hidden", view !== "pages");
  document.getElementById("source-grid").classList.toggle("hidden", view === "pages");
  document.querySelectorAll("#view-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  if (view === "pages" && pendingPreview) refreshPreviews();
}

document.querySelectorAll("#view-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => setPreviewView(btn.dataset.view));
});

document.getElementById("engine-select").addEventListener("change", () => {
  pendingPreview = true;
  setPreviewStatus("Rendering pages…");
  refreshPreviews();
});

// Printing an iframe from this page is unreliable in Chrome, so the print page
// is a separate document: the job is handed over via session storage (tab-scoped
// and cleared by the browser, and never written to disk like chrome.storage.local).
document.getElementById("print-btn").addEventListener("click", async () => {
  const saveStatus = document.getElementById("save-status");
  if (!latestResult) return;

  const addedLine = latestResult.addedKeywords.length ? ADDED_KEYWORDS_LABEL : "";
  await chrome.storage.session.set({
    resumePrintJob: {
      tex: latestResult.tailoredText,
      engine: selectedEngine(),
      highlightText: addedLine,
      label: latestResult.sourceLabel || "resume",
      at: Date.now()
    }
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL("src/resume/print.html") });
  saveStatus.textContent = "Opening the print page — choose \"Save as PDF\" as the destination.";
  Analytics.track("Tailored Resume Exported", { method: "print", added_count: latestResult.addedKeywords.length });
});

// If popup.js's "Tailor Resume" button stashed a JD scraped from the job
// page (see scanJobDescription in page-scripts.js), pre-fill it and run the
// analysis automatically — this is the "one-click from the job page" path.
// Consumed once: cleared from storage immediately so re-opening this tab
// manually later (or refreshing) doesn't silently reuse a stale JD from a
// different job.
(async () => {
  const { pendingJD } = await chrome.storage.local.get("pendingJD");

  Analytics.track("Resume Page Opened", {
    auto_filled: !!(pendingJD && pendingJD.text),
    jd_source: pendingJD && pendingJD.text ? pendingJD.source : "none"
  });

  if (!pendingJD || !pendingJD.text) return;

  await chrome.storage.local.remove("pendingJD");

  const jdInput = document.getElementById("jd-input");
  const status = document.getElementById("status");
  jdInput.value = pendingJD.text;

  const ageMs = Date.now() - (pendingJD.capturedAt || 0);
  const staleNote = ageMs > 5 * 60 * 1000 ? " (captured a few minutes ago — re-check it's still the right posting)" : "";
  const truncatedNote = pendingJD.truncated ? " Truncated to the first 20,000 characters." : "";
  const autoFillNote = `Auto-filled from the job page (${pendingJD.source})${staleNote}.${truncatedNote}`;

  // handleAnalyze() overwrites `status` with its own progress/result text —
  // prepend our note to whatever it lands on rather than setting it first
  // (which handleAnalyze would just clobber).
  await handleAnalyze();
  status.textContent = `${autoFillNote} ${status.textContent}`;
})();

// ---- Stored PDF for the popup's file-upload autofill ----
//
// Takes the result of the shared loadResumePdf() in schema.js, so this page and
// the popup can never disagree about which PDF is in play — including *why*
// there isn't one.
function renderPdfStatus(result) {
  const el = document.getElementById("pdf-status");
  const stored = result && result.pdf;

  if (stored && stored.savedAt) {
    el.textContent = `Stored: ${stored.filename} (${Math.round(stored.size / 1024)} KB, saved ${new Date(stored.savedAt).toLocaleString()})`;
  } else if (stored) {
    el.textContent = `Using resumePdfPath from settings.json: ${stored.filename} (${Math.round(stored.size / 1024)} KB). Upload a PDF above to override it.`;
  } else if (result && result.error) {
    el.textContent = `No resume PDF available — ${result.error}.`;
  } else {
    el.textContent = "No compiled PDF stored yet — the popup's Fill button can't auto-attach a resume until one is uploaded here.";
  }
}

// Reads an uploaded PDF into LaTeX and makes it the tailoring source. The text
// and structure come back out of the PDF (pdf.js), so the rest of the page —
// preview, tailoring, print — works exactly as it does for a .tex.
async function usePdfAsResumeSource(file, options) {
  const opts = options || {};
  const status = document.getElementById("pdf-source-status");
  // An upload is user-initiated and should say what it is doing; the PDF that was
  // already configured is picked up in the background.
  if (!opts.quiet) status.textContent = `Reading ${file.name}…`;

  // The background conversion is the only one this can race with: picking a
  // different file while it runs must win, not lose to the older result.
  const seq = ++pdfConvertSeq;
  const startedAt = performance.now();
  try {
    const buffer = await file.arrayBuffer();
    const extracted = await extractPdfToTex(buffer);
    if (seq !== pdfConvertSeq) return;
    const { stats, warnings } = extracted;

    if (!extracted.tex.trim()) {
      setOverrideSource("pdf", "", "", "No text found in that PDF — is it a scanned image?");
      return;
    }

    const label = `${file.name} (PDF → LaTeX)`;
    setOverrideSource(
      "pdf",
      extracted.tex,
      label,
      `Read ${stats.pages} page(s), ${stats.lines} lines, ${stats.sections} sections, ${stats.bullets} bullets ` +
        `from ${file.name} — press Analyze & Tailor.`
    );
    // Warnings are about this PDF, so they belong next to it rather than in the
    // analysis status line, which is about the job description.
    if (warnings.length) status.textContent += ` Note: ${warnings.join(" ")}`;
    Analytics.trackTimed("Resume PDF Converted", startedAt, {
      pages: stats.pages,
      lines: stats.lines,
      warnings_count: warnings.length,
      auto: !!opts.quiet
    });
  } catch (err) {
    if (seq !== pdfConvertSeq) return;
    setOverrideSource("pdf", "", "", `Could not read ${file.name}: ${err.message}`);
    Analytics.track("Resume PDF Convert Failed", { error: err.message });
  }
}

// The resume PDF this extension already knows about is picked up in the
// background by the startup block at the end of this file. Set once that
// conversion settles, so an analysis started meanwhile waits for it instead of
// silently falling back to the bundled .tex. Declared up here because the
// auto-analysis below runs while the rest of this file is still loading.
function whenSourceReady() {
  return sourceReady || Promise.resolve();
}

document.getElementById("pdf-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const pdfStatus = document.getElementById("pdf-status");
  if (!file) return;

  if (file.type !== "application/pdf") {
    pdfStatus.textContent = "Please choose a PDF file.";
    Analytics.track("Resume PDF Rejected", { reason: "not a pdf" });
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(",")[1];
    const record = { base64, filename: file.name, mimeType: file.type, size: file.size, savedAt: Date.now() };
    await chrome.storage.local.set({ resumePdf: record });
    renderPdfStatus({ pdf: record, source: "upload", error: null });
    // Size only — the PDF itself never leaves chrome.storage.local.
    Analytics.track("Resume PDF Saved", { size_kb: Math.round(file.size / 1024) });
  };
  reader.onerror = () => {
    pdfStatus.textContent = `Could not read file: ${reader.error?.message || "unknown error"}`;
  };
  reader.readAsDataURL(file);

  // One upload, both jobs: the popup's file attach and this page's source.
  await usePdfAsResumeSource(file);
});

// The resume PDF this extension already knows about (uploaded earlier, or the
// resumePdfPath in settings.json) is also this page's tailoring source, so
// opening the page is enough — no re-upload needed. It converts in the
// background; anything that reads the source waits on sourceReady.
sourceReady = (async () => {
  try {
    const result = await loadResumePdf(await settingsReady);
    renderPdfStatus(result);
    if (result && result.pdf && result.pdf.base64) {
      const buffer = base64ToArrayBuffer(result.pdf.base64);
      const file = new File([buffer], result.pdf.filename || "resume.pdf", { type: "application/pdf" });
      await usePdfAsResumeSource(file, { quiet: true });
    }
  } catch (err) {
    renderPdfStatus({ pdf: null, source: "file", error: err.message });
  }
})();
