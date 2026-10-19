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

// The controller for the sync currently running in this tab, so the Stop
// button can cancel it. Null when nothing is running — which is also what the
// Stop handler checks before doing anything.
let mailSyncController = null;

// Job-discovery panel state, the same shape as `mail` — looked up lazily, one
// flag so a storage-driven repaint never fights a run in progress.
const discover = { running: false, settings: null };

// Bumped whenever the Gmail import changes. Chrome keeps serving the previously
// loaded dashboard scripts to an already-open tab even after the extension is
// reloaded, so without a visible stamp there is no way to tell whether a panel
// is showing current code or a cached copy from before a fix. If this does not
// read `DASHBOARD_BUILD` below, hard-reload the tab.
const DASHBOARD_BUILD = "mail-ai-only-2026-10-16a";

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
  // The schedule's own keys, written by the worker when it arms an alarm. A
  // next-run line and the history repaint from these even though the last-run
  // line above did not change.
  if ((changes.schedulerStatus || changes.emailSyncHistory) && !mail.syncing) renderMailSchedule();
  // Naukri: the alarm's run writes all three of these from the worker, so the
  // panel stays live without a reload.
  if (changes.naukriRefreshState || changes.naukriRefreshHistory || changes.schedulerStatus) renderNaukriStatus();
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

// The look-back is a free-text count now, so the value has to survive a blank
// box, a stray letter, a fraction and the absurd. One day is the floor (Gmail's
// newer_than needs an integer) and ten years is the ceiling, which is past any
// real inbox history and keeps a mistyped "99999999" from asking Gmail for the
// whole account.
const LOOKBACK_MIN_DAYS = 1;
const LOOKBACK_MAX_DAYS = 3650;

function clampLookbackDays(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < LOOKBACK_MIN_DAYS) return 30;
  return Math.min(n, LOOKBACK_MAX_DAYS);
}

// The dedicated AI tally for the mail sync. It is its own row rather than part
// of the transient status line because the counts are the thing the user wants
// to watch tick by, and they must stay put after the run ends. `stats` is
// either a live progress tick or a persisted report — both carry
// aiOn / aiEnriched / aiSkipped / aiFailed / deferred.
function renderAiStats(stats) {
  const el = byId("mail-ai-stats");
  if (!el) return;

  const deferred = (stats && stats.deferred) || 0;
  const on = !!(stats && (stats.aiOn || stats.aiEnriched || stats.aiSkipped || stats.aiFailed || deferred));
  if (!on) {
    el.textContent = "";
    el.className = "ai-stats hidden";
    return;
  }

  const enriched = stats.aiEnriched || 0;
  const skipped = stats.aiSkipped || 0;
  const failed = stats.aiFailed || 0;
  let text = `AI: ${enriched} enriched · ${skipped} skipped · ${failed} failed`;
  if (deferred) text += ` · ${deferred} waiting for AI`;
  el.textContent = text;
  el.className = `ai-stats${failed || deferred ? " warn" : ""}`;
}

function renderLastRun() {
  const el = byId("mail-last-run");
  if (!el) return;

  return MailImport.readSyncState().then((state) => {
    // Cleared first, on every path. A reason left over from the previous run
    // would describe a sync that no longer exists.
    renderSyncFailures([]);
    // The persisted AI tally, so the counts survive a page reload even when
    // this run's progress ticks happened minutes ago.
    renderAiStats(state);

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
    if (state.ignored) bits.push(`${state.ignored} not job-related`);
    if (state.failed) bits.push(`${state.failed} unreadable`);
    bits.push(state.full ? `${state.scanned} emails read` : `${state.scanned} matching emails`);
    if (state.aiEnriched) bits.push(`${state.aiEnriched} read by AI`);
    // In AI-only mode a skipped or failed email is not imported at all, so the
    // wording must not promise a local fallback that did not happen.
    if (state.aiSkipped) {
      bits.push(state.aiRequired
        ? `${state.aiSkipped} over the AI limit`
        : `${state.aiSkipped} read locally (over the AI limit)`);
    }
    if (state.aiFailed) {
      bits.push(state.aiRequired
        ? `${state.aiFailed} AI call(s) failed`
        : `${state.aiFailed} AI call(s) failed, read locally`);
    }
    if (state.deferred) bits.push(`${state.deferred} waiting for AI — will retry`);

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

// One bounded run-history list, shared by the mail and Naukri panels. The
// <details> wrapper is hidden entirely when there is nothing to list, rather
// than showing an empty "Recent runs" row that promises history and gives
// none.
function renderHistory(ulId, boxId, entries, describe) {
  const ul = byId(ulId);
  const box = byId(boxId);
  if (!ul || !box) return;

  ul.textContent = "";
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    box.classList.add("hidden");
    return;
  }

  for (const entry of list) {
    const li = document.createElement("li");
    li.textContent = describe(entry);
    ul.appendChild(li);
  }
  box.classList.remove("hidden");
}

// The mail schedule's "next check" line and its run history. Separate from
// renderLastRun because they read different keys: the last run is
// emailSyncState, the schedule and the history are the scheduler's own keys,
// and a settings/schedule change must repaint this without touching the last
// run's summary.
async function renderMailSchedule() {
  const nextEl = byId("mail-next-run");
  if (nextEl) {
    const status = await SchedulerState.readSchedulerStatus();
    const nextAt = status.emailSync && status.emailSync.nextAt;
    nextEl.textContent = nextAt
      ? `Next automatic check ${SchedulerState.formatNextRun(nextAt)} (${new Date(nextAt).toLocaleString()}).`
      : "Automatic check is off — press Read & Sync to run one now.";
  }

  const history = await SchedulerState.readEmailHistory();
  renderHistory("mail-history", "mail-history-box", history, SchedulerState.describeEmailRun);
}

function renderConnection(connection) {
  const stateEl = byId("mail-conn-state");
  const connectBtn = byId("mail-connect");
  const disconnectBtn = byId("mail-disconnect");
  const noteEl = byId("mail-conn-note");

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
  if (connectBtn) connectBtn.classList.remove("hidden");
  if (disconnectBtn) disconnectBtn.classList.add("hidden");
  if (noteEl) noteEl.textContent = "Grants read-only access so confirmation emails can be read. You can revoke it from your Google account at any time.";
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
async function runMailSync({ force = true, auto = false, full = false } = {}) {
  if (mail.syncing || mail.rechecking) return null;

  const button = byId("mail-sync-now");
  const stopButton = byId("mail-sync-stop");
  const recheckButton = byId("mail-recheck");
  mail.syncing = true;
  // One controller per run. Its signal is what Stop trips; the run reads it
  // between messages and between Gmail pages, so a stop lands within an
  // in-flight request rather than after the whole window has been read.
  mailSyncController = new AbortController();
  if (button) button.disabled = true;
  // The re-check reads the same Gmail quota and writes the same board, so the
  // two must never run at once.
  if (recheckButton) recheckButton.disabled = true;
  if (stopButton) {
    stopButton.hidden = false;
    stopButton.disabled = false;
  }

  try {
    mailStatus(auto ? "Checking your mail…" : full ? "Reading every mail in the window…" : "Reading your mail…", "busy");
    // Fresh tally for this run; the first progress tick fills it in.
    renderAiStats(null);
    const report = await MailImport.runSync({
      settings: await loadPanelSettings(),
      force,
      full,
      signal: mailSyncController.signal,
      onProgress: ({ phase, done, total, aiOn, aiEnriched = 0, aiSkipped = 0, aiFailed = 0, deferred = 0 }) => {
        const counts = total ? ` ${done}/${total}` : "";
        const label =
          phase === "enrich"
            ? `Using AI…${counts}`
            : phase === "fetch"
              ? `Reading emails…${counts}`
              : phase === "parse"
                ? `Reading applications…${counts}`
                : "";
        if (!label) return;
        // The AI tallies ride along on every tick from enrichment onwards, so
        // "how much was read by AI / skipped / failed" stays visible while the
        // run is still going instead of only appearing in the final report.
        const ai = aiOn
          ? ` · AI: ${aiEnriched} enriched, ${aiSkipped} skipped, ${aiFailed} failed${deferred ? `, ${deferred} waiting` : ""}`
          : "";
        mailStatus(`${label}${ai}`, "busy");
        // Same counters in their own always-visible row, so they are readable
        // during the run and don't scroll past with the status text.
        renderAiStats({ aiOn, aiEnriched, aiSkipped, aiFailed, deferred });
      }
    });

    if (report && report.aborted) {
      const kept = report.added + report.updated;
      mailStatus(
        kept
          ? `Stopped — ${kept} application${kept === 1 ? "" : "s"} from the emails already read ${kept === 1 ? "was" : "were"} kept.`
          : "Stopped. Nothing had been imported yet.",
        "warn"
      );
    } else if (!report.ok) {
      mailStatus(report.notes[0] || "The sync did not finish.", "err");
    } else if (!report.scanned) {
      mailStatus(full ? "No mail found in this window." : "No matching emails found. Try a broader Gmail search above.", "warn");
    } else {
      const parts = [];
      if (report.added) parts.push(`${report.added} added`);
      if (report.updated) parts.push(`${report.updated} moved stage`);
      if (report.datesFixed) parts.push(`${report.datesFixed} dates corrected`);
      if (report.skipped) parts.push(`${report.skipped} already imported`);
      if (report.ignored) parts.push(`${report.ignored} not job-related`);
      if (report.aiRejected) parts.push(`${report.aiRejected} rejected by AI`);
      if (report.failed) parts.push(`${report.failed} unreadable`);
      if (report.aiEnriched) parts.push(`${report.aiEnriched} enriched by AI`);
      if (report.aiSkipped) parts.push(`${report.aiSkipped} over the AI limit`);
      if (report.aiFailed) parts.push(`${report.aiFailed} AI failed`);
      if (report.deferred) parts.push(`${report.deferred} waiting for AI — will retry next sync`);
      const summary = parts.length ? `${parts.join(", ")}.` : "Nothing new to import.";
      mailStatus(report.notes.length ? `${summary} ${report.notes[0]}` : summary, "ok");
    }

    renderLastRun();
    await refresh();
    return report;
  } catch (err) {
    mailStatus(err.message, "err");
    return null;
  } finally {
    mail.syncing = false;
    mailSyncController = null;
    if (button) button.disabled = false;
    if (recheckButton) recheckButton.disabled = false;
    if (stopButton) {
      stopButton.hidden = true;
      stopButton.disabled = false;
    }
  }
}

// The line under the mail panel summarising the last AI re-check. Reads the
// persisted report so it survives a reload the same way the sync's last-run
// line does; an explicit report passed in (straight after a run) skips the read.
async function renderRecheckLastRun(report) {
  const el = byId("mail-recheck-last");
  if (!el) return;

  const state = report || (await MailImport.readReclassifyState());
  if (!state || !state.at) {
    el.textContent = "";
    return;
  }

  const when = new Date(state.at).toLocaleString();
  if (!state.ok) {
    el.textContent = `Last re-check ${when} — ${(state.notes && state.notes[0]) || "it did not finish."}`;
    return;
  }

  const bits = [`Last re-checked ${when}`];
  if (state.moved) bits.push(`${state.moved} moved`);
  if (state.renamed) bits.push(`${state.renamed} renamed`);
  if (state.unchanged) bits.push(`${state.unchanged} already right`);
  const windowDays = Number(state.lookbackDays) || 0;
  if (state.unmatched) {
    bits.push(
      windowDays
        ? `${state.unmatched} not checked (no email within ${windowDays} days — raise Look back)`
        : `${state.unmatched} not checked (no matching email in the window)`
    );
  }
  bits.push(`${state.matched} of ${state.rechecked} matched`);
  el.textContent = `${bits.join(" · ")}.`;
}

// The AI re-check: read the window again, ask AI for the stage behind every
// imported card, and move each one to whatever the AI decides — including
// backwards, which a normal sync deliberately never does. One place, like
// runMailSync, so the button and its status line cannot drift apart.
async function runMailReclassify() {
  if (mail.rechecking || mail.syncing) return null;

  const button = byId("mail-recheck");
  const syncButton = byId("mail-sync-now");
  mail.rechecking = true;
  if (button) button.disabled = true;
  if (syncButton) syncButton.disabled = true;

  try {
    mailStatus("Re-reading your applications with AI…", "busy");
    // Fresh tally for this run; the enrichment ticks fill it in.
    renderAiStats(null);

    const settings = await loadPanelSettings();
    const windowDays = clampLookbackDays(settings.emailLookbackDays);
    const report = await MailImport.reclassifyWithAi({
      settings,
      onProgress: ({ phase, done, total, aiEnriched = 0, aiFailed = 0 }) => {
        const label =
          phase === "fetch"
            ? "Reading emails"
            : phase === "enrich"
              ? "Asking AI"
              : phase === "apply"
                ? "Moving cards"
                : "";
        if (!label) return;
        mailStatus(`${label}…${total ? ` ${done}/${total}` : ""}`, "busy");
        if (phase === "enrich") renderAiStats({ aiOn: true, aiEnriched, aiFailed });
      }
    });

    await renderRecheckLastRun(report);
    // Persist the final AI tally on the stats row, not just the live ticks, so
    // the counts stay put after the run ends.
    if (report && report.ok) renderAiStats(report);

    if (!report || !report.ok) {
      mailStatus((report && report.notes[0]) || "The re-check did not finish.", "err");
    } else if (!report.rechecked) {
      mailStatus("Nothing to re-check — no cards have been imported from Gmail yet.", "warn");
    } else if (report.aiFailed && !report.aiEnriched) {
      // Every call failed, so nothing could be matched. Saying "no emails
      // matched" here would send the user chasing the look-back window when the
      // real problem is the provider, so the failure is named outright.
      const reason = (report.notes || []).find((note) => /^AI provider failed:/.test(note));
      mailStatus(
        `AI could not read your email — all ${report.aiFailed} call${report.aiFailed === 1 ? "" : "s"} failed. ${reason ? reason.replace(/^AI provider failed:\s*/, "") : "Check your API key on the API Keys page and try again."}`,
        "err"
      );
    } else if (!report.matched) {
      mailStatus(
        `None of your ${report.rechecked} imported card${report.rechecked === 1 ? "" : "s"} had an email in the last ${windowDays} day${windowDays === 1 ? "" : "s"}, so nothing could be checked. Raise Look back above and run it again.`,
        "warn"
      );
    } else {
      const bits = [];
      if (report.moved) bits.push(`${report.moved} moved`);
      if (report.renamed) bits.push(`${report.renamed} renamed`);
      if (report.unchanged) bits.push(`${report.unchanged} already right`);
      if (report.unmatched) {
        bits.push(
          `${report.unmatched} not checked (their emails are older than the ${windowDays}-day look-back — raise Look back and re-run)`
        );
      }
      if (report.aiFailed) bits.push(`${report.aiFailed} AI call${report.aiFailed === 1 ? "" : "s"} failed`);
      mailStatus(
        `Re-checked ${report.matched} of ${report.rechecked} card${report.rechecked === 1 ? "" : "s"} — ${bits.length ? bits.join(", ") : "nothing changed"}.`,
        "ok"
      );
    }

    await refresh();
    return report;
  } catch (err) {
    mailStatus(err.message, "err");
    return null;
  } finally {
    mail.rechecking = false;
    if (button) button.disabled = false;
    if (syncButton) syncButton.disabled = false;
  }
}

// The "start over" path: wipe the board and the imported-email ledger, then read
// the whole look-back window again so every tab is rebuilt from the mail itself.
//
// Clearing the ledger is what makes this a rebuild rather than a re-check: with
// it intact, runSync treats every mail as already imported and only repairs
// dates, so the board would stay empty. Emptying both is the only way to get a
// genuinely fresh board out of the same inbox. The day count currently in the
// box is saved first, so the rebuild reads the window the user is looking at
// even if they never pressed Save settings.
async function rebuildFromMail() {
  if (mail.syncing || mail.rechecking) return null;

  const lookback = byId("mail-lookback");
  const days = clampLookbackDays(lookback && lookback.value);
  const count = (await Tracker.list()).length;

  const ok = confirm(
    `Delete all ${count} card${count === 1 ? "" : "s"} on the board and forget every imported email, then read the last ${days} day${days === 1 ? "" : "s"} of mail again?\n\n` +
      "• Every Saved / Applied / Interview / Offer / Rejected card is removed — including any you added by hand.\n" +
      "• The last " + days + " day" + (days === 1 ? "" : "s") + " of email is read again and the tabs are rebuilt from it, with AI if it is switched on.\n" +
      "• This cannot be undone."
  );
  if (!ok) return null;

  await savePanelSettings({ emailLookbackDays: days });
  mail.settings = await loadPanelSettings();

  await Tracker.clear();
  await MailImport.ledger.clear();
  await refresh();
  mailStatus(`Cleared. Reading the last ${days} day${days === 1 ? "" : "s"} of mail to rebuild your tabs…`, "busy");

  return runMailSync({ force: true, full: true });
}

async function initMailPanel() {
  const panel = byId("mail-panel");
  if (!panel) return;

  // Stamped before anything else, so it is visible even if the rest of this
  // function throws.
  const buildEl = byId("mail-build");
  if (buildEl) buildEl.textContent = DASHBOARD_BUILD;

  mail.settings = await loadPanelSettings();

  const enabled = byId("mail-enabled");
  const every = byId("mail-every");
  const time = byId("mail-time");
  const lookback = byId("mail-lookback");
  const query = byId("mail-query");
  const useAi = byId("mail-use-ai");
  const requireAi = byId("mail-require-ai");

  if (enabled) enabled.checked = !!mail.settings.emailSyncEnabled;
  if (time) time.value = mail.settings.emailSyncTime || "09:00";
  if (query) query.value = mail.settings.emailSyncQuery || "";
  if (useAi) useAi.checked = mail.settings.emailUseAi !== false;
  // Defaults on: the whole point is that an unread card never reaches the board.
  // Only an explicit false turns it off.
  if (requireAi) requireAi.checked = mail.settings.emailRequireAi !== false;

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

  // A free day count rather than a fixed menu: how far back a card's email can
  // be depends on how long the user has been applying, and a rejection from four
  // months ago is a real thing to re-read. Any positive whole number is
  // accepted; only a missing or nonsensical stored value falls back to 30.
  if (lookback) lookback.value = String(clampLookbackDays(mail.settings.emailLookbackDays));

  const aiConfigured = configuredProviders(mail.settings).length > 0;
  if (useAi && !aiConfigured) {
    useAi.checked = false;
    useAi.disabled = true;
    const note = useAi.closest("label");
    if (note) note.title = "Add an API key on the API Keys page to turn this on.";
  }

  const connection = await refreshConnection();
  renderLastRun();
  renderMailSchedule();
  renderRecheckLastRun();

  byId("mail-connect").addEventListener("click", async () => {
    mailStatus("Waiting for Google's consent screen…", "busy");
    try {
      // Settings are re-read rather than reused so a freshly written
      // src/data/google-oauth.json is picked up without a page reload.
      const connection = await Gmail.connect({ settings: await loadPanelSettings() });
      renderConnection(connection);
      // The grant is done, so the first import runs itself. Making the user
      // press Read & Sync once to see their own history is exactly the extra
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
      emailLookbackDays: clampLookbackDays(lookback && lookback.value),
      emailSyncQuery: (query && query.value.trim()) || MailImport.DEFAULT_QUERY,
      emailUseAi: !!(useAi && useAi.checked),
      emailRequireAi: !!(requireAi && requireAi.checked)
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
        : "Saved. The automatic check is off; Read & Sync still works.",
      "ok"
    );
  });

  // The manual click is the full-window read: every mail in the look-back
  // window re-fetched from Gmail, not the newest page of the search query, so
  // a new mail the query never matched still reaches the board.
  byId("mail-sync-now").addEventListener("click", () => runMailSync({ force: true, full: true }));

  // Stop trips the signal of the run in progress. It is only ever visible
  // while that run is alive, so there is nothing to guard against here beyond
  // the controller being present; disabling the button makes a second press a
  // no-op until the run's own finally block resets the pair.
  const stopButton = byId("mail-sync-stop");
  if (stopButton) {
    stopButton.addEventListener("click", () => {
      if (!mailSyncController) return;
      mailSyncController.abort();
      stopButton.disabled = true;
      mailStatus("Stopping…", "warn");
    });
  }

  byId("mail-reset").addEventListener("click", async () => {
    if (!confirm("Forget which emails have already been imported? The next sync will read them again — existing cards are updated rather than duplicated, but titles and companies may be re-guessed.")) return;

    await MailImport.ledger.clear();
    mailStatus("Cleared. Press Read & Sync to read your mail again.", "ok");
  });

  const rebuildButton = byId("mail-rebuild");
  if (rebuildButton) rebuildButton.addEventListener("click", () => rebuildFromMail());

  // The AI re-check. The confirmation is not decoration: the pass can move a
  // card backwards and spends one AI request per batch of emails, so both the
  // authority it takes over your tabs and the cost are stated before it starts.
  const recheckButton = byId("mail-recheck");
  if (recheckButton) {
    recheckButton.addEventListener("click", () => {
      if (mail.rechecking || mail.syncing) return;
      const ok = confirm(
        "Ask AI to re-read the emails behind every card imported from Gmail and move each one to the stage it decides?\n\n" +
          "• Cards can move forward or backward (for example Applied → Rejected, or Rejected → Interview).\n" +
          "• Cards you added by hand are left untouched.\n" +
          "• Every job email in the look-back window is sent to your AI provider, which may cost money."
      );
      if (ok) runMailReclassify();
    });
  }

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

// ---- Naukri profile refresh panel ----------------------------------------
//
// The run itself belongs to the worker (it owns the daily alarm) and to the
// content script (it owns the page's DOM). This panel is only the switch, the
// clock, and a "do it now" button that asks the worker for the same run the
// alarm would do — with the content script's own report handed back verbatim.

function naukriStatus(text, kind = "") {
  const el = byId("naukri-status-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

// The Naukri panel's persisted status — the last run (naukriRefreshState), the
// next scheduled run (schedulerStatus) and the run history. All three are
// written by the worker, so a refresh that happened while this tab was closed
// (or the side panel was the only thing open) shows up the moment it is
// opened, and the storage listener below repaints it live when the alarm
// fires while the tab is open.
async function renderNaukriStatus() {
  const lastEl = byId("naukri-last-run");
  const nextEl = byId("naukri-next-run");

  const [state, status] = await Promise.all([
    SchedulerState.readNaukriState(),
    SchedulerState.readSchedulerStatus()
  ]);

  if (lastEl) {
    if (!state || !state.at) {
      lastEl.textContent = "Not refreshed yet.";
    } else if (!state.ok) {
      lastEl.textContent = `Last attempt ${SchedulerState.formatStamp(state.at)} — ${state.reason || "it did not finish."}`;
    } else {
      const outcome = state.saved ? "profile saved" : state.edited ? "edited but not saved" : "nothing changed";
      lastEl.textContent = `Last refreshed ${SchedulerState.formatStamp(state.at)} — ${outcome}.`;
    }
  }

  if (nextEl) {
    const nextAt = status.naukriRefresh && status.naukriRefresh.nextAt;
    nextEl.textContent = nextAt
      ? `Next refresh ${SchedulerState.formatNextRun(nextAt)} (${new Date(nextAt).toLocaleString()}).`
      : "Daily refresh is off.";
  }

  const history = await SchedulerState.readNaukriHistory();
  renderHistory("naukri-history", "naukri-history-box", history, SchedulerState.describeNaukriRun);
}

// The run behind both "do it now" buttons — the panel's own and the page-head
// one. Kept as one function so the two cannot drift: same message, same
// verbatim report, same status line. It opens and scrolls to the panel first
// so the progress line the run writes into is on screen from either trigger.
async function runNaukriNow() {
  const panel = byId("naukri-panel");
  if (panel) {
    panel.open = true;
    if (typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  const button = byId("naukri-run");
  if (button) button.disabled = true;
  naukriStatus("Opening your Naukri profile…", "busy");
  try {
    const result = await chrome.runtime.sendMessage({ type: "naukri:run" });
    if (!result) {
      naukriStatus("The extension worker did not answer.", "err");
    } else if (!result.ok) {
      naukriStatus(result.reason || result.error || "The refresh did not finish.", "err");
    } else if (result.edited) {
      const note = result.note ? ` (${result.note})` : "";
      naukriStatus((result.saved ? "Done — the resume headline was toggled and the profile was saved." : "The resume headline was changed but it could not be saved.") + note, result.saved ? "ok" : "err");
    }
  } catch (err) {
    naukriStatus(err.message, "err");
  } finally {
    if (button) button.disabled = false;
  }
  // Repaint from storage after the run: the worker recorded the outcome, and
  // this is the panel's own summary of it (the transient status line above
  // is only what the click returned).
  await renderNaukriStatus();
}

async function initNaukriPanel() {
  const panel = byId("naukri-panel");
  if (!panel) return;

  const enabled = byId("naukri-enabled");
  const time = byId("naukri-time");
  const settings = await loadPanelSettings();

  if (enabled) enabled.checked = settings.naukriRefreshEnabled !== false;
  if (time) time.value = settings.naukriRefreshTime || "08:00";

  await renderNaukriStatus();

  byId("naukri-save").addEventListener("click", async () => {
    const patch = {
      naukriRefreshEnabled: !!(enabled && enabled.checked),
      naukriRefreshTime: (time && time.value) || "08:00"
    };
    await savePanelSettings(patch);

    // The alarm lives in the worker; this is the nudge that re-arms it with
    // the new time without waiting for the next worker start.
    const res = await chrome.runtime.sendMessage({ type: "naukri:reschedule" }).catch(() => null);
    const when = res && res.when
      ? new Date(res.when).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : "";
    naukriStatus(
      patch.naukriRefreshEnabled
        ? `Saved. The profile refreshes daily at ${patch.naukriRefreshTime}${when ? ` — next run ${when}` : ""}.`
        : "Saved. The daily profile refresh is off.",
      "ok"
    );
  });

  byId("naukri-run").addEventListener("click", () => runNaukriNow());

  // The page-head button mirrors the panel's own "Refresh now" but is reachable
  // without expanding the collapsed panel — the same shortcut the board's Find
  // jobs button gives discovery.
  const headerBtn = byId("update-naukri");
  if (headerBtn) headerBtn.addEventListener("click", () => runNaukriNow());
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

  const stamp = typeof SchedulerState !== "undefined"
    ? SchedulerState.formatStamp(state.at)
    : new Date(state.at).toLocaleString();
  const bits = [`Last searched ${stamp}`];
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
  const hashtagsEl = byId("discover-hashtags");
  const maxEl = byId("discover-max");
  const autoEl = byId("discover-auto");
  const useAiEl = byId("discover-use-ai");

  discover.settings = await loadPanelSettings();
  const settings = discover.settings;

  if (rolesEl) rolesEl.value = (settings.discoverRoles || []).join(", ");
  if (locationEl) locationEl.value = settings.discoverLocations || "";
  if (hashtagsEl) {
    const tags = Array.isArray(settings.discoverHashtags)
      ? settings.discoverHashtags
      : Discover.DEFAULT_HASHTAGS;
    hashtagsEl.value = tags.join(", ");
  }
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
        discoverHashtags: String((hashtagsEl && hashtagsEl.value) || "")
          .split(/[\s,]+/)
          .map((tag) => tag.trim().replace(/^#+/, ""))
          .filter(Boolean),
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

// ---- Cloud account panel -----------------------------------------------

function accountStatus(text, kind = "") {
  const el = byId("account-status-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

// The email + display name of the extension's own sign-in session
// (Cloud.getSession, src/lib/cloud.js). Kept tolerant of a missing record so the
// panel can render a signed-out state without a second code path.
function accountIdentity(session) {
  return {
    email: (session && session.email) || "",
    name: (session && session.name) || ""
  };
}

// Paints the signed-in state from a session record (or null). The panel is
// entirely a view of that one value, so there is nowhere else to look when
// asking "is this signed in".
function renderAccountState(session) {
  const stateEl = byId("account-state");
  const signinBtn = byId("account-signin");
  const signoutBtn = byId("account-signout");
  const noteEl = byId("account-conn-note");
  if (!stateEl) return;

  if (session) {
    const identity = accountIdentity(session);
    const who = identity.email || identity.name || "Signed in";
    stateEl.textContent = `Signed in · ${who}`;
    stateEl.className = "pill on";
    if (signinBtn) signinBtn.classList.add("hidden");
    if (signoutBtn) signoutBtn.classList.remove("hidden");
    if (noteEl) {
      noteEl.textContent = identity.email
        ? `Signed in as ${identity.email}. Your profile, resume and board sync to Supabase and show on the website.`
        : "Signed in. You can sign out here at any time.";
    }
    return;
  }

  stateEl.textContent = "Signed out";
  stateEl.className = "pill";
  if (signinBtn) signinBtn.classList.remove("hidden");
  if (signoutBtn) signoutBtn.classList.add("hidden");
  if (noteEl) {
    noteEl.textContent = "Sign in with Google — the same account whose data you want on the website.";
  }
}

async function initAccountPanel() {
  const panel = byId("account-panel");
  if (!panel) return;
  if (typeof Cloud === "undefined") {
    accountStatus("The sign-in client (cloud.js) is not loaded.", "err");
    return;
  }

  const supabaseUrlInput = byId("account-supabase-url");
  const supabaseKeyInput = byId("account-supabase-key");
  const signinBtn = byId("account-signin");
  const signoutBtn = byId("account-signout");

  const initialSettings = await loadPanelSettings();
  // Left blank when unset: the extension has no bundled project, so an empty box
  // is the honest "not configured yet" rather than a placeholder that would
  // silently point the sync at someone else's data.
  if (supabaseUrlInput) supabaseUrlInput.value = initialSettings.supabaseUrl || "";
  if (supabaseKeyInput) supabaseKeyInput.value = initialSettings.supabaseAnonKey || "";
  renderAccountState(await Cloud.getSession());
  await renderAccountLastSync();

  // Re-arms the background sync alarm in the service worker. The worker
  // cannot see a page's storage writes until they land, and the alarm must
  // follow the session / Supabase config immediately, not on next worker start.
  function rescheduleBackgroundSync() {
    try {
      const result = chrome.runtime.sendMessage({ type: "cloud:reschedule" }, () => {
        void chrome.runtime.lastError;
      });
      // When a callback is supplied Chrome returns nothing, but a mock (or an
      // older Chrome) may hand back a promise — swallow its rejection so an
      // unreachable worker never becomes an unhandled rejection.
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Worker not reachable — it reconciles on its next start anyway.
    }
  }

  // Shared tail for sign-in: show the state, re-arm the alarm, then run a first
  // sync immediately so a new device pulls the cloud state down instead of
  // waiting for the background alarm.
  async function afterSignIn(session) {
    renderAccountState(session);
    rescheduleBackgroundSync();
    const identity = accountIdentity(session);
    accountStatus("Signed in — syncing with Supabase…", "busy");
    const merged = await loadPanelSettings();
    const res = await (typeof CloudSync !== "undefined" ? CloudSync.pushPull(merged) : { ok: false });
    if (res && res.ok) {
      await renderAccountLastSync();
      accountStatus(`Signed in and synced as ${identity.email || "your account"}.`, "ok");
      await refresh();
    } else {
      accountStatus(
        `Signed in, but sync failed: ${(res && res.notes && res.notes[0]) || "unknown error"}`,
        "err"
      );
    }
  }

  byId("account-save").addEventListener("click", async () => {
    const patch = {
      supabaseUrl: (supabaseUrlInput && supabaseUrlInput.value.trim()) || "",
      supabaseAnonKey: (supabaseKeyInput && supabaseKeyInput.value.trim()) || ""
    };
    await savePanelSettings(patch);
    rescheduleBackgroundSync();
    accountStatus("Saved.", "ok");
  });

  if (signinBtn) {
    signinBtn.addEventListener("click", async () => {
      signinBtn.disabled = true;
      accountStatus("Waiting for Google's consent screen…", "busy");
      try {
        // Settings are re-read so a URL/key typed since page load is used.
        const session = await Cloud.signIn(await loadPanelSettings());
        await afterSignIn(session);
      } catch (err) {
        renderAccountState(await Cloud.getSession());
        accountStatus(err.message, "err");
      } finally {
        signinBtn.disabled = false;
      }
    });
  }

  if (signoutBtn) {
    signoutBtn.addEventListener("click", async () => {
      signoutBtn.disabled = true;
      try {
        await Cloud.signOut(await loadPanelSettings());
        renderAccountState(null);
        rescheduleBackgroundSync();
        accountStatus("Signed out.", "ok");
      } catch (err) {
        accountStatus(err.message, "err");
      } finally {
        signoutBtn.disabled = false;
      }
    });
  }

  const syncBtn = byId("account-sync");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      accountStatus("Syncing…", "busy");
      try {
        const res = await (typeof CloudSync !== "undefined" ? CloudSync.pushPull(await loadPanelSettings()) : { ok: false });
        if (res && res.ok) {
          await renderAccountLastSync();
          accountStatus(res.aborted ? "Sync stopped." : "Synced.", "ok");
          await refresh();
        } else {
          accountStatus((res && res.notes && res.notes[0]) || "Sync failed.", "err");
        }
      } catch (err) {
        accountStatus(err.message, "err");
      } finally {
        syncBtn.disabled = false;
      }
    });
  }
}

async function renderAccountLastSync() {
  const el = byId("account-last-sync");
  if (!el || typeof CloudSync === "undefined") return;
  const last = await CloudSync.loadLastSync();
  if (!last || !last.at) {
    el.textContent = "Last sync: never.";
    return;
  }
  el.textContent = `Last sync: ${new Date(last.at).toLocaleString()} · pushed ${last.pushed || 0}, pulled ${last.pulled || 0}.`;
}

refresh();
initAccountPanel().catch((err) => accountStatus(err.message, "err"));
initMailPanel().catch((err) => mailStatus(err.message, "err"));
initNaukriPanel().catch((err) => naukriStatus(err.message, "err"));
initDiscoverPanel().catch((err) => discoverStatus(err.message, "err"));