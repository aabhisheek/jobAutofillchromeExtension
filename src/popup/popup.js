let currentProfile = null;
let currentRows = [];
let currentSettings = { ...DEFAULT_SETTINGS };
let currentResumePdf = null; // { base64, filename, mimeType, size, savedAt } | null — resolved by loadResumePdf() in schema.js
// Why currentResumePdf is null, when it is: a bad resumePdfPath or a missing
// file. Kept so a resume-upload row can say *why* it can't attach something,
// instead of looking the same as "you haven't saved a resume yet".
let currentResumePdfError = null;
// Contents of the bundled context file (src/data/context.md), read once at panel
// open: { text, path, error }. Kept beside draftContext so a row can say WHICH
// context is in play, and a broken path can be reported instead of looking like
// the AI simply ignored the notes.
let currentContextFile = { text: "", path: "", error: null };
// ATS platform the popup was opened over ("workday", "greenhouse", …, or
// "other"/"unknown"). Resolved once in init() and attached to the scan/fill
// events so failures can be traced to a platform — the hostname itself is
// never sent, see the privacy note in lib/analytics.js.
let currentAts = "unknown";
let currentAdapter = GenericAtsAdapter;
// Raw scan output and the matcher's verdict on it, kept so the diagnostics
// button can show both stages. Empty until the first scan.
let currentScannedFields = null;
let currentMatchedRows = null;

// Whether every frame of the page had stopped adding form controls by the time
// of the last scan (see waitForFormReady in page-scripts.js). A settled page
// that still scans short is a scanner problem, and retrying it only delays
// saying so.
let currentScanSettled = false;

// The frames the last scan actually read, and how they turned out: one entry
// per frame, in the order the browser reported them, each carrying the adapter
// chosen for that frame's URL and whether the frame was still loading. Kept so
// a fill can be routed back to the frame a field came from, and so the
// diagnostics dump can say which frame a field lives in.
let currentFrames = [];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- host access ----
// Host access is declarative: manifest.json lists http://*/* and https://*/* in
// host_permissions, so Chrome grants read access at install time and scanning
// needs no prompt and no per-site grant. That is the whole point of an autofill
// extension — it has to be able to read whatever form you are looking at.
//
// The check below is not a gate. It exists only to produce a readable message
// for the single case the extension cannot fix itself: the user switching this
// extension's site access off in Chrome's own settings.
let currentTabOrigin = null;
let currentTabHost = "";
let hasHostAccess = false;

function originPatternFor(url) {
  try {
    const { origin, hostname } = new URL(url);
    return { origin: `${origin}/*`, hostname };
  } catch {
    return null;
  }
}

function renderAccessNotice() {
  const bar = document.getElementById("access-bar");
  if (!bar) return;

  if (hasHostAccess || !currentTabOrigin) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");
  document.getElementById("access-text").textContent =
    `Needs permission to read ${currentTabHost}.`;
}

async function refreshHostAccess(tab) {
  const parsed = tab && tab.url ? originPatternFor(tab.url) : null;
  currentTabOrigin = parsed ? parsed.origin : null;
  currentTabHost = parsed ? parsed.hostname : "";

  hasHostAccess = currentTabOrigin
    ? await chrome.permissions.contains({ origins: [currentTabOrigin] }).catch(() => false)
    : false;

  renderAccessNotice();
  return hasHostAccess;
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

// The context actually sent to the model for a draft: the popup textarea plus
// the bundled context file, merged by buildDraftContext (schema.js). Every place
// that displays or sends context goes through this, so the hint under a row and
// the prompt can't disagree about what is in play.
function effectiveDraftContext() {
  return buildDraftContext(currentSettings.draftContext, currentContextFile);
}

// One-line description of the context in play, for a row's hint. Names the
// sources rather than quoting the merged blob, because the merged text is
// arbitrarily long and its first line is whatever the file happens to open with.
function contextSummary() {
  const typed = !!(currentSettings.draftContext && currentSettings.draftContext.trim());
  const file = !!currentContextFile.text;
  if (typed && file) return `Using context: popup box + ${currentContextFile.path}`;
  if (file) return `Using context: ${currentContextFile.path}`;
  if (typed) {
    const trimmed = currentSettings.draftContext.trim();
    return `Using context: "${trimmed.length > 45 ? trimmed.slice(0, 42) + "…" : trimmed}"`;
  }
  return "";
}

function renderProfileSummary(profile) {
  const el = document.getElementById("profile-summary");
  const name = [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(" ");
  el.textContent = name
    ? `${name} · ${profile.personal.email || "no email set"}`
    : "Profile saved, but name/email are empty.";
}

let draftContextSaveTimeout = null;

// One line under the context textarea saying whether the bundled context file
// was picked up — the user edits that file on disk, so the only way to know the
// extension actually sees it is to be told.
//
// Stays silent when no path is configured at all (nothing was asked for), and
// says so plainly when one is configured but unreadable, since silently drafting
// without it looks like the model ignored the notes.
function renderContextFileNotice() {
  const el = document.getElementById("ai-context-file");
  if (!el) return;

  if (!currentContextFile.path && currentContextFile.error) {
    // No path configured — not a problem, so no message.
    el.textContent = "";
    return;
  }

  if (currentContextFile.error) {
    el.textContent = `⚠️ Context file not loaded — ${currentContextFile.error}`;
    el.className = "muted context-file-error";
    return;
  }

  if (!currentContextFile.text) {
    el.textContent = `${currentContextFile.path} is empty — add notes there and they'll be sent with every draft.`;
    el.className = "muted";
    return;
  }

  el.textContent = `+ ${currentContextFile.path} (${currentContextFile.text.length} chars) is sent with every draft. Edit it on disk, then reopen this panel.`;
  el.className = "muted";
}

function updateAiContextUI() {
  const badge = document.getElementById("ai-context-badge");
  const textInput = document.getElementById("ai-context-text");
  // Either source counts: the card covers the textarea AND the bundled file, so
  // a badge reading "optional" while the file is loaded and in every prompt
  // would be actively misleading.
  const hasContext = !!effectiveDraftContext();

  if (badge) {
    if (hasContext) {
      badge.textContent = "active";
      badge.className = "badge auto";
    } else {
      badge.textContent = "optional";
      badge.className = "badge";
    }
  }

  if (textInput && textInput.value !== (currentSettings.draftContext || "")) {
    textInput.value = currentSettings.draftContext || "";
  }
}

function setupAiContextListeners() {
  const textInput = document.getElementById("ai-context-text");
  const statusEl = document.getElementById("ai-context-status");
  if (!textInput) return;

  const saveContext = async (val) => {
    currentSettings.draftContext = val;
    updateAiContextUI();
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, draftContext: val }
    });
    if (statusEl) {
      statusEl.textContent = "Saved";
      setTimeout(() => {
        if (statusEl.textContent === "Saved") statusEl.textContent = "";
      }, 1500);
    }
    // Re-render rows to update context hints / buttons if rows exist
    if (currentRows && currentRows.length) {
      renderRows(currentRows);
    }
  };

  textInput.addEventListener("input", () => {
    if (statusEl) statusEl.textContent = "Saving…";
    clearTimeout(draftContextSaveTimeout);
    draftContextSaveTimeout = setTimeout(() => {
      saveContext(textInput.value);
    }, 300);
  });

  textInput.addEventListener("change", () => {
    clearTimeout(draftContextSaveTimeout);
    saveContext(textInput.value);
  });
}

// Anything we managed to fill is ticked by default. The list is for reviewing and
// unticking, not for picking, so a row is only left unticked when there is genuinely
// nothing to send: an unmatched field, or a resume slot with no compiled PDF loaded
// (matcher.js can't know about the PDF — it only sees the field).
function precheckFilled(rows) {
  return rows.map((row) => {
    if (row.include) return row;
    if (row.status === "unmatched") return row;
    if (row.status === "resume-upload") {
      return currentResumePdf ? { ...row, include: true } : row;
    }
    return row.value ? { ...row, include: true } : row;
  });
}

// ============================================================
// NEWLY LEARNED FIELD RULES
// ============================================================
//
// A rule is inert until approved (see learned.js), so a field the AI has just
// answered for the first time needs to be *offered* rather than filed silently.
// The banner offers both routes in one click each — approve everything now, or go
// and read the rules — because the alternative is a rule the user never learns
// about and cannot therefore trust.
//
// It names counts, never labels: the labels came off a web page and the popup is
// the wrong place to start trusting one. The review list in the options page
// shows every rule with the exact wording it was learned from.

function renderLearnedNotice(added) {
  const status = document.getElementById("scan-status");
  if (!status) return;

  let notice = document.getElementById("learned-notice");
  if (!added) {
    if (notice) notice.remove();
    return;
  }

  if (!notice) {
    notice = document.createElement("div");
    notice.id = "learned-notice";
    notice.className = "learned-notice";
    status.insertAdjacentElement("afterend", notice);
  }

  notice.innerHTML = "";

  const text = document.createElement("span");
  text.className = "learned-notice-text";
  text.textContent = `${added} field rule${added === 1 ? "" : "s"} learned — this label will be answered from your profile next time, with no AI call.`;
  notice.appendChild(text);

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "learned-approve";
  approveBtn.textContent = "Approve";
  approveBtn.addEventListener("click", async () => {
    approveBtn.disabled = true;
    await approveAllRules();
    notice.remove();
    Analytics.track("Field Rules Approved", { ats: currentAts, count: added, from: "popup" });
  });

  const reviewBtn = document.createElement("button");
  reviewBtn.type = "button";
  reviewBtn.className = "link-btn learned-review";
  reviewBtn.textContent = "Review";
  reviewBtn.title = "See every learned rule, and delete any you don't want";
  reviewBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

  notice.appendChild(approveBtn);
  notice.appendChild(reviewBtn);
}


function renderRows(rows) {
  currentRows = rows;
  // Kept in step with the row list on every render, so the batch button's count
  // and visibility can never drift from what is actually on screen.
  syncResolveButton();
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
    // Disabled only when there's genuinely nothing to attach. A site that
    // builds its file input on click still gets filled, via the drop target
    // rather than the input, so it must not be locked out.
    checkbox.disabled =
      row.status === "resume-upload"
        ? !currentResumePdf
        : row.status === "unmatched";
    checkbox.addEventListener("change", () => {
      currentRows[idx].include = checkbox.checked;
    });

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = row.label;
    // Said out loud, because an answer that came from a rule rather than from the
    // bundled table is exactly the one worth a second look.
    if (row.learned) {
      const note = document.createElement("span");
      note.className = "learned-note";
      note.textContent = " (learned)";
      note.title = `Answered from your profile: ${row.matchedPath}`;
      label.appendChild(note);
    }

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
      // Three states. The third is the one that matters on Google Forms: the field
      // is real and the resume is loaded, but this site hides its file input
      // behind a click, so the resume goes in by drop event instead of by
      // assignment. Whether the page accepts that is not guaranteed, so the
      // copy promises the attempt and names the manual fallback, rather than
      // promising an attachment that may not happen.
      if (row.resumeRequiresClick) {
        info.textContent = currentResumePdf
          ? `Will drop in ${currentResumePdf.filename} on this upload area. If nothing appears, click "Add file" and choose it yourself.`
          : "This form's file picker is built on click — and no compiled resume PDF is saved yet.";
      } else {
        info.textContent = currentResumePdf
          ? `Will attach: ${currentResumePdf.filename}`
          : currentResumePdfError
            ? `Can't attach a resume — ${currentResumePdfError}.`
            : "No compiled resume PDF saved yet — open Tailor Resume and upload the compiled PDF.";
      }
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
        const sourceBar = document.createElement("div");
        sourceBar.className = "draft-source-bar";

        const sourceNote = document.createElement("span");
        sourceNote.className = "muted";
        sourceNote.textContent = `Source: ${row.draftSource}`;
        sourceBar.appendChild(sourceNote);

        const actions = document.createElement("div");
        actions.className = "draft-source-actions";

        const regenBtn = document.createElement("button");
        regenBtn.type = "button";
        regenBtn.className = "link-btn regen-btn";
        regenBtn.textContent = "🔄 Regenerate";
        regenBtn.title = "Regenerate draft with latest context and profile";
        regenBtn.addEventListener("click", () => handleGenerateDraft(idx, regenBtn));
        actions.appendChild(regenBtn);

        const editContextBtn = document.createElement("button");
        editContextBtn.type = "button";
        editContextBtn.className = "link-btn";
        editContextBtn.textContent = "✏️ AI Context";
        editContextBtn.title = "View or modify custom context sent to AI";
        editContextBtn.addEventListener("click", () => {
          const container = document.getElementById("ai-context-container");
          if (container) {
            container.open = true;
            const txt = document.getElementById("ai-context-text");
            if (txt) {
              txt.focus();
              txt.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          }
        });
        actions.appendChild(editContextBtn);

        sourceBar.appendChild(actions);
        wrap.appendChild(sourceBar);
      }
    } else if (isDraftCandidate(row)) {
      const draftBox = document.createElement("div");
      draftBox.className = "draft-candidate-box";

      const actionRow = document.createElement("div");
      actionRow.className = "draft-action-row";

const draftBtn = document.createElement("button");
      // A choice group isn't drafted, it's answered — the button says so, because
      // "Generate Draft" next to a list of radio options reads as if it would write
      // an essay into the wrong sort of field.
      const isChoiceRow = row.tagName === "radiogroup";

      draftBtn.textContent = isChoiceRow
        ? (currentSettings.useLLM ? "Suggest with AI" : "Suggest")
        : (currentSettings.useLLM ? "Generate Draft (AI)" : "Generate Draft");
      draftBtn.className = "draft-btn";
      draftBtn.title = isChoiceRow
        ? "Pick the best option(s) from this question using your profile, then tick them automatically."
        : "Draft an answer to this field using your profile.";
      draftBtn.addEventListener("click", () => handleGenerateDraft(idx, draftBtn));
      actionRow.appendChild(draftBtn);

      const contextBtn = document.createElement("button");
      contextBtn.type = "button";
      contextBtn.className = "context-toggle-btn";
      const hasCtx = !!effectiveDraftContext();
      contextBtn.textContent = hasCtx ? "✏️ Context" : "➕ Context";
      contextBtn.title = hasCtx ? "Edit custom context for AI" : "Add custom context for AI";
      contextBtn.addEventListener("click", () => {
        const container = document.getElementById("ai-context-container");
        if (container) {
          container.open = true;
          const txt = document.getElementById("ai-context-text");
          if (txt) {
            txt.focus();
            txt.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }
      });
      actionRow.appendChild(contextBtn);
      draftBox.appendChild(actionRow);

      const contextHint = contextSummary();
      if (contextHint) {
        const hint = document.createElement("div");
        hint.className = "context-active-hint";
        hint.textContent = contextHint;
        draftBox.appendChild(hint);
      }

      wrap.appendChild(draftBox);
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

// Placeholder text some dropdown widgets (react-select, Workday select
// widgets) show before a choice is made. If scanFormFields captures one of
// these as a field's LABEL rather than its value, the widget's real label
// wasn't wired up yet (async hydration) at scan time — not a genuine
// unlabeled field. Kept in sync with PLACEHOLDER_LABELS in page-scripts.js,
// which filters the same texts out during the scan itself.
const GENERIC_DROPDOWN_LABELS = new Set([
  "select one",
  "select...",
  "select",
  "choose one",
  "choose...",
  "choose",
  "please select",
  "-- select --",
  "search",
  "search..."
]);

function hasGenericLabels(rows) {
  return rows.some((r) => GENERIC_DROPDOWN_LABELS.has((r.label || "").trim().toLowerCase()));
}

// ============================================================
// FRAMES
// ============================================================
//
// A job application is often not in the document you are looking at. Several
// companies — ChargePoint among them — serve a careers page whose entire
// content is a cross-origin <iframe> hosting the real form on the ATS. The top
// document then holds the site's own navigation and nothing else, so scanning it
// returns no application fields and no amount of waiting changes that: it reads
// as a page that is still rendering, and the scan burned all six rescans saying
// so before reporting "0 fields found" with the real cause — one iframe — only
// mentioned in passing.
//
// So the scan reads every frame and the fill is routed back to the frame each
// field came from. Two things make that safe:
//
//   - Each frame is matched against the adapter its OWN url calls for. A
//     Greenhouse form embedded in an employer's careers page is a Greenhouse
//     form, so resolving the adapter against the host page applies the wrong
//     selectors — or, as on chargepoint.com, the generic fallback to a page
//     whose whole content is the frame.
//
//   - Frame ids are folded into the uids the rest of the panel uses (see
//     frameUid), because scanFormFields() numbers its fields from af-0 in every
//     document it runs in. Two frames would hand back the same uid for two
//     different inputs, and every uid-keyed map in this panel — learned rules,
//     the AI draft queue, the fill payload — would silently drop one of them.
// ============================================================

// Frame 0 is the top document. Naming it is the same target as { tabId }, so
// every injection below can be routed the same way.
function frameTarget(tabId, frameId) {
  return frameId ? { tabId, frameIds: [frameId] } : { tabId };
}

function frameUid(frameId, uid) {
  return `f${frameId}-${uid}`;
}

function splitFrameUid(uid) {
  const match = /^f(\d+)-(.+)$/.exec(String(uid || ""));
  return match ? { frameId: Number(match[1]), uid: match[2] } : { frameId: 0, uid };
}

// Poll interval for the frame tree, and how many identical samples count as
// settled. Two samples is enough to catch a frame that is up but still
// streaming its questions, and short enough not to be felt on a page that has
// nothing to wait for.
const FRAME_POLL_MS = 150;
const FRAME_STABLE_POLLS = 2;

// What changed between two samples of the frame tree. Counts and load state
// only, never contents, so nothing read off the page leaves here.
function frameSignature(frames) {
  return frames
    .map((frame) => `${frame.frameId}:${frame.readyState}:${frame.controls}:${frame.frames}`)
    .join("|");
}

// Every frame that should exist is reporting, none is still parsing, and the
// counts have held still.
function framesAreSettled(frames, stable) {
  // The top document plus one per <iframe> declared anywhere in the tree. A
  // frame that has not finished loading cannot report anything about itself, so
  // it shows up here as a shortfall rather than as an empty frame.
  const expected = 1 + frames.reduce((total, frame) => total + (frame.frames || 0), 0);

  return (
    frames.length >= expected &&
    frames.every((frame) => frame.readyState !== "loading") &&
    stable >= FRAME_STABLE_POLLS
  );
}

async function sampleFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: describeFrames
  });

  return (results || []).map((entry) => ({ frameId: entry.frameId, ...(entry.result || {}) }));
}

// Reads every frame once, waiting while any of them is still loading.
//
// The wait is bounded and self-limiting, and an ordinary page pays nothing for
// it: with no <iframe> anywhere there is nothing that can still be loading, so
// this returns from the first sample without polling.
async function readFrames(tabId, timeoutMs = 2500) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, timeoutMs || 0);

  let frames = await sampleFrames(tabId);
  let stable = 0;
  let signature = frameSignature(frames);

  if (frames.length > 1 || frames.some((frame) => frame.frames > 0)) {
    while (!framesAreSettled(frames, stable) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));

      const next = await sampleFrames(tabId);
      const nextSignature = frameSignature(next);
      stable = nextSignature === signature ? stable + 1 : 0;
      frames = next;
      signature = nextSignature;
    }
  } else {
    // Nothing to wait for, so the single sample stands as the settled answer.
    stable = FRAME_STABLE_POLLS;
  }

  return { frames, settled: framesAreSettled(frames, stable), waited: Date.now() - startedAt };
}

function adapterForFrame(frame) {
  return frame.origin ? AtsRegistry.resolve(frame.origin) : currentAdapter;
}

// The pageConfig a frame must be filled with — the one that scanned it, not the
// one for the tab's URL. Falls back to the tab's adapter when the frame is not
// in the last scan (the user filled without scanning, say), which is the old
// behaviour.
function pageConfigForFrame(frameId) {
  const frame = currentFrames.find((entry) => entry.frameId === frameId);
  return frame ? frame.adapter.pageConfig : currentAdapter.pageConfig;
}

// Injects into one frame and hands back its return value, or null when the
// injection produced nothing — a frame can go away between being listed and being
// read, and that is a null answer, not an exception to destructure.
async function injectIntoFrame(tabId, frameId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: frameTarget(tabId, frameId),
    func,
    args
  });

  return (results && results[0] && results[0].result) || null;
}

// One frame's readiness signal. A failure here is not an error: it only means
// "no verdict", which leaves the scan un-settled so a rescan is still allowed to
// help — the same treatment the top document got before frames existed.
async function frameSettled(tabId, frame, adapter) {
  try {
    const ready = await injectIntoFrame(tabId, frame.frameId, waitForFormReady, [
      adapter.pageConfig,
      1800
    ]);
    return !!(ready && ready.settled);
  } catch {
    return false;
  }
}

// One frame's fields, tagged with the frame they came from. The error is
// returned rather than thrown: pages routinely embed frames that cannot be read
// (a sandboxed map, an opaque origin), and losing those must not cost the fields
// in the frames that can be.
async function scanFrame(tabId, frame, adapter, scanOptions) {
  try {
    const result = await injectIntoFrame(tabId, frame.frameId, scanFormFields, [
      adapter.pageConfig,
      scanOptions
    ]);

    return {
      frame,
      adapter,
      fields: (result || []).map((field) => ({
        ...field,
        uid: frameUid(frame.frameId, field.uid)
      }))
    };
  } catch (err) {
    return { frame, adapter, fields: [], error: err };
  }
}

async function scanCurrentTab(tabId, scanOptions = {}) {

  // Frames first, because the form is frequently not in the top document and a
  // frame that is still loading scans as a short but entirely well-formed
  // result — the fields it does have are read correctly and the rest are simply
  // absent, so nothing downstream can recover them.
  let frameList = null;
  try {
    frameList = await readFrames(tabId);
  } catch {
    // Frames could not be enumerated at all (host access off, a page Chrome
    // will not script). Reading the top document alone is the old behaviour,
    // which is better than not reading anything — and "not settled" is reported
    // so a rescan can still help.
    frameList = null;
  }

  const frames = frameList && frameList.frames.length
    ? frameList.frames
    : [{ frameId: 0, top: true, readyState: "complete", controls: 0, frames: 0, origin: null }];

  const targets = frames.map((frame) => ({ frame, adapter: adapterForFrame(frame) }));

  // Concurrent rather than sequential: every frame is waited on and scanned
  // independently, so a page with several frames costs one frame's wait instead
  // of the sum of them. Promise.all keeps the frame order either way.
  const settled = await Promise.all(
    targets.map(({ frame, adapter }) => frameSettled(tabId, frame, adapter))
  );
  const scans = await Promise.all(
    targets.map(({ frame, adapter }) => scanFrame(tabId, frame, adapter, scanOptions))
  );

  // A page where nothing at all could be read is the one case that is an error
  // rather than a short scan, and it is the case the "Could not scan this page"
  // message was written for.
  const unreadable = scans.filter((scan) => scan.error);
  if (unreadable.length === scans.length) {
    throw unreadable[0].error;
  }

  currentFrames = scans.map((scan) => ({
    frameId: scan.frame.frameId,
    top: !!scan.frame.top,
    origin: scan.frame.origin || null,
    readyState: scan.frame.readyState,
    adapter: scan.adapter,
    // How much this frame contributed to the scan, so the panel can report the
    // platform the form actually lives on rather than the one hosting it.
    fieldCount: scan.fields.length
  }));
  currentScanSettled = !!frameList && frameList.settled && settled.every(Boolean);

  const fields = scans.flatMap((scan) => scan.fields);
  currentScannedFields = fields;

  // Matched and overridden per frame, because both the dictionary's reading of a
  // field and any value override belong to the adapter — and two frames on one
  // page can be two different platforms.
  const rows = scans.flatMap(({ adapter, fields: frameFields }) => {
    // Dropped rows are diagnostic-only: the page returned fields it could see but
    // would not label. They must never reach matchFields(), which would show the
    // user rows with nothing to fill.
    const fillable = frameFields.filter((f) => !f.dropped);
    return applyAdapterValueOverrides(
      matchFields(fillable, currentProfile, learnedRules()),
      adapter.pageConfig
    );
  });

  currentMatchedRows = rows;
  return rows;
}


// Debugging aid: shows what the scanner actually saw next to what the matcher
// decided about it. When a field lands as "unmatched" there are two very
// different causes — the scanner read the wrong label, or it read the right one
// but the profile has no value for it — and they need opposite fixes. The popup
// row only shows the final label, so this dumps both stages verbatim.
//
// Rendered into a textarea rather than copied to the clipboard: the async
// clipboard API is denied in an extension popup unless the document is focused,
// which made this silently fail. Selecting and copying the text by hand works.
async function buildDiagnostics(tabId) {
  // debugDropped asks the scanner to report fields it had to discard, with
  // their markup. A question that scans as nothing at all is the case this
  // dump exists to explain.
  await scanCurrentTab(tabId, { debugDropped: true });
  const fields = currentScannedFields;

  let url = null;
  try {
    url = (await chrome.tabs.get(tabId)).url || null;
  } catch {
    // Not worth failing the dump over — the adapter name identifies the site.
  }

  return JSON.stringify(
    {
      url,
      adapter: currentAts,
      // Which frames the scan read, and the adapter each one matched. A field
      // found on a page whose visible content is one ATS iframe belongs to that
      // frame, and this is what makes that visible in the dump.
      frames: currentFrames.map((frame) => ({
        frameId: frame.frameId,
        top: frame.top,
        adapter: frame.adapter.id,
        readyState: frame.readyState
      })),
      // Only the parts that explain a match decision. Option text can run to
      // hundreds of entries per dropdown, which would bury the useful lines.
      scanned: (fields || []).map((f) => ({
        uid: f.uid,
        frameId: splitFrameUid(f.uid).frameId,
        label: f.label,
        tagName: f.tagName,
        inputType: f.inputType,
        optionCount: (f.options || []).length,
        // Why the scanner skipped a container, and its ownership counts.
        // A choice question that produced no row is otherwise invisible here.
        debug: f.debug || "",
        choiceScan: f.choiceScan || null,
        debugHtml: f.debugHtml || ""
      })),
      matched: (currentMatchedRows || []).map((r) => ({
        label: r.label,
        status: r.status,
        matchedPath: r.matchedPath || null,
        value: r.value === undefined ? null : r.value
      })),
      // Only the answer keys, so a stale saved profile is visible without
      // pasting the whole profile (which holds personal details).
      profileAnswers: (currentProfile && currentProfile.answers) || null
    },
    null,
    2
  );
}

// Some ATSs constrain a field to a broader vocabulary than the profile uses.
// Adapters can replace only the value sent to that site's form and provide
// option-text aliases, leaving the stored profile untouched.
function applyAdapterValueOverrides(rows, pageConfig) {
  const overrides = pageConfig.valueOverrides || {};
  return rows.map((row) => {
    const override = overrides[row.matchedPath];
    if (!override) return row;

    const normalized = typeof override === "string" ? { value: override } : override;
    return {
      ...row,
      value: normalized.value,
      accepts: [...new Set([...(row.accepts || []), ...(normalized.accepts || [])])]
    };
  });
}

// Asks the page why it has no fillable fields — see probePageState in
// page-scripts.js. Run against every frame and summed, because a page whose
// form is inside an iframe has all of its controls in that frame. Returns null
// if no frame could be probed at all, in which case the caller just falls back
// to a generic message.
async function probeCurrentTab(tabId) {
  const frames = currentFrames.length
    ? currentFrames
    : [{ frameId: 0, top: true, origin: null, adapter: currentAdapter }];

  const probes = await Promise.all(
    frames.map(async (frame) => {
      try {
        return await injectIntoFrame(tabId, frame.frameId, probePageState, [
          frame.adapter.pageConfig
        ]);
      } catch {
        return null;
      }
    })
  );

  const readable = probes.filter(Boolean);
  if (!readable.length) return null;

  const sum = (key) => readable.reduce((total, probe) => total + (probe[key] || 0), 0);
  // The largest frame's text, not the total: what "the page still looks empty"
  // means is that no single frame has anything on it yet.
  const textLength = readable.reduce((longest, probe) => Math.max(longest, probe.textLength || 0), 0);
  const loading = frames.filter((frame) => frame.readyState === "loading").length;

  return {
    // "loading" if any frame is still parsing — that is the state that makes a
    // short scan worth retrying, and one frame in that state is enough.
    readyState: loading > 0 ? "loading" : "complete",

    total: sum("total"),
    visible: sum("visible"),
    iframes: sum("iframes"),
    choiceGroups: sum("choiceGroups"),
    choiceOptions: sum("choiceOptions"),
    textLength,

    // Frame facts, so the empty-scan message can distinguish a form still
    // loading inside a frame from one that loaded and held no fields.
    frames: {
      scanned: frames.length,
      read: readable.length,
      loading
    }
  };
}

// The scan is not ready to be trusted when it found nothing at all. Workday's
// /apply/autofillWithResume parses the uploaded resume before it renders the
// form, so a scan fired right after landing legitimately returns zero fields —
// and an empty result contains no generic labels either, which is all the
// retry loop below used to watch for. So an empty page has to be retried too,
// not just a half-hydrated one.
//
// The probe adds the check that actually catches a half-rendered Google Form.
// Everything else here looks at the rows we produced, which are internally
// consistent however few of them there are: a scan that found the first of nine
// choice questions reads exactly as healthy as one that found all nine. The one
// thing that cannot be faked is the page itself — it holds a known number of
// choice options, and every option in a completed scan belongs to some row.
function scanLooksUnfinished(rows, probe) {
  if (rows.length === 0 || hasGenericLabels(rows)) {
    return true;
  }

  // Comparing containers instead would be wrong: a Google Form's questions are
  // wrapped in an outer role="list" that matches the same selector as the
  // questions and is deliberately not emitted, so the container count is always
  // a couple higher than the row count even when the scan is perfect.
  //
  // Every choice question has at least two options, so a shortfall of two or
  // more means a whole question is absent. One option is within the noise of
  // an option being hidden or carrying no value, and reacting to that would
  // burn every rescan on a page that was already complete.
  //
  // A page that has stopped adding controls is excluded: nothing is on its way,
  // so rescanning it cannot close the gap and the honest answer is to stop and
  // let the diagnostics dump explain the scanner, not to spend six rounds
  // rediscovering the same short scan.
  const MISSING_MIN = 2;

  const scannedOptions = rows.reduce(
    (total, row) => total + (Array.isArray(row.options) ? row.options.length : 0),
    0
  );

  if (probe && !currentScanSettled) {
    return probe.choiceOptions - scannedOptions >= MISSING_MIN;
  }

  return false;
}

// Human-readable explanation for a scan that found nothing. The two possible
// causes need opposite fixes, so say which one this looks like instead of
// leaving the user with a bare "0 fields found".
function describeEmptyScan(probe, attempts) {
  if (!probe) return "No fillable fields found on this page.";

  const bits = [];

  if (probe.visible > 0) {
    bits.push(`${probe.visible} visible control${probe.visible === 1 ? "" : "s"} present but not fillable`);
  } else if (probe.total > 0) {
    bits.push(`${probe.total} control${probe.total === 1 ? "" : "s"} in the DOM but none visible`);
  } else if (probe.textLength < 200) {
    bits.push("page still looks empty");
  }

  if (probe.frames && probe.frames.loading > 0) {
    bits.push(
      `${probe.frames.loading} of ${probe.frames.scanned} frame${probe.frames.scanned === 1 ? "" : "s"} still loading`
    );
  } else if (probe.frames && probe.frames.read < probe.frames.scanned) {
    // Some frame is on the page and could not be read at all — an embedded form
    // the extension has no access to is the one cause here worth naming.
    bits.push(
      `${probe.frames.scanned - probe.frames.read} of ${probe.frames.scanned} frames could not be read (site access off?)`
    );
  } else if (probe.iframes > 0) {
    // Every frame was read and none of them held application fields, which is a
    // different problem from a frame that has not arrived yet.
    bits.push(
      `${probe.frames.scanned} frame${probe.frames.scanned === 1 ? "" : "s"} read, none with a form`
    );
  }

  bits.push(`document ${probe.readyState}`);

  const retryNote = attempts > 0 ? ` after ${attempts} retr${attempts === 1 ? "y" : "ies"}` : "";

  return `No fillable fields found${retryNote} — ${bits.join(" · ")}.`;
}

async function handleScan() {
  const status = document.getElementById("scan-status");

  // Host access is declarative (manifest host_permissions), so Chrome grants it
  // at install and there is normally nothing to do here. This check only catches
  // the one case the extension cannot fix itself: the user switching this
  // extension's site access off in Chrome's own settings.
  if (!hasHostAccess) {
    status.textContent =
      "This extension cannot read this page. Turn its site access back on in Chrome's extension settings, then reload the page.";
    return;
  }

  const startedAt = performance.now();
  status.textContent = "Scanning…";

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    status.textContent = "No active tab found.";
    return;
  }

  try {
    let rows = await scanCurrentTab(tab.id);
    let probe = await probeCurrentTab(tab.id);

    // A single fixed-delay rescan isn't reliable across ATS platforms —
    // different custom dropdown widgets on the same page can hydrate their
    // real label at different times (seen on Greenhouse: some fields'
    // labels resolve within ~700ms, others noticeably later), so a field
    // that's still showing a generic placeholder like "Select..." as its
    // label after one retry isn't necessarily stuck — it just hasn't
    // hydrated yet. Poll a few more times before giving up, stopping the
    // moment the scan looks complete.
    //
    // The delay ramps up rather than staying fixed: the slow case is a page
    // that has to finish real work first (Workday parses the uploaded resume
    // before rendering the form, which takes several seconds), and a flat
    // 700ms would burn every retry inside the first two of those seconds.
    const MAX_RESCANS = 6;
    const RESCAN_DELAY_MS = 600;
    const RESCAN_DELAY_STEP_MS = 250;
    let attempt = 0;
    while (scanLooksUnfinished(rows, probe) && attempt < MAX_RESCANS) {
      attempt++;
      status.textContent = `Scanning… (waiting for page to finish rendering, attempt ${attempt}/${MAX_RESCANS})`;
      await new Promise((resolve) => setTimeout(resolve, RESCAN_DELAY_MS + attempt * RESCAN_DELAY_STEP_MS));
      rows = await scanCurrentTab(tab.id);
      probe = await probeCurrentTab(tab.id);
    }

    const autoCount = rows.filter((r) => r.status === "auto").length;
    const reviewCount = rows.filter((r) => r.status === "review").length;
    const unmatchedCount = rows.filter((r) => r.status === "unmatched").length;

    status.textContent = rows.length
      ? `${rows.length} fields found — ${autoCount} auto, ${reviewCount} need review, ${unmatchedCount} unmatched.`
      : describeEmptyScan(probe, attempt);

    renderRows(precheckFilled(rows));

    // The platform the form itself lives on, which need not be the platform of
    // the page hosting it: chargepoint.com serves a Greenhouse form inside an
    // iframe, and "other page, 0 fields" and "other page, greenhouse frame" are
    // entirely different bugs to go looking for. Still only the vendor enum (see
    // atsVendor in lib/analytics.js) — the frame's origin is never sent.
    const formFrame = [...currentFrames].sort((a, b) => b.fieldCount - a.fieldCount)[0];

    Analytics.trackTimed("Form Scanned", startedAt, {
      ats: currentAts,
      ats_frame: formFrame ? atsVendor(formFrame.origin) : "unknown",
      field_count: rows.length,
      auto_count: autoCount,
      review_count: reviewCount,
      unmatched_count: unmatchedCount,
      resume_upload_count: rows.filter((r) => r.status === "resume-upload").length,
      draftable_count: rows.filter(isDraftCandidate).length,
      // How many hydration rescans it took — if this trends toward MAX_RESCANS
      // on a platform, the polling window is too short there.
      rescan_attempts: attempt,
      // Why an empty scan came back empty, as counts only: a page whose form
      // controls exist but are all hidden means "not rendered yet", while
      // frames_read < frame_count alongside no visible controls means the form is
      // in a frame that could not be read at all. Both are page-shape facts,
      // never field values or a URL.
      dom_control_count: probe ? probe.total : -1,
      visible_control_count: probe ? probe.visible : -1,
      iframe_count: probe ? probe.iframes : -1,
      frame_count: currentFrames.length,
      frames_read: probe && probe.frames ? probe.frames.read : -1,
      frames_loading: probe && probe.frames ? probe.frames.loading : -1
    });
  } catch (err) {
    status.textContent = `Could not scan this page: ${err.message}`;
    Analytics.trackTimed("Form Scan Failed", startedAt, { ats: currentAts, error: err.message });
  }
}

// One click for every outstanding field, rather than one click per field.
//
// resolveFields() sends the whole outstanding list once and re-asks internally
// for anything the model failed to answer, so a single click is expected to
// clear the form. This is the default path because it is dramatically cheaper:
// the profile is the bulk of each prompt, so resolving a dozen fields separately
// re-uploads the same JSON a dozen times. The per-field button stays for
// retrying one field on its own.
async function handleResolveAll(buttonEl) {
  const status = document.getElementById("scan-status");
  const pending = currentRows.filter(isDraftCandidate);

  if (!pending.length) {
    status.textContent = "Nothing left for AI to resolve.";
    return;
  }

  const startedAt = performance.now();
  buttonEl.disabled = true;
  buttonEl.textContent = "Resolving…";
  status.textContent = `Asking AI about ${pending.length} field${pending.length === 1 ? "" : "s"}…`;

  try {
    const { results, source, declined, unanswered, calls, rounds, truncatedReplies, sources } = await resolveFields(
      pending,
      currentProfile,
      currentSettings,
      effectiveDraftContext()
    );

    if (!results.size) {
      status.textContent =
        "AI didn't answer any of these from your profile — nothing was changed. Fill them in by hand, or add detail to your AI context.";
      buttonEl.disabled = false;
      buttonEl.textContent = "Resolve All with AI";
      Analytics.trackTimed("Batch Resolve Declined", startedAt, {
        ats: currentAts,
        empty: true,
        use_llm: !!currentSettings.useLLM,
        requested_count: pending.length,
        truncated_replies: truncatedReplies || 0
      });
      return;
    }

    let groupsTicked = 0;
    let textDrafted = 0;

    const next = currentRows.map((row) => {
      const answer = results.get(row.uid);
      if (!answer) return row;

      if (answer.values) {
        groupsTicked += 1;
        return {
          ...row,
          value: answer.values.join(", "),
          values: answer.values,
          multiple: row.multiple === true,
          // A choice group can only be answered with an option the form already
          // offers, so there is nothing free-form to review — it goes in ready to
          // fill. The user can still untick it in the list.
          status: "auto",
          include: true,
          draftSource: source
        };
      }

      textDrafted += 1;
      return {
        ...row,
        value: answer.text,
        status: "review",
        // Ticked like every other filled field. The row still reads "review" so
        // it can be read before submitting, and unticking is one click.
        include: true,
        draftSource: source
      };
    });

    currentRows = next;
    renderRows(currentRows);
    // renderRows re-syncs the button, which resets its label and re-enables it.

    // A field the dictionary could not name is the one case where an AI answer
    // teaches something reusable, so this is where that is picked up: after the
    // rows are settled, so each claim can be checked against the value that was
    // actually applied. Nothing here changes a row — a rule is filed as pending
    // and stays inert until it is approved.
    const learnedResult = await learnFromResolution(sources, pending, currentProfile);
    renderLearnedNotice(learnedResult.added);
    if (learnedResult.added > 0) {
      Analytics.track("Field Rules Learned", {
        ats: currentAts,
        added: learnedResult.added,
        existing: learnedResult.existing,
        rejected: learnedResult.rejected,
        pending_total: pendingRuleCount()
      });
    }

    // The two reasons a field came back empty are worth telling apart: a decline
    // is the model saying the profile has no answer, while an unanswered field
    // just ran out of rounds. Only the second is worth another click.
    const declinedCount = Array.isArray(declined) ? declined.length : 0;
    const unansweredCount = Array.isArray(unanswered) ? unanswered.length : 0;
    const retryNote = calls > 1 ? ` across ${calls} AI calls` : "";

    const notes = [
      `${groupsTicked} ticked`,
      `${textDrafted} drafted for review`
    ];
    if (unansweredCount) notes.push(`${unansweredCount} still unanswered — click again to retry`);
    if (declinedCount) notes.push(`${declinedCount} no answer in your profile`);

    status.textContent = `Resolved ${results.size} of ${pending.length}${retryNote} — ${notes.join(", ")}.`;

    Analytics.trackTimed("Batch Resolved", startedAt, {
      ats: currentAts,
      empty: false,
      use_llm: !!currentSettings.useLLM,
      draft_source: source,
      requested_count: pending.length,
      resolved_count: results.size,
      declined_count: declinedCount,
      unanswered_count: unansweredCount,
      calls: calls || 1,
      rounds: rounds || 1,
      // Replies that stopped at the output ceiling, so the salvage path in
      // draft.js can be measured rather than guessed at. This is the number
      // that separates "the form is too big for one reply" from "the model
      // wouldn't answer" — they look identical in every other field here.
      truncated_replies: truncatedReplies || 0,
      groups_ticked: groupsTicked,
      texts_drafted: textDrafted
    });
  } catch (err) {
    status.textContent = `AI call failed: ${err.message} — nothing was changed.`;
    buttonEl.disabled = false;
    buttonEl.textContent = "Resolve All with AI";
    Analytics.trackTimed("Batch Resolve Failed", startedAt, {
      ats: currentAts,
      use_llm: !!currentSettings.useLLM,
      error: err.message
    });
  }
}


// Show the batch button only when it would actually do something, so the panel
// doesn't grow a button that errors on every page with nothing to resolve.
function syncResolveButton() {
  const btn = document.getElementById("resolve-btn");
  if (!btn) return;

  const pending = currentRows.filter(isDraftCandidate).length;
  btn.classList.toggle("hidden", pending === 0 || !currentSettings.useLLM);
  btn.textContent = pending > 1 ? `Resolve ${pending} Fields with AI` : "Resolve with AI";
  btn.disabled = false;
}


async function handleGenerateDraft(idx, buttonEl) {
  const row = currentRows[idx];
  const startedAt = performance.now();
  buttonEl.textContent = "Generating…";
  buttonEl.disabled = true;

  try {
    // A choice group is a different question to the model than a text box: it
    // has to answer with one of the options the form offers, not with prose.
    if (row.tagName === "radiogroup") {
      await suggestChoice(row, idx, buttonEl, startedAt);
      return;
    }

    const { text, source } = await generateDraft(row, currentProfile, currentSettings, effectiveDraftContext());
    if (!text) {
      buttonEl.textContent = "Not enough profile data — fill manually";
      buttonEl.disabled = false;
      Analytics.trackTimed("Draft Generated", startedAt, { ats: currentAts, empty: true, use_llm: !!currentSettings.useLLM });
      return;
    }
    currentRows[idx] = {
      ...row,
      value: text,
      status: "review",
      // An answered field is filled by default, whether this is its first draft or
      // a regenerate — so the row is ticked either way.
      include: true,
      draftSource: source
    };
    renderRows(currentRows);

    // `source` is one of the fixed labels from generateDraft ("AI · Groq",
    // "template (AI drafts off)", …) — a provider enum, not user content.
    Analytics.trackTimed("Draft Generated", startedAt, {
      ats: currentAts,
      empty: false,
      use_llm: !!currentSettings.useLLM,
      draft_source: source,
      has_custom_context: !!effectiveDraftContext(),
      // Which of the two context sources carried the answer. Presence and size
      // only — no content, and not the path itself.
      has_context_box: !!(currentSettings.draftContext || "").trim(),
      has_context_file: !!currentContextFile.text,
      // Length only — the drafted text itself is never transmitted.
      draft_length: text.length
    });
  } catch (err) {
    buttonEl.textContent = `Draft failed: ${err.message}`;
    buttonEl.disabled = false;
    Analytics.trackTimed("Draft Failed", startedAt, { ats: currentAts, use_llm: !!currentSettings.useLLM, error: err.message });
  }
}


// AI-assisted selection for a radio/checkbox group the dictionary left
// unresolved.
//
// Unlike a text draft, a successful selection is included automatically. The
// answer can only be one of the options the form itself offers, so there is
// nothing free-form for the user to review before it goes in — and the whole
// point of asking is to avoid ticking each box by hand. Anything else leaves
// the row exactly as it was: a provider error, or every provider declining, and
// the field stays untouched for the user.
async function suggestChoice(row, idx, buttonEl, startedAt) {
  const { values, source } = await chooseOptions(row, currentProfile, currentSettings, effectiveDraftContext());

  if (!values.length) {
    buttonEl.textContent = "No option matched — pick one yourself";
    buttonEl.disabled = false;
    Analytics.trackTimed("Draft Declined", startedAt, { ats: currentAts, empty: true, use_llm: !!currentSettings.useLLM });
    return;
  }

  currentRows[idx] = {
    ...row,
    value: values.join(", "),
    values,
    // A multi-select needs every value kept separately for the filler; a
    // single-select keeps `values` too so the row survives a re-render.
    multiple: row.multiple === true,
    status: "auto",
    include: true,
    draftSource: source
  };
  renderRows(currentRows);

  Analytics.trackTimed("Choice Suggested", startedAt, {
    ats: currentAts,
    empty: false,
    use_llm: !!currentSettings.useLLM,
    draft_source: source,
    multiple: row.multiple === true,
    // How many boxes were ticked, and how many the question offered. Counts
    // only — never the option text, which can carry personal detail.
    selected_count: values.length,
    option_count: (row.options || []).length
  });
}

async function handleFill() {
  const status = document.getElementById("fill-status");
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  const included = currentRows.filter((r) => r.include);
  const textPayload = included
    .filter((r) => r.status !== "resume-upload" && r.value)
    .map((r) => {
      // The uid the page knows this field by, plus the frame it lives in: both
      // are needed, because the page's own uid is only unique inside its frame
      // (see frameUid) and every field must be filled where it was scanned.
      const { frameId, uid } = splitFrameUid(r.uid);

      return {
        uid,
        frameId,
        label: r.label,
        value: r.value,
        // Alternate option texts for the same answer, so a Yes/No dropdown and a
        // select whose option reads "Authorized to work" are both satisfiable by
        // one profile entry. Empty unless the profile stores that answer as a
        // list (see the `answers` comment in schema.js).
        accepts: r.accepts || [],
        matchedPath: r.matchedPath,
        tagName: r.tagName,
        inputType: r.inputType,
        // Multi-select groups tick one box per entry in values[], so the filler
        // knows it may select several rather than stopping at the first match.
        ...(r.multiple ? { multiple: true, values: r.values || [] } : {})
      };
    });
  // Resume rows split by how the page accepts a file. Sites that ship a real
  // <input type="file"> get fillResumeFile(); ones that only build the input on
  // click (Google Forms) get fillResumeByDrop(), which uses the drop target the
  // file question also exposes instead of the input it hides. A row can only be
  // ticked when there is a PDF to send (see precheckFilled), and the fill reads
  // currentResumePdf.base64 unguarded, so the guard is repeated here rather than
  // left to the checkbox.
  const filePayload = included.filter(
    (r) => r.status === "resume-upload" && !!currentResumePdf
  );

  if (textPayload.length === 0 && filePayload.length === 0) {
    status.textContent = "Nothing selected to fill.";
    Analytics.track("Fill Attempted With Nothing Selected", { ats: currentAts, row_count: currentRows.length });
    return;
  }

  const startedAt = performance.now();
  status.textContent = "Filling…";

  try {
    let textOk = 0;
    let textTotal = 0;
    let fileOk = 0;
    let failures = [];

    if (textPayload.length) {
      // One call per frame, because that is the only way to address the frame a
      // field was scanned in. Grouped rather than issued per field: a frame's
      // fields go in a single fill, which is also what makes a multi-select group
      // work (see the `multiple` note on the payload above).
      const byFrame = new Map();
      for (const item of textPayload) {
        if (!byFrame.has(item.frameId)) byFrame.set(item.frameId, []);
        byFrame.get(item.frameId).push(item);
      }

      for (const [frameId, items] of byFrame) {
        // The adapter that scanned this frame is the one that has to fill it:
        // two frames on a page can be two different platforms, each with its own
        // widget handling.
        const pageConfig = pageConfigForFrame(frameId);

        const report = await injectIntoFrame(tab.id, frameId, fillFormFields, [
          items,
          pageConfig
        ]);

        const results = report || [];
        textOk += results.filter((r) => r.ok).length;
        textTotal += results.length;

        // Keep the failures and say which field each one belongs to.
        //
        // "filled 14/16 fields" leaves the user with nothing to act on — not even
        // which two fields failed, let alone why. The page script explains what
        // it observed at each step for a field it couldn't set, and that
        // explanation is the only thing that makes a stubborn widget debuggable.
        // Matched on frame as well as uid, since page uids repeat per frame.
        failures.push(
          ...results
            .filter((r) => !r.ok && r.reason)
            .map((r) => {
              const label =
                (items.find((p) => p.uid === r.uid) || {}).label || r.uid;

              return `${label}: ${r.reason}`;
            })
        );
      }
    }

    for (const row of filePayload) {
      // Resume uploads are per field, and each one has to happen in the frame
      // that holds the file input.
      const { frameId, uid } = splitFrameUid(row.uid);

      const result = await injectIntoFrame(tab.id, frameId, row.resumeRequiresClick ? fillResumeByDrop : fillResumeFile, [
        uid,
        currentResumePdf.base64,
        currentResumePdf.filename,
        currentResumePdf.mimeType
      ]);
      if (result && result.ok) {
        fileOk++;
      } else if (result && result.reason) {
        // Same reasoning as a failed text field: a resume the page silently
        // refused is the one thing the user is most likely to submit without.
        // Say so, and say what to do instead.
        failures.push(`${row.label || row.uid}: ${result.reason}`);
      }
    }

    const parts = [];
    if (textTotal) parts.push(`filled ${textOk}/${textTotal} fields`);
    if (filePayload.length) parts.push(`attached ${fileOk}/${filePayload.length} resume upload(s)`);
    status.textContent = `${parts.join(", ")}. Review the page before submitting.`;

    if (failures.length) {
      // One line per field that didn't take, so a failure can be acted on
      // instead of guessed at. These are long by design — each one is a
      // sentence describing what the page actually did.
      for (const failure of failures) {
        // A span, because the status element is one.
        const line = document.createElement("span");
        line.className = "fill-failure";
        line.textContent = failure;
        status.appendChild(line);
      }
    }

    Analytics.trackTimed("Fields Filled", startedAt, {
      ats: currentAts,
      text_selected: textTotal,
      text_filled: textOk,
      files_selected: filePayload.length,
      files_attached: fileOk,
      // Which of the scan's suggestions the user actually kept — the closest
      // proxy this extension has for match quality.
      auto_included: included.filter((r) => r.status === "auto").length,
      review_included: included.filter((r) => r.status === "review").length,
      edited_drafts_included: included.filter((r) => r.draftSource).length
    });
  } catch (err) {
    status.textContent = `Fill failed: ${err.message}`;
    Analytics.trackTimed("Fill Failed", startedAt, { ats: currentAts, error: err.message });
  }
}

async function init() {
  Analytics.init("popup");

  currentProfile = await loadProfile();
  currentSettings = await loadSettings();

  setupAiContextListeners();
  updateAiContextUI();

  // The long-form half of the context, from the file the user edits on disk.
  // Read here so every draft in this panel sees the same snapshot, and so a
  // broken path shows up in the context card instead of silently doing nothing.
  currentContextFile = await loadBundledContext(currentSettings);
  renderContextFileNotice();

  // Shared resolver (schema.js): uploaded PDF first, then
  // settings.resumePdfPath. Its `error` is kept for the resume row's message.
  const resume = await loadResumePdf(currentSettings);
  currentResumePdf = resume.pdf;
  currentResumePdfError = resume.error;

  // Approved learned rules, before any scan can run: matching is synchronous and
  // reads them from memory, so a scan that beat this load would quietly resolve
  // every learned label as unmatched.
  await loadLearnedRules();

  const tab = await getActiveTab();
  currentAts = atsVendor(tab && tab.url);
  currentAdapter = AtsRegistry.resolve(tab && tab.url);

  // Scanned before the "no profile" early-return below, so the access notice
  // is already correct if the panel is later given a profile.
  await refreshHostAccess(tab);
  await refreshTrackButton();

  Analytics.track("Popup Opened", {
    ats: currentAts,
    has_profile: !!currentProfile,
    has_resume_pdf: !!currentResumePdf,
    use_llm: !!currentSettings.useLLM
  });

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
document.getElementById("resolve-btn").addEventListener("click", (event) => handleResolveAll(event.currentTarget));
document.getElementById("fill-btn").addEventListener("click", handleFill);
document.getElementById("access-btn").addEventListener("click", () => {
  document.getElementById("scan-status").textContent =
    "Site access is controlled in Chrome: open chrome://extensions, find this extension, and set Site access to 'On all sites'.";
});
document.getElementById("diag-btn").addEventListener("click", async () => {
  const status = document.getElementById("diag-status");
  const box = document.getElementById("diag-text");
  try {
    const text = await buildDiagnostics((await getActiveTab()).id);
    box.value = text;
    box.classList.remove("hidden");
    box.select();
    status.textContent = "Select-all and copy the JSON below.";
  } catch (err) {
    // Surface the reason. Swallowing it here is what made the first version of
    // this button useless — it failed for a typo and looked like the page could
    // not be read.
    status.textContent = `Diagnostics failed: ${err && err.message}`;
  }
});
function openOptionsFrom(entryPoint) {
  Analytics.track("Options Opened From Popup", { ats: currentAts, entry_point: entryPoint });
  chrome.runtime.openOptionsPage();
}

// Minimize = dismiss the panel and keep it dismissed.
//
// Disabling the side panel is what actually closes it, so that write is the
// dismissal and window.close() is deliberately not called: a side panel is not
// a window Chrome will close for us. The flag is stored rather than kept in a
// variable because this document can be torn down at any point, so nothing
// held here would survive to be read back. Key and panel path must stay in step
// with background.js.
document.getElementById("minimize-btn").addEventListener("click", async () => {
  Analytics.track("Panel Minimized", { ats: currentAts });

  const ignored = (result) => (result && typeof result.catch === "function" ? result.catch(() => {}) : Promise.resolve());

  // Flag first: background.js reconciles the enabled/disabled state from it on
  // the next worker start, so a failed panel write can never leave the panel
  // permanently disabled with nothing recording why.
  await ignored(chrome.storage.local.set({ panelMinimized: true }));
  await ignored(chrome.sidePanel?.setOptions({ path: "src/popup/popup.html", enabled: false }));
});

document.getElementById("open-options").addEventListener("click", () => openOptionsFrom("no-profile-prompt"));
document.getElementById("footer-options").addEventListener("click", () => openOptionsFrom("footer"));
// Grabs the JD off the current job page before handing off to the Resume
// tab, so tailoring doesn't require copy-pasting it by hand. Best-effort:
// scanJobDescription() (see page-scripts.js) always returns *something*
// (falls back to a largest-text-block guess), so this never blocks opening
// the Resume page — worst case the JD textarea opens empty, same as before.
document.getElementById("footer-resume").addEventListener("click", async () => {
  const tab = await getActiveTab();
  let pendingJD = null;

  if (tab && tab.url) {
    await refreshHostAccess(tab);
  }

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

  // Only the scrape's outcome is reported (which strategy won, how much text,
  // whether it was capped) — never the job description itself.
  Analytics.track("Resume Tailoring Opened", {
    ats: currentAts,
    jd_captured: !!pendingJD,
    jd_source: pendingJD ? pendingJD.source : "none",
    jd_length: pendingJD ? pendingJD.text.length : 0,
    jd_truncated: pendingJD ? !!pendingJD.truncated : false
  });

  chrome.tabs.create({ url: chrome.runtime.getURL("src/resume/resume.html") });
});

// ---- Job tracking ----
//
// Logs the posting you're currently looking at to the Dashboard. One button, two
// states: a job that isn't on the board yet gets added as "saved", and one that
// already is gets moved to "applied" — which is the only transition this button
// ever makes, so pressing it twice can't walk a job up the pipeline by accident.
// Anything beyond that (interview, offer, rejected) is the Dashboard's business,
// where the stage sits next to the rest of the pipeline.
//
// The label is re-derived from the tracked row on every render, so a job tracked
// from the Dashboard tab shows the right label when the panel is reopened.
const trackBtn = document.getElementById("footer-track");

function renderTrackButton(application) {
  if (!trackBtn) return;
  if (!application) trackBtn.textContent = "Track Job";
  else if (application.status === "saved") trackBtn.textContent = "Mark Applied";
  else trackBtn.textContent = "Tracked ✓";
}

async function currentTrackedJob() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) return null;
  const items = await Tracker.list();
  return items.find((item) => item.url === tab.url) || null;
}

async function refreshTrackButton() {
  renderTrackButton(await currentTrackedJob());
}

trackBtn.addEventListener("click", async () => {
  trackBtn.disabled = true;
  const existing = await currentTrackedJob();

  try {
    const updated = existing
      ? await Tracker.setStatus(existing.id, "applied")
      : await Tracker.trackActiveTab("applied");
    renderTrackButton(updated);
    Analytics.track("Job Tracked", { ats: currentAts, from_popup: true, already_tracked: !!existing });
  } catch (err) {
    trackBtn.textContent = "Couldn't track";
  } finally {
    trackBtn.disabled = false;
  }
});

document.getElementById("footer-dashboard").addEventListener("click", () => {
  Analytics.track("Dashboard Opened From Popup", { ats: currentAts });
  chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
});

init();
