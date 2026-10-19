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

importScripts(
  "/src/lib/schema.js",
  "/src/lib/providers.js",
  "/src/lib/tracker.js",
  "/src/lib/scheduler-state.js",
  "/src/lib/gmail.js",
  "/src/lib/mail-import.js",
  "/src/lib/cloud.js",
  "/src/lib/supabase.js",
  "/src/lib/cloud-sync.js"
);

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

// A synchronous mirror of the minimized flag, for the auto-open path only.
//
// chrome.sidePanel.open() must be called during the user gesture, and the
// gesture is carried by the content script's message — but an `await` anywhere
// before open() (including the storage read isMinimized() does) spends it, and
// the call is then rejected. So the flag is cached in memory here: the content
// script's click can consult it without yielding, and it is refreshed on
// worker start and whenever storage changes.
let panelMinimized = false;
function refreshPanelMinimized() {
  chrome.storage.local
    .get(MINIMIZED_KEY)
    .then((data) => {
      panelMinimized = data[MINIMIZED_KEY] === true;
    })
    .catch(() => {});
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
// closed is not replayed by Chrome, so the panel offers "Read & Sync" and the next
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
    // Persisted so both UIs can show "next check" without re-deriving the
    // schedule — the armed instant is the truth, and it lives here.
    await SchedulerState.setNextRun("emailSync", next).catch(() => {});
    return next;
  }

  const next = nextRunAt(settings.emailSyncTime);
  await chrome.alarms.create(EMAIL_ALARM, {
    when: next,
    periodInMinutes: DAY_MINUTES
  });
  await SchedulerState.setNextRun("emailSync", next).catch(() => {});
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
      // The schedule is off: no next run to advertise, and a stale instant
      // from the previous schedule would be a lie the panel would render.
      await SchedulerState.setNextRun("emailSync", null).catch(() => {});
      return null;
    }
    return await scheduleEmailSync(settings);
  } catch {
    // Best-effort: a missing alarm costs a scheduled run, and the panel's
    // Read & Sync button still works.
    return null;
  }
}



const NAUKRI_REFRESH_ALARM = "naukri-profile-refresh";
const NAUKRI_REFRESH_FIELDS = ["naukriRefreshEnabled", "naukriRefreshTime", "naukriRefreshUrl", "naukriRefreshEditPattern", "naukriRefreshCustomText"];

async function scheduleNaukriRefresh(settings) {
  const next = nextRunAt(settings.naukriRefreshTime || "08:00");
  await chrome.alarms.create(NAUKRI_REFRESH_ALARM, {
    when: next,
    periodInMinutes: DAY_MINUTES
  });
  // Same reasoning as the email arm above: the pages render "next refresh"
  // from this, and the armed instant beats a recomputation.
  await SchedulerState.setNextRun("naukriRefresh", next).catch(() => {});
  return next;
}

let naukriRefreshInFlight = null;

// Every outcome — success, content-script refusal, thrown error — is recorded
// through SchedulerState.recordNaukriRun, so "when did this last work?" always
// has an answer. The alarm's fire-and-forget path used to discard the result
// entirely, which is why a week of silent failures was invisible.
function runNaukriRefresh(options = {}) {
  const trigger = options.trigger || "alarm";
  if (!naukriRefreshInFlight) {
    naukriRefreshInFlight = (async () => {
      const settings = await loadSettings();
      try {
        const result = await triggerNaukriProfileRefresh(settings, options);
        // "disabled" is a refusal, not a run: the schedule is off, so writing
        // it into the history would read as a failure the user never asked to
        // fix. Every other outcome — including a forced manual run — is kept.
        if (result && result.reason !== "disabled") {
          await SchedulerState.recordNaukriRun({ ...result, trigger }).catch(() => {});
        }
        return result;
      } catch (err) {
        const failure = { ok: false, reason: err.message, trigger };
        await SchedulerState.recordNaukriRun(failure).catch(() => {});
        return failure;
      }
    })().finally(() => {
      naukriRefreshInFlight = null;
    });
  }
  return naukriRefreshInFlight;
}

// The content script only exists once the tab's document has reached
// document_idle, and a Naukri redirect (session expired -> login page, then
// back) can reset the document after that. So the message is retried on a
// one-second beat instead of fired once into the void: the old single attempt
// failed silently whenever the tab was still loading, which is most of the
// time, and the run reported ok while doing nothing.
async function sendNaukriRefresh(tabId, message, attempts = 30) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return { ok: false, reason: `The Naukri tab never answered (${lastError && lastError.message}).` };
}

async function triggerNaukriProfileRefresh(settings, { force = false } = {}) {
  if (!settings.naukriRefreshEnabled && !force) return { ok: false, reason: "disabled" };

  const url = settings.naukriRefreshUrl || "https://www.naukri.com/mnjuser/profile";
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  try {
    const result = await sendNaukriRefresh(tab.id, {
      type: "naukri:refresh",
      editPattern: settings.naukriRefreshEditPattern || "dots",
      customText: settings.naukriRefreshCustomText || " .",
      profileUrl: url,
      // The tab is opened with active:false, so the content script's render is
      // frozen: the drawer never closes and the last-updated line never repaints
      // even after a save that went through. Saying so explicitly stops the run
      // from reading that freeze as "the change did not save".
      backgroundTab: true
    });
    return { ...(result || { ok: false, reason: "No answer from the tab." }), url };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    // Closed after the run so a daily alarm does not leave a tab open every
    // morning. Best-effort: a tab the user already closed is fine.
    if (tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function reconcileNaukriRefreshAlarm() {
  try {
    const settings = await loadSettings();
    if (!settings.naukriRefreshEnabled) {
      await chrome.alarms.clear(NAUKRI_REFRESH_ALARM);
      // Same as the email path: off means no next run, and a leftover instant
      // would be rendered as a promise the schedule no longer keeps.
      await SchedulerState.setNextRun("naukriRefresh", null).catch(() => {});
      return null;
    }
    return await scheduleNaukriRefresh(settings);
  } catch {
    return null;
  }
}

// ---- scheduled Supabase sync --------------------------------------------
//
// A third alarm, alongside email sync and the Naukri refresh: every
// CLOUD_SYNC_INTERVAL_MINUTES it runs CloudSync.pushPull() when — and only
// when — the user is signed in AND Supabase is configured. The gate is
// deliberate: an unsigned-in or unconfigured install must never make a network
// call it cannot attribute to an account, and clearing the alarm (rather than
// letting it fire and no-op) keeps that guarantee visible in chrome://alarms.
//
// The interval is fixed rather than user-configurable because the sync is
// cheap (one metadata pass plus whatever changed) and the dashboard already
// offers a manual "Sync now"; a settings field would be a knob with no
// meaningful range to turn it through.

const CLOUD_SYNC_ALARM = "job-cloud-sync";
const CLOUD_SYNC_INTERVAL_MINUTES = 30;

// Single-flight, same reasoning as the email and Naukri paths: a second
// trigger arriving mid-sync must not start a parallel pushPull — the two
// would race on the same storage keys and on the same Supabase rows.
let cloudSyncInFlight = null;

function runCloudSync(options = {}) {
  if (!cloudSyncInFlight) {
    cloudSyncInFlight = (async () => {
      const settings = await loadSettings();
      return CloudSync.pushPull(settings, options);
    })().finally(() => {
      cloudSyncInFlight = null;
    });
  }
  return cloudSyncInFlight;
}

// Reconciles the alarm with the current session + Supabase configuration.
// Runs on every worker start and whenever the session or the two Supabase
// settings keys change — the user can sign in / paste a key from a page while
// this worker is asleep, and the alarm has to follow.
async function reconcileCloudSyncAlarm() {
  try {
    const settings = await loadSettings();
    const armed = await CloudSync.shouldSyncAutomatically(settings);
    if (armed) {
      await chrome.alarms.create(CLOUD_SYNC_ALARM, {
        periodInMinutes: CLOUD_SYNC_INTERVAL_MINUTES
      });
    } else {
      await chrome.alarms.clear(CLOUD_SYNC_ALARM);
    }
    return armed;
  } catch {
    // Best-effort: a missing alarm costs a background sync, and the
    // dashboard's manual button still works.
    return false;
  }
}

// ---- wiring ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  // Auto-open: the content script detects an application form, then sends this
  // from the first ordinary click/keypress on the page. That gesture is what
  // chrome.sidePanel.open() requires; the detection report itself carries none
  // and would be rejected. Nothing is awaited before openPanel() — every await
  // between the gesture and the call can spend it — and a minimized panel is
  // left alone, since minimizing means "do not reopen until I ask".
  if (message.type === "autofill:open-panel") {
    if (!panelMinimized) openPanel(sender && sender.tab);
    return false;
  }

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

  // The dashboard's "Refresh now" — the same run the alarm does, but forced,
  // so it works with the schedule switched off, and answered with the content
  // script's own report of what it changed. Tagged manual so the history can
  // tell a click from the daily alarm.
  if (message.type === "naukri:run") {
    runNaukriRefresh({ force: true, trigger: "manual" })
      .then((result) => sendResponse(result || { ok: false, reason: "No result." }))
      .catch((err) => sendResponse({ ok: false, reason: err.message }));
    return true;
  }

  // Re-arming the daily alarm after the panel changes the time or the switch.
  if (message.type === "naukri:reschedule") {
    reconcileNaukriRefreshAlarm()
      .then((when) => sendResponse({ ok: true, when }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // The dashboard's "Sync now" button and the post-sign-in auto-sync both land
  // here: the panel runs its own copy for instant feedback, but this worker
  // also runs one so the sync happens even if the panel closes mid-flight.
  if (message.type === "cloud:sync") {
    runCloudSync()
      .then((result) => sendResponse(result || { ok: false, notes: ["No result."] }))
      .catch((err) => sendResponse({ ok: false, notes: [err.message] }));
    return true;
  }

  // Re-arming the background sync alarm after sign-in / sign-out / a Supabase
  // settings change.
  if (message.type === "cloud:reschedule") {
    reconcileCloudSyncAlarm()
      .then((armed) => sendResponse({ ok: true, armed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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
  if (alarm.name === EMAIL_ALARM) {
    runEmailSync().catch(() => {});
    return;
  }
  if (alarm.name === NAUKRI_REFRESH_ALARM) {
    runNaukriRefresh().catch(() => {});
    return;
  }
  if (alarm.name === CLOUD_SYNC_ALARM) {
    runCloudSync().catch(() => {});
    return;
  }
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
// Settings keys that change when the background cloud-sync alarm should be
// re-armed. Compared by key on a storage event, same as the two schedules
// above, so an unrelated preference flip does not churn the alarm.
const CLOUD_SYNC_FIELDS = ["cloudSession", "supabaseUrl", "supabaseAnonKey"];

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (MINIMIZED_KEY in changes) {
    // Keep the synchronous mirror honest before applyPanelState() (which is
    // async) resolves, so an auto-open arriving in between sees the new value.
    panelMinimized = changes[MINIMIZED_KEY].newValue === true;
    applyPanelState();
  }
  if (EMAIL_SCHEDULE_FIELDS.some((key) => key in changes)) reconcileEmailAlarm();
  if (NAUKRI_REFRESH_FIELDS.some((key) => key in changes)) reconcileNaukriRefreshAlarm();
  if (CLOUD_SYNC_FIELDS.some((key) => key in changes)) reconcileCloudSyncAlarm();
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
  reconcileNaukriRefreshAlarm();
  reconcileCloudSyncAlarm();
  // Chrome does not replay an alarm the browser slept through, and the browser
  // has only just opened — this is the natural moment to catch up on yesterday's
  // mail instead of waiting for the scheduled hour. Gated on the same setting
  // the alarm is, so a refused run never rewrites the panel's last-run line.
  MailImport.loadSettings()
    .then((settings) => (settings.emailSyncEnabled ? runEmailSync() : null))
    .catch(() => {});
  // Same reasoning for the Supabase sync: a laptop that was closed overnight
  // should reconcile with the cloud on open, not half an hour from now. The
  // call is gated inside runCloudSync (signed in + configured), so an
  // unconfigured install makes no network request at all.
  loadSettings()
    .then((settings) => (CloudSync.shouldSyncAutomatically(settings) ? runCloudSync() : null))
    .catch(() => {});
});
flush().catch(() => {});

// Re-apply the panel's state on every worker start: setOptions/setPanelBehavior
// live on the session, not the worker, and MV3 tears this worker down often.
applyPanelState().catch(() => {});

// Prime the synchronous minimized mirror the auto-open path reads.
refreshPanelMinimized();

// Same for the sync alarm: Chrome persists alarms across restarts, but the
// schedule the user wants lives in storage and is edited from a page while this
// worker sleeps. Reconciling here is what makes the two agree.
reconcileEmailAlarm().catch(() => {});
reconcileNaukriRefreshAlarm().catch(() => {});
reconcileCloudSyncAlarm().catch(() => {});
