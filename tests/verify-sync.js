// End-to-end of the sync path: real mail-import.js + tracker.js against a
// scripted Gmail and a scripted AI provider, so the idempotency ledger, the
// dedupe rules and the AI-failure fallback are all exercised together.
const vm = require("vm");
const { ROOT, makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

const chromeMock = makeChrome({ storage: makeStorage() });

let aiCalls = 0;
const AI_REPLIES = {};
// When set, replaces the scripted batch answer entirely — used by the
// id-mapping test to script an out-of-order, partially-dropped reply.
let aiOverride = null;

function replyFor(subject) {
  for (const [key, value] of Object.entries(AI_REPLIES)) {
    if (String(subject).includes(key)) return value;
  }
  return {};
}

// One OpenAI-shaped response per request. The importer now sends many emails in
// one prompt, each tagged `=== ref: eN ===`, so the answer is an array echoing
// those refs. A single-email prompt (if one is ever sent) still gets an object.
function aiReply(body) {
  const text = String(body);
  if (aiOverride) {
    return { choices: [{ message: { content: JSON.stringify(aiOverride(text)) }, finish_reason: "stop" }] };
  }

  const blocks = [...text.matchAll(/=== ref: (\S+) ===\nSubject: ?([^\n]*)/g)];
  if (blocks.length) {
    const answer = blocks.map(([, ref, subject]) => ({ ref, ...replyFor(subject) }));
    return { choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }] };
  }

  return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
}

const MESSAGES = [];
let failIds = new Set();
// What the last list call asked Gmail for — the full read and the scheduled
// query read must be distinguishable from the outside.
let lastList = null;

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
  async hasCredentials(settings) { return !!String((settings && settings.gmailClientId) || "").trim(); },
  async listMessageIds(_s, opts) {
    lastList = { kind: "query", opts };
    return MESSAGES.slice(0, opts.maxResults).map((m) => m.id);
  },
  async listAllMessageIds(_s, opts) {
    lastList = { kind: "window", opts };
    return MESSAGES.slice(0, opts.ceiling).map((m) => m.id);
  },
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
    groqModel: "test-model",
    // Keep the retry/rotation layer's backoff out of the test clock. Nothing in
    // the UI sets this; it exists so the failure tests do not sleep for real.
    aiRetryBaseMs: 0
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
  eq("report records that AI was on", report.aiOn, true);
  console.log("   report:", JSON.stringify(report));
  console.log("   progress phases:", [...new Set(progress.map(p => p.phase))].join(","));

  // Live AI counters: the dashboard must be able to show how much was read by
  // AI while the run is still going, not only once it lands in the report.
  const enrichTicks = progress.filter((p) => p.phase === "enrich");
  eq("enrichment reports live progress", enrichTicks.length >= 1, true);
  eq("the AI-on flag rides on the tick", enrichTicks[0].aiOn, true);
  eq("the very first reading tick already carries the AI flag", progress.find((p) => p.phase === "fetch").aiOn, true);
  eq("live enriched count reaches the run total", progress.filter((p) => p.phase === "parse").pop().aiEnriched, 6);

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
  eq("report records that AI was off", noAi.aiOn, false);
  eq("no AI calls", aiCalls, 0);
  eq("still imported", noAi.added, 5);
  eq("ML row still found by heuristic", !!(await T.list()).find((r) => /Requisition/i.test(r.title)), true);

  // ---- 7. AI cap: past the cap, remaining rows fall back to the local parse ----
  await T.clear(); await M.ledger.clear(); aiCalls = 0;
  const capTicks = [];
  const capped = await M.runSync({ settings: { ...settings, emailMaxAiPerRun: 2 }, onProgress: (p) => capTicks.push(p) });
  eq("cap honoured", capped.aiEnriched, 2);
  eq("rest fell back", capped.aiSkipped, 5);
  eq("everything still imported", capped.added + capped.updated, 7);
  const lastCapTick = capTicks[capTicks.length - 1];
  eq("live tick shows how many were AI-skipped", lastCapTick.aiSkipped, 5);
  eq("live tick shows how many the AI read", lastCapTick.aiEnriched, 2);
  // The two emails under the cap share one request now, so a capped window costs
  // one call per batch rather than one per email.
  eq("the two under the cap share one AI call", aiCalls, 1);

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
  const downTicks = [];
  const aiDown = await M.runSync({ settings: { ...settings, emailUseAi: true }, onProgress: (p) => downTicks.push(p) });
  ctx.fetch = realFetch;
  eq("run survived the AI outage", aiDown.ok, true);
  // 7 messages by now: a1/a2/a3 are one job (1 add + 2 updates), plus 4 others.
  eq("every mail still saved", aiDown.added + aiDown.updated, 7);
  eq("AI failures counted separately from unreadable mail", aiDown.failed, 0);
  eq("AI failures reported", aiDown.aiFailed, 7);
  eq("nothing claimed as AI-enriched", aiDown.aiEnriched, 0);
  eq("live tick reports the AI failures", downTicks.filter((p) => p.phase === "parse").pop().aiFailed, 7);
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

  // ---- 11. the manual full read: whole window, gated locally ----
  // Read & Sync does not take the first page of the search query — it asks for
  // every message in the look-back window and decides relevance here, so a new
  // mail the query never matched still reaches the board while newsletters
  // stay off it.
  const relevant = msg("x1", "Application received: Frontend Engineer at Umbrella", "Umbrella Careers <careers@umbrella.com>",
      { receivedAt: AT(1) });
  const noise = msg("n1", "Your weekly digest of 42 articles", "Digest <news@digest.example.com>",
      { receivedAt: AT(2) });
  MESSAGES.push(relevant, noise);
  try {
    const full = await M.runSync({ settings, full: true, force: true });
    eq("window read scanned everything in the window", full.scanned, 9);
    eq("the window query, not the search query", lastList.kind, "window");
    eq("window is the look-back floor alone", lastList.opts.query, "newer_than:30d");
    eq("new mail the query never matched is imported", full.added, 1);
    eq("the newsletter is read but turned away", full.ignored, 1);
    eq("nothing merged by mistake", full.updated, 0);
    eq("already-imported mail still skipped, not re-added", full.skipped, 7);
    eq("run marked full for the last-run line", full.full, true);
    eq("the new card is on the board", !!(await T.list()).find((r) => r.company === "Umbrella"), true);

    // A scheduled run right after must still take the query path — the full
    // read is the button, not the alarm.
    await M.runSync({ settings });
    eq("scheduled run goes back to the query list", lastList.kind, "query");
  } finally {
    MESSAGES.splice(MESSAGES.indexOf(relevant), 1);
    MESSAGES.splice(MESSAGES.indexOf(noise), 1);
  }

  // ---- 12. Stop: an AbortSignal ends the run but keeps what it imported ----
  // The Stop button trips a signal the importer reads between messages and
  // between Gmail pages. Three things must hold: an already-aborted run reads
  // nothing, a stop during the import ends it at once while every row already
  // saved stays, and a stop during the read still imports the mail in hand —
  // that last one is the whole point of stopping after "a few".
  const stopMsgs = [
    msg("p1", "Your application for Designer at Pineapple", "Pineapple <jobs@pineapple.com>", { receivedAt: AT(2) }),
    msg("p2", "Your application for Writer at Quokka", "Quokka <jobs@quokka.com>", { receivedAt: AT(2) }),
    msg("p3", "Your application for Manager at Rhino", "Rhino <hr@rhino.com>", { receivedAt: AT(2) })
  ];
  MESSAGES.unshift(...stopMsgs);
  const stopTitles = ["Designer", "Writer", "Manager"];
  const countRows = async (titles) => (await T.list()).filter((r) => titles.includes(r.title)).length;
  const origGet = ctx.Gmail.getMessage;
  try {
    // (a) stopped before it began: nothing read, nothing written, and reported
    //     as a stop rather than a failure.
    const idle = new AbortController();
    idle.abort();
    let reads = 0;
    ctx.Gmail.getMessage = async (s, id) => { reads += 1; return origGet(s, id); };
    const stopped = await M.runSync({ settings, full: true, force: true, signal: idle.signal });
    eq("pre-aborted run is a stop", stopped.aborted, true);
    eq("pre-aborted run is not a failure", stopped.ok, true);
    eq("pre-aborted run reads nothing", reads, 0);
    eq("pre-aborted run imports nothing", await countRows(stopTitles), 0);

    // (b) stopped while importing: the first new mail is saved, the rest are
    //     left for the next run.
    ctx.Gmail.getMessage = origGet;
    const parseStop = new AbortController();
    const stoppedParse = await M.runSync({
      settings, full: true, force: true, signal: parseStop.signal,
      onProgress: (p) => { if (p.phase === "parse" && p.done === 1) parseStop.abort(); }
    });
    eq("import-stop marks the report", stoppedParse.aborted, true);
    eq("import-stop keeps the row it had already saved", await countRows(stopTitles), 1);
    eq("import-stop leaves the rest unread", await countRows(["Writer", "Manager"]), 0);

    // (c) stopped while reading: the bodies fetched before the stop are still
    //     imported, the ones after it never get read.
    const readStop = new AbortController();
    ctx.Gmail.getMessage = async (s, id) => {
      if (id === "p2") readStop.abort();
      return origGet(s, id);
    };
    const stoppedRead = await M.runSync({ settings, full: true, force: true, signal: readStop.signal });
    eq("read-stop marks the report", stoppedRead.aborted, true);
    eq("read-stop counts no failures", stoppedRead.failed, 0);
    eq("read-stop imported the mail it did read", await countRows(stopTitles), 2);
    eq("read-stop never read the next one", await countRows(["Manager"]), 0);
    ctx.Gmail.getMessage = origGet;

    // (d) a clean run afterwards finishes the job.
    const finish = await M.runSync({ settings, full: true, force: true });
    eq("a plain run is not marked aborted", finish.aborted, false);
    eq("every stop-test card ends up on the board", await countRows(stopTitles), 3);
  } finally {
    ctx.Gmail.getMessage = origGet;
    for (const m of stopMsgs) { const i = MESSAGES.indexOf(m); if (i >= 0) MESSAGES.splice(i, 1); }
  }

  // ---- 13. batched AI: refs map answers back to the right email ----
  // The model is scripted to answer out of order and to drop one email. The two
  // it answered must take its values; the one it skipped must fall back to the
  // local parse, and no email may receive a neighbour's data.
  await T.clear();
  await M.ledger.clear();
  MESSAGES.length = 0;
  MESSAGES.push(
    msg("m1", "Your application for Alpha at One", "One <jobs@one.com>", { receivedAt: AT(2) }),
    msg("m2", "Your application for Beta at Two", "Two <jobs@two.com>", { receivedAt: AT(2) }),
    msg("m3", "Your application for Gamma at Three", "Three <jobs@three.com>", { receivedAt: AT(2) })
  );
  aiOverride = () => [
    { ref: "e3", title: "Gamma AI", company: "Three AI", url: "", stage: "offer" },
    { ref: "e1", title: "Alpha AI", company: "One AI", url: "https://one.ai/j", stage: "interview" }
  ];
  aiCalls = 0;
  const batched = await M.runSync({ settings });
  aiOverride = null;

  eq("batched run ok", batched.ok, true);
  eq("three emails, three cards", (await T.list()).length, 3);
  eq("two refs mapped, one dropped", batched.aiEnriched, 2);
  eq("one request for the whole batch", aiCalls, 1);
  const byEmail = new Map((await T.list()).map((r) => [r.sourceEmailId, r]));
  eq("out-of-order ref lands on the right email", byEmail.get("m1").title, "Alpha AI");
  eq("its stage came through too", byEmail.get("m1").status, "interview");
  eq("last ref lands on the right email", byEmail.get("m3").title, "Gamma AI");
  eq("last ref stage came through", byEmail.get("m3").status, "offer");
  eq("dropped email falls back to its own local parse",
     byEmail.get("m2").title, M.parseLocally(await ctx.Gmail.getMessage(settings, "m2")).title);
  eq("and it borrowed neither neighbour's title",
     ["Alpha AI", "Gamma AI"].includes(byEmail.get("m2").title), false);

  // ---- 14. AI-only mode: no AI answer means no card, but a retry later ----
  // The default is that an email the AI never read is not imported from the
  // local parse; it is held back and tried again on a later run, so the board
  // never shows a half-read card.
  await T.clear(); await M.ledger.clear(); MESSAGES.length = 0;
  MESSAGES.push(
    msg("r1", "Your application for Role One at One", "One <jobs@one.com>", { receivedAt: AT(2) }),
    msg("r2", "Your application for Role Two at Two", "Two <jobs@two.com>", { receivedAt: AT(2) })
  );
  const aiOnly = { ...settings, emailRequireAi: true };
  const realFetchForOutage = ctx.fetch;
  ctx.fetch = async () => ({ ok: false, status: 500, text: async () => "down", json: async () => ({}) });
  const heldBack = await M.runSync({ settings: aiOnly });
  ctx.fetch = realFetchForOutage;
  eq("AI-only: a provider outage imports nothing", heldBack.added, 0);
  eq("AI-only: both emails are counted as deferred", heldBack.deferred, 2);
  eq("AI-only: the board stays empty", (await T.list()).length, 0);
  eq("AI-only: deferred emails are not in the ledger",
     (await M.ledger.read()).has("r1"), false);

  const retried = await M.runSync({ settings: aiOnly });
  eq("AI-only: the next run imports them once AI answers", retried.added, 2);
  eq("AI-only: nothing is left deferred", retried.deferred, 0);
  eq("AI-only: two cards on the board", (await T.list()).length, 2);

  // ---- 15. AI-only mode: past the per-run cap is deferred, not imported ----
  await T.clear(); await M.ledger.clear(); MESSAGES.length = 0;
  MESSAGES.push(
    msg("cap1", "Your application for Capped One at One", "One <jobs@one.com>", { receivedAt: AT(2) }),
    msg("cap2", "Your application for Capped Two at Two", "Two <jobs@two.com>", { receivedAt: AT(2) })
  );
  const capOnly = await M.runSync({ settings: { ...settings, emailRequireAi: true, emailMaxAiPerRun: 1 } });
  eq("AI-only cap: only the one under the cap is imported", capOnly.added, 1);
  eq("AI-only cap: the one over the cap is deferred", capOnly.deferred, 1);
  eq("AI-only cap: the board holds only the enriched card", (await T.list()).length, 1);

  // ---- 16. a failing provider is retried, then the next one takes over ----
  // Groq answers 500 on every attempt; DeepSeek, configured as the second
  // provider, answers. The email must still be read by AI, and the run must
  // record no AI failure.
  await T.clear(); await M.ledger.clear(); MESSAGES.length = 0;
  MESSAGES.push(
    msg("rot1", "Your application for Rotated at Rotateco", "Rotateco <jobs@rotateco.com>", { receivedAt: AT(2) })
  );
  const realFetchRotate = ctx.fetch;
  aiCalls = 0;
  ctx.fetch = async (url, init) => {
    if (String(url).includes("groq.com")) {
      aiCalls += 1;
      return { ok: false, status: 500, text: async () => "groq down", json: async () => ({}) };
    }
    return realFetchRotate(url, init);
  };
  const rotated = await M.runSync({
    settings: { ...settings, emailRequireAi: true, deepseekApiKey: "sk-deepseek" }
  });
  ctx.fetch = realFetchRotate;
  eq("rotation: the second provider still imports the card", rotated.added, 1);
  eq("rotation: no AI failure is recorded", rotated.aiFailed, 0);
  eq("rotation: groq was retried before the switch (3 tries + 1 deepseek call)", aiCalls, 4);
  eq("rotation: the card is marked AI-read", rotated.aiEnriched, 1);

  // ---- 10. state is written for the panel to render ----

  process.exit(done() ? 1 : 0);
})();