// Dashboard page: stat tiles, the five-column board, and the add/edit/delete
// actions behind every card.
//
// Renders from scratch on each change rather than diffing the DOM. The list is
// small (tens of rows), and a full redraw is what keeps the column counts and
// the tiles from ever disagreeing with the cards.

const insightsEl = document.getElementById("insights");
const boardEl = document.getElementById("board");
const emptyEl = document.getElementById("empty");
const noticeEl = document.getElementById("notice");
const addPanel = document.getElementById("add-panel");
const addForm = document.getElementById("add-form");
const addStatusSelect = document.getElementById("add-status");
const addStatusMsg = document.getElementById("add-status-msg");

let items = [];

// Monotonic token for inline edits. Opening a new inline edit bumps it; an
// older edit's finishing repaint is then skipped, otherwise the commit-refresh
// of card A would repaint the board and destroy the input just opened on
// card B. The newer edit's own finish repaints instead.
let editEpoch = 0;

// The panel is always in the DOM (the dashboard is the only place that can run
// Gmail's consent window, since chrome.identity.launchWebAuthFlow needs a live
// document), so its elements are looked up lazily by the functions that use
// them. That also keeps the board's own wiring above this one readable.
const mail = {};

// Job-discovery panel state, the same shape as `mail` — looked up lazily, one
// flag so a storage-driven repaint never fights a run in progress.
const discover = { running: false, settings: null };

// Bumped whenever the Gmail import changes. Chrome keeps serving the previously
// loaded dashboard scripts to an already-open tab even after the extension is
// reloaded, so without a visible stamp there is no way to tell whether a panel
// is showing current code or a cached copy from before a fix. If this does not
// read `DASHBOARD_BUILD` below, hard-reload the tab.
const DASHBOARD_BUILD = "discover-2026-10-06a";

function byId(id) {
  return document.getElementById(id);
}

function showNotice(text, kind = "info") {
  noticeEl.textContent = text;
  noticeEl.className = `banner ${kind}`;
  noticeEl.classList.remove("hidden");
}

function clearNotice() {
  noticeEl.classList.add("hidden");
  noticeEl.textContent = "";
}

function tile(value, label) {
  return `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
}

function renderInsights(list) {
  const insights = Tracker.computeInsights(list);
  insightsEl.innerHTML = [
    tile(String(insights.week), "Applied this week"),
    tile(String(insights.month), "Applied (30d)"),
    tile(Tracker.formatPercent(insights.responseRate), "Response rate"),
    tile(Tracker.formatPercent(insights.offerRate), "Offer rate"),
    tile(String(insights.interviews), "Interviews"),
    tile(String(insights.total), "Total tracked")
  ].join("");
}

function statusOptions(selected) {
  return Tracker.STATUSES.map(
    (status) => `<option value="${status}"${status === selected ? " selected" : ""}>${status}</option>`
  ).join("");
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

// Hover text for a discovery rating: the three numbers a triage decision
// needs, in the order they are asked for.
function ratingTitle(match) {
  const bits = [`Match ${match.pct}%`];
  if (Number.isFinite(match.shortlist)) bits.push(`shortlist chance ${match.shortlist}%`);
  if (Array.isArray(match.reasons) && match.reasons.length) bits.push(match.reasons.join(" · "));
  return bits.join(" — ");
}

// Stars stored by the scorer, with the percentage as the fallback for a card
// written by an older build that had the rating but not the star count.
function ratingStars(match) {
  const stars = Number(match.stars);
  if (Number.isFinite(stars) && stars >= 1 && stars <= 5) return Math.round(stars);
  return Math.max(1, Math.min(5, Math.round(Number(match.pct || 0) / 20)));
}

// A card is three facts and three controls. Anything longer (notes, the full
// URL) lives behind the card's own row on the dashboard rather than being
// truncated here — the board is for triage, not for reading.
function renderCard(item) {
  const role = escapeHtml(item.title || "Untitled role");
  const company = escapeHtml(item.company || "Unknown company");
  const source = item.source ? `<span class="source">${escapeHtml(item.source)}</span>` : "";
  // Marks a card that came from Gmail rather than a button press. Worth its own
  // glyph: an imported row's title is a machine's best guess, and the user
  // should be able to spot those to correct first.
  const fromEmail = item.sourceEmailId
    ? '<span class="mail-mark" title="Imported from Gmail">✉</span>'
    : "";
  // The date a card leads with is the date of the event it is showing — when
  // the application went out, or when the rejection arrived — not the moment
  // the row was last written, which every sync would otherwise turn into
  // "today" for the whole board. Saved cards have no event yet, so they fall
  // back to the save date.
  const stamp = item.status === "rejected"
    ? item.rejectedAt || item.appliedAt || item.savedAt
    : item.appliedAt || item.savedAt;
  const age = Tracker.relativeTime(stamp);
  const exactDate = Number.isFinite(stamp) ? new Date(stamp).toLocaleDateString() : "";
  // The discovery rating, when the card came from the job finder. Stars for a
  // glance; the full breakdown — match percentage, shortlist chance, and the
  // reasons — lives in the hover title so the card stays three lines.
  const rating = item.match && Number.isFinite(item.match.pct)
    ? `<span class="rating" title="${escapeHtml(ratingTitle(item.match))}">${"★".repeat(ratingStars(item.match))}${"☆".repeat(5 - ratingStars(item.match))} ${item.match.pct}%</span>`
    : "";
  const open = item.url
    ? `<a class="icon-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer" title="Open job posting">↗</a>`
    : "";

  return `
    <div class="app-card" data-id="${escapeHtml(item.id)}">
      <div class="role edit-field" title="Click to edit title">${role}${fromEmail}</div>
      <div class="company edit-field" title="Click to edit company">${company}</div>
      <div class="meta">${rating}${source}<span${exactDate ? ` title="${escapeHtml(exactDate)}"` : ""}>${escapeHtml(age)}</span></div>
      <div class="actions">
        <select class="status-select" title="Move to another stage">${statusOptions(item.status)}</select>
        ${open}
        <button class="icon-link danger" data-action="delete" title="Delete">✕</button>
      </div>
    </div>`;
}

// Board order inside a column: the displayed percentage, highest first. That
// is the number on the card, so it is the number the order has to agree with —
// the AI pass also writes a hidden shortlist chance, and ranking by that made
// a card showing 25% sit above one showing 70%. Shortlist chance only breaks
// a tie between equal percentages. Cards with no rating at all — saved by hand
// or imported from mail — sort last, and Array#sort is stable so equally
// rated cards keep the recency order they arrived in.
function byRating(a, b) {
  const am = a.match;
  const bm = b.match;
  const ap = am && Number.isFinite(am.pct) ? am.pct : -1;
  const bp = bm && Number.isFinite(bm.pct) ? bm.pct : -1;
  if (ap !== bp) return bp - ap;
  const as = am && Number.isFinite(am.shortlist) ? am.shortlist : -1;
  const bs = bm && Number.isFinite(bm.shortlist) ? bm.shortlist : -1;
  return bs - as;
}

function renderBoard(list) {
  boardEl.innerHTML = Tracker.COLUMNS.map((column) => {
    const columnItems = list
      .filter((item) => item.status === column.id)
      .sort(byRating);
    const cards = columnItems.length
      ? columnItems.map(renderCard).join("")
      : '<p class="column-empty">Nothing here</p>';

    return `
      <div class="column">
        <div class="column-head">
          <span class="dot ${column.id}"></span>${column.label}
          <span class="count">${columnItems.length}</span>
        </div>
        <div class="cards">${cards}</div>
      </div>`;
  }).join("");

  emptyEl.classList.toggle("hidden", list.length > 0);
  boardEl.classList.toggle("hidden", list.length === 0);
}

async function refresh() {
  items = await Tracker.listByRecency();
  renderInsights(items);
  renderBoard(items);
}

// Delegated so a card re-rendered by any other action keeps working — there are
// no per-card listeners to rebind, and no listener left pointing at a row that
// has since moved to a different column.
boardEl.addEventListener("change", async (event) => {
  const select = event.target.closest(".status-select");
  if (!select) return;

  const id = select.closest(".app-card").dataset.id;
  try {
    await Tracker.setStatus(id, select.value);
    await refresh();
  } catch (err) {
    showNotice(`Could not move that application: ${err.message}`, "err");
    await refresh();
  }
});

boardEl.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="delete"]');
  if (!button) return;

  const id = button.closest(".app-card").dataset.id;
  await Tracker.remove(id);
  await refresh();
  showNotice("Application deleted.", "ok");
});

// Inline rename of a card's role or company. The title and company on a tracked
// card are machine guesses (page-title / sender heuristics), so both need to be
// correctable in place. Clicking the text swaps it for an input; Enter/blur
// saves, Escape discards. Delegated for the same reason the status handler is:
// a repaint must not leave a listener dangling.
boardEl.addEventListener("click", (event) => {
  const field = event.target.closest(".edit-field");
  const card = event.target.closest(".app-card");
  if (!field || !card) return;

  const id = card.dataset.id;
  const key = field.classList.contains("role") ? "title" : "company";
  const item = items.find((it) => it.id === id);
  if (!item) return;
  const epoch = ++editEpoch;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit";
  input.value = item[key] || "";
  input.placeholder = key === "company" ? "Company name" : "Role / title";
  field.replaceWith(input);
  input.focus();
  input.select();

  // Blur is the commit point, so a stray click (e.g. on the card's own select)
  // saves cleanly instead of leaving an orphan input behind.
  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (!commit || !value) {
      if (epoch === editEpoch) await refresh();
      return;
    }
    try {
      await Tracker.save({ id, [key]: value });
      showNotice(key === "company" ? "Company updated." : "Title updated.", "ok");
    } catch (err) {
      showNotice(`Could not save: ${err.message}`, "err");
    }
    if (epoch === editEpoch) await refresh();
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    if (ev.key === "Escape") {
      ev.stopPropagation();
      input.removeEventListener("blur", onBlur);
      finish(false);
    }
  });
  const onBlur = () => finish(true);
  input.addEventListener("blur", onBlur);
});

for (const status of Tracker.STATUSES) {
  const option = document.createElement("option");
  option.value = status;
  option.textContent = status;
  addStatusSelect.appendChild(option);
}
addStatusSelect.value = "saved";

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addStatusMsg.textContent = "";

  const draft = {
    title: document.getElementById("add-title").value.trim(),
    company: document.getElementById("add-company").value.trim(),
    url: document.getElementById("add-url").value.trim(),
    status: addStatusSelect.value,
    notes: document.getElementById("add-notes").value.trim()
  };

  if (!draft.title && !draft.url) {
    addStatusMsg.className = "status-msg err";
    addStatusMsg.textContent = "Give it a job title or a URL so it can be found again.";
    return;
  }

  if (draft.url && !/^https?:\/\//i.test(draft.url)) {
    addStatusMsg.className = "status-msg err";
    addStatusMsg.textContent = "The URL needs to start with http:// or https://";
    return;
  }

  await Tracker.save(draft);
  addForm.reset();
  addStatusSelect.value = "saved";
  addPanel.open = false;
  await refresh();
  showNotice("Added to your dashboard.", "ok");
});

document.getElementById("add-cancel").addEventListener("click", () => {
  addForm.reset();
  addStatusSelect.value = "saved";
  addPanel.open = false;
});

document.getElementById("refresh").addEventListener("click", async () => {
  await refresh();
  showNotice("Refreshed.", "ok");
});

document.getElementById("export-csv").addEventListener("click", () => {
  if (!items.length) {
    showNotice("Nothing to export yet.", "warn");
    return;
  }
  const blob = new Blob([Tracker.toCsv(items)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "applications.csv";
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!items.length) return;
  if (!confirm(`Delete all ${items.length} tracked applications? This cannot be undone.`)) return;
  await Tracker.clear();
  await refresh();
  showNotice("All applications cleared.", "ok");
});

// Another page (the side panel's Track Job button) can add a row while this tab
// is open, so keep the board live instead of showing a stale snapshot.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.applications) refresh();
  // The background worker writes its own summary, and a sync started from the
  // alarm lands here with no UI open at all.
  if (changes.emailSyncState && !mail.syncing) renderLastRun();
  // The discovery engine writes its own last-run summary too — from this page
  // normally, but the same rule applies: never repaint over a live run.
  if (changes.discoverState && !discover.running) renderDiscoverLastRun();
});

// ---- Gmail import panel -------------------------------------------------
//
// Everything here runs in the page rather than the service worker for one
// reason: chrome.identity.launchWebAuthFlow opens a real consent window, and a
// service worker Chrome is free to suspend mid-flow is the wrong place for that.
// The scheduled run itself lives in background.js, behind an alarm.

// Reads the merged settings the same way every other page does, so a value
// placed in the bundled src/data/settings.json shows up here without being
// retyped.
async function loadPanelSettings() {
  const { settings: override } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    const res = await fetch(chrome.runtime.getURL("src/data/settings.json"));
    if (res.ok) bundled = await res.json();
  } catch {
    // mergeSettings still supplies DEFAULT_SETTINGS and the stored overrides.
  }

  return mergeSettings(bundled, override);
}

// Written field by field rather than replacing the record: `settings` also holds
// the provider keys, the analytics token and the theme, and clobbering it from
// a mail panel would be a spectacular way to lose an API key.
async function savePanelSettings(patch) {
  const { settings: existing = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...existing, ...patch } });
  return { ...existing, ...patch };
}

function mailStatus(text, kind = "") {
  const el = byId("mail-status-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

function setupStatus(text, kind = "") {
  const el = byId("mail-setup-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

// Copy buttons for the two values that have to be pasted into Google Cloud
// character for character. Google compares redirect URIs as exact strings, so a
// transcribed one is a `redirect_uri_mismatch` with no other visible cause --
// worth removing transcription from the loop entirely.
function initCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = byId(String(button.dataset.copy || "").replace(/^#/, ""));
      const value = String((source && source.textContent) || "").trim();
      if (!value) {
        setupStatus("Nothing to copy yet.", "err");
        return;
      }

      const label = button.textContent;
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
      } catch {
        // Clipboard access is denied in some extension contexts, and the older
        // path still works there.
        const scratch = document.createElement("textarea");
        scratch.value = value;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        const copied = document.execCommand("copy");
        scratch.remove();
        button.textContent = copied ? "Copied" : "Press Ctrl+C";
      }
      setTimeout(() => {
        button.textContent = label;
      }, 1600);
    });
  });
}

function renderLastRun() {
  const el = byId("mail-last-run");
  if (!el) return;

  return MailImport.readSyncState().then((state) => {
    // Cleared first, on every path. A reason left over from the previous run
    // would describe a sync that no longer exists.
    renderSyncFailures([]);

    if (!state || !state.at) {
      el.textContent = "Never synced yet.";
      return;
    }

    const when = new Date(state.at).toLocaleString();
    if (!state.ok) {
      el.textContent = `Last attempt ${when} — ${state.notes[0] || "it did not finish."}`;
      return;
    }

    const bits = [`Last synced ${when}`];
    if (state.added) bits.push(`${state.added} new`);
    if (state.updated) bits.push(`${state.updated} moved stage`);
    if (state.datesFixed) bits.push(`${state.datesFixed} dates corrected`);
    if (state.skipped) bits.push(`${state.skipped} already imported`);
    if (state.failed) bits.push(`${state.failed} unreadable`);
    bits.push(`${state.scanned} matching emails`);
    if (state.aiEnriched) bits.push(`${state.aiEnriched} read by AI`);
    if (state.aiSkipped) bits.push(`${state.aiSkipped} read locally (over the AI limit)`);
    if (state.aiFailed) bits.push(`${state.aiFailed} AI call(s) failed, read locally`);

    el.textContent = `${bits.join(" · ")}.`;

    // Every unreadable message, not just a count. "5 unreadable" on its own is
    // unactionable: the reason is in the notes, and it is the only place it
    // appears, so hiding it turns a diagnosable problem into a shrug.
    const reasons = (state.notes || []).filter((note) => /could not read|skipped one message/i.test(note));
    if (reasons.length) {
      const shown = reasons.slice(0, 3);
      const more = reasons.length - shown.length;
      renderSyncFailures([
        ...shown.map((note) => note.replace(/^(could not read|skipped one message) one message:\s*/i, "")),
        ...(more > 0 ? [`…and ${more} more`] : [])
      ]);
    }
  });
}

// The reason each email could not be read, listed under the sync summary. Shown
// as its own block rather than appended to the summary line, because these are
// error strings that need room and are the thing to read when nothing was
// imported.
function renderSyncFailures(reasons) {
  const box = byId("mail-last-run-errors");
  if (!box) return;

  box.textContent = "";
  if (!reasons || !reasons.length) {
    box.classList.add("hidden");
    return;
  }

  const label = document.createElement("strong");
  label.textContent = reasons.length === 1 ? "Why one email could not be read:" : "Why emails could not be read:";
  box.appendChild(label);

  for (const reason of reasons) {
    const line = document.createElement("code");
    line.className = "fail-line";
    line.textContent = reason;
    box.appendChild(line);
  }
  box.classList.remove("hidden");
}

function renderConnection(connection) {
  const stateEl = byId("mail-conn-state");
  const connectBtn = byId("mail-connect");
  const disconnectBtn = byId("mail-disconnect");
  const noteEl = byId("mail-conn-note");
  const setupEl = byId("mail-setup");

  // The Google Cloud steps only matter until there is something to paste.
  if (setupEl) setupEl.classList.toggle("hidden", !!mail.clientId);

  if (!stateEl) return;

  if (connection.connected) {
    stateEl.textContent = connection.email ? `Connected · ${connection.email}` : "Connected";
    stateEl.className = "pill on";
    if (connectBtn) connectBtn.classList.add("hidden");
    if (disconnectBtn) disconnectBtn.classList.remove("hidden");
    if (noteEl) noteEl.textContent = "Read-only access to Gmail. Revoke it from your Google account at any time.";
    return;
  }

  stateEl.textContent = "Not connected";
  stateEl.className = "pill";
  if (connectBtn) {
    connectBtn.classList.remove("hidden");
    // Nothing to connect until there is a client id, and the button saying
    // "Connect Gmail" before the user can possibly do so is a dead end.
    connectBtn.disabled = !mail.clientId;
  }
  if (disconnectBtn) disconnectBtn.classList.add("hidden");
  if (noteEl) noteEl.textContent = mail.clientId
    ? "Grants read-only access so confirmation emails can be read. You can revoke it from your Google account at any time."
    : "Save a Google OAuth client id above first.";
}

async function refreshConnection() {
  const connection = await Gmail.getConnection(mail.settings);
  renderConnection(connection);
  return connection;
}

// One sync, one place. Every trigger — the button, the first import after
// connecting, and simply opening the dashboard — runs this, so the progress
// line, the last-run line and the board refresh cannot drift apart between
// them. Runs here rather than in the worker so progress can be reported as it
// happens; the worker's own scheduled alarm is a separate, silent run.
//
// force: true means "run whether or not the automatic schedule is switched
// on", which is right for anything the user just asked for with a click or a
// page load. Only the background alarm respects the schedule toggle.
async function runMailSync({ force = true, auto = false } = {}) {
  if (mail.syncing) return null;

  const button = byId("mail-sync-now");
  mail.syncing = true;
  if (button) button.disabled = true;

  try {
    mailStatus(auto ? "Checking your mail…" : "Reading your mail…", "busy");
    const report = await MailImport.runSync({
      settings: await loadPanelSettings(),
      force,
      onProgress: ({ phase, done, total }) => {
        if (!total) return;
        mailStatus(phase === "fetch" ? `Reading emails… ${done}/${total}` : `Reading applications… ${done}/${total}`, "busy");
      }
    });

    if (!report.ok) {
      mailStatus(report.notes[0] || "The sync did not finish.", "err");
    } else if (!report.scanned) {
      mailStatus("No matching emails found. Try a broader Gmail search above.", "warn");
    } else {
      const parts = [];
      if (report.added) parts.push(`${report.added} added`);
      if (report.updated) parts.push(`${report.updated} moved stage`);
      if (report.datesFixed) parts.push(`${report.datesFixed} dates corrected`);
      if (report.skipped) parts.push(`${report.skipped} already imported`);
      if (report.failed) parts.push(`${report.failed} unreadable`);
      mailStatus(parts.length ? `${parts.join(", ")}.` : "Nothing new to import.", "ok");
    }

    renderLastRun();
    await refresh();
    return report;
  } catch (err) {
    mailStatus(err.message, "err");
    return null;
  } finally {
    mail.syncing = false;
    if (button) button.disabled = false;
  }
}

async function initMailPanel() {
  const panel = byId("mail-panel");
  if (!panel) return;

  // Stamped before anything else, so it is visible even if the rest of this
  // function throws.
  const buildEl = byId("mail-build");
  if (buildEl) buildEl.textContent = DASHBOARD_BUILD;

  mail.settings = await loadPanelSettings();
  mail.clientId = String(mail.settings.gmailClientId || "").trim();

  const clientIdInput = byId("mail-client-id");
  if (clientIdInput) clientIdInput.value = mail.clientId;

  // The secret is deliberately never written back into the input: a blank field
  // means "keep what is stored", which is what makes it safe to screenshot the
  // dashboard and what lets the placeholder report whether one exists at all.
  const secretInput = byId("mail-client-secret");
  if (secretInput) {
    secretInput.value = "";
    secretInput.placeholder = mail.settings.gmailClientSecret
      ? "Saved — type to replace"
      : "GOCSPX-…";
  }
  const clearSecret = byId("mail-clear-secret");
  if (clearSecret) clearSecret.checked = false;

  // Show the extension id and the exact redirect URI this build will send, so
  // they can be compared against the Application ID registered in Google Cloud.
  // This mismatch is the only cause of `redirect_uri_mismatch`, and it is
  // otherwise completely invisible from inside the extension.
  const extIdEl = byId("mail-ext-id");
  if (extIdEl) extIdEl.textContent = chrome.runtime.id || "(unavailable)";

  const redirectEl = byId("mail-redirect-uri");
  if (redirectEl && chrome.identity && chrome.identity.getRedirectURL) {
    redirectEl.textContent = chrome.identity.getRedirectURL();
  }

  initCopyButtons();

  const enabled = byId("mail-enabled");
  const every = byId("mail-every");
  const time = byId("mail-time");
  const lookback = byId("mail-lookback");
  const query = byId("mail-query");
  const useAi = byId("mail-use-ai");

  if (enabled) enabled.checked = !!mail.settings.emailSyncEnabled;
  if (time) time.value = mail.settings.emailSyncTime || "09:00";
  if (query) query.value = mail.settings.emailSyncQuery || "";
  if (useAi) useAi.checked = mail.settings.emailUseAi !== false;

  // The daily time only means something on the daily schedule; on the hourly
  // ones it still anchors the first run, but showing it would invite the user
  // to set a time the alarm then ignores.
  const syncEvery = () => {
    const value = every ? every.value : "daily";
    return ["1h", "2h", "daily"].includes(value) ? value : "2h";
  };
  const renderTimeRow = () => {
    const row = byId("mail-time-row");
    if (row) row.classList.toggle("hidden", syncEvery() !== "daily");
  };
  if (every) {
    const stored = String(mail.settings.emailSyncEvery || "2h");
    every.value = ["1h", "2h", "daily"].includes(stored) ? stored : "2h";
    every.addEventListener("change", renderTimeRow);
  }
  renderTimeRow();

  const days = String(mail.settings.emailLookbackDays || 30);
  // Fall back to the closest option rather than leaving the select blank: a
  // stored value of 45 is a real state and silently showing "30 days" would
  // hide it.
  if (lookback) {
    if ([...lookback.options].some((option) => option.value === days)) lookback.value = days;
    else lookback.selectedIndex = 1;
  }

  const aiConfigured = configuredProviders(mail.settings).length > 0;
  if (useAi && !aiConfigured) {
    useAi.checked = false;
    useAi.disabled = true;
    const note = useAi.closest("label");
    if (note) note.title = "Add an API key on the API Keys page to turn this on.";
  }

  const connection = await refreshConnection();
  renderLastRun();

  byId("mail-save-client").addEventListener("click", async () => {
    const value = (byId("mail-client-id").value || "").trim();
    if (value && !/\.apps\.googleusercontent\.com$/.test(value)) {
      setupStatus("That does not look like a Google client id — it should end in apps.googleusercontent.com.", "err");
      return;
    }
    await savePanelSettings({ gmailClientId: value });

    // Three outcomes, and conflating them is how a secret silently disappears:
    // a typed value replaces, an empty field keeps, the checkbox clears.
    const secretInput = byId("mail-client-secret");
    const clearInput = byId("mail-clear-secret");
    const typed = String((secretInput && secretInput.value) || "").trim();
    const shouldClear = !!(clearInput && clearInput.checked);
    let secretNote = "";
    if (shouldClear) {
      await savePanelSettings({ gmailClientSecret: "" });
      secretNote = " Client secret cleared.";
    } else if (typed) {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(typed)) {
        setupStatus("That does not look like a Google client secret — it should be GOCSPX-…", "err");
        return;
      }
      await savePanelSettings({ gmailClientSecret: typed });
      secretNote = " Client secret saved.";
      if (secretInput) secretInput.value = "";
    }

    mail.clientId = value;
    mail.settings = await loadPanelSettings();
    setupStatus(
      (value ? "Saved. Now connect your Gmail." : "Client ID cleared.") + secretNote,
      "ok"
    );
    await refreshConnection();
  });

  byId("mail-connect").addEventListener("click", async () => {
    mailStatus("Waiting for Google's consent screen…", "busy");
    try {
      // The settings are re-read rather than reused: saving the client id is a
      // separate click, and a stale copy here is the difference between a
      // working connection and a Google error about an unknown client.
      const connection = await Gmail.connect({ settings: await loadPanelSettings() });
      renderConnection(connection);
      // The grant is done, so the first import runs itself. Making the user
      // press Sync now once to see their own history is exactly the extra
      // click this panel should not have.
      await runMailSync({ force: true, auto: true });
    } catch (err) {
      renderConnection({ connected: false });
      mailStatus(err.message, "err");
    }
  });

  byId("mail-disconnect").addEventListener("click", async () => {
    await Gmail.disconnect();
    renderConnection({ connected: false });
    mailStatus("Disconnected. Nothing is read from Gmail until you connect again.", "ok");
  });

  byId("mail-save").addEventListener("click", async () => {
    const patch = {
      emailSyncEnabled: !!(enabled && enabled.checked),
      emailSyncEvery: syncEvery(),
      emailSyncTime: (time && time.value) || "09:00",
      emailLookbackDays: Number((lookback && lookback.value) || 30),
      emailSyncQuery: (query && query.value.trim()) || MailImport.DEFAULT_QUERY,
      emailUseAi: !!(useAi && useAi.checked)
    };

    await savePanelSettings(patch);
    mail.settings = await loadPanelSettings();

    // The alarm lives in the worker, which is asleep by now; this is the nudge
    // that makes the saved time take effect without waiting for a restart.
    const res = await chrome.runtime
      .sendMessage({ type: "mail:reschedule" })
      .catch(() => null);

    const when = res && res.when ? new Date(res.when).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const rhythm =
      patch.emailSyncEvery === "1h" ? "every hour"
      : patch.emailSyncEvery === "2h" ? "every 2 hours"
      : `every day at ${(time && time.value) || "09:00"}`;
    mailStatus(
      patch.emailSyncEnabled
        ? `Saved. Checking your mail ${rhythm} — next run ${when}.`
        : "Saved. The automatic check is off; Sync now still works.",
      "ok"
    );
  });

  byId("mail-sync-now").addEventListener("click", () => runMailSync({ force: true }));

  byId("mail-reset").addEventListener("click", async () => {
    if (!confirm("Forget which emails have already been imported? The next sync will read them again — existing cards are updated rather than duplicated, but titles and companies may be re-guessed.")) return;

    await MailImport.ledger.clear();
    mailStatus("Cleared. Press Sync now to read your mail again.", "ok");
  });

  // Opening the dashboard is itself a sync trigger: the board is what the user
  // came to read, and it should already hold this morning's mail rather than
  // waiting for a click on a button whose job is only "catch up now". The
  // worker's scheduled alarm still covers the days the dashboard is not
  // opened; this covers the moment it is. Fire-and-forget — the board renders
  // from storage either way, and the status line reports the outcome.
  if (connection && connection.connected) {
    runMailSync({ force: true, auto: true }).catch(() => {});
  }
}

// ---- job discovery panel -------------------------------------------------
//
// The engine lives in discover.js and is UI-free; this panel is its settings
// form, its progress line and its trigger. It runs in the page (like the mail
// sync does) because progress has to be visible, and because opening a search
// tab is something the user should see happen rather than wonder about.

function discoverStatus(text, kind = "") {
  const el = byId("discover-status-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

// Same storage-then-bundled fallback as the popup's loadProfile, so discovery
// scores against the real profile without a trip to Options first.
async function loadProfileForDiscover() {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile) return profile;

  try {
    const res = await fetch(chrome.runtime.getURL("src/data/profile.json"));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function renderDiscoverLastRun() {
  const el = byId("discover-last-run");
  if (!el || typeof Discover === "undefined") return;

  const state = await Discover.readState();
  if (!state || !state.at) {
    el.textContent = "Not searched yet.";
    return;
  }

  const bits = [`Last searched ${Tracker.relativeTime(state.at)}`];
  if (state.scanned) bits.push(`${state.scanned} listings found`);
  if (state.added) bits.push(`${state.added} added`);
  if (state.updated) bits.push(`${state.updated} refreshed`);
  if (state.alreadyTracked) bits.push(`${state.alreadyTracked} already tracked`);
  if (state.aiScored) bits.push(`${state.aiScored} shortlist-scored`);
  el.textContent = `${bits.join(" · ")}.`;
}

// One search, one place — the same reasoning as runMailSync: the button, and
// the automatic run on open, must produce identical status lines and identical
// board refreshes.
async function runDiscoverNow({ auto = false } = {}) {
  if (discover.running || typeof Discover === "undefined") return null;

  const button = byId("discover-run");
  discover.running = true;
  if (button) button.disabled = true;

  try {
    discoverStatus(auto ? "Searching for jobs…" : "Searching job boards…", "busy");
    const settings = await loadPanelSettings();
    const profile = await loadProfileForDiscover();

    const report = await Discover.run({
      settings,
      profile,
      onProgress: ({ phase, done, total }) => {
        if (!total) return;
        const label =
          phase === "scrape" ? "Reading listings"
          : phase === "score" ? "Rating matches"
          : "Adding to the board";
        discoverStatus(`${label}… ${done}/${total}`, "busy");
      }
    });

    if (!report.ok) {
      discoverStatus(report.notes[0] || "The search did not finish.", "err");
    } else if (!report.scanned) {
      discoverStatus("No listings found.", "warn");
    } else {
      const parts = [];
      if (report.added) parts.push(`${report.added} added`);
      if (report.updated) parts.push(`${report.updated} refreshed`);
      if (report.alreadyTracked) parts.push(`${report.alreadyTracked} already tracked`);
      if (report.aiScored) parts.push(`${report.aiScored} shortlist-scored`);
      discoverStatus(
        `Found ${report.scanned} listings — ${parts.length ? parts.join(", ") : "nothing new"}.`,
        "ok"
      );
    }

    await renderDiscoverLastRun();
    await refresh();
    return report;
  } catch (err) {
    discoverStatus(err.message, "err");
    return null;
  } finally {
    discover.running = false;
    if (button) button.disabled = false;
  }
}

async function initDiscoverPanel() {
  const panel = byId("discover-panel");
  if (!panel) return;

  // Stamped before anything else, the same way the mail panel does it, so a
  // panel rendered from a stale cached dashboard.js is visible at a glance.
  const buildEl = byId("discover-build");
  if (buildEl) buildEl.textContent = DASHBOARD_BUILD;

  // discover.js is its own script tag; a dashboard served from a cached copy
  // that predates it must degrade to "no panel" rather than die with a
  // ReferenceError before the board renders.
  if (typeof Discover === "undefined") return;

  const rolesEl = byId("discover-roles");
  const locationEl = byId("discover-location");
  const maxEl = byId("discover-max");
  const autoEl = byId("discover-auto");
  const useAiEl = byId("discover-use-ai");

  discover.settings = await loadPanelSettings();
  const settings = discover.settings;

  if (rolesEl) rolesEl.value = (settings.discoverRoles || []).join(", ");
  if (locationEl) locationEl.value = settings.discoverLocations || "";
  if (maxEl) maxEl.value = String(settings.discoverMaxJobs || Discover.DEFAULT_MAX_JOBS);
  if (autoEl) autoEl.checked = settings.discoverAuto !== false;
  if (useAiEl) {
    useAiEl.checked = settings.discoverUseAi !== false;
    // Same rule as the mail panel's AI toggle: no configured provider, no
    // checkbox — with the reason on hover instead of a mystery greyed box.
    const configured = typeof configuredProviders === "function" && configuredProviders(settings).length > 0;
    if (!configured) {
      useAiEl.checked = false;
      useAiEl.disabled = true;
      const note = useAiEl.closest("label");
      if (note) note.title = "Add an API key on the API Keys page to turn this on.";
    }
  }

  await renderDiscoverLastRun();

  const saveBtn = byId("discover-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const patch = {
        discoverRoles: String((rolesEl && rolesEl.value) || "")
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean),
        discoverLocations: String((locationEl && locationEl.value) || "").trim(),
        discoverMaxJobs: Math.max(1, Math.min(50, Number((maxEl && maxEl.value) || Discover.DEFAULT_MAX_JOBS))),
        discoverAuto: !!(autoEl && autoEl.checked),
        discoverUseAi: !!(useAiEl && useAiEl.checked)
      };

      await savePanelSettings(patch);
      discover.settings = await loadPanelSettings();
      discoverStatus("Saved. “Find jobs now” uses it straight away.", "ok");
    });
  }

  const runBtn = byId("discover-run");
  if (runBtn) {
    runBtn.addEventListener("click", () => runDiscoverNow());
  }

  // The page-head button: the one thing on the dashboard that says "jobs" in
  // plain words. It opens the panel so the settings and the progress line are
  // on screen, then runs the same search as the panel's own button.
  const findBtn = byId("find-jobs");
  if (findBtn) {
    findBtn.addEventListener("click", () => {
      panel.open = true;
      if (typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      runDiscoverNow();
    });
  }

  // Automatic, and throttled: every run opens real tabs on real job sites, so
  // a board opened ten times a day must not mean ten crawls. The interval
  // lives in discover.js (2h); the button above ignores it entirely.
  if (settings.discoverAuto && (await Discover.shouldAutoRun())) {
    runDiscoverNow({ auto: true }).catch(() => {});
  }
}

refresh();
initMailPanel().catch((err) => mailStatus(err.message, "err"));
initDiscoverPanel().catch((err) => discoverStatus(err.message, "err"));