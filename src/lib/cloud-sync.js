// Cloud data sync — bidirectional, backed by Supabase (the project configured
// in the Account panel). See src/lib/supabase.js for the REST client.
//
// Identity comes from the extension's OWN sign-in (src/lib/cloud.js): the
// Google session it stores carries the user's email, and every row is keyed on
// that email, lowercased. Supabase is used purely as a data store reached with
// the project's anon key — there is no Supabase Auth session on this side.
//
// Tables (see supabase/schema.sql):
//   user_data     one JSON blob per (user_id, kind). Kinds:
//                 profile | settings | resume_pdf | resume_tex. `data` is
//                 exactly what chrome.storage.local holds for that key.
//   applications  one JSON blob per tracked job; `data` is the tracker row.
//
// Order and conflict model — PULL, then PUSH:
//
//   1. Pull. A kind's blob is adopted when this device has nothing stored for
//      it, or when the cloud row changed after this device's last sync.
//      Applications merge per row: a remote row is adopted when it is unknown
//      here or its updatedAt beats the local copy's.
//   2. Push. Everything held locally is uploaded, so the cloud ends the sync
//      holding this device's state.
//
// Pull-before-push is deliberate: pushing first would let a device that has not
// synced since an edit elsewhere overwrite that newer cloud copy with its own
// stale one before ever reading it.
//
// Deletions are not propagated: removing something locally does not remove it
// in the cloud, and the next pull brings it back. There are no tombstones.

const CLOUD_SYNC_STATE_KEY = "cloudSyncState";

// kind (table column) -> chrome.storage.local key.
const USER_DATA_KINDS = [
  { kind: "profile", key: "profile" },
  { kind: "settings", key: "settings" },
  { kind: "resume_pdf", key: "resumePdf" },
  { kind: "resume_tex", key: "resumeTex" }
];

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

// The row key for a signed-in session, or "" when there is nothing to key on.
// Lowercased because email case is not stable across the ways a user might type
// or sign in with it.
function cloudUserKey(session) {
  const email = session && session.email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// ---- row mapping --------------------------------------------------------

// A tracker row is stored whole in `data`; only the two columns the merge reads
// are lifted to the top level.
function applicationToRow(userId, app) {
  return {
    user_id: userId,
    id: String(app.id),
    data: app,
    updated_at: Number.isFinite(app.updatedAt) ? app.updatedAt : 0
  };
}

function rowToApplication(row) {
  return row && row.data && typeof row.data === "object" ? row.data : null;
}

// ---- pull ---------------------------------------------------------------

async function pullUserData(client, userId, since) {
  const rows = await client.select("user_data", {
    select: "kind,data,updated_at",
    filters: { user_id: `eq.${userId}` },
    limit: 100
  });
  if (!rows.length) return 0;

  const stored = await chrome.storage.local.get(USER_DATA_KINDS.map((k) => k.key));
  const known = new Map(USER_DATA_KINDS.map((k) => [k.kind, k.key]));

  const patch = {};
  for (const row of rows) {
    const key = known.get(row.kind);
    if (!key || row.data == null) continue;
    const localHas = stored[key] !== undefined;
    const remoteMs = Number(row.updated_at) || 0;
    if (!localHas || remoteMs > since) patch[key] = row.data;
  }

  const count = Object.keys(patch).length;
  if (count) await chrome.storage.local.set(patch);
  return count;
}

async function pullApplications(client, userId, since) {
  const rows = await client.select("applications", {
    select: "data,updated_at",
    filters: { user_id: `eq.${userId}`, updated_at: `gt.${since}` },
    order: "updated_at.desc",
    limit: 5000
  });
  if (!rows.length) return 0;
  if (typeof Tracker === "undefined" || !Tracker.mergeRemote) return 0;

  const remoteApps = rows.map(rowToApplication).filter(Boolean);
  const local = await Tracker.list().catch(() => []);
  const localById = new Map(local.map((app) => [app.id, app]));
  const changed = remoteApps.filter((remote) => {
    const existing = localById.get(remote.id);
    if (!existing) return true;
    return (Number(remote.updatedAt) || 0) > (Number(existing.updatedAt) || 0);
  });

  if (!changed.length) return 0;
  await Tracker.mergeRemote(changed);
  return changed.length;
}

// ---- push ---------------------------------------------------------------

async function pushUserData(client, userId) {
  const stored = await chrome.storage.local.get(USER_DATA_KINDS.map((k) => k.key));
  const updatedAt = Date.now();

  const rows = [];
  for (const { kind, key } of USER_DATA_KINDS) {
    const data = stored[key];
    if (data === undefined || data === null) continue;
    rows.push({ user_id: userId, kind, data, updated_at: updatedAt });
  }
  if (!rows.length) return 0;

  await client.upsert("user_data", rows, { onConflict: "user_id,kind" });
  return rows.length;
}

async function pushApplications(client, userId) {
  let apps = [];
  if (typeof Tracker !== "undefined" && Tracker.list) {
    try {
      apps = await Tracker.list();
    } catch {
      apps = [];
    }
  }
  if (!apps.length) return 0;
  const rows = apps.map((app) => applicationToRow(userId, app));
  await client.upsert("applications", rows, { onConflict: "user_id,id" });
  return rows.length;
}

// ---- the sync itself ----------------------------------------------------

async function pushPull(settings = {}, { signal } = {}) {
  if (typeof Supabase === "undefined" || !Supabase.connect) {
    return {
      ok: false,
      error: "client_missing",
      notes: ["The Supabase client (supabase.js) is not loaded on this page."]
    };
  }

  const session = typeof Cloud !== "undefined" && Cloud.getSession ? await Cloud.getSession() : null;
  const userId = cloudUserKey(session);
  if (!userId) {
    return {
      ok: false,
      error: "not_signed_in",
      notes: ["Not signed in. Sign in with Google in the Account panel first."]
    };
  }

  const client = Supabase.connect(settings);
  if (!client) {
    return {
      ok: false,
      error: "not_configured",
      notes: ["Supabase is not configured. Set the project URL and anon key in the Account panel."]
    };
  }

  const last = await loadLastSync();
  const since = last && Number.isFinite(last.at) ? last.at : 0;
  const notes = [];

  // ---- pull (cloud -> local) ----
  let pulledKinds = 0;
  let pulledApps = 0;
  try {
    pulledKinds = await pullUserData(client, userId, since);
    pulledApps = await pullApplications(client, userId, since);
  } catch (err) {
    return {
      ok: false,
      error: "pull_failed",
      notes: [
        `Download failed — ${err.message}`,
        "Nothing was uploaded, so the cloud copy is untouched."
      ]
    };
  }

  if (signal && signal.aborted) {
    return { ok: true, aborted: true, notes: ["Sync stopped after download."] };
  }

  // ---- push (local -> cloud) ----
  let pushedKinds = 0;
  let pushedApps = 0;
  try {
    pushedKinds = await pushUserData(client, userId);
    pushedApps = await pushApplications(client, userId);
  } catch (err) {
    return {
      ok: false,
      error: "push_failed",
      notes: [
        `Download succeeded but upload failed — ${err.message}`,
        "Your local data is intact; retry the sync to finish uploading it."
      ]
    };
  }

  const state = {
    at: Date.now(),
    userId,
    pushed: pushedKinds + pushedApps,
    pulled: pulledKinds + pulledApps,
    pushedApps,
    pushedKinds,
    pulledApps,
    pulledKinds
  };
  await saveLastSync(state);

  return { ok: true, state, notes };
}

// Whether the background alarm should be armed: signed in AND Supabase
// configured. An unsigned-in or unconfigured install must never make a network
// call it cannot attribute to an account.
async function shouldSyncAutomatically(settings) {
  if (typeof Supabase === "undefined" || !Supabase.connect) return false;
  if (!Supabase.config(settings)) return false;
  const session = typeof Cloud !== "undefined" && Cloud.getSession ? await Cloud.getSession() : null;
  return !!cloudUserKey(session);
}

const CloudSync = {
  pushPull,
  loadLastSync,
  shouldSyncAutomatically,
  cloudUserKey,
  // Exposed for tests.
  applicationToRow,
  rowToApplication
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = { CloudSync };
} catch {}
