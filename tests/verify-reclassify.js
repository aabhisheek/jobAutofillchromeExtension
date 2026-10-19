// Exercises the AI re-check path: real mail-import.js + tracker.js against a
// scripted Gmail and a scripted AI, so "move a wrong tab either direction",
// "newest mail wins", and "hand-added cards are never touched" are all checked
// together.
const vm = require("vm");
const { makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

const chromeMock = makeChrome({ storage: makeStorage() });

let aiCalls = 0;

// What the model would say, keyed by the exact subject line. Exact keys (not
// substrings) let two mails for the same job carry different answers.
const AI_REPLY = {
  "Your application for Backend Engineer at Acme Corp": { title: "Backend Engineer", company: "Acme Corp", stage: "rejected" },
  "Your application for Data Engineer at Globex": { title: "Data Engineer", company: "Globex", stage: "applied" },
  "Your application for SRE at Initech": { title: "SRE", company: "Initech", stage: "applied" },
  "Thank you for applying to SRE at Initech": { title: "SRE", company: "Initech", stage: "offer" },
  "Your application for Product Manager at Hooli": { title: "Product Manager", company: "Hooli", stage: "applied" },
  // A requisition-id subject the local parser reads as title "Requisition 88123"
  // / company "DEEP-DIVE". AI corrects it, so the stored card looks nothing
  // like the local parse — only the message id can match them.
  "Application Received - Requisition 88123 - DEEP-DIVE": { title: "ML Engineer", company: "Acme Corp", stage: "offer" }
};

const MESSAGES = [
  { id: "m1", subject: "Your application for Backend Engineer at Acme Corp", from: "Acme Careers <careers@acme.com>", receivedAt: 1000 },
  { id: "m3", subject: "Your application for Data Engineer at Globex", from: "Globex <talent@globex.com>", receivedAt: 2000 },
  { id: "m5", subject: "Your application for SRE at Initech", from: "Initech <jobs@initech.com>", receivedAt: 3000 },
  { id: "m6", subject: "Thank you for applying to SRE at Initech", from: "Initech <jobs@initech.com>", receivedAt: 4000 },
  { id: "m7", subject: "Your application for Product Manager at Hooli", from: "Hooli <careers@hooli.com>", receivedAt: 6000 },
  { id: "m8", subject: "Application Received - Requisition 88123 - DEEP-DIVE", from: "Talent <no-reply@acme.com>", receivedAt: 7000 },
  // Never job-related, must never reach AI or a card.
  { id: "n1", subject: "10 productivity tips for this week", from: "Digest <news@digest.example.com>", receivedAt: 5000, snippet: "Read more." }
];

const ctx = makeContext({ chrome: chromeMock });

load(ctx, "src/lib/schema.js");
load(ctx, "src/lib/tracker.js");
load(ctx, "src/lib/providers.js");

ctx.Gmail = {
  async getConnection() { return { connected: true, email: "me@gmail.com" }; },
  async hasCredentials() { return true; },
  async listMessageIds() { return MESSAGES.map((m) => m.id); },
  async listAllMessageIds() { return MESSAGES.map((m) => m.id); },
  async getMessage(_s, id) {
    const m = MESSAGES.find((x) => x.id === id);
    const at = m.from.lastIndexOf("<");
    const address = at >= 0 ? m.from.slice(at + 1, -1) : m.from;
    return {
      id: m.id,
      subject: m.subject,
      from: { name: at > 0 ? m.from.slice(0, at).trim() : m.from, address, domain: address.split("@")[1] || "" },
      receivedAt: m.receivedAt,
      snippet: m.snippet || "",
      body: "",
      links: []
    };
  }
};

load(ctx, "src/lib/mail-import.js");

// Bypass the real HTTP provider: answer each batched prompt from AI_REPLY,
// echoing the refs the prompt assigned. This is the same shape enrichBatchWithAi
// expects back, so the parsing/mapping under test is still the real code.
ctx.sendProviderPrompt = async ({ prompt }) => {
  aiCalls += 1;
  const blocks = [...String(prompt).matchAll(/=== ref: (\S+) ===\nSubject: ?([^\n]*)/g)];
  const answer = blocks.map(([, ref, subject]) => ({ ref, ...(AI_REPLY[subject.trim()] || {}) }));
  return JSON.stringify(answer);
};

const { T, M } = take(ctx, "({ T: Tracker, M: MailImport })");
const { eq, ok, done } = expect("reclassify");

(async () => {
  const settings = { gmailClientId: "123.apps.googleusercontent.com", groqApiKey: "gsk_test", emailLookbackDays: 30 };

  // ---- seed the board ----
  // R1 and R3 were filed by the local parse, R2 was filed as interview by a
  // loose local read, and R4 is the user's own hand-added row.
  await T.save({ sourceEmailId: "m1", title: "Backend Engineer", company: "Acme Corp", status: "applied", matchLoose: true });
  await T.save({ sourceEmailId: "m3", title: "Data Engineer", company: "Globex", status: "interview", matchLoose: true });
  await T.save({ sourceEmailId: "m5", title: "SRE", company: "Initech", status: "applied", matchLoose: true });
  // Already correct: AI will agree, so it must not be counted as a move.
  await T.save({ sourceEmailId: "m7", title: "Product Manager", company: "Hooli", status: "applied", matchLoose: true });
  // The card AI built at import: its stored name is nowhere in the local parse.
  await T.save({ sourceEmailId: "m8", title: "ML Engineer", company: "Acme Corp", status: "applied", matchLoose: true });
  await T.save({ title: "Designer", company: "Studio", status: "saved" });
  const before = await T.list();
  eq("six cards seeded", before.length, 6);

  // ---- 1. the re-check ----
  const progress = [];
  const report = await M.reclassifyWithAi({ settings, onProgress: (p) => progress.push(p) });

  eq("ok", report.ok, true);
  eq("flagged as a re-check", report.reclassify, true);
  eq("scanned the whole window", report.scanned, 7);
  eq("newsletter turned away by the relevance gate", report.considered, 6);
  eq("five imported cards re-examined", report.rechecked, 5);
  eq("five cards matched to their mail", report.matched, 5);
  eq("four stages moved", report.moved, 4);
  eq("nothing renamed", report.renamed, 0);
  eq("one card already right", report.unchanged, 1);
  eq("nothing left unmatched", report.unmatched, 0);
  eq("every eligible mail read by AI", report.aiEnriched, 6);
  eq("no AI failures", report.aiFailed, 0);
  console.log("   report:", JSON.stringify(report));
  console.log("   progress phases:", [...new Set(progress.map((p) => p.phase))].join(","));

  const rows = await T.list();
  eq("still six cards — re-check never adds or deletes", rows.length, 6);

  // Applied -> Rejected: the wrong-tab case the feature exists for.
  const acme = rows.find((r) => r.sourceEmailId === "m1");
  eq("wrong tab corrected applied -> rejected", acme.status, "rejected");
  eq("rejection stamped from the mail's own date", acme.rejectedAt, 1000);

  // Interview -> Applied: a deliberate demotion a normal sync refuses to do.
  const globex = rows.find((r) => r.sourceEmailId === "m3");
  eq("card moved backwards interview -> applied", globex.status, "applied");

  // Newest mail for the job wins: the applied confirmation then the offer.
  const initech = rows.find((r) => r.sourceEmailId === "m5");
  eq("newest mail about the job wins (offer)", initech.status, "offer");

  // The card AI built from a requisition-id subject, found only by message id.
  const ml = rows.find((r) => r.sourceEmailId === "m8");
  eq("AI-corrected card found by its email id and re-staged", ml.status, "offer");

  // The hand-added card is not a mail-imported row and is left alone.
  const studio = rows.find((r) => r.company === "Studio");
  eq("hand-added card untouched", studio.status, "saved");
  eq("hand-added card has no mail provenance", studio.sourceEmailId, "");

  // ---- 2. idempotent: a second pass changes nothing ----
  aiCalls = 0;
  const again = await M.reclassifyWithAi({ settings });
  eq("second pass moves nothing", again.moved, 0);
  eq("second pass finds all five already right", again.unchanged, 5);
  eq("second pass still reads every mail", again.aiEnriched, 6);

  // ---- 3. the report is persisted for the dashboard's last-run line ----
  const state = await M.readReclassifyState();
  eq("state persisted", state && state.reclassify, true);
  eq("state carries the move count", state.moved, 0);

  // ---- 4. no provider -> refused with a reason, nothing touched ----
  const noAi = await M.reclassifyWithAi({ settings: { ...settings, groqApiKey: "" } });
  eq("refused without AI", noAi.ok, false);
  eq("and says why", /needs AI/i.test(noAi.notes[0]), true);

  // ---- 5. not connected -> refused before any work ----
  const realGetConnection = ctx.Gmail.getConnection;
  ctx.Gmail.getConnection = async () => ({ connected: false });
  const offline = await M.reclassifyWithAi({ settings });
  ctx.Gmail.getConnection = realGetConnection;
  eq("refused while disconnected", offline.ok, false);
  eq("with the connection reason", /not connected/i.test(offline.notes[0]), true);

  // ---- 6. provider down -> the failures are counted and the reason kept ----
  // The dashboard has to tell a broken provider apart from a window that holds
  // no matching mail; without the captured reason it cannot.
  const realPrompt = ctx.sendProviderPrompt;
  ctx.sendProviderPrompt = async () => {
    throw new Error("Groq is rate limiting this key — try again in a minute.");
  };
  const down = await M.reclassifyWithAi({ settings });
  ctx.sendProviderPrompt = realPrompt;
  eq("a provider outage does not abort the run", down.ok, true);
  eq("every eligible mail counted as failed", down.aiFailed, down.considered);
  eq("nothing enriched", down.aiEnriched, 0);
  eq("nothing matched without AI answers", down.matched, 0);
  eq(
    "the provider's own reason is recorded",
    down.notes.some((n) => /^AI provider failed:.*rate limiting/i.test(n)),
    true
  );
  eq(
    "and no card moved on a failed pass",
    (await T.list()).length,
    6
  );

  // ---- 7. a batch too big for the key recovers by splitting ----
  // The provider rejects any request carrying more than two emails — the shape
  // of a per-minute token cap — but answers smaller ones. Before the split this
  // whole batch would have been written off; now every email still gets read.
  const realPrompt2 = ctx.sendProviderPrompt;
  let splitCalls = 0;
  ctx.sendProviderPrompt = async ({ prompt }) => {
    splitCalls += 1;
    const blocks = [...String(prompt).matchAll(/=== ref: (\S+) ===\nSubject: ?([^\n]*)/g)];
    if (blocks.length > 2) {
      throw new Error("Groq is rate limiting this key — try again in a minute.");
    }
    const answer = blocks.map(([, ref, subject]) => ({ ref, ...(AI_REPLY[subject.trim()] || {}) }));
    return JSON.stringify(answer);
  };
  const splitRun = await M.reclassifyWithAi({ settings });
  ctx.sendProviderPrompt = realPrompt2;
  eq("a too-large batch is split, not dropped", splitRun.aiEnriched, 6);
  eq("nothing is lost to the split", splitRun.aiFailed, 0);
  ok("more than one request was made", splitCalls > 1);

  process.exit(done() ? 1 : 0);
})();
