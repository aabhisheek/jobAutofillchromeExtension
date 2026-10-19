// Supabase REST client — zero dependencies, plain fetch.
//
// The extension has no bundler and no npm runtime dependencies, so instead of
// @supabase/supabase-js this file talks to Supabase's PostgREST HTTP API
// directly. It is plain JSON over HTTPS, which is all fetch needs.
//
// Identity does NOT come from here. The extension signs in with its own Google
// flow (src/lib/cloud.js) and reaches Supabase with the project's public anon
// key; rows are keyed on the sign-in email. Every table is protected by RLS
// (see supabase/schema.sql). This client is only the transport.
//
// Config comes from the merged settings object: settings.supabaseUrl and
// settings.supabaseAnonKey. When either is missing every helper returns null so
// an unconfigured install never sends anything to a guessed project.
//
// Loaded as a classic script in extension pages (via <script>) and in the
// background service worker (via importScripts). Defines the global `Supabase`.

function supabaseConfig(settings) {
  const url = String((settings && settings.supabaseUrl) || "").trim().replace(/\/+$/, "");
  const key = String((settings && settings.supabaseAnonKey) || "").trim();
  if (!url || !key) return null;
  return { url, key };
}

function supabaseHeaders(cfg, extra = {}) {
  return {
    apikey: cfg.key,
    authorization: `Bearer ${cfg.key}`,
    "content-type": "application/json",
    ...extra
  };
}

// Builds a PostgREST query string. `filters` uses PostgREST operator syntax:
// { user_id: "eq.<email>", updated_at: "gt.1700000000000" }.
function supabaseQueryString({ select = "*", filters = {}, order, limit } = {}) {
  const params = new URLSearchParams();
  params.set("select", select);
  for (const [column, opValue] of Object.entries(filters)) {
    params.set(column, opValue);
  }
  if (order) params.set("order", order);
  if (limit != null) params.set("limit", String(limit));
  return params.toString();
}

async function supabaseRequest(cfg, path, { method = "GET", headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: supabaseHeaders(cfg, headers),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error(`Could not reach Supabase at ${cfg.url} (${err && err.message ? err.message : "network error"}).`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase ${method} ${path} failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}.`);
  }

  // 204 No Content (delete / minimal upsert) has no body to parse.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- PostgREST table helpers -------------------------------------------

async function tableSelect(cfg, table, options = {}) {
  const qs = supabaseQueryString(options);
  const rows = await supabaseRequest(cfg, `/rest/v1/${table}?${qs}`);
  return Array.isArray(rows) ? rows : [];
}

// UPSERT one row or an array of rows. `onConflict` names the column list that
// decides a duplicate (PostgREST turns it into ON CONFLICT); the default is the
// table's primary key.
async function tableUpsert(cfg, table, rows, { onConflict } = {}) {
  let path = `/rest/v1/${table}`;
  if (onConflict) path += `?on_conflict=${encodeURIComponent(onConflict)}`;
  return supabaseRequest(cfg, path, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: rows
  });
}

async function tableUpdate(cfg, table, filters, patch) {
  const qs = supabaseQueryString({ select: "*", filters });
  return supabaseRequest(cfg, `/rest/v1/${table}?${qs}`, { method: "PATCH", body: patch });
}

async function tableDelete(cfg, table, filters) {
  const qs = supabaseQueryString({ select: "*", filters });
  return supabaseRequest(cfg, `/rest/v1/${table}?${qs}`, { method: "DELETE" });
}

// ---- public surface -----------------------------------------------------

const Supabase = {
  // Returns { url, key } or null when the project is not configured.
  config: supabaseConfig,

  // Returns a small object bound to one project, or null when unconfigured.
  // Every method throws a descriptive Error on failure — callers decide whether
  // to surface or swallow.
  connect(settings) {
    const cfg = supabaseConfig(settings);
    if (!cfg) return null;
    return {
      url: cfg.url,
      select: (table, options) => tableSelect(cfg, table, options),
      upsert: (table, rows, options) => tableUpsert(cfg, table, rows, options),
      update: (table, filters, patch) => tableUpdate(cfg, table, filters, patch),
      delete: (table, filters) => tableDelete(cfg, table, filters)
    };
  }
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = { Supabase };
} catch {}
