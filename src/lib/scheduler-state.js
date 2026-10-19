// Scheduler run history and next-run status, shared by the three contexts
// that need it: the service worker (which records runs and arms the alarms),
// the dashboard (which renders the full panels) and the side panel (which
// renders a compact status card).
//
// Why a lib rather than logic inside background.js: the worker's functions are
// not reachable from a page, and the pages must read exactly the keys the
// worker writes — one definition of the key names, the history cap and the
// entry shape keeps the two sides honest. Pure helpers (pushHistory,
// formatWhen, the describe* line builders) live here too so they can be unit
// tested without a chrome.* mock, the same way background.js's scheduling
// math is tested.

const SCHEDULER_STATUS_KEY = "schedulerStatus";
const NAUKRI_STATE_KEY = "naukriRefreshState";
const NAUKRI_HISTORY_KEY = "naukriRefreshHistory";
const EMAIL_HISTORY_KEY = "emailSyncHistory";

// Owned by mail-import.js (EMAIL_SYNC_STATE_KEY). Duplicated here as a string,
// not logic, so the side panel can read the last sync without loading that
// 1700-line importer just for one timestamp. Only used as a fallback so the
// Gmail row is accurate even before the first sync after this feature landed;
// the history above is the preferred source.
const EMAIL_STATE_KEY = "emailSyncState";

// Newest-first ring buffer size. Twenty daily Naukri runs is three weeks; the
// mail schedule can be hourly, so this is "recent runs", not an audit log —
// the board itself is the durable record of what the sync imported.
const HISTORY_CAP = 20;

// ---- pure helpers ---------------------------------------------------------

// Prepends `entry` to a copied list and trims it to `cap`. Pure: the caller
// persists the returned array, so a storage failure between read and write
// cannot corrupt what was already stored.
function pushHistory(list, entry, cap = HISTORY_CAP) {
  const next = Array.isArray(list) ? list.slice() : [];
  next.unshift(entry);
  return next.slice(0, Math.max(1, Number(cap) || HISTORY_CAP));
}

// Fine-grained relative time for the scheduler lines. Tracker.relativeTime is
// day-granularity ("today" / "6d ago") which is right for application cards
// but useless for "did this morning's 08:00 run happen?" — that needs hours
// and minutes.
function formatWhen(ts, from = Date.now()) {
  const time = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(time)) return "";

  const minutes = Math.floor((from - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

// The exact clock time a run happened, spelled the same way the mail panel
// spells its last sync ("10/16/2026, 8:02:00 AM"). The scheduler lines used
// formatWhen's relative ages, which answer "was it recent?" but not "when
// exactly?" — and the user asked for the mail panel's stamp everywhere, so
// every "last run" line reads identically.
function formatStamp(ts) {
  const time = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString();
}

// The "next automatic run" clause, or "" when there is none (schedule off, or
// nothing armed yet). Spelled out rather than folded into formatWhen because
// a future instant reads better as "in 3h" than as a negative age.
function formatNextRun(nextAt, from = Date.now()) {
  if (!Number.isFinite(nextAt) || nextAt <= 0) return "";
  const minutes = Math.round((nextAt - from) / 60000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

// One history line for a Naukri run: "3/4 08:02 · ok · headline toggled and
// saved" or "3/4 08:02 · failed · the Naukri tab never answered". Kept here
// rather than in each page so the dashboard and the side panel cannot word
// the same run differently.
function describeNaukriRun(entry) {
  if (!entry) return "";
  const when = new Date(entry.at).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  if (!entry.ok) return `${when} · failed · ${entry.reason || "it did not finish"}`;
  if (entry.saved) return `${when} · ok · profile saved`;
  if (entry.edited) return `${when} · edited but not saved`;
  return `${when} · ok · nothing changed`;
}

// Same, for a mail-sync history entry. Only the fields that fit one line; the
// dashboard's main last-run line keeps the full tally from emailSyncState.
function describeEmailRun(entry) {
  if (!entry) return "";
  const when = new Date(entry.at).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  if (entry.aborted) return `${when} · stopped early · ${entry.note || ""}`.replace(/ · $/, "");
  if (!entry.ok) return `${when} · failed · ${entry.note || "it did not finish"}`;
  const bits = [`${entry.added || 0} new`, `${entry.updated || 0} moved`];
  if (entry.scanned) bits.push(`${entry.scanned} read`);
  return `${when} · ok · ${bits.join(", ")}`;
}

// ---- storage --------------------------------------------------------------

// Every Naukri run — the daily alarm's and the dashboard's forced "Refresh
// now" alike — lands here, failures included. `trigger` exists so the history
// can tell an scheduled run from a manual one without guessing from the clock.
async function recordNaukriRun(entry) {
  const trimmed = {
    at: Number.isFinite(entry && entry.at) ? entry.at : Date.now(),
    ok: !!(entry && entry.ok),
    edited: !!(entry && entry.edited),
    saved: !!(entry && entry.saved),
    reason: String((entry && entry.reason) || ""),
    note: String((entry && entry.note) || ""),
    trigger: (entry && entry.trigger) || "alarm"
  };

  const stored = await chrome.storage.local.get([NAUKRI_STATE_KEY, NAUKRI_HISTORY_KEY]);
  await chrome.storage.local.set({
    [NAUKRI_STATE_KEY]: trimmed,
    [NAUKRI_HISTORY_KEY]: pushHistory(stored[NAUKRI_HISTORY_KEY], trimmed)
  });
  return trimmed;
}

function readNaukriState() {
  return chrome.storage.local.get(NAUKRI_STATE_KEY).then((stored) => stored[NAUKRI_STATE_KEY] || null);
}

function readNaukriHistory() {
  return chrome.storage.local.get(NAUKRI_HISTORY_KEY).then((stored) => stored[NAUKRI_HISTORY_KEY] || []);
}

// Trims a full mail-sync report down to the one-line entry the history keeps.
// The complete report stays in emailSyncState (owned by mail-import.js); this
// is only what the history list needs to render.
function trimEmailRun(report) {
  const note = report && Array.isArray(report.notes) ? report.notes[0] : "";
  return {
    at: Number.isFinite(report && report.at) ? report.at : Date.now(),
    ok: !!(report && report.ok),
    aborted: !!(report && report.aborted),
    scanned: (report && report.scanned) || 0,
    added: (report && report.added) || 0,
    updated: (report && report.updated) || 0,
    skipped: (report && report.skipped) || 0,
    failed: (report && report.failed) || 0,
    deferred: (report && report.deferred) || 0,
    aiEnriched: (report && report.aiEnriched) || 0,
    full: !!(report && report.full),
    note: String(note || "")
  };
}

// Called from mail-import.js's writeSyncState, the single choke point every
// persisted sync report goes through — so a run cannot be the "latest state"
// without also being in the history.
async function appendEmailHistory(report) {
  const entry = trimEmailRun(report);
  const stored = await chrome.storage.local.get(EMAIL_HISTORY_KEY);
  await chrome.storage.local.set({ [EMAIL_HISTORY_KEY]: pushHistory(stored[EMAIL_HISTORY_KEY], entry) });
  return entry;
}

function readEmailHistory() {
  return chrome.storage.local.get(EMAIL_HISTORY_KEY).then((stored) => stored[EMAIL_HISTORY_KEY] || []);
}

// The most recent mail sync in the trimmed one-line shape, for the side panel:
// prefers the newest history entry and falls back to the raw latest report in
// emailSyncState so the row is accurate even before the first sync after this
// feature was added. Returns null when there has never been a run.
async function readEmailLastRun() {
  const stored = await chrome.storage.local.get([EMAIL_HISTORY_KEY, EMAIL_STATE_KEY]);
  const history = stored[EMAIL_HISTORY_KEY];
  if (Array.isArray(history) && history[0]) return history[0];
  const state = stored[EMAIL_STATE_KEY];
  if (!state || !state.at) return null;
  return trimEmailRun(state);
}

// The instant each alarm was actually armed for — written by the worker when
// it creates (or clears) an alarm, read by both UIs for the "next run" clause.
// Persisted rather than recomputed in the pages because the armed instant is
// the truth: recomputing would need the scheduling helpers duplicated
// everywhere and would disagree with the worker the moment a setting changed
// while a page was open.
async function setNextRun(kind, when) {
  const stored = await chrome.storage.local.get(SCHEDULER_STATUS_KEY);
  const status = stored[SCHEDULER_STATUS_KEY] || {};
  status[kind] = {
    nextAt: Number.isFinite(when) ? when : null,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [SCHEDULER_STATUS_KEY]: status });
  return status[kind];
}

function readSchedulerStatus() {
  return chrome.storage.local.get(SCHEDULER_STATUS_KEY).then((stored) => stored[SCHEDULER_STATUS_KEY] || {});
}

const SchedulerState = {
  STATUS_KEY: SCHEDULER_STATUS_KEY,
  NAUKRI_STATE_KEY,
  NAUKRI_HISTORY_KEY,
  EMAIL_HISTORY_KEY,
  HISTORY_CAP,
  pushHistory,
  formatWhen,
  formatStamp,
  formatNextRun,
  describeNaukriRun,
  describeEmailRun,
  recordNaukriRun,
  readNaukriState,
  readNaukriHistory,
  trimEmailRun,
  appendEmailHistory,
  readEmailHistory,
  readEmailLastRun,
  setNextRun,
  readSchedulerStatus
};
