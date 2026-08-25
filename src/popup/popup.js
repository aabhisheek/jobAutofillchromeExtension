let currentProfile = null;
let currentRows = [];
let currentSettings = { ...DEFAULT_SETTINGS };
let currentResumePdf = null; // { base64, filename, mimeType, size, savedAt } | null — see src/resume/resume.js

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Falls back to the bundled src/data/profile.json when storage is empty
// (fresh install, cleared storage) so autofill works without a trip to
// Options first — see options.js for the matching fallback there.
async function loadProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile) return profile;

  try {
    const res = await fetch(chrome.runtime.getURL("src/data/profile.json"));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// src/data/settings.json is the base default; chrome.storage.local's saved
// settings (from the Options page) override it field-by-field via
// mergeSettings (see schema.js) — so editing the bundled file always takes
// effect for anything not explicitly overridden in the UI. Note: even with
// keys resolved this way, the optional host permission for api.groq.com /
// generativelanguage.googleapis.com must still have been granted at least
// once via Options (Chrome requires a user gesture for that; it can't be
// auto-granted from a bundled file).
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    const res = await fetch(chrome.runtime.getURL("src/data/settings.json"));
    if (res.ok) bundled = await res.json();
  } catch {
    // fall through — mergeSettings still applies DEFAULT_SETTINGS/overrides
  }

  return mergeSettings(bundled, settings);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// The compiled resume PDF, saved from src/resume/resume.js. Falls back to the
// bundled src/data/resume.pdf (storage empty — fresh install, cleared
// storage) so autofill works without a trip to the Resume page first — same
// pattern as loadProfile/loadSettings above.
async function loadResumePdf() {
  const { resumePdf } = await chrome.storage.local.get("resumePdf");
  if (resumePdf) return resumePdf;

  try {
    const res = await fetch(chrome.runtime.getURL("src/data/resume.pdf"));
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return {
      base64: arrayBufferToBase64(buffer),
      filename: "resume.pdf",
      mimeType: "application/pdf",
      size: buffer.byteLength,
      savedAt: null
    };
  } catch {
    return null;
  }
}

function renderProfileSummary(profile) {
  const el = document.getElementById("profile-summary");
  const name = [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(" ");
  el.textContent = name
    ? `${name} · ${profile.personal.email || "no email set"}`
    : "Profile saved, but name/email are empty.";
}

function renderRows(rows) {
  currentRows = rows;
  const list = document.getElementById("field-list");
  list.innerHTML = "";

  if (rows.length === 0) {
    list.innerHTML = `<p class="muted">No fillable fields found on this page.</p>`;
    document.getElementById("fill-bar").classList.add("hidden");
    return;
  }

  rows.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "field-row";

    const top = document.createElement("div");
    top.className = "row-top";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.include;
    checkbox.disabled = row.status === "resume-upload" ? !currentResumePdf : row.status === "unmatched";
    checkbox.addEventListener("change", () => {
      currentRows[idx].include = checkbox.checked;
    });

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = row.label;

    const badge = document.createElement("span");
    badge.className = `badge ${row.status}`;
    badge.textContent = row.status === "auto" ? "auto" : row.status === "review" ? "review" : row.status === "resume-upload" ? "resume" : "unmatched";

    top.appendChild(checkbox);
    top.appendChild(label);
    top.appendChild(badge);
    wrap.appendChild(top);

    if (row.status === "resume-upload") {
      const info = document.createElement("div");
      info.className = "muted";
      info.textContent = currentResumePdf
        ? `Will attach: ${currentResumePdf.filename}`
        : "No compiled resume PDF saved yet — open Tailor Resume and upload the compiled PDF.";
      wrap.appendChild(info);
    } else if (row.status !== "unmatched") {
      const input = row.tagName === "textarea" ? document.createElement("textarea") : document.createElement("input");
      if (input.tagName === "INPUT") input.type = "text";
      input.value = row.value;
      input.addEventListener("input", () => {
        currentRows[idx].value = input.value;
      });
      wrap.appendChild(input);
      if (row.draftSource) {
        const sourceNote = document.createElement("div");
        sourceNote.className = "muted";
        sourceNote.textContent = `Source: ${row.draftSource}`;
        wrap.appendChild(sourceNote);
      }
    } else if (isDraftCandidate(row)) {
      const draftBtn = document.createElement("button");
      draftBtn.textContent = "Generate Draft (AI)";
      draftBtn.className = "draft-btn";
      draftBtn.addEventListener("click", () => handleGenerateDraft(idx, draftBtn));
      wrap.appendChild(draftBtn);
    } else {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.textContent = row.tagName === "radiogroup" ? `Options: ${row.options.map((o) => o.text).join(", ")}` : "Not in your profile — fill manually.";
      wrap.appendChild(hint);
    }

    list.appendChild(wrap);
  });

  document.getElementById("fill-bar").classList.remove("hidden");
}

// Placeholder text some dropdown widgets (react-select, etc.) show before a
// choice is made. If scanFormFields captures one of these as a field's LABEL
// rather than its value, the widget's real label wasn't wired up yet (async
// hydration) at scan time — not a genuine unlabeled field.
const GENERIC_DROPDOWN_LABELS = new Set(["select...", "select", "choose...", "choose", "please select", "-- select --"]);

function hasGenericLabels(rows) {
  return rows.some((r) => GENERIC_DROPDOWN_LABELS.has((r.label || "").trim().toLowerCase()));
}

async function scanCurrentTab(tabId) {
  const [{ result: scanResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanFormFields
  });
  const fields = scanResult || [];
  return matchFields(fields, currentProfile);
}

async function handleScan() {
  const status = document.getElementById("scan-status");
  status.textContent = "Scanning…";

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    status.textContent = "No active tab found.";
    return;
  }

  try {
    let rows = await scanCurrentTab(tab.id);

    // A single fixed-delay rescan isn't reliable across ATS platforms —
    // different custom dropdown widgets on the same page can hydrate their
    // real label at different times (seen on Greenhouse: some fields'
    // labels resolve within ~700ms, others noticeably later), so a field
    // that's still showing a generic placeholder like "Select..." as its
    // label after one retry isn't necessarily stuck — it just hasn't
    // hydrated yet. Poll a few more times before giving up, stopping the
    // moment no generic labels remain.
    const MAX_RESCANS = 4;
    const RESCAN_DELAY_MS = 600;
    let attempt = 0;
    while (hasGenericLabels(rows) && attempt < MAX_RESCANS) {
      attempt++;
      status.textContent = `Scanning… (waiting for page to finish rendering, attempt ${attempt}/${MAX_RESCANS})`;
      await new Promise((resolve) => setTimeout(resolve, RESCAN_DELAY_MS));
      rows = await scanCurrentTab(tab.id);
    }

    const autoCount = rows.filter((r) => r.status === "auto").length;
    const reviewCount = rows.filter((r) => r.status === "review").length;
    const unmatchedCount = rows.filter((r) => r.status === "unmatched").length;

    status.textContent = `${rows.length} fields found — ${autoCount} auto, ${reviewCount} need review, ${unmatchedCount} unmatched.`;
    renderRows(rows);
  } catch (err) {
    status.textContent = `Could not scan this page: ${err.message}`;
  }
}

async function handleGenerateDraft(idx, buttonEl) {
  const row = currentRows[idx];
  buttonEl.textContent = "Generating…";
  buttonEl.disabled = true;

  try {
    const { text, source } = await generateDraft(row, currentProfile, currentSettings);
    if (!text) {
      buttonEl.textContent = "Not enough profile data — fill manually";
      return;
    }
    currentRows[idx] = {
      ...row,
      value: text,
      status: "review",
      include: false, // drafted content always needs an explicit opt-in
      draftSource: source
    };
    renderRows(currentRows);
  } catch (err) {
    buttonEl.textContent = `Draft failed: ${err.message}`;
    buttonEl.disabled = false;
  }
}

async function handleFill() {
  const status = document.getElementById("fill-status");
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  const included = currentRows.filter((r) => r.include);
  const textPayload = included
    .filter((r) => r.status !== "resume-upload" && r.value)
    .map((r) => ({ uid: r.uid, value: r.value, tagName: r.tagName, inputType: r.inputType }));
  const filePayload = included.filter((r) => r.status === "resume-upload");

  if (textPayload.length === 0 && filePayload.length === 0) {
    status.textContent = "Nothing selected to fill.";
    return;
  }

  status.textContent = "Filling…";

  try {
    let textOk = 0;
    let textTotal = 0;
    let fileOk = 0;

    if (textPayload.length) {
      const [{ result: report }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillFormFields,
        args: [textPayload]
      });
      textOk = report.filter((r) => r.ok).length;
      textTotal = report.length;
    }

    for (const row of filePayload) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillResumeFile,
        args: [row.uid, currentResumePdf.base64, currentResumePdf.filename, currentResumePdf.mimeType]
      });
      if (result && result.ok) fileOk++;
    }

    const parts = [];
    if (textTotal) parts.push(`filled ${textOk}/${textTotal} fields`);
    if (filePayload.length) parts.push(`attached ${fileOk}/${filePayload.length} resume upload(s)`);
    status.textContent = `${parts.join(", ")}. Review the page before submitting.`;
  } catch (err) {
    status.textContent = `Fill failed: ${err.message}`;
  }
}

async function init() {
  currentProfile = await loadProfile();
  currentSettings = await loadSettings();
  currentResumePdf = await loadResumePdf();

  if (!currentProfile) {
    document.getElementById("no-profile").classList.remove("hidden");
    document.getElementById("main").classList.add("hidden");
    document.getElementById("profile-summary").textContent = "No profile set up.";
    return;
  }

  document.getElementById("no-profile").classList.add("hidden");
  document.getElementById("main").classList.remove("hidden");
  renderProfileSummary(currentProfile);
}

document.getElementById("scan-btn").addEventListener("click", handleScan);
document.getElementById("fill-btn").addEventListener("click", handleFill);
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("footer-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
// Grabs the JD off the current job page before handing off to the Resume
// tab, so tailoring doesn't require copy-pasting it by hand. Best-effort:
// scanJobDescription() (see page-scripts.js) always returns *something*
// (falls back to a largest-text-block guess), so this never blocks opening
// the Resume page — worst case the JD textarea opens empty, same as before.
document.getElementById("footer-resume").addEventListener("click", async () => {
  const tab = await getActiveTab();
  let pendingJD = null;

  if (tab && tab.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanJobDescription
      });
      if (result && result.text) {
        pendingJD = { text: result.text, source: result.source, truncated: result.truncated, capturedAt: Date.now() };
      }
    } catch {
      // Page doesn't allow scripting (e.g. chrome:// or a PDF viewer) — fall
      // through with no pending JD, same as manually opening Resume today.
    }
  }

  if (pendingJD) {
    await chrome.storage.local.set({ pendingJD });
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("src/resume/resume.html") });
});

init();
