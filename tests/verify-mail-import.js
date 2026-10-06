// Runs the real tracker.js + mail-import.js in a VM with chrome.storage mocked,
// so the URL/parser/upsert rules can be exercised without loading the extension.
const vm = require("vm");
const { ROOT, makeChrome, makeContext, load, take, expect } = require("./harness");

const chromeMock = makeChrome();
const ctx = makeContext({ chrome: chromeMock });

load(ctx, "src/lib/schema.js");
load(ctx, "src/lib/tracker.js");
load(ctx, "src/lib/providers.js");

// mail-import's top level only touches Tracker/configuredProviders at call time,
// so it loads cleanly with Gmail stubbed.
ctx.Gmail = {
  getConnection: async () => ({ connected: true }),
  listMessageIds: async () => [],
  getMessage: async () => ({})
};
load(ctx, "src/lib/mail-import.js");

const { T, M, normalizeUrl, computeInsights, matchIndex } =
  take(ctx, "({ T: Tracker, M: MailImport, normalizeUrl, computeInsights, matchIndex })");

const MailImport = M;
const { eq, done } = expect("mail-import");
const store = chromeMock.storage.local;

console.log("--- normalizeUrl ---");
eq("strips utm", normalizeUrl("https://acme.com/jobs/42?utm_source=x&utm_medium=y"), "https://acme.com/jobs/42");
eq("strips gh_src", normalizeUrl("https://boards.greenhouse.io/acme/jobs/42?gh_src=abc&gh_jid=9"), "https://boards.greenhouse.io/acme/jobs/42");
eq("strips trailing slash", normalizeUrl("https://acme.com/jobs/42/"), "https://acme.com/jobs/42");
eq("lowercases host + www", normalizeUrl("https://WWW.Acme.com/Jobs/42"), "https://acme.com/Jobs/42");
eq("keeps real params", normalizeUrl("https://acme.com/j?ghid=7"), "https://acme.com/j?ghid=7");
eq("sorts params", normalizeUrl("https://acme.com/j?b=2&a=1"), "https://acme.com/j?a=1&b=2");
eq("drops fragment", normalizeUrl("https://acme.com/j#app"), "https://acme.com/j");
eq("non-url passthrough", normalizeUrl("not a url"), "not a url");
eq("mail tracking noise", normalizeUrl("https://acme.com/j?lipi=LA&licu=LB&lipj=%7Babc%7D"), "https://acme.com/j");

console.log("--- cleanSubject ---");
const cs = MailImport.cleanSubject;
eq("plain", cs("Your application for Backend Engineer at Acme Corp"), "Backend Engineer at Acme Corp");
eq("received prefix", cs("Application received: Your application for Backend Engineer at Acme"), "Backend Engineer at Acme");
eq("re fwd stack", cs("Re: Fwd: Application received: Your application for Data Engineer at Globex"), "Data Engineer at Globex");
eq("thanks for applying", cs("Thank you for applying to Backend Engineer at Acme"), "Backend Engineer at Acme");
eq("we received", cs("We received your application for SRE at Initech"), "SRE at Initech");
eq("suffix", cs("Your application for Backend Engineer at Acme - Job Application"), "Backend Engineer at Acme");
eq("external tag", cs("[EXTERNAL] Application received - Backend Engineer at Acme"), "Backend Engineer at Acme");
eq("requisition only", cs("Application Received - Requisition 88123 - DEEP-DIVE"), "Requisition 88123 - DEEP-DIVE");

console.log("--- splitRoleCompany ---");
const sc = MailImport.splitRoleCompany;
eq("at", sc("Backend Engineer at Acme Corp"), { title: "Backend Engineer", company: "Acme Corp" });
eq("dash", sc("Backend Engineer - Acme Corp"), { title: "Backend Engineer", company: "Acme Corp" });
eq("team at company keeps team in role", sc("Backend Team - Payments at Acme"), { title: "Backend Team - Payments", company: "Acme" });
eq("company pipe trimmed", sc("Backend Engineer at Acme Corp | Bengaluru"), { title: "Backend Engineer", company: "Acme Corp" });
eq("no separator", sc("Backend Engineer"), { title: "Backend Engineer", company: "" });

console.log("--- companyFromSender ---");
const cf = MailImport.companyFromSender;
eq("careers suffix", cf({ name: "Acme Careers", domain: "acme.com" }), "Acme");
eq("talent acquisition", cf({ name: "Globex Talent Acquisition Team", domain: "globex.com" }), "Globex");
eq("no-reply falls to domain", cf({ name: "no-reply", domain: "acme.com" }), "Acme");
eq("known platform host", cf({ name: "Greenhouse", domain: "greenhouse.io" }), "Greenhouse");
eq("workday subdomain", cf({ name: "WD Recruiting", domain: "acme.wd5.myworkdayjobs.com" }), "Workday");
eq("email subdomain", cf({ name: "Mail", domain: "mail.acme.com" }), "Acme");
eq("empty", cf({ name: "", domain: "" }), "");

console.log("--- pickJobUrl ---");
const pj = MailImport.pickJobUrl;
eq("prefers job link over unsubscribe",
  pj([{ href: "https://acme.com/unsubscribe", text: "Unsubscribe" }, { href: "https://acme.com/jobs/42", text: "View job" }]),
  "https://acme.com/jobs/42");
eq("ats host wins",
  pj([{ href: "https://acme.com/blog", text: "Read" }, { href: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Bengaluru/42", text: "Apply" }]),
  "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Bengaluru/42");
eq("skips mailto", pj([{ href: "mailto:hr@acme.com", text: "Email us" }]), "");
eq("status page",
  pj([{ href: "https://greenhouse.io/acme/apply/12345/status", text: "View your application" }]),
  "https://greenhouse.io/acme/apply/12345/status");
eq("no usable link", pj([{ href: "https://twitter.com/acme", text: "Twitter" }]), "");

console.log("--- inferStatus ---");
const st = MailImport.inferStatus;
eq("applied", st({ subject: "Application received for Backend Engineer at Acme", snippet: "We have received your application", body: "" }), "applied");
eq("interview from subject", st({ subject: "Interview invitation - Backend Engineer at Acme", snippet: "", body: "" }), "interview");
eq("interview from body", st({ subject: "Next steps", snippet: "We would like to invite you to a phone screen", body: "" }), "interview");
eq("offer", st({ subject: "Your offer from Acme", snippet: "Congratulations!", body: "" }), "offer");
eq("rejected", st({ subject: "Update on your application at Acme", snippet: "Unfortunately we have decided to move forward with other candidates", body: "" }), "rejected");
eq("rejected beats applied", st({ subject: "Application update", snippet: "We received your application but will not be moving forward", body: "" }), "rejected");
eq("default applied", st({ subject: "We have received your application", snippet: "", body: "" }), "applied");

console.log("--- parseLocally end to end ---");
eq("full message", MailImport.parseLocally({
  subject: "Application received: Your application for Senior Backend Engineer at Acme Corp",
  from: { name: "Acme Careers", address: "careers@acme.com", domain: "acme.com" },
  snippet: "We have received your application.",
  body: "Thanks!",
  links: [{ href: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/42", text: "View job" }]
}), { title: "Senior Backend Engineer", company: "Acme Corp", url: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/42", status: "applied" });

console.log("--- parseJsonObject ---");
eq("fenced", MailImport.parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
eq("prose prefix", MailImport.parseJsonObject('Here you go:\n{"title":"X"}'), { title: "X" });
eq("brace in prose", MailImport.parseJsonObject('Use a { brace } carefully. Result: {"title":"Y"}'), { title: "Y" });
eq("garbage", MailImport.parseJsonObject("no json here"), null);

console.log("--- buildQuery ---");
eq("appends floor", MailImport.buildQuery({ emailSyncQuery: '"application received"', emailLookbackDays: 14 }), '"application received" newer_than:14d');
eq("respects user's own", MailImport.buildQuery({ emailSyncQuery: 'newer_than:7d "x"', emailLookbackDays: 30 }), 'newer_than:7d "x"');
eq("empty query", MailImport.buildQuery({ emailSyncQuery: "", emailLookbackDays: 30 }), "newer_than:30d");

console.log("--- tracker upsert / dedupe ---");
(async () => {
  // 1. Same URL, different tracking params -> one row.
  await T.save({ url: "https://acme.com/jobs/42?utm_source=li", title: "Backend Engineer", company: "Acme", status: "applied" });
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "applied" });
  eq("url dedupe -> 1 row", (await T.list()).length, 1);

  // 2. Interview email with the same url must upgrade, not duplicate.
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "interview" });
  let all = await T.list();
  eq("still 1 row", all.length, 1);
  eq("upgraded to interview", all[0].status, "interview");

  // 3. A stale rejection mail must not demote interview -> rejected.
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "rejected" });
  all = await T.list();
  eq("rejection did not demote", all[0].status, "interview");

  // 4. Offer outranks everything.
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "offer" });
  eq("offer sticks", (await T.list())[0].status, "offer");

  // 5. A late "application received" must not drag an offer back to applied.
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "applied" });
  eq("offer survives stale applied", (await T.list())[0].status, "offer");

  eq("still one row after stage churn", (await T.list()).length, 1);
  console.log("   insights:", JSON.stringify(computeInsights(await T.list())));

  // 6. A manual add must NOT use the loose title/company match, even when an
  //    imported row for the same role already exists.
  await T.save({ sourceEmailId: "m1", title: "Backend Engineer", company: "Acme", status: "applied", matchLoose: true });
  await T.save({ url: "", title: "Backend Engineer", company: "Acme", status: "saved" });
  eq("manual add makes a new row", (await T.list()).length, 2);

  // 7. An imported follow-up with no url DOES use it: the applied mail, then
  //    the interview mail for the same job, must be one card that moved.
  await T.clear();
  await T.save({ sourceEmailId: "m1", title: "Backend Engineer", company: "Acme", status: "applied", matchLoose: true });
  await T.save({ sourceEmailId: "m2", title: "Backend Engineer", company: "Acme", status: "interview", matchLoose: true });
  all = await T.list();
  eq("loose match merged into one row", all.length, 1);
  eq("loose match upgraded the stage", all[0].status, "interview");
  eq("creating mail keeps provenance", all[0].sourceEmailId, "m1");

  // 7b. The second mail's id goes in the ledger, so tomorrow's run skips it
  //     even though no single row remembers it.
  await M.ledger.write(new Set(["m1", "m2"]));
  eq("ledger remembers both mails", [...(await M.ledger.read())].sort().join(","), "m1,m2");

  // 8. Re-importing the same message id is an update, never a new row.
  const before = (await T.list()).length;
  await T.save({ sourceEmailId: "m2", title: "Backend Engineer", company: "Acme", status: "interview", matchLoose: true });
  eq("same email id -> no new row", (await T.list()).length, before);

  // 9. An import must not clobber notes the user typed into the row.
  const target = (await T.list())[0];
  await T.save({ id: target.id, notes: "Recruiter: Priya, referral REQ-99" });
  eq("explicit edit sets notes", (await T.list())[0].notes, "Recruiter: Priya, referral REQ-99");
  await T.save({ sourceEmailId: "m3", title: "Backend Engineer", company: "Acme", status: "rejected", matchLoose: true });
  eq("notes preserved through import", (await T.list())[0].notes, "Recruiter: Priya, referral REQ-99");
  eq("stale rejection did not demote", (await T.list())[0].status, "interview");

  // 10. An import with no url must not wipe a url the user typed, and vice
  //     versa: an import with no title must not blank a corrected one.
  await T.clear();
  await T.save({ url: "https://acme.com/jobs/42", title: "Backend Engineer", company: "Acme", status: "applied" });
  const withUrl = (await T.list())[0];
  await T.save({ id: withUrl.id, sourceEmailId: "m4", url: "", title: "", company: "", status: "applied", matchLoose: true });
  let after = (await T.list())[0];
  eq("url preserved", after.url, withUrl.url);
  eq("title preserved", after.title, "Backend Engineer");

  // 11. Insights now actually count something, which is the whole point.
  const ins = computeInsights(await T.list());
  eq("total tracked", ins.total, 1);
  eq("applied this week", ins.week, 1);
  console.log("   insights:", JSON.stringify(ins));

  // 12. matchIndex resolves by email id before url.
  const items = [{ id: "x", url: "https://a.com/1", sourceEmailId: "e1" }, { id: "y", url: "https://b.com/2", sourceEmailId: "e2" }];
  eq("email id wins", matchIndex(items, { sourceEmailId: "e2", url: "https://a.com/1" }), 1);
  eq("falls back to url", matchIndex(items, { url: "https://b.com/2?utm_source=x" }), 1);
  eq("loose title/company", matchIndex(items, { title: "A", company: "B", matchLoose: true }), -1);
  eq("no loose match without the flag", matchIndex(items, { title: "x", company: "y" }), -1);

  // 13. A rejection mail lands on a card that already reads Applied: same
  //     card, now Rejected — that is the only way the rejection date ever
  //     reaches the board. A stale applied mail must not undo it afterwards.
  await T.clear();
  await T.save({ sourceEmailId: "r1", title: "Data Engineer", company: "Globex", status: "applied", matchLoose: true });
  await T.save({ sourceEmailId: "r2", title: "Data Engineer", company: "Globex", status: "rejected", matchLoose: true });
  all = await T.list();
  eq("rejection merged into the applied card", all.length, 1);
  eq("card moved applied -> rejected", all[0].status, "rejected");
  await T.save({ sourceEmailId: "r3", title: "Data Engineer", company: "Globex", status: "applied", matchLoose: true });
  eq("stale applied mail cannot un-reject", (await T.list())[0].status, "rejected");

  // 14. Rejected still cannot demote the two live stages.
  await T.setStatus((await T.list())[0].id, "interview");
  await T.save({ sourceEmailId: "r4", title: "Data Engineer", company: "Globex", status: "rejected", matchLoose: true });
  eq("rejection does not demote interview", (await T.list())[0].status, "interview");

  process.exit(done() ? 1 : 0);
})();