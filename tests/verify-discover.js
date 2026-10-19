// End-to-end of job discovery: the pure scoring, the search plan, and a full
// run against a scripted pair of boards (canned listings come back from the
// mocked chrome.scripting) — so the cap, the dedupe, the rating fields, the
// idempotence of a re-run and the AI shortlist pass are all exercised
// together, with the real discover.js + tracker.js + resume-tailor.js.
const { makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

// ---- canned boards -------------------------------------------------------

function listing(i, title, snippet = "") {
  return {
    url: `https://jobs.example.com/posting/${i}`,
    title,
    company: `Company ${i}`,
    location: "Remote",
    snippet
  };
}

// LinkedIn: ten exact-role matches, ten designers. One match carries a snippet
// with profile skills so the keyword half of the score has something to find.
const LINKEDIN = [];
for (let i = 0; i < 20; i += 1) {
  LINKEDIN.push(listing(i, i % 2 === 0 ? "Backend Engineer" : "Graphic Designer"));
}
LINKEDIN[0].snippet = "Stack: Node.js, PostgreSQL on AWS.";

// Indeed: four URL-duplicates of LinkedIn (must dedupe away), ten unique
// senior-role matches, and three internships that a professional search must
// skip even though their titles would otherwise score as role matches.
const INDEED = [];
for (let i = 0; i < 4; i += 1) INDEED.push(listing(i, "Backend Engineer"));
for (let i = 20; i < 30; i += 1) INDEED.push(listing(i, "Senior Backend Engineer"));
for (let i = 30; i < 33; i += 1) INDEED.push(listing(i, "Backend Engineer Intern"));

// Feeds: hashtag posts. Five read like real hiring posts and one is noise that
// must not become a card; the last one carries an external apply link in place
// of a permalink, which is the shape the feed scanner prefers.
const FEED = [
  { url: "https://x.com/recruiter/status/1001", title: "We're hiring a Backend Engineer", company: "", location: "", snippet: "Node.js and PostgreSQL on AWS. Apply now." },
  { url: "https://x.com/recruiter/status/1002", title: "Hiring: Data Engineer", company: "", location: "", snippet: "Open position, apply now." },
  { url: "https://www.linkedin.com/posts/acme-2001", title: "Join our team as a Backend Engineer", company: "", location: "", snippet: "We're looking for a Backend Engineer. AWS, Node.js." },
  { url: "https://www.linkedin.com/posts/acme-2002", title: "Frontend Developer opening", company: "", location: "", snippet: "React and TypeScript role. Apply now." },
  { url: "https://jobs.example.com/posting/900", title: "Backend Engineer", company: "", location: "", snippet: "Node.js, PostgreSQL, AWS. Hiring now." },
  { url: "https://x.com/celebrations/status/1003", title: "Congratulations to our team", company: "", location: "", snippet: "So proud of everyone this quarter." }
];

// ---- chrome mock ---------------------------------------------------------

const store = makeStorage();
const chromeMock = makeChrome({ storage: store });

let tabSeq = 0;
const openTabs = new Map();
const removedTabs = [];

chromeMock.tabs.create = async ({ url, active }) => {
  const id = ++tabSeq;
  openTabs.set(id, { id, url, active });
  return { id, url };
};
chromeMock.tabs.get = async (id) => {
  const tab = openTabs.get(id);
  if (!tab) throw new Error(`tab ${id} is gone`);
  return { id, status: "complete" };
};
chromeMock.tabs.remove = async (id) => {
  removedTabs.push(id);
  openTabs.delete(id);
};
// The injected reader is replaced wholesale: what matters here is the engine's
// tab lifecycle and what it does with a listing set, not LinkedIn's DOM. The
// feed tabs are routed to the canned feed posts instead of the board listings.
const scannedFuncs = [];
chromeMock.scripting = {
  executeScript: async ({ target, func }) => {
    scannedFuncs.push(func && func.name);
    const tab = openTabs.get(target.tabId);
    const url = (tab && tab.url) || "";
    const source =
      url.includes("/jobs/search") ? LINKEDIN
      : url.includes("indeed.com/jobs") ? INDEED
      : url.includes("x.com") || url.includes("/search/results/content") ? FEED
      : [];
    return [{ result: source.map((item) => ({ ...item })) }];
  }
};

let aiCalls = 0;
async function mockFetch(url, init = {}) {
  const u = String(url);
  if (u.includes("settings.json") || u.includes("profile.json")) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (u.includes("api.groq.com") || u.includes("/chat/completions")) {
    aiCalls += 1;
    // Every top listing gets a descending shortlist score, so a correct AI
    // pass re-orders the saved cards in a way the local score alone would not.
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push({ i, shortlist: 90 - i, reasons: ["strong backend fit"] });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: "stop" }] })
    };
  }
  throw new Error("unexpected fetch: " + u);
}

const ctx = makeContext({ chrome: chromeMock, globals: { fetch: mockFetch } });

load(ctx, "src/lib/schema.js");
load(ctx, "src/lib/providers.js");
load(ctx, "src/lib/tracker.js");
load(ctx, "src/lib/mail-import.js");
load(ctx, "src/lib/resume-tailor.js");
load(ctx, "src/lib/page-scripts.js");
load(ctx, "src/lib/discover.js");

const { T, D } = take(ctx, "({ T: Tracker, D: Discover })");

const profile = {
  skills: ["Node.js", "React", "PostgreSQL", "AWS"],
  experience: [{ title: "Backend Engineer", technologies: ["Node.js", "AWS"] }],
  projects: []
};

const baseSettings = {
  discoverRoles: ["Backend Engineer", "Data Engineer"],
  discoverLocations: "",
  discoverMaxJobs: 20,
  discoverAuto: true,
  discoverUseAi: false
};

const { eq, ok, done } = expect("discover");

(async () => {
  console.log("--- role scoring ---");
  eq("exact title", D.roleScore("Backend Engineer", ["Backend Engineer"]).score, 1);
  eq("seniority prefix still matches",
     D.roleScore("Senior Backend Engineer", ["Backend Engineer"]).score >= 0.9, true);
  eq("unrelated title scores zero", D.roleScore("Graphic Designer", ["Backend Engineer"]).score, 0);
  eq("no roles configured is neutral, not zero", D.roleScore("Anything", []).score, 0.6);
  eq("reports which role it matched", D.roleScore("Backend Engineer", ["Backend Engineer"]).matched, "Backend Engineer");

  console.log("--- stars ---");
  eq("100% -> 5", D.starsFor(100), 5);
  eq("78% -> 4", D.starsFor(78), 4);
  eq("50% -> 3", D.starsFor(50), 3);
  eq("30% -> 2", D.starsFor(30), 2);
  eq("5% -> 1 (floor)", D.starsFor(5), 1);

  console.log("--- listing score ---");
  const good = D.scoreListing(
    { title: "Backend Engineer", snippet: "Node.js and PostgreSQL required" }, profile, ["Backend Engineer"]
  );
  const bad = D.scoreListing({ title: "Graphic Designer", snippet: "Figma and Illustrator" }, profile, ["Backend Engineer"]);
  ok("good score is in range", good.pct >= 0 && good.pct <= 100);
  ok("matching role + skills outranks a mismatch", good.pct > bad.pct);
  eq("good stars agree with pct", good.stars, D.starsFor(good.pct));
  ok("reasons explain the rating", good.reasons.some((r) => /Backend Engineer/.test(r)));
  eq("keyword coverage found in the snippet", good.reasons.some((r) => /covers/.test(r)), true);
  eq("shortlist falls back to the local score", good.shortlist, good.pct);

  console.log("--- search plan ---");
  const plan = D.searchPlan(["Backend Engineer", "Data Engineer", "SRE"], { discoverLocations: "Bangalore" });
  const boards = plan.filter((p) => p.kind !== "feed");
  const feeds = plan.filter((p) => p.kind === "feed");
  eq("board tabs capped at 4", boards.length, 4);
  eq("LinkedIn first", plan[0].site, "LinkedIn");
  ok("role in the url", plan[0].url.includes("Backend%20Engineer"));
  ok("location in the url", plan[0].url.includes("Bangalore"));
  eq("all LinkedIn before Indeed", boards.filter((p) => p.site === "LinkedIn").length, 3);
  ok("LinkedIn targets early career (entry + associate)",
     plan[0].url.includes("f_E=2%2C3"));
  const indeedPlan = plan.find((p) => p.site === "Indeed");
  ok("Indeed targets entry level", indeedPlan.url.includes("explvl=entry_level"));

  console.log("--- hashtag feeds ---");
  eq("feeds appended after the boards", feeds.length, 2);
  eq("LinkedIn content search first", feeds[0].site, "LinkedIn Posts");
  ok("LinkedIn feed searches the hashtags",
     feeds[0].url.includes("linkedin.com/search/results/content"));
  ok("LinkedIn feed queries #hiring", feeds[0].url.includes("%23hiring"));
  eq("X second", feeds[1].site, "X (Twitter)");
  ok("X feed uses the Latest tab", feeds[1].url.includes("f=live"));
  eq("default hashtags", D.normalizeHashtags({}), ["hiring", "ITjobs", "SDE"]);
  eq("string input and # stripped",
     D.normalizeHashtags({ discoverHashtags: "#hiring, itjobs" }), ["hiring", "itjobs"]);
  eq("duplicates collapse case-insensitively",
     D.normalizeHashtags({ discoverHashtags: ["SDE", "sde", "Dev"] }), ["SDE", "Dev"]);
  eq("an explicit empty list turns feeds off",
     D.normalizeHashtags({ discoverHashtags: [] }), []);
  eq("no feed tabs when hashtags are empty", D.feedPlan({ discoverHashtags: [] }).length, 0);
  eq("no feed tabs in the plan either",
     D.searchPlan(["Backend Engineer"], { discoverHashtags: [] }).length, 2);

  console.log("--- roles fall back to the profile ---");
  eq("explicit roles win", D.normalizeRoles({ discoverRoles: ["SRE"] }, profile), ["SRE"]);
  eq("empty roles fall back to experience titles",
     D.normalizeRoles({ discoverRoles: [] }, profile), ["Backend Engineer"]);
  eq("nothing at all yields nothing", D.normalizeRoles({ discoverRoles: [] }, {}), []);
  eq("an intern title is dropped from the fallback",
     D.normalizeRoles({ discoverRoles: [] },
       { experience: [{ title: "Software Engineer Intern" }, { title: "Software Engineer" }] }),
     ["Software Engineer"]);
  eq("an all-intern history yields nothing",
     D.normalizeRoles({ discoverRoles: [] }, { experience: [{ title: "Software Engineer Intern" }] }), []);
  eq("an intern role typed by the user is still honored",
     D.normalizeRoles({ discoverRoles: ["Software Engineer Intern"] }, profile),
     ["Software Engineer Intern"]);

  console.log("--- full run: top 20 of 30 board listings + 6 posts ---");
  const report = await D.run({ settings: baseSettings, profile });
  eq("ok", report.ok, true);
  eq("scanned (duplicates removed)", report.scanned, 36);
  eq("six tabs opened (four boards + two feeds)", report.tabs, 6);
  eq("all six closed", removedTabs.length, 6);
  eq("four tabs used the board scanner",
     scannedFuncs.filter((name) => name === "scanJobListings").length, 4);
  eq("two tabs used the feed scanner",
     scannedFuncs.filter((name) => name === "scanFeedPosts").length, 2);
  eq("no AI on this run", report.aiScored, 0);
  eq("capped at 20 added", report.added, 20);

  let board = await T.list();
  eq("board holds exactly the cap", board.length, 20);
  ok("no designer slipped past the cap", board.every((row) => !/Graphic Designer/.test(row.title)));
  ok("no internship slipped past the scan", board.every((row) => !/intern/i.test(row.title)));
  ok("no engagement-bait post became a card",
     board.every((row) => !/Congratulations/.test(row.title)));
  ok("every card carries a rating", board.every((row) => row.match && row.match.pct >= 0 && row.match.pct <= 100));
  ok("every card has 1-5 stars", board.every((row) => row.match.stars >= 1 && row.match.stars <= 5));
  ok("every card is saved", board.every((row) => row.status === "saved"));
  ok("notes say where it came from", board.every((row) => /Discovered from (LinkedIn|Indeed|X)/.test(row.notes)));
  ok("sources labelled", board.every((row) => row.source));
  eq("the skill-rich listing tops the locals",
     Math.max(...board.map((row) => row.match.pct)), 100);

  console.log("--- auto-run throttle ---");
  eq("refuses to re-run inside the window", await D.shouldAutoRun(), false);
  const state = await D.readState();
  ok("last-run state recorded", state && Number.isFinite(state.at));
  await chromeMock.storage.local.set({ discoverState: { ...state, at: Date.now() - 13 * 3600 * 1000 } });
  eq("runs again once the window passes", await D.shouldAutoRun(), true);

  console.log("--- re-run: no duplicates, leftovers fill the cap ---");
  const second = await D.run({ settings: baseSettings, profile });
  eq("nothing added twice", second.added, 16);
  eq("tracked listings skipped", second.alreadyTracked, 20);
  board = await T.list();
  eq("board grew by the leftovers only", board.length, 36);

  const third = await D.run({ settings: baseSettings, profile });
  eq("third run adds nothing", third.added, 0);
  eq("everything already tracked", third.alreadyTracked, 36);
  ok("says so", third.notes.some((n) => /already on the board/.test(n)));
  eq("board stable", (await T.list()).length, 36);

  console.log("--- AI shortlist pass ---");
  await T.clear();
  aiCalls = 0;
  const aiReport = await D.run({
    settings: { ...baseSettings, discoverUseAi: true, groqApiKey: "gsk_test", groqModel: "test-model" },
    profile
  });
  eq("AI scored the whole top set", aiReport.aiScored, 20);
  eq("one batched call, not twenty", aiCalls, 1);
  board = await T.list();
  eq("board rebuilt", board.length, 20);
  eq("shortlist chance replaced the local fallback", board[0].match.shortlist, 90);
  eq("cards saved in shortlist order", board.map((r) => r.match.shortlist), Array.from({ length: 20 }, (_, i) => 90 - i));
  ok("AI reasons prepended", /strong backend fit/.test(board[0].match.reasons.join(" ")));

  console.log("--- no roles anywhere is a clear failure, not an empty crawl ---");
  const nothing = await D.run({ settings: { discoverRoles: [] }, profile: {} });
  eq("not ok", nothing.ok, false);
  ok("explains itself", nothing.notes.some((n) => /No roles/.test(n)));
  eq("no tabs opened for it", report.tabs, 6);

  process.exit(done() ? 1 : 0);
})();
