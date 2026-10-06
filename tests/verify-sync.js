// End-to-end of the sync path: real mail-import.js + tracker.js against a
// scripted Gmail and a scripted AI provider, so the idempotency ledger, the
// dedupe rules and the AI-failure fallback are all exercised together.
const vm = require("vm");
const { ROOT, makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

const chromeMock = makeChrome({ storage: makeStorage() });

let aiCalls = 0;
const AI_REPLIES = {};

// One OpenAI-shaped response per request, keyed by a marker in the subject.
function aiReply(body) {
  for (const [key, value] of Object.entries(AI_REPLIES)) {
    if (body.includes(key)) return { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] };
  }
  return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
}

const MESSAGES = [];
let failIds = new Set();

async function mockFetch(url, init = {}) {
  const u = String(url);

  if (u.includes("settings.json")) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (u.includes("/messages?")) {
    const q = decodeURIComponent(String(u).split("q=")[1] || "");
    const ids = MESSAGES.filter((m) => q === "" || true).map((m) => m.id);
    return { ok: true, status: 200, json: async () => ({ messages: ids.map((id) => ({ id })) }) };
  }
  const one = u.match(/\/messages\/([^?]+)\?format=full/);
  if (one) {
    const id = decodeURIComponent(one[1]);
    if (failIds.has(id)) return { ok: 500, status: 500, text: async () => "boom" };
    const m = MESSAGES.find((x) => x.id === id);
    return { ok: true, status: 200, json: async () => ({ payload: { headers: m.headers, body: m.body } }) };
  }
  if (u.startsWith("https://api.") || u.includes("/chat/completions")) {
    aiCalls += 1;
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => aiReply(body.messages[0].content) };
  }
  throw new Error("unexpected fetch: " + u);
}

const ctx = makeContext({ chrome: chromeMock, globals: { fetch: mockFetch } });

load(ctx, "src/lib/schema.js");
load(ctx, "src/lib/tracker.js");
load(ctx, "src/lib/providers.js");

ctx.Gmail = {
  async getConnection() { return { connected: true, email: "me@gmail.com" }; },
  async listMessageIds(_s, opts) { return MESSAGES.slice(0, opts.maxResults).map((m) => m.id); },
  async getMessage(_s, id) {
    const m = MESSAGES.find((x) => x.id === id);
    if (failIds.has(id)) throw new Error(`Gmail request failed (500)`);
    const header = (n) => (m.headers.find((h) => h.name === n) || { value: "" }).value;
    const raw = header("from");
    const at = raw.lastIndexOf("<");
    const from = {
      name: at > 0 ? raw.slice(0, at).trim().replace(/^"|"$/g, "") : raw,
      address: at > 0 ? raw.slice(at + 1, raw.length - 1) : raw,
      domain: at > 0 ? raw.slice(at + 1, raw.length - 1).split("@")[1] : ""
    };
    const date = header("date");
    return {
      id: m.id,
      subject: header("subject"),
      from,
      date,
      // Same shape gmail.js returns: when the mail arrived, not when it is read.
      receivedAt: m.receivedAt || Date.parse(date) || 0,
      snippet: m.snippet || "",
      body: "",
      links: m.links || []
    };
  }
};
load(ctx, "src/lib/mail-import.js");

const { T, M } = take(ctx, "({ T: Tracker, M: MailImport })");

function msg(id, subject, from, extra = {}) {
  return { id, headers: [{ name: "subject", value: subject }, { name: "from", value: from }], ...extra };
}

// Each message carries its own arrival date, days apart, so any assertion
// about "the email's date" can never be satisfied by the sync's own clock.
const DAY_MS = 86400000;
const AT = (daysAgo) => Date.now() - daysAgo * DAY_MS;
const A1_AT = AT(20);
const A2_AT = AT(19);
const A3_AT = AT(18);
const B1_AT = AT(15);
const C1_AT = AT(12);
const D1_AT = AT(5);
const E1_AT = AT(10);

// Five messages: two for the same job (applied + interview), three others.
MESSAGES.push(
  msg("a1", "Application received: Your application for Backend Engineer at Acme Corp", "Acme Careers <careers@acme.com>",
      { receivedAt: A1_AT }),
  msg("a2", "Interview invitation - Backend Engineer at Acme Corp", "Acme Careers <careers@acme.com>",
      { receivedAt: A2_AT, snippet: "We would like to invite you to a phone screen." }),
  msg("b1", "Your application for Data Engineer at Globex", "no-reply@globex.com",
      { receivedAt: B1_AT }),
  msg("c1", "We received your application for SRE at Initech", "Recruiting <talent@wd5.myworkdayjobs.com>",
      { receivedAt: C1_AT }),
  msg("d1", "Unfortunately, we will not be moving forward with your application", "Acme Careers <careers@acme.com>",
      { receivedAt: D1_AT, snippet: "We received your application but will not be moving forward." })
);

AI_REPLIES["Requisition"] = { title: "ML Engineer", company: "Acme Corp", url: "https://acme.com/j/7", stage: "applied" };
MESSAGES.push(msg("e1", "Application Received - Requisition 88123 - DEEP-DIVE", "Talent <no-reply@acme.com>",
    { receivedAt: E1_AT }));

const { eq, done } = expect("sync");

(async () => {
  const settings = {
    gmailClientId: "123.apps.googleusercontent.com",
    emailSyncEnabled: true,
    emailSyncQuery: "newer_than:30d {application}",
    emailLookbackDays: 30,
    emailUseAi: true,
    emailMaxAiPerRun: 20,
    groqApiKey: "gsk_test",
    groqModel: "test-model"
  };

  // ---- 1. full run ----
  const progress = [];
  const report = await M.runSync({ settings, onProgress: (p) => progress.push(p) });

  eq("ok", report.ok, true);
  eq("scanned", report.scanned, 6);
  eq("added (5 new jobs)", report.added, 5);
  eq("updated (the interview mail merged into its application)", report.updated, 1);
  eq("skipped", report.skipped, 0);
  eq("failed", report.failed, 0);
  eq("no notes", report.notes, []);
  eq("ai ran on every message", report.aiEnriched, 6);
  console.log("   report:", JSON.stringify(report));
  console.log("   progress phases:", [...new Set(progress.map(p => p.phase))].join(","));

  let rows = await T.list();
  eq("six mails, five cards", rows.length, 5);

  const acme = rows.find((r) => r.company === "Acme Corp");
  eq("acme interview stage", acme.status, "interview");
  eq("acme role", acme.title, "Backend Engineer");
  eq("acme url empty", acme.url, "");
  eq("acme source", acme.source, "Email");
  // The whole point of carrying the mail's date: an import records when the
  // application went out, never the moment this sync happened to run.
  eq("applied date is the confirmation email's date", acme.appliedAt, A1_AT);
  eq("and it is in the past, not the sync's clock", acme.appliedAt < Date.now(), true);

  const ml = rows.find((r) => r.title === "ML Engineer");
  eq("AI corrected the requisition-only subject", !!ml, true);
  eq("AI url adopted", ml.url, "https://acme.com/j/7");
  eq("AI url -> ATS-free source is the host", ml.source, "acme.com");
  eq("AI-imported row is dated from its email too", ml.appliedAt, E1_AT);

  const rej = rows.find((r) => r.company && r.status === "rejected");
  eq("rejection row exists", !!rej, true);
  eq("rejection counts as applied", Number.isFinite(rej.appliedAt), true);
  eq("rejection dated from the rejection email", rej.rejectedAt, D1_AT);
  eq("rejection's applied stamp comes from the same mail", rej.appliedAt, D1_AT);

  // ---- 2. second run is a no-op ----
  aiCalls = 0;
  const again = await M.runSync({ settings });
  eq("second run scanned all", again.scanned, 6);
  eq("second run skipped all", again.skipped, 6);
  eq("second run added nothing", again.added, 0);
  eq("second run spent no AI", aiCalls, 0);
  eq("dates already right, nothing to repair", again.datesFixed, 0);
  eq("board unchanged", (await T.list()).length, 5);

  // ---- 2b. rows stamped by an older build are repaired from the mail date ----
  // The bug this replaces: appliedAt/rejectedAt written as Date.now() at sync
  // time. The mail for every row is still in hand on the next run, so the
  // wrong stamp is rewritten from the message's own date — once.
  await T.save({ id: acme.id, appliedAt: Date.now() });
  await T.save({ id: rej.id, rejectedAt: Date.now() });
  const repair = await M.runSync({ settings });
  eq("both wrong dates found and repaired", repair.datesFixed, 2);
  eq("nothing else touched", repair.skipped, 4);
  eq("acme applied date restored to the email's date",
     (await T.list()).find((r) => r.sourceEmailId === "a1").appliedAt, A1_AT);
  eq("rejection date restored to the rejection email's date",
     (await T.list()).find((r) => r.status === "rejected").rejectedAt, D1_AT);
  const settled = await M.runSync({ settings });
  eq("a repaired row is not repaired again", settled.datesFixed, 0);
  eq("and the run goes back to skipping", settled.skipped, 6);

  // ---- 2c. a card stranded in Applied by the old rank rule is flipped ----
  // The rejection mail is already in the ledger, so only the repair pass can
  // reach it. The stage moves, the date stays the mail's own — this is what
  // makes an old board catch up without a manual "Re-import everything".
  await T.setStatus(rej.id, "applied");
  const flip = await M.runSync({ settings });
  eq("stranded card found and repaired", flip.datesFixed, 1);
  const flipped = (await T.list()).find((r) => r.sourceEmailId === "d1");
  eq("card moved applied -> rejected", flipped.status, "rejected");
  eq("rejection date still the mail's date", flipped.rejectedAt, D1_AT);
  const settledAfterFlip = await M.runSync({ settings });
  eq("flipped card is not repaired again", settledAfterFlip.datesFixed, 0);
  eq("and the run goes back to skipping", settledAfterFlip.skipped, 6);

  // ---- 3. a new interview mail for a tracked job updates that card ----
  MESSAGES.push(msg("a3", "Interview invitation - Backend Engineer at Acme Corp", "Acme Careers <careers@acme.com>",
      { receivedAt: A3_AT }));
  const third = await M.runSync({ settings });
  eq("third run scanned seven", third.scanned, 7);
  eq("the extra mail updated the card", third.updated, 1);
  eq("third run added none", third.added, 0);
  eq("board still five", (await T.list()).length, 5);

  // ---- 4. deleted row does not resurrect on a re-run ----
  await T.clear();
  const fourth = await M.runSync({ settings });
  eq("ledger still suppresses re-import", fourth.added, 0);
  eq("board stays empty after delete", (await T.list()).length, 0);

  // ---- 5. ledger cleared -> history returns, without duplicates ----
  await M.ledger.clear();
  const fifth = await M.runSync({ settings });
  eq("history re-imported once cleared", fifth.added, 5);
  eq("and merged, not duplicated", (await T.list()).length, 5);

  // ---- 6. AI disabled: local parse only, zero AI calls ----
  await T.clear(); await M.ledger.clear(); aiCalls = 0;
  const noAi = await M.runSync({ settings: { ...settings, emailUseAi: false } });
  eq("no AI enrichment", noAi.aiEnriched, 0);
  eq("no AI calls", aiCalls, 0);
  eq("still imported", noAi.added, 5);
  eq("ML row still found by heuristic", !!(await T.list()).find((r) => /Requisition/i.test(r.title)), true);

  // ---- 7. AI cap: past the cap, remaining rows fall back to the local parse ----
  await T.clear(); await M.ledger.clear(); aiCalls = 0;
  const capped = await M.runSync({ settings: { ...settings, emailMaxAiPerRun: 2 } });
  eq("cap honoured", capped.aiEnriched, 2);
  eq("rest fell back", capped.aiSkipped, 5);
  eq("everything still imported", capped.added + capped.updated, 7);
  eq("exactly two AI calls", aiCalls, 2);

  // ---- 8. one unreadable message does not sink the run ----
  await T.clear(); await M.ledger.clear();
  failIds = new Set(["c1"]);
  const partial = await M.runSync({ settings: { ...settings, emailUseAi: false } });
  eq("run still ok", partial.ok, true);
  eq("one failure counted", partial.failed, 1);
  eq("other rows still imported", partial.added, 4);
  eq("failure recorded", partial.notes.length, 1);
  failIds = new Set();

  // ---- 8b. an AI outage must fall back, not skip the application ----
  await T.clear(); await M.ledger.clear();
  const realFetch = ctx.fetch;
  ctx.fetch = async (url, init) => {
    if (String(url).includes("chat/completions")) {
      return { ok: false, status: 401, text: async () => '{"error":{"message":"Invalid API key"}}' };
    }
    return realFetch(url, init);
  };
  const aiDown = await M.runSync({ settings: { ...settings, emailUseAi: true } });
  ctx.fetch = realFetch;
  eq("run survived the AI outage", aiDown.ok, true);
  // 7 messages by now: a1/a2/a3 are one job (1 add + 2 updates), plus 4 others.
  eq("every mail still saved", aiDown.added + aiDown.updated, 7);
  eq("AI failures counted separately from unreadable mail", aiDown.failed, 0);
  eq("AI failures reported", aiDown.aiFailed, 7);
  eq("nothing claimed as AI-enriched", aiDown.aiEnriched, 0);
  eq("local parse still produced a row", (await T.list()).length, 5);
  eq("status still inferred locally", (await T.list())[0].status, "interview");

  // ---- 9. guards ----
  const off = await M.runSync({ settings: { ...settings, emailSyncEnabled: false } });
  eq("disabled + not forced is refused", off.ok, false);
  eq("with a reason", /switched off/i.test(off.notes[0]), true);
  const forced = await M.runSync({ settings: { ...settings, emailSyncEnabled: false }, force: true });
  eq("forced runs anyway", forced.ok, true);

  // Read the persisted state HERE, immediately after the run being checked.
  // A refused run still calls writeSyncState with its own report, so reading
  // state after any further runSync would compare against the wrong run — which
  // is how this assertion once "passed" only when two runs shared a millisecond.
  const state = await M.readSyncState();
  eq("state is the latest run", state.at, forced.at);
  eq("state has the numbers", typeof state.added === "number" && typeof state.scanned === "number", true);

  const noClient = await M.runSync({ settings: { ...settings, gmailClientId: "" } });
  eq("missing client id is refused", /client id/i.test(noClient.notes[0]), true);
  eq("a refused run still records state for the panel", (await M.readSyncState()).at, noClient.at);

  // ---- 10. state is written for the panel to render ----

  process.exit(done() ? 1 : 0);
})();