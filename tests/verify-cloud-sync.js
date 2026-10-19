// The Supabase-backed sync path, run for real inside the harness vm with a
// scripted PostgREST backend.
//
// The backend below is an in-memory stand-in for PostgREST: it stores rows in
// Maps keyed the way each table's primary key is, projects requested columns,
// and understands the filters the client emits (user_id=eq.…, updated_at=gt.…).
// That is enough to prove the client's request shapes and the pull/push ordering
// without a live project.
const { makeStorage, makeChrome, makeContext, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("cloud-sync");

const EMAIL = "anand.abhisheek@gmail.com";
const CONFIG = { supabaseUrl: "https://proj.supabase.co", supabaseAnonKey: "anon-key" };

// ---- scripted PostgREST backend ----------------------------------------

function keyFor(table, row) {
  if (table === "user_data") return `${row.user_id}::${row.kind}`;
  if (table === "applications") return `${row.user_id}::${row.id}`;
  return JSON.stringify(row);
}

function makeBackend() {
  return { user_data: new Map(), applications: new Map(), calls: [] };
}

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (obj === null ? "" : JSON.stringify(obj)),
    json: async () => obj
  };
}

function makeFetch(backend) {
  return async function fetchStub(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const table = u.pathname.replace(/^\/rest\/v1\//, "").split("/")[0];
    backend.calls.push({
      method,
      table,
      select: u.searchParams.get("select"),
      onConflict: u.searchParams.get("on_conflict")
    });
    const store = backend[table];

    if (method === "POST" || method === "PATCH") {
      const body = JSON.parse(init.body);
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        const key = keyFor(table, row);
        const prev = store.get(key);
        store.set(key, prev ? { ...prev, ...row } : { ...row });
      }
      return jsonRes(201, null);
    }

    // GET
    let rows = [...store.values()];
    const userFilter = u.searchParams.get("user_id");
    if (userFilter && userFilter.startsWith("eq.")) {
      const target = userFilter.slice(3);
      rows = rows.filter((r) => r.user_id === target);
    }
    const updatedFilter = u.searchParams.get("updated_at");
    if (updatedFilter && updatedFilter.startsWith("gt.")) {
      const since = Number(updatedFilter.slice(3));
      rows = rows.filter((r) => Number(r.updated_at) > since);
    }
    const select = u.searchParams.get("select") || "*";
    if (select !== "*") {
      const cols = select.split(",").map((c) => c.trim());
      rows = rows.map((r) => {
        const out = {};
        for (const c of cols) out[c] = r[c];
        return out;
      });
    }
    return jsonRes(200, rows);
  };
}

// ---- one isolated world per scenario -----------------------------------

function makeWorld({ storage, session = { token: "T", email: EMAIL, name: "Abhishek" } } = {}) {
  const backend = makeBackend();
  const store =
    storage ||
    makeStorage({
      profile: { personal: { firstName: "Abhishek", email: EMAIL } },
      ...(session ? { cloudSession: { ...session, expiresAt: Date.now() + 3600_000 } } : {})
    });

  const chrome = makeChrome({ storage: store });
  const ctx = makeContext({ chrome, globals: { fetch: makeFetch(backend) } });
  load(ctx, "src/lib/tracker.js");
  load(ctx, "src/lib/cloud.js");
  load(ctx, "src/lib/supabase.js");
  load(ctx, "src/lib/cloud-sync.js");

  return { ctx, backend, store, chrome };
}

(async () => {
  // ---- 1. guards ----
  {
    const w = makeWorld({ storage: makeStorage({}) });
    const noSession = await take(w.ctx, "CloudSync").pushPull(CONFIG);
    eq("no session -> not_signed_in", noSession.error, "not_signed_in");

    const noConfig = makeWorld();
    const res = await take(noConfig.ctx, "CloudSync").pushPull({});
    eq("signed in but unconfigured -> not_configured", res.error, "not_configured");
  }

  // ---- 2. first sync: empty cloud, everything is uploaded ----
  {
    const w = makeWorld();
    const { ctx, backend } = w;
    const Tracker = take(ctx, "Tracker");
    const CloudSync = take(ctx, "CloudSync");

    await Tracker.save({ url: "https://jobs.acme.com/1", title: "Backend Engineer", company: "Acme", status: "applied" });
    await Tracker.save({ url: "https://jobs.globex.com/2", title: "SRE", company: "Globex", status: "saved" });

    const res = await CloudSync.pushPull(CONFIG);
    eq("first sync ok", res.ok, true);
    eq("adopted no applications from an empty cloud", res.state.pulledApps, 0);
    eq("uploaded both applications", res.state.pushedApps, 2);
    eq("uploaded the profile blob", res.state.pushedKinds, 1);

    ok("applications stored under the lowercased email",
      [...backend.applications.keys()].every((k) => k.startsWith(`${EMAIL}::`)), true);
    eq("two application rows", backend.applications.size, 2);
    eq("profile blob stored", backend.user_data.get(`${EMAIL}::profile`).data.personal.firstName, "Abhishek");

    const upsert = backend.calls.find((c) => c.method === "POST" && c.table === "applications");
    eq("applications upsert targets (user_id,id)", upsert.onConflict, "user_id,id");
    const dataUpsert = backend.calls.find((c) => c.method === "POST" && c.table === "user_data");
    eq("user_data upsert targets (user_id,kind)", dataUpsert.onConflict, "user_id,kind");

    // Second sync with nothing changed must be a pure read.
    const again = await CloudSync.pushPull(CONFIG);
    eq("second sync ok", again.ok, true);
    eq("second sync adopts nothing", again.state.pulledApps + again.state.pulledKinds, 0);
  }

  // ---- 3. a fresh device pulls the whole cloud ----
  {
    const seeded = makeBackend();
    const past = Date.now() - 60_000;
    seeded.user_data.set(`${EMAIL}::profile`, {
      user_id: EMAIL,
      kind: "profile",
      data: { personal: { firstName: "Cloud" } },
      updated_at: past
    });
    seeded.applications.set(`${EMAIL}::app_x`, {
      user_id: EMAIL,
      id: "app_x",
      data: { id: "app_x", url: "https://x.dev/j", title: "Cloud Job", company: "CloudCo", status: "applied", updatedAt: past },
      updated_at: past
    });

    const store = makeStorage({ cloudSession: { token: "T", email: EMAIL, expiresAt: Date.now() + 3600_000 } });
    const chrome = makeChrome({ storage: store });
    const ctx = makeContext({ chrome, globals: { fetch: makeFetch(seeded) } });
    load(ctx, "src/lib/tracker.js");
    load(ctx, "src/lib/cloud.js");
    load(ctx, "src/lib/supabase.js");
    load(ctx, "src/lib/cloud-sync.js");

    const Tracker = take(ctx, "Tracker");
    const CloudSync = take(ctx, "CloudSync");
    const res = await CloudSync.pushPull(CONFIG);

    eq("fresh device sync ok", res.ok, true);
    eq("adopted the application", res.state.pulledApps, 1);
    eq("adopted the profile blob", res.state.pulledKinds, 1);
    eq("profile written locally", (await store.get("profile")).profile.personal.firstName, "Cloud");
    eq("application appears on the board", (await Tracker.list()).map((a) => a.title), ["Cloud Job"]);
  }

  // ---- 4. applications: newer cloud row wins, stale one does not ----
  {
    const w = makeWorld();
    const { ctx, backend } = w;
    const Tracker = take(ctx, "Tracker");
    const CloudSync = take(ctx, "CloudSync");

    await Tracker.save({ url: "https://jobs.acme.com/1", title: "Backend Engineer", company: "Acme", status: "applied" });
    await CloudSync.pushPull(CONFIG);
    const local = (await Tracker.list())[0];

    // A stale remote copy (older updated_at) must be ignored by the pull.
    const stored = backend.applications.get(`${EMAIL}::${local.id}`);
    backend.applications.set(`${EMAIL}::${local.id}`, { ...stored, updated_at: local.updatedAt - 10_000 });
    // A brand-new remote row must be adopted.
    const future = Date.now() + 5000;
    backend.applications.set(`${EMAIL}::app_new`, {
      user_id: EMAIL,
      id: "app_new",
      data: { id: "app_new", url: "https://new.dev/j", title: "New from cloud", company: "NewCo", status: "interview", updatedAt: future },
      updated_at: future
    });

    const res = await CloudSync.pushPull(CONFIG);
    const byId = new Map((await Tracker.list()).map((a) => [a.id, a]));
    eq("new remote row adopted", byId.has("app_new"), true);
    eq("adopted exactly one application", res.state.pulledApps, 1);
  }

  // ---- 5. local edit survives an unchanged cloud ----
  {
    const w = makeWorld();
    const { ctx, store } = w;
    const CloudSync = take(ctx, "CloudSync");

    await CloudSync.pushPull(CONFIG); // establishes state.at
    await store.set({ profile: { personal: { firstName: "LocalEdit" } } });

    const res = await CloudSync.pushPull(CONFIG);
    eq("unchanged cloud -> local edit not overwritten", (await store.get("profile")).profile.personal.firstName, "LocalEdit");
    eq("nothing adopted", res.state.pulledKinds, 0);
  }

  // ---- 6. a newer cloud blob wins over the local copy ----
  {
    const w = makeWorld();
    const { ctx, backend, store } = w;
    const CloudSync = take(ctx, "CloudSync");

    await CloudSync.pushPull(CONFIG); // establishes state.at
    // A cloud edit that landed after our last sync.
    const row = backend.user_data.get(`${EMAIL}::profile`);
    backend.user_data.set(`${EMAIL}::profile`, {
      ...row,
      data: { personal: { firstName: "CloudWins" } },
      updated_at: Date.now() + 10_000
    });

    const res = await CloudSync.pushPull(CONFIG);
    eq("newer cloud blob adopted", res.state.pulledKinds, 1);
    eq("cloud overwrote the local profile", (await store.get("profile")).profile.personal.firstName, "CloudWins");
  }

  // ---- 7. row mapping ----
  {
    const w = makeWorld();
    const CloudSync = take(w.ctx, "CloudSync");
    const app = {
      id: "app_1", url: "u", title: "t", company: "c", source: "s", status: "applied",
      notes: "n", sourceEmailId: "m1", match: { pct: 80 }, savedAt: 5, appliedAt: 6, rejectedAt: null, updatedAt: 7
    };
    const row = CloudSync.applicationToRow(EMAIL, app);
    eq("row keyed on the email", row.user_id, EMAIL);
    eq("row carries the whole app in data", row.data.title, "t");
    eq("row lifts updatedAt", row.updated_at, 7);
    eq("round-trips through rowToApplication", CloudSync.rowToApplication(row).id, "app_1");
  }

  // ---- 8. session email is lowercased for the row key ----
  {
    const w = makeWorld({ session: { token: "T", email: "Anand.Abhisheek@Gmail.com", name: "A" } });
    const CloudSync = take(w.ctx, "CloudSync");
    const res = await CloudSync.pushPull(CONFIG);
    eq("mixed-case sign-in syncs ok", res.ok, true);
    eq("state key is lowercased", res.state.userId, EMAIL);
    ok("rows stored under the lowercased email",
      [...w.backend.user_data.keys()].every((k) => k.startsWith(`${EMAIL}::`)), true);
  }

  // ---- 9. shouldSyncAutomatically gating ----
  {
    const w = makeWorld();
    eq("armed with a session + config", await take(w.ctx, "CloudSync").shouldSyncAutomatically(CONFIG), true);

    const signedOut = makeWorld({ storage: makeStorage({}) });
    eq("disarmed when signed out", await take(signedOut.ctx, "CloudSync").shouldSyncAutomatically(CONFIG), false);

    const unconfigured = makeWorld();
    eq("disarmed when unconfigured", await take(unconfigured.ctx, "CloudSync").shouldSyncAutomatically({}), false);
  }

  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
