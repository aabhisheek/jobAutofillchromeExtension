// Cloud data sync using the existing Cloud sign-in session.
// Auth: Google sign-in via Cloud (getSession) returns a Bearer session token
// that the backend (/sync) verifies with its session secret.

const CLOUD_SYNC_STATE_KEY = "cloudSyncState";

function now() {
  return Date.now();
}

async function getSession() {
  if (typeof Cloud === "undefined" || !Cloud.getSession) return null;
  return Cloud.getSession();
}

function apiUrl(settings) {
  if (typeof Cloud !== "undefined" && Cloud.apiUrl) return Cloud.apiUrl(settings);
  const configured = settings && settings.cloudApiUrl;
  const value = typeof configured === "string" && configured.trim() ? configured.trim() : "http://localhost:8787";
  return value.replace(/\/+$/, "");
}

async function loadLastSync() {
  const stored = await chrome.storage.local.get(CLOUD_SYNC_STATE_KEY);
  const state = stored[CLOUD_SYNC_STATE_KEY];
  if (!state || typeof state !== "object") return null;
  return state;
}

async function saveLastSync(state) {
  await chrome.storage.local.set({ [CLOUD_SYNC_STATE_KEY]: state });
  return state;
}

async function pushPull(settings = {}, { signal } = {}) {
  const session = await getSession();
  if (!session || !session.token) {
    return {
      ok: false,
      error: "not_signed_in",
      notes: ["Not signed in. Sign in with Google in the Account panel first."]
    };
  }

  const last = await loadLastSync();
  const since = last && Number.isFinite(last.at) ? last.at : 0;
  const base = apiUrl(settings);

  // Build payload
  let applications = [];
  if (typeof Tracker !== "undefined" && Tracker.list) {
    try {
      applications = await Tracker.list();
    } catch {
      applications = [];
    }
  }

  let resume = null;
  // Try to load stored profile if present, else skip
  try {
    const { profile } = await chrome.storage.local.get("profile");
    if (profile) resume = profile;
  } catch {}

  const payload = {
    since,
    applications,
    emails: [],
    resume
  };

  let res;
  try {
    res = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return { ok: false, error: "network", notes: ["Could not reach the sync server."] };
  }

  if (signal && signal.aborted) {
    return { ok: true, aborted: true, notes: ["Sync stopped."] };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: "server", notes: [`Sync failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`] };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "bad_response", notes: ["Invalid response from server."] };
  }

  if (typeof Tracker !== "undefined" && Tracker.mergeRemote && Array.isArray(data.applications)) {
    await Tracker.mergeRemote(data.applications);
  }
  if (resume && data && data.resume) {
    // don't overwrite unless needed; keep local
  }

  const state = {
    at: data.serverTime || now(),
    pushed: applications.length,
    pulled: Array.isArray(data.applications) ? data.applications.length : 0
  };
  await saveLastSync(state);

  return { ok: true, state, data };
}

const CloudSync = {
  pushPull,
  loadLastSync
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = { CloudSync };
} catch {}
