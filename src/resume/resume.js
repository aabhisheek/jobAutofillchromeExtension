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

// Identity of a resume PDF for the cached conversion: same name and size means
// the same bytes for this purpose, so a stored conversion is only ever reused
// for the file it was read from.
function pdfSourceKey(name, size) {
  return `${name}:${size}`;
}

// The stored conversion of a resume PDF, if one was made from exactly these
// bytes. chrome.storage.local is the "text file" this writes behind the scenes:
// an MV3 extension cannot create files inside its own package, so the LaTeX
// read out of the PDF is kept here and every later run reads it back instead of
// re-parsing the same PDF.
async function readCachedPdfTex(pdfKey) {
  try {
    const { resumePdfTex } = await chrome.storage.local.get("resumePdfTex");
    if (resumePdfTex && resumePdfTex.tex && resumePdfTex.pdfKey === pdfKey) {
      return resumePdfTex;
    }
  } catch {
    // Storage unavailable — treat as a miss; the PDF is converted again below.
  }
  return null;
}

// Best-effort write of a fresh conversion: a full disk must not turn a
// conversion that already succeeded into a failure, so the LaTeX is used for
// this run either way.
async function cachePdfTex(pdfKey, label, tex, extracted) {
  try {
    await chrome.storage.local.set({
      resumePdfTex: {
        tex,
        pdfKey,
        label,
        stats: extracted.stats,
        warnings: extracted.warnings,
        savedAt: Date.now()
      }
    });
  } catch {
    // ignored — see above
  }
}

// PDF in, LaTeX out, through the cache: a hit is returned as-is, a miss is
// converted once and written back. Returns { ok, text, source } or
// { ok: false, error }, so the caller can report *why* there is no source
// instead of only that some other file was missing.
async function resumeTextFromPdf(pdf) {
  const pdfKey = pdfSourceKey(pdf.filename || "resume.pdf", pdf.size || 0);
  const cached = await readCachedPdfTex(pdfKey);
  if (cached) return { ok: true, text: cached.tex, source: cached.label };

  try {
    const extracted = await extractPdfToTex(base64ToArrayBuffer(pdf.base64));
    const tex = (extracted.tex || "").trim();
    if (!tex) {
      return { ok: false, error: `no text found in ${pdf.filename} — is it a scanned image?` };
    }
    const label = `${pdf.filename} (PDF → LaTeX)`;
    await cachePdfTex(pdfKey, label, tex, extracted);
    return { ok: true, text: tex, source: label };
  } catch (err) {
    return { ok: false, error: `could not read ${pdf.filename}: ${err.message}` };
  }
}

// The LaTeX source to tailor, and where it came from. Resolution order:
//   1. what this page was given — an uploaded PDF (converted to LaTeX) or a .tex
//      from the "Use a .tex file instead" box
//   2. resumeTex already in chrome.storage.local
//   3. the resume PDF itself — an upload, or settings.resumePdfPath — converted
//      here (or read back from the conversion stored with it) when nothing
//      converted it earlier
//   4. the bundled file named by settings.resumeTexPath (see src/data/settings.json)
// The PDF sits ahead of the bundled .tex because it is the resume this
// extension is actually configured with: analysis must keep working off that
// PDF even when the .tex file has never existed. Only when neither produces
// anything does this throw, and the message then names everything tried.
// A PDF is a real source, not just something to attach: it is converted once on
// upload, and everything downstream works on the resulting LaTeX.
async function loadResumeText() {
  const override = overrideSource;
  if (override && override.text.trim()) {
    return { text: override.text, source: override.label };
  }

  const { resumeTex } = await chrome.storage.local.get("resumeTex");
  if (resumeTex && resumeTex.trim()) return { text: resumeTex, source: "stored resumeTex" };

  const settings = await settingsReady;

  const pdfResult = await loadResumePdf(settings);
  let pdfProblem = pdfResult.error;
  if (pdfResult.pdf && pdfResult.pdf.base64) {
    const fromPdf = await resumeTextFromPdf(pdfResult.pdf);
    if (fromPdf.ok) return { text: fromPdf.text, source: fromPdf.source };
    pdfProblem = fromPdf.error;
  }

  const resolved = bundledFileUrl(settings.resumeTexPath, "resumeTexPath", [".tex"]);
  let texProblem = resolved.error;
  if (!texProblem) {
    try {
      const res = await fetch(resolved.url);
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) return { text, source: resolved.path };
        texProblem = `"${resolved.path}" is empty`;
      } else {
        texProblem = `"${resolved.path}" is not in the extension (HTTP ${res.status})`;
      }
    } catch {
      texProblem = `"${resolved.path}" could not be read from the extension`;
    }
  }

  // Nothing above produced a resume. Naming only the last file tried would send
  // the user hunting for a resume.tex that was never the real problem when the
  // PDF exists but could not be read — so both are reported, plus the one action
  // that resolves either.
  const tried = [];
  if (pdfProblem) tried.push(`resume PDF: ${pdfProblem}`);
  if (texProblem) tried.push(`LaTeX file: ${texProblem}`);
  throw new Error(
    `No resume available — ${tried.join("; ") || "nothing to read"}. ` +
      "Upload your resume PDF in the box above; it is read and converted to LaTeX automatically."
  );
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
    { id: "new-pages", tex: latestResult.tailoredText, highlight: "" }
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

// A full role rewrite is not an additive change — almost every line differs —
// so the source pane shows it plainly instead of painting the whole body as
// "added".
function renderPlainPane(paneId, text) {
  const pane = document.getElementById(paneId);
  pane.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = text;
  pane.appendChild(span);
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
    const [profile, settings, current, contextMd] = await Promise.all([
      loadProfile(),
      loadSettings(),
      loadResumeText(),
      loadContextMd()
    ]);

    // Every analysis runs the full role rewrite: the description's role is
    // detected when it names one (falling back to Full Stack Developer), and the
    // timeline is rescaled to the years the description asks for (the graduation
    // year moves with the first job). Matched JD keywords are folded into the
    // rewritten skills rather than added as a separate keyword line.
    const detected = detectRoleFromText(jdText);
    const roleId = detected ? detected.id : "fullstack";
    const jdKeywords = await extractKeywords(jdText, profile, settings);
    const { matched, missing } = analyzeMatch(jdKeywords, profile);
    // Scale the timeline up to what the description asks for; never shrink real
    // experience to match a lower number (a "1+ year" posting must not cut a
    // 3-year resume down to 1).
    const requiredYears = detectRequiredYears(jdText);
    const currentMonths = estimateExperienceMonths(profile.experience);
    const targetYears = requiredYears && requiredYears * 12 > currentMonths ? requiredYears : null;

    const rewrite = await rewriteForRole({
      profile,
      contextMd,
      roleId,
      customRole: "",
      targetYears,
      jdText,
      extraSkills: matched,
      settings
    });
    const result = {
      originalText: current.text,
      tailoredText: rewrite.tex,
      jdKeywords,
      matched,
      missing,
      addedKeywords: rewrite.tailored.skillsFocusAdded || [],
      newKeywords: [],
      roleLabel: rewrite.playbook.label,
      yearsLabel: rewrite.tailored.yearsLabel,
      dateShifted: !!rewrite.dateResult.shifted
    };

    // Never silently replace a good resume with one that failed validation —
    // keep the previous result and surface the reason instead.
    if (!rewrite.validation.ok && latestResult && latestResult.validationOk !== false) {
      document.getElementById("results").classList.remove("hidden");
      status.textContent = `Rewrite failed validation (${rewrite.validation.errors.join("; ")}) — keeping the previous result.`;
      Analytics.trackTimed("Resume Rewrite Validation Failed", startedAt, {
        error_count: rewrite.validation.errors.length,
        kept_previous: true
      });
      return;
    }
    result.validationOk = rewrite.validation.ok;
    latestResult = result;

    renderChips("matched-chips", result.matched, "matched");
    renderChips("missing-chips", result.missing, "missing");

    document.getElementById("old-pane").textContent = result.originalText;
    // A role rewrite is not an additive change — almost every line differs — so
    // the source pane is shown plainly instead of painted as one added block.
    renderPlainPane("new-pane", result.tailoredText);
    renderCurrentSourceLabels(current.source);
    // Carried into the print job so "Save as PDF" names the file after the
    // resume it came from, not after this page.
    latestResult.sourceLabel = `role rewrite — ${result.roleLabel} (from ${current.source})`;

    // Say exactly what changed: which role it was rewritten for, which JD
    // keywords were folded into the skills, and which were deliberately left
    // out because nothing in the profile backs them.
    const parts = [];
    parts.push(
      `Rewritten for ${result.roleLabel}` +
        (result.dateShifted ? ` with the timeline rescaled to ${result.yearsLabel}` : "")
    );
    if (result.addedKeywords.length) {
      parts.push(`surfaced ${result.addedKeywords.length} matched keyword(s) in the skills`);
    } else if (result.matched.length) {
      parts.push(`${result.matched.length} JD keyword(s) already covered by the skills`);
    } else {
      parts.push("no JD keyword matches your profile");
    }
    if (result.missing.length) parts.push(`${result.missing.length} JD keyword(s) left out (no match in your profile)`);
    if (!rewrite.validation.ok) {
      parts.unshift(`Validation warning: ${rewrite.validation.errors.join("; ")}`);
    }
    status.textContent = `${parts.join(". ")}.`;

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
      role_rewrite: true,
      target_years: targetYears || "kept",
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

// ---- Role-based rewrite ---------------------------------------------------
// Rewrites the whole resume for a target role (headline, titles, bullets,
// projects, skills) and optionally rescales the employment timeline to a target
// number of years. See src/lib/resume-rewriter.js for the playbooks and the
// date engine. Nothing is written to storage — the result lives in
// latestResult like a keyword-tailored run, and is exported the same ways.

const CONTEXT_MD_URL = chrome.runtime.getURL("src/data/context.md");

async function loadContextMd() {
  try {
    const res = await fetch(CONTEXT_MD_URL);
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

// Remembered choices so reopening the page for the next application doesn't
// start from scratch. { roleId, customRole, years, polish }.
let rewritePrefs = { roleId: "java-developer", customRole: "", years: "", polish: false };
// Set when the user touches a control, so JD-based auto-detection (which runs
// when the popup hands over a scraped description) never overrides a choice
// made in this tab.
let rewritePrefsTouched = false;

async function loadRewritePrefs() {
  try {
    const stored = (await chrome.storage.local.get("rewritePrefs")).rewritePrefs;
    if (stored && typeof stored === "object") rewritePrefs = { ...rewritePrefs, ...stored };
  } catch {
    // defaults are fine
  }
  document.getElementById("role-select").value = rewritePrefs.roleId || "java-developer";
  document.getElementById("role-custom-input").value = rewritePrefs.customRole || "";
  document.getElementById("years-select").value = rewritePrefs.years || "";
  document.getElementById("polish-checkbox").checked = !!rewritePrefs.polish;
  toggleCustomRoleInput();
}

function persistRewritePrefs() {
  rewritePrefs = {
    roleId: document.getElementById("role-select").value,
    customRole: document.getElementById("role-custom-input").value.trim(),
    years: document.getElementById("years-select").value,
    polish: document.getElementById("polish-checkbox").checked
  };
  chrome.storage.local.set({ rewritePrefs });
}

function toggleCustomRoleInput() {
  const isCustom = document.getElementById("role-select").value === "custom";
  document.getElementById("role-custom-input").classList.toggle("hidden", !isCustom);
}

["role-select", "role-custom-input", "years-select", "polish-checkbox"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    rewritePrefsTouched = true;
    toggleCustomRoleInput();
    persistRewritePrefs();
  });
});

async function handleRewrite() {
  const status = document.getElementById("rewrite-status");
  const roleSelect = document.getElementById("role-select");
  const roleId = roleSelect.value;
  const customRole = document.getElementById("role-custom-input").value.trim();
  const yearsValue = document.getElementById("years-select").value;
  const polish = document.getElementById("polish-checkbox").checked;
  const jdText = document.getElementById("jd-input").value.trim();

  if (roleId === "custom" && !customRole) {
    status.textContent = "Type the custom role title first.";
    return;
  }

  const startedAt = performance.now();
  status.textContent = "Rewriting…";
  document.getElementById("results").classList.add("hidden");
  const rewriteBtn = document.getElementById("rewrite-btn");
  rewriteBtn.disabled = true;

  try {
    await whenSourceReady();
    const [profile, settings, contextMd] = await Promise.all([
      loadProfile(),
      loadSettings(),
      loadContextMd()
    ]);

    // The rewrite is generated fresh from profile.json + context.md, so an
    // unconfigured resume source is not fatal — it only costs us the "old"
    // side of the diff. Fall back to an empty original rather than failing.
    let current = { text: "", source: "profile.json (no resume source configured)" };
    try {
      current = await loadResumeText();
    } catch (err) {
      setPreviewStatus(`No current resume source: ${err.message} — showing the rewrite only.`);
    }

    // Match the JD's keywords first, then hand the matches to the rewrite so
    // they are folded into the skills rather than added as a keyword line.
    let jdKeywords = [];
    let matched = [];
    let missing = [];
    if (jdText) {
      jdKeywords = await extractKeywords(jdText, profile, settings);
      const analysis = analyzeMatch(jdKeywords, profile);
      matched = analysis.matched;
      missing = analysis.missing;
    }

    const result = await rewriteForRole({
      profile,
      contextMd,
      roleId,
      customRole,
      targetYears: yearsValue ? Number(yearsValue) : null,
      jdText,
      extraSkills: matched,
      settings: { ...settings, rewritePolish: polish }
    });

    const tailoredText = result.tex;
    const addedKeywords = result.tailored.skillsFocusAdded || [];

    // Never silently replace a good resume with one that failed validation.
    if (!result.validation.ok && latestResult && latestResult.validationOk !== false) {
      document.getElementById("results").classList.remove("hidden");
      status.textContent = `Rewrite failed validation (${result.validation.errors.join("; ")}) — keeping the previous result.`;
      Analytics.trackTimed("Resume Rewrite Validation Failed", startedAt, {
        error_count: result.validation.errors.length,
        kept_previous: true
      });
      return;
    }

    latestResult = {
      originalText: current.text,
      tailoredText,
      jdKeywords,
      matched,
      missing,
      addedKeywords,
      validationOk: result.validation.ok,
      sourceLabel: `role rewrite — ${result.playbook.label}${yearsValue ? `, ${yearsValue} yrs` : ""} (from ${current.source})`
    };

    renderChips("matched-chips", matched, "matched");
    renderChips("missing-chips", missing, "missing");
    document.getElementById("old-pane").textContent = current.text;
    renderPlainPane("new-pane", tailoredText);
    renderCurrentSourceLabels(current.source);

    const dateNote = result.dateResult.shifted
      ? `Timeline rescaled to ${result.tailored.yearsLabel} (shifted ${result.dateResult.deltaMonths} month(s) vs. today-anchored span).`
      : `Dates kept as-is (${result.tailored.yearsLabel} total).`;
    const polishNote = result.polishedWith ? ` Wording polished with ${result.polishedWith}.` : "";
    const keywordNote = jdText
      ? addedKeywords.length
        ? ` ${addedKeywords.length} JD keyword(s) folded into the skills.`
        : matched.length
          ? ` ${matched.length} JD keyword(s) already covered by the skills.`
          : " No JD keyword matched your profile — see the gaps below."
      : "";
    status.textContent = `Rewritten for ${result.playbook.label}. ${dateNote}${polishNote}${keywordNote}`;
    if (!result.validation.ok) {
      status.textContent = `Validation warning: ${result.validation.errors.join("; ")}. ${status.textContent}`;
    }

    document.getElementById("results").classList.remove("hidden");
    try {
      await refreshPreviews();
    } catch (err) {
      setPreviewStatus(`Preview failed: ${err.message} — the LaTeX source view still works.`);
    }

    Analytics.trackTimed("Resume Rewritten", startedAt, {
      role: result.playbook.id,
      years: yearsValue || "kept",
      shifted: !!result.dateResult.shifted,
      polished: !!result.polishedWith,
      jd_present: !!jdText,
      matched_count: matched.length
    });
  } catch (err) {
    status.textContent = `Could not rewrite: ${err.message}`;
    Analytics.trackTimed("Resume Rewrite Failed", startedAt, {
      role: roleId,
      years: yearsValue || "kept",
      error: err.message
    });
  } finally {
    rewriteBtn.disabled = false;
  }
}

document.getElementById("rewrite-btn").addEventListener("click", handleRewrite);
loadRewritePrefs();

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

  await chrome.storage.session.set({
    resumePrintJob: {
      tex: latestResult.tailoredText,
      engine: selectedEngine(),
      highlightText: "",
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

  // Preselect the role this job description looks like — the rewrite half of
  // the page answers to the same JD the keyword half just received. A choice
  // already made in this tab always wins over detection.
  await loadRewritePrefs();
  if (!rewritePrefsTouched) {
    const detected = detectRoleFromText(pendingJD.text);
    if (detected && detected.score >= 3) {
      document.getElementById("role-select").value = detected.id;
      toggleCustomRoleInput();
      persistRewritePrefs();
    }
  }

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
// preview, tailoring, print — works exactly as it does for a .tex. The
// conversion is kept (see readCachedPdfTex) so these bytes are only parsed once.
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
  const pdfKey = pdfSourceKey(file.name, file.size);

  // Already converted from exactly these bytes — reuse that instead of parsing
  // the whole PDF again on every open of this page.
  const cached = await readCachedPdfTex(pdfKey);
  if (seq !== pdfConvertSeq) return;
  if (cached) {
    const stats = cached.stats;
    setOverrideSource(
      "pdf",
      cached.tex,
      cached.label,
      stats
        ? `Read ${stats.pages} page(s), ${stats.lines} lines, ${stats.sections} sections, ${stats.bullets} bullets ` +
            `from ${file.name} (saved conversion) — press Analyze & Tailor.`
        : `Using ${file.name} (saved conversion) — press Analyze & Tailor.`
    );
    if (cached.warnings && cached.warnings.length) {
      status.textContent += ` Note: ${cached.warnings.join(" ")}`;
    }
    Analytics.track("Resume PDF Converted", { cached: true, auto: !!opts.quiet });
    return;
  }

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
    await cachePdfTex(pdfKey, label, extracted.tex, extracted);
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
