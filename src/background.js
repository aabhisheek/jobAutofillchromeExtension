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

importScripts("/src/lib/schema.js");

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
async function enqueue(event, props) {
  const settings = await loadSettings();
  if (!settings.analyticsEnabled) return;

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

  await flush(settings);
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

// ---- wiring ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "analytics:track") return false;

  // Returning true (async response) is what keeps this worker alive long enough
  // to persist the event when the popup is closing as it fires.
  enqueue(message.event, message.props)
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
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
});
flush().catch(() => {});
