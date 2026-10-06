// Background service worker — the only place that talks to Mixpanel.
//
// Extension pages call Analytics.track() (src/lib/analytics.js), which posts a
// message here; this worker stamps the event with identity/context, persists
// it to chrome.storage.local and flushes batches to Mixpanel's HTTP API. The
// queue lives in storage rather than memory because MV3 tears this worker down
// aggressively — an event tracked as the popup closes must survive that.
//
// No Mixpanel SDK is vendored: mixpanel-browser assumes a cookie-bearing
// document and a bundler, neither of which exists here. The /track endpoint is
// a plain JSON POST, so a ~150-line client keeps this project dependency-free
// and buildless, exactly like the rest of src/lib.

importScripts("/src/lib/schema.js", "/src/lib/providers.js", "/src/lib/tracker.js", "/src/lib/gmail.js", "/src/lib/mail-import.js");

const MIXPANEL_TRACK_URL = "https://api.mixpanel.com/track";
const MIXPANEL_ENGAGE_URL = "https://api.mixpanel.com/engage";
const BUNDLED_SETTINGS_URL = chrome.runtime.getURL("src/data/settings.json");

const QUEUE_KEY = "analyticsQueue";
const DEVICE_ID_KEY = "analyticsDeviceId";

// Cap the backlog so an extended offline stretch (or a configured-analytics /
// missing-token gap) can't grow chrome.storage.local without bound. Oldest
// events are dropped first.
const MAX_QUEUE = 200;
const MAX_BATCH = 50;
// Backstop for the privacy contract in analytics.js: no string property should
// ever be long enough to smuggle a field value, a JD excerpt or a URL.
const MAX_STRING_LENGTH = 120;

// ---- settings ----
// Same resolution order as the rest of the extension: bundled
// src/data/settings.json is the base, chrome.storage.local overrides it
// field-by-field (see mergeSettings in schema.js).
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    const res = await fetch(BUNDLED_SETTINGS_URL);
    if (res.ok) bundled = await res.json();
  } catch {
    // fall through — mergeSettings still applies DEFAULT_SETTINGS/overrides
  }

  return mergeSettings(bundled, settings);
}

function mixpanelToken(settings) {
  return (settings.mixpanelToken || "").trim();
}

// ---- identity & context ----
// A random per-installation id. There is no login in this extension, so this
// is the distinct_id: it identifies a browser profile, never a person, and it
// is generated locally rather than derived from anything in the user's saved
// profile.
async function getDeviceId() {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (stored[DEVICE_ID_KEY]) return stored[DEVICE_ID_KEY];

  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: deviceId });
  return deviceId;
}

let platformInfoPromise = null;
function getPlatformInfo() {
  if (!platformInfoPromise) {
    platformInfoPromise = chrome.runtime.getPlatformInfo().catch(() => ({ os: "unknown", arch: "unknown" }));
  }
  return platformInfoPromise;
}

function sanitizeProps(props) {
  const clean = {};
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      clean[key] = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    }
    // Objects/arrays are dropped outright — nothing this extension would nest
    // in a property is safe to transmit.
  }
  return clean;
}

// ---- queue ----
// chrome.storage.local read-modify-write operations are not atomic. Popup
// clicks can arrive close together, so serialize only the persistence portion:
// otherwise two enqueue calls can read the same queue, each append one event,
// and the last write silently loses the other event. Flushes remain
// single-flight below and are deliberately not held behind this queue.
let enqueueWriteInFlight = Promise.resolve();

async function persistEnqueuedEvent(event, props) {
  const settings = await loadSettings();
  if (!settings.analyticsEnabled) return null;

  const [deviceId, platform] = await Promise.all([getDeviceId(), getPlatformInfo()]);
  const { version } = chrome.runtime.getManifest();

  const entry = {
    event,
    properties: {
      ...sanitizeProps(props),
      distinct_id: deviceId,
      $device_id: deviceId,
      // Lets Mixpanel de-duplicate if a batch is retried after a response was
      // actually delivered but never seen by us.
      $insert_id: crypto.randomUUID(),
      time: Date.now(),
      $os: platform.os,
      extension_version: version,
      locale: chrome.i18n.getUILanguage()
    }
  };

  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(entry);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });

  return settings;
}

function enqueue(event, props) {
  const write = enqueueWriteInFlight.then(() => persistEnqueuedEvent(event, props));
  // Keep the serialization chain healthy after a failed storage operation;
  // the caller still receives the original rejection through `write`.
  enqueueWriteInFlight = write.catch(() => {});

  return write.then((settings) => {
    if (settings) return flush(settings);
  });
}

// Single-flight: concurrent tracks (or a track landing during a retry) must not
// each pull the same batch off the queue and double-send it.
let flushInFlight = null;
function flush(settings) {
  if (!flushInFlight) {
    flushInFlight = doFlush(settings).finally(() => {
      flushInFlight = null;
    });
  }
  return flushInFlight;
}

async function doFlush(knownSettings) {
  const settings = knownSettings || (await loadSettings());
  if (!settings.analyticsEnabled) return;

  const token = mixpanelToken(settings);
  // No token configured yet — events stay queued (capped at MAX_QUEUE) so the
  // backlog is delivered once a token is entered in Options, rather than
  // silently discarded.
  if (!token) return;

  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  if (queue.length === 0) return;

  const batch = queue.slice(0, MAX_BATCH);
  const body = batch.map((entry) => ({
    event: entry.event,
    properties: { ...entry.properties, token }
  }));

  let ok = false;
  try {
    // ip=0 suppresses Mixpanel's IP-based geolocation. Deliberate: this
    // extension already holds the user's address in their profile, and product
    // analytics here doesn't need to also pin down where they live.
    const res = await fetch(`${MIXPANEL_TRACK_URL}?ip=0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    ok = res.ok;
  } catch {
    ok = false; // offline / blocked — keep the batch queued
  }

  // Anything not delivered stays at the head of the queue and is retried on the
  // next tracked event or browser start. Re-read rather than reusing `queue`:
  // enqueue() may have appended while the request was in flight, and only the
  // sent prefix should be dropped.
  if (!ok) return;

  const { [QUEUE_KEY]: current = [] } = await chrome.storage.local.get(QUEUE_KEY);
  await chrome.storage.local.set({ [QUEUE_KEY]: current.slice(batch.length) });

  if (current.length > batch.length) await doFlush(settings);
}

// ---- user profile ----
// Set on install/update only, so installs can be segmented by version/OS in
// Mixpanel without attaching that to every single event.
async function updateUserProfile() {
  const settings = await loadSettings();
  if (!settings.analyticsEnabled) return;

  const token = mixpanelToken(settings);
  if (!token) return;

  const [deviceId, platform] = await Promise.all([getDeviceId(), getPlatformInfo()]);
  const { version } = chrome.runtime.getManifest();

  try {
    await fetch(MIXPANEL_ENGAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          $token: token,
          $distinct_id: deviceId,
          $ip: "0",
          $set: { extension_version: version, $os: platform.os, locale: chrome.i18n.getUILanguage() },
          $set_once: { first_installed_at: new Date().toISOString() }
        }
      ])
    });
  } catch {
    // Profile updates are best-effort; events are the source of truth.
  }
}

// ---- side panel ----
// The panel is a Chrome side panel rather than a browser-action popup for one
// reason: Chrome destroys a popup the instant focus leaves it ("There is no way
// to keep the popup open after the user has clicked away" — Chrome's "Add a
// popup" docs), so scan results were lost every time the user reached for the
// form. A side panel stays open while the page is used, and it is the same
// document, so popup.html and all of its logic are reused unchanged.
//
// Minimize disables the panel and records that in storage. Nothing re-enables it
// afterwards except an explicit restore, so the panel never returns on its own.
const PANEL_PATH = "src/popup/popup.html";
const MINIMIZED_KEY = "panelMinimized";
const PANEL_COMMAND = "toggle-panel";
const PANEL_TITLE = "Job Application Autofill";

// A Chrome API can be missing (permission not granted yet, older browser) or
// return undefined. The `?.` calls mean a missing sidePanel namespace cannot
// throw before settle() ever sees it, and settle() covers the undefined return.
// Calling `.catch()` on a raw result is what threw "Uncaught TypeError" in an
// earlier revision of the minimize path.
function settle(result) {
  if (result && typeof result.catch === "function") return result.catch(() => {});
  return Promise.resolve();
}

async function isMinimized() {
  const { [MINIMIZED_KEY]: minimized } = await chrome.storage.local.get(MINIMIZED_KEY);
  return minimized === true;
}

// Single source of truth for the toolbar button.
//
// openPanelOnActionClick is ON whenever the panel is not minimized, so Chrome
// opens the panel itself. That is deliberate: chrome.sidePanel.open() is a
// programmatic call that has to be made from a live user gesture in a service
// worker that Chrome is free to suspend, and relying on it left the button
// doing nothing. Chrome's own open path has none of those failure modes. It is
// turned OFF while minimized so that the click reaches onClicked below and can
// be used to restore.
async function applyPanelState() {
  const minimized = await isMinimized();

  await settle(chrome.sidePanel?.setOptions({ path: PANEL_PATH, enabled: !minimized }));
  await settle(chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: !minimized }));
  await settle(chrome.action.setBadgeText({ text: minimized ? "\u2013" : "" }));
  await settle(
    chrome.action.setTitle({
      title: minimized ? `${PANEL_TITLE} (minimized - click the toolbar icon to restore)` : PANEL_TITLE
    })
  );
}

// Programmatic open, used only to bring the panel up immediately on restore.
// Returns whether it worked: when it doesn't, Chrome's own open-on-action-click
// is already back on, so the next toolbar click still opens the panel and the
// caller never leaves the user with a dead button.
async function openPanel(tab) {
  if (!tab || !tab.id) return false;
  // Chrome refuses on pages that disallow side panels (chrome://, the Web
  // Store).
  try {
    await chrome.sidePanel?.open({ tabId: tab.id });
    return true;
  } catch {
    return false;
  }
}

async function restorePanel(tab) {
  await chrome.storage.local.set({ [MINIMIZED_KEY]: false });
  await applyPanelState();
  await openPanel(tab);
}

// Toolbar click and the keyboard shortcut do the same thing: bring the panel
// back if it was minimized, otherwise show it. Minimized is a distinct action
// rather than a toggle so the panel can never be dismissed by a stray click.
//
// While not minimized Chrome normally handles the click itself and this never
// runs; the openPanel call is the safety net for when it does.
async function handlePanelRequest(tab) {
  if (await isMinimized()) {
    await restorePanel(tab);
    return;
  }
  await openPanel(tab);
}

// ---- scheduled email sync ------------------------------------------------
//
// One chrome.alarms alarm runs MailImport.runSync() on the schedule the
// dashboard panel was configured for: hourly, every two hours, or once a day
// at a chosen time.
//
// chrome.alarms rather than an OS scheduler (launchd/cron/Task Scheduler)
// because the thing that has to happen is a fetch() from a service worker that
// only exists while Chrome is running, into a storage key only that worker can
// read. An OS job would need a second process, a second auth path, and a way to
// hand results across a process boundary — to do something an alarm already
// does. The honest limitation is that an alarm missed while the browser was
// closed is not replayed by Chrome, so the panel offers "Sync now" and the next
// day's run picks up anything missed (the importer is idempotent per message,
// and the search window is a rolling 30 days).

const EMAIL_ALARM = "job-email-sync";

// The only settings fields that change when the alarm should fire. Compared by
// key on a storage event, so flipping an unrelated preference does not re-arm a
// timer the user did not touch.
const EMAIL_SCHEDULE_FIELDS = ["emailSyncEnabled", "emailSyncTime", "emailSyncEvery"];

const DAY_MINUTES = 1440;

// Background schedules, in minutes. Anything not in here — including a missing
// or hand-edited value — falls back to the daily alarm.
const SYNC_INTERVAL_MINUTES = { "1h": 60, "2h": 120 };

// "HH:MM" in the machine's local zone. Returns null for anything else, so a
// half-typed value in the time input falls back to the previous schedule rather
// than silently scheduling midnight.
function parseSyncTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

// The next occurrence of the configured wall-clock time, today if it is still
// ahead, tomorrow if it has passed. Recreated on every browser start rather
// than trusted to survive: an alarm's `when` is wall-clock, so a laptop that
// slept through the scheduled moment would otherwise keep firing at a stale
// hour forever.
function nextRunAt(time, from = Date.now()) {
  const parsed = parseSyncTime(time) || { hours: 9, minutes: 0 };
  const next = new Date(from);
  next.setHours(parsed.hours, parsed.minutes, 0, 0);

  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// Next firing of an interval schedule (hourly / every two hours), anchored on
// the last completed run. Deterministic in (lastAt, period, from) so that the
// worker — which reconciles on every start, i.e. constantly — recomputes the
// same future instant instead of pushing the alarm forward each time it wakes
// (which would starve a `when: now + period` schedule forever). A last run far
// enough in the past lands on the next multiple of the period ahead, so a
// browser that was closed for a day catches up within one period rather than
// replaying every missed one. Returns null when there is no last run: the
// caller then falls back to the daily anchor, which is a fixed wall-clock
// time and therefore safe to recompute the same way.
function nextIntervalRunAt(lastAt, periodMinutes, from = Date.now()) {
  const period = Math.max(1, Number(periodMinutes) || 60) * 60000;
  if (!Number.isFinite(lastAt) || lastAt <= 0) return null;
  const missed = Math.floor((from - lastAt) / period);
  return lastAt + (Math.max(0, missed) + 1) * period;
}

async function scheduleEmailSync(settings) {
  const period = SYNC_INTERVAL_MINUTES[settings.emailSyncEvery];
  if (period) {
    const state = await MailImport.readSyncState().catch(() => null);
    const next = nextIntervalRunAt(state && state.at, period) || nextRunAt(settings.emailSyncTime);
    await chrome.alarms.create(EMAIL_ALARM, { when: next, periodInMinutes: period });
    return next;
  }

  const next = nextRunAt(settings.emailSyncTime);
  await chrome.alarms.create(EMAIL_ALARM, {
    when: next,
    periodInMinutes: DAY_MINUTES
  });
  return next;
}

// The alarm fires in a worker Chrome is free to suspend at any moment, and a
// second trigger must not stack a second run on top of the first: two syncs
// racing would each read the ledger before either wrote it, and the loser would
// re-import messages the winner had already turned into rows.
let emailSyncInFlight = null;

function runEmailSync(options = {}) {
  if (!emailSyncInFlight) {
    emailSyncInFlight = (async () => {
      const settings = await MailImport.loadSettings();
      return MailImport.runSync({ ...options, settings });
    })().finally(() => {
      emailSyncInFlight = null;
    });
  }
  return emailSyncInFlight;
}

// Reconciles the alarm with the stored settings. Called on every worker start
// (alarms are persisted by Chrome, but the desired time lives in storage and
// the user can change it from a page while this worker is asleep) and whenever
// the settings record changes.
async function reconcileEmailAlarm() {
  try {
    const settings = await MailImport.loadSettings();
    if (!settings.emailSyncEnabled) {
      await chrome.alarms.clear(EMAIL_ALARM);
      return null;
    }
    return await scheduleEmailSync(settings);
  } catch {
    // Best-effort: a missing alarm costs a scheduled run, and the panel's
    // Sync now button still works.
    return null;
  }
}

// ---- wiring ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  // The panel runs the sync itself rather than asking this worker to, so it can
  // show progress as messages arrive. These messages are for the parts that have
  // to happen here: the sync alarm, and re-arming it after a settings change.
  if (message.type === "mail:sync") {
    if (message.run) {
      sendResponse({ accepted: true });
      runEmailSync({ force: true }).catch(() => {});
      return false;
    }
    runEmailSync({ force: !!message.force })
      .then((report) => sendResponse({ report }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "mail:reschedule") {
    reconcileEmailAlarm()
      .then((when) => sendResponse({ ok: true, when }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "mail:connection") {
    MailImport.loadSettings()
      .then((settings) => Gmail.getConnection(settings))
      .then((connection) => sendResponse({ connection }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type !== "analytics:track") return false;

  // Returning true (async response) is what keeps this worker alive long enough
  // to persist the event when the popup is closing as it fires.
  enqueue(message.event, message.props)
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== EMAIL_ALARM) return;
  runEmailSync().catch(() => {});
});

// With no default_popup in the manifest, every toolbar click lands here.
chrome.action.onClicked.addListener((tab) => {
  handlePanelRequest(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === PANEL_COMMAND) handlePanelRequest(tab);
});

// The panel writes the flag itself on the minimize click; this is the
// reconciliation path for a worker that was asleep when it changed, and it
// re-runs from scratch on every worker start. setPanelBehavior() is
// session-only state, so re-deriving it here is what makes "minimized until I
// restore it" hold across restarts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (MINIMIZED_KEY in changes) applyPanelState();
  if (EMAIL_SCHEDULE_FIELDS.some((key) => key in changes)) reconcileEmailAlarm();
});

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  const { version } = chrome.runtime.getManifest();

  if (reason === "install") {
    await enqueue("Extension Installed", {});
  } else if (reason === "update" && previousVersion && previousVersion !== version) {
    await enqueue("Extension Updated", { previous_version: previousVersion });
  }

  await updateUserProfile();
});

// Drain anything that was queued while offline / before a token existed.
chrome.runtime.onStartup.addListener(() => {
  flush().catch(() => {});
  reconcileEmailAlarm();
  // Chrome does not replay an alarm the browser slept through, and the browser
  // has only just opened — this is the natural moment to catch up on yesterday's
  // mail instead of waiting for the scheduled hour. Gated on the same setting
  // the alarm is, so a refused run never rewrites the panel's last-run line.
  MailImport.loadSettings()
    .then((settings) => (settings.emailSyncEnabled ? runEmailSync() : null))
    .catch(() => {});
});
flush().catch(() => {});

// Re-apply the panel's state on every worker start: setOptions/setPanelBehavior
// live on the session, not the worker, and MV3 tears this worker down often.
applyPanelState().catch(() => {});

// Same for the sync alarm: Chrome persists alarms across restarts, but the
// schedule the user wants lives in storage and is edited from a page while this
// worker sleeps. Reconciling here is what makes the two agree.
reconcileEmailAlarm().catch(() => {});
