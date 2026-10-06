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

// Indeed: four URL-duplicates of LinkedIn (must dedupe away) plus ten unique
// senior-role matches.
const INDEED = [];
for (let i = 0; i < 4; i += 1) INDEED.push(listing(i, "Backend Engineer"));
for (let i = 20; i < 30; i += 1) INDEED.push(listing(i, "Senior Backend Engineer"));

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
// tab lifecycle and what it does with a listing set, not LinkedIn's DOM.
chromeMock.scripting = {
  executeScript: async ({ target }) => {
    const tab = openTabs.get(target.tabId);
    const url = (tab && tab.url) || "";
    const source = url.includes("linkedin") ? LINKEDIN : url.includes("indeed") ? INDEED : [];
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
  eq("capped at 4 tabs", plan.length, 4);
  eq("LinkedIn first", plan[0].site, "LinkedIn");
  ok("role in the url", plan[0].url.includes("Backend%20Engineer"));
  ok("location in the url", plan[0].url.includes("Bangalore"));
  eq("all LinkedIn before Indeed", plan.filter((p) => p.site === "LinkedIn").length, 3);

  console.log("--- roles fall back to the profile ---");
  eq("explicit roles win", D.normalizeRoles({ discoverRoles: ["SRE"] }, profile), ["SRE"]);
  eq("empty roles fall back to experience titles",
     D.normalizeRoles({ discoverRoles: [] }, profile), ["Backend Engineer"]);
  eq("nothing at all yields nothing", D.normalizeRoles({ discoverRoles: [] }, {}), []);

  console.log("--- full run: top 20 of 30 listings ---");
  const report = await D.run({ settings: baseSettings, profile });
  eq("ok", report.ok, true);
  eq("scanned (duplicates removed)", report.scanned, 30);
  eq("four tabs opened", report.tabs, 4);
  eq("all four closed", removedTabs.length, 4);
  eq("no AI on this run", report.aiScored, 0);
  eq("capped at 20 added", report.added, 20);

  let board = await T.list();
  eq("board holds exactly the cap", board.length, 20);
  ok("no designer slipped past the cap", board.every((row) => !/Graphic Designer/.test(row.title)));
  ok("every card carries a rating", board.every((row) => row.match && row.match.pct >= 0 && row.match.pct <= 100));
  ok("every card has 1-5 stars", board.every((row) => row.match.stars >= 1 && row.match.stars <= 5));
  ok("every card is saved", board.every((row) => row.status === "saved"));
  ok("notes say where it came from", board.every((row) => /Discovered from (LinkedIn|Indeed)/.test(row.notes)));
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
  eq("nothing added twice", second.added, 10);
  eq("tracked listings skipped", second.alreadyTracked, 20);
  board = await T.list();
  eq("board grew by the leftovers only", board.length, 30);

  const third = await D.run({ settings: baseSettings, profile });
  eq("third run adds nothing", third.added, 0);
  eq("everything already tracked", third.alreadyTracked, 30);
  ok("says so", third.notes.some((n) => /already on the board/.test(n)));
  eq("board stable", (await T.list()).length, 30);

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
  eq("no tabs opened for it", report.tabs, 4);

  process.exit(done() ? 1 : 0);
})();
