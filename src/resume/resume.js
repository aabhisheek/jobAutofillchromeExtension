const BUNDLED_RESUME_URL = chrome.runtime.getURL("src/data/resume.tex");
const BUNDLED_PROFILE_URL = chrome.runtime.getURL("src/data/profile.json");
const BUNDLED_SETTINGS_URL = chrome.runtime.getURL("src/data/settings.json");

let latestResult = null;

Analytics.init("resume");

async function loadProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile) return profile;
  const res = await fetch(BUNDLED_PROFILE_URL);
  return res.ok ? res.json() : DEFAULT_PROFILE;
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings) return settings;
  const res = await fetch(BUNDLED_SETTINGS_URL);
  return res.ok ? res.json() : { useLLM: false };
}

async function loadResumeText() {
  const { resumeTex } = await chrome.storage.local.get("resumeTex");
  if (resumeTex) return resumeTex;
  const res = await fetch(BUNDLED_RESUME_URL);
  if (!res.ok) throw new Error(`Could not load bundled resume.tex (${res.status})`);
  return res.text();
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
    const [profile, settings, resumeText] = await Promise.all([loadProfile(), loadSettings(), loadResumeText()]);
    const result = await buildTailoredResume(resumeText, jdText, profile, settings);
    latestResult = result;

    renderChips("matched-chips", result.matched, "matched");
    renderChips("missing-chips", result.missing, "missing");

    document.getElementById("old-pane").textContent = result.originalText;
    renderDiffPane("new-pane", result.originalText, result.tailoredText);

    const addedNote = result.addedKeywords.length
      ? `Added ${result.addedKeywords.length} keyword(s) not already in the resume text.`
      : "All matched keywords were already present in the resume text — nothing added.";
    status.textContent = `${result.matched.length} matched, ${result.missing.length} gap(s). ${addedNote}`;

    document.getElementById("results").classList.remove("hidden");

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
function renderPdfStatus(stored) {
  const el = document.getElementById("pdf-status");
  if (stored && stored.savedAt) {
    el.textContent = `Stored: ${stored.filename} (${Math.round(stored.size / 1024)} KB, saved ${new Date(stored.savedAt).toLocaleString()})`;
  } else if (stored) {
    el.textContent = `Using bundled default: ${stored.filename} (${Math.round(stored.size / 1024)} KB). Upload a PDF above to override it.`;
  } else {
    el.textContent = "No compiled PDF stored yet — the popup's Fill button can't auto-attach a resume until one is uploaded here.";
  }
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
    renderPdfStatus(record);
    // Size only — the PDF itself never leaves chrome.storage.local.
    Analytics.track("Resume PDF Saved", { size_kb: Math.round(file.size / 1024) });
  };
  reader.onerror = () => {
    pdfStatus.textContent = `Could not read file: ${reader.error?.message || "unknown error"}`;
  };
  reader.readAsDataURL(file);
});

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

(async () => {
  const { resumePdf } = await chrome.storage.local.get("resumePdf");
  if (resumePdf) {
    renderPdfStatus(resumePdf);
    return;
  }

  try {
    const res = await fetch(chrome.runtime.getURL("src/data/resume.pdf"));
    if (!res.ok) {
      renderPdfStatus(null);
      return;
    }
    const buffer = await res.arrayBuffer();
    renderPdfStatus({
      base64: arrayBufferToBase64(buffer),
      filename: "resume.pdf",
      mimeType: "application/pdf",
      size: buffer.byteLength,
      savedAt: null
    });
  } catch {
    renderPdfStatus(null);
  }
})();
