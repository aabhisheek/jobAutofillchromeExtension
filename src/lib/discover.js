// Job discovery: find matching postings from LinkedIn and other job boards,
// score them against the profile and the roles the user asked for, and put the
// best few on the board as cards that carry their rating.
//
// How a run works, in order:
// 1. The target roles (settings.discoverRoles, falling back to the titles in
//    the profile's experience) each become a jobs-search URL — LinkedIn first,
//    then Indeed. A background tab is opened per search, the listing cards are
//    read with chrome.scripting.executeScript, and the tab is closed again.
//    The tab carries the user's own logged-in session, which is the only way
//    LinkedIn shows results at all; an anonymous fetch would hit the auth wall.
// 2. Every listing is scored locally: how well the title matches a wanted
//    role, and how much of what the posting asks for the profile can actually
//    answer. That produces the percentage and the stars — deterministic,
//    instant, and free.
// 3. If AI is on and a provider is configured, one batched call scores the
//    shortlist chance of the top set. A failure here keeps the local scores;
//    it never fails the run.
// 4. The top discoverMaxJobs are saved to the board as "saved" cards with
//    their rating in `match`. URLs the board already tracks are skipped, so a
//    re-run refreshes nothing into duplicates.
//
// Runs in the dashboard page (where progress can be shown). The engine is
// deliberately UI-free: callers pass settings/profile in and read the report.

const DISCOVER_STATE_KEY = "discoverState";

// Auto-runs are throttled to this, because every run opens real tabs on real
// job sites and a board opened ten times a day must not mean ten crawls.
const DISCOVER_AUTO_INTERVAL_MS = 2 * 60 * 60 * 1000;

// Searches per run. Bounded the way the mail importer is bounded: a role list
// is user-editable and could otherwise open a tab per line. Ordered
// LinkedIn-first, so a long role list spends its budget on the useful site.
const DISCOVER_MAX_TABS = 4;

// Ceiling on the candidate pool per run. Enough to pick a top 20 with room to
// spare, small enough that one run stays a handful of seconds.
const DISCOVER_MAX_POOL = 120;

const DISCOVER_DEFAULT_MAX_JOBS = 20;

// ---- inputs --------------------------------------------------------------

// The roles to search for. Explicit settings win; an empty list falls back to
// the profile's own job titles, so discovery works before anyone fills the
// panel in.
function normalizeDiscoverRoles(settings, profile) {
  const raw = Array.isArray(settings && settings.discoverRoles) ? settings.discoverRoles : [];
  const roles = raw.map((role) => String(role || "").trim()).filter(Boolean);
  if (roles.length) return [...new Set(roles)];

  const history = ((profile && profile.experience) || [])
    .map((entry) => String(entry && entry.title || "").trim())
    .filter(Boolean);
  return [...new Set(history)].slice(0, 3);
}

// Which searches a run performs. Sites are the outer loop so every role gets
// a LinkedIn search before any role gets a second-board search, and the whole
// plan is capped at DISCOVER_MAX_TABS.
function discoverSearchPlan(roles, settings) {
  const where = String((settings && settings.discoverLocations) || "").trim();
  const sites = [
    {
      site: "LinkedIn",
      url: (role) =>
        `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(role)}` +
        (where ? `&location=${encodeURIComponent(where)}` : "")
    },
    {
      site: "Indeed",
      url: (role) =>
        `https://www.indeed.com/jobs?q=${encodeURIComponent(role)}` +
        (where ? `&l=${encodeURIComponent(where)}` : "")
    }
  ];

  const plan = [];
  for (const { site, url } of sites) {
    for (const role of roles) plan.push({ site, role, url: url(role) });
  }
  return plan.slice(0, DISCOVER_MAX_TABS);
}

// ---- scoring (pure) ------------------------------------------------------

function discoverWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 0..1: how much the listing's title is one of the wanted roles. Exact and
// containment matches score high; partial token overlap scores proportionally.
// With no roles configured there is nothing to judge against, so a neutral
// 0.6 keeps such listings in the running instead of burying them at zero.
function discoverRoleScore(title, roles) {
  const target = discoverWords(title);
  if (!roles || !roles.length) return { score: 0.6, matched: "" };
  if (!target) return { score: 0, matched: "" };

  const targetTokens = target.split(" ").filter(Boolean);
  let best = { score: 0, matched: "" };

  for (const role of roles) {
    const wanted = discoverWords(role);
    if (!wanted) continue;

    let score = 0;
    if (wanted === target) score = 1;
    else if (wanted.includes(target) || target.includes(wanted)) score = 0.9;
    else {
      const wantedTokens = new Set(wanted.split(" ").filter(Boolean));
      const overlap = targetTokens.filter((token) => wantedTokens.has(token)).length;
      const ratio = wantedTokens.size ? overlap / wantedTokens.size : 0;
      if (ratio >= 0.6) score = 0.8;
      else if (ratio > 0) score = Math.min(0.5, ratio);
    }

    if (score > best.score) best = { score, matched: role };
  }
  return best;
}

// ★★★★☆ for a card's meta row. Rounded to the nearest star with a floor of
// one: a job on the board at all is worth something, and a black star would
// read as "broken" rather than "low match".
function discoverStars(pct) {
  return Math.max(1, Math.min(5, Math.round(Number(pct || 0) / 20)));
}

// The local rating. Half the score is "is this the kind of role you asked
// for", half is "of what the posting mentions, how much can your profile
// answer" — the same matched/missing logic the resume tailor uses, so a job
// that looks like a match here also tailors well. Returns the shape that goes
// straight into the card's `match` field.
function scoreDiscoverListing(listing, profile, roles) {
  const role = discoverRoleScore(listing.title, roles);

  const text = `${listing.title || ""} ${listing.snippet || ""}`.toLowerCase();
  // Resume-tailor's vocabulary is the curated tech dictionary ∪ the profile's
  // own skills/technologies; extractKeywordsLocal pulls whichever of those the
  // listing actually mentions, analyzeMatch splits them into covered/gaps.
  const keywords = extractKeywordsLocal(text, profile || {});
  const { matched, missing } = analyzeMatch(keywords, profile || {});
  const skillScore = keywords.length ? matched.length / keywords.length : 0.5;

  const pct = Math.max(0, Math.min(100, Math.round(100 * (0.5 * role.score + 0.5 * skillScore))));
  const reasons = [];
  if (role.matched) reasons.push(`matches "${role.matched}"`);
  if (matched.length) reasons.push(`covers ${matched.slice(0, 6).join(", ")}`);
  if (missing.length) reasons.push(`missing ${missing.slice(0, 4).join(", ")}`);

  return {
    pct,
    stars: discoverStars(pct),
    // Local fallback for the shortlist chance: the match score itself. The AI
    // pass replaces this with a judgment call when it is on.
    shortlist: pct,
    reasons,
    matchedRole: role.matched
  };
}

// ---- scraping (tabs + injection) ----------------------------------------

async function waitForTabReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false; // tab gone (crashed / closed by the site)
    }
    if (tab && tab.status === "complete") return true;
    if (Date.now() >= deadline) return true; // inject anyway; the scanner waits too
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// One search, one tab: open it in the background, read its cards, close it.
// Any failure yields [] and the run continues — one board being down is not a
// reason to return nothing from the other three.
async function scrapeDiscoverUrl(plan) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: plan.url, active: false });
    tabId = tab && tab.id;
    if (tabId == null) return [];
    await waitForTabReady(tabId, 20000);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanJobListings,
      args: [{ maxCards: 60, waitForMs: 9000 }]
    });
    const listings = (results && results[0] && results[0].result) || [];
    return listings
      .filter((item) => item && item.url && item.title)
      .map((item) => ({ ...item, site: plan.site, role: plan.role }));
  } catch {
    return [];
  } finally {
    if (tabId != null) {
      // A rejected removal (tab already gone) must not reject the run.
      Promise.resolve(chrome.tabs.remove(tabId)).catch(() => {});
    }
  }
}

// ---- AI shortlist pass ---------------------------------------------------

// One call for the whole top set, not one per job: 20 listings is 20 items of
// context in a single request, which is cheaper and arrives in one burst
// instead of twenty. Failure anywhere in here leaves the local scores alone.
async function scoreShortlistWithAi(candidates, profile, settings) {
  if (!settings || !settings.discoverUseAi) return 0;
  const providers = configuredProviders(settings);
  if (!providers.length) return 0;

  const roles = normalizeDiscoverRoles(settings, profile);
  const skills = ((profile && profile.skills) || []).slice(0, 40).join(", ") || "(none listed)";
  const titles = ((profile && profile.experience) || [])
    .slice(0, 4)
    .map((entry) => String(entry.title || "").trim())
    .filter(Boolean)
    .join(", ") || "(none listed)";

  const lines = candidates.map((item, index) =>
    `${index}. ${item.title || "Untitled"} at ${item.company || "Unknown company"}` +
    (item.snippet ? ` — ${item.snippet.slice(0, 220)}` : "")
  );

  const prompt = [
    "You are estimating, for each job listing below, the chance (0-100) that this",
    "candidate gets shortlisted (screened in) for it. Judge role fit, skill fit,",
    "and seniority fit. Be realistic, not generous.",
    "",
    `Target roles: ${roles.join(", ")}`,
    `Recent titles: ${titles}`,
    `Skills: ${skills}`,
    "",
    "Listings:",
    ...lines,
    "",
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '{"results":[{"i":0,"shortlist":72,"reasons":["strong backend fit"]}]}',
    "Include every listing index exactly once. `reasons` is 1-2 short phrases."
  ].join("\n");

  try {
    const raw = await sendProviderPrompt({
      provider: providers[0],
      settings,
      prompt,
      maxTokens: 1200
    });
    const parsed = MailImport.parseJsonObject(raw);
    const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
    if (!results) return 0;

    let scored = 0;
    for (const entry of results) {
      const index = Number(entry && entry.i);
      const shortlist = Number(entry && entry.shortlist);
      if (!Number.isFinite(index) || !candidates[index]) continue;
      if (Number.isFinite(shortlist)) {
        candidates[index].match.shortlist = Math.max(0, Math.min(100, Math.round(shortlist)));
        scored += 1;
      }
      if (Array.isArray(entry.reasons) && entry.reasons.length) {
        const extra = entry.reasons
          .map((reason) => String(reason || "").trim())
          .filter(Boolean)
          .slice(0, 3);
        candidates[index].match.reasons = [...extra, ...candidates[index].match.reasons].slice(0, 5);
      }
    }
    return scored;
  } catch {
    return 0; // AI is an enhancement; the local scores already stand
  }
}

// ---- state ---------------------------------------------------------------

async function readDiscoverState() {
  try {
    const stored = await chrome.storage.local.get(DISCOVER_STATE_KEY);
    return stored[DISCOVER_STATE_KEY] || null;
  } catch {
    return null;
  }
}

async function writeDiscoverState(report) {
  try {
    await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: report });
  } catch {
    // Last-run display only; never worth failing a run over.
  }
}

// Whether the automatic (dashboard-opens) path should run now. The button
// bypasses this entirely.
async function shouldAutoRunDiscover() {
  const state = await readDiscoverState();
  if (!state || !Number.isFinite(state.at)) return true;
  return Date.now() - state.at >= DISCOVER_AUTO_INTERVAL_MS;
}

// ---- the run -------------------------------------------------------------

async function runDiscover({ settings, profile, onProgress } = {}) {
  const report = {
    ok: false,
    at: Date.now(),
    roles: [],
    scanned: 0,
    added: 0,
    updated: 0,
    alreadyTracked: 0,
    aiScored: 0,
    tabs: 0,
    notes: []
  };

  const fail = async (note) => {
    report.notes.push(note);
    await writeDiscoverState(report);
    return report;
  };

  try {
    const roles = normalizeDiscoverRoles(settings, profile);
    report.roles = roles;
    if (!roles.length) {
      return await fail("No roles to search for — add them on the Discover panel.");
    }

    const plan = discoverSearchPlan(roles, settings);
    if (!plan.length) return await fail("Nothing to search.");

    const maxJobs = Math.max(1, Math.min(50, Number(settings && settings.discoverMaxJobs) || DISCOVER_DEFAULT_MAX_JOBS));

    // ---- scrape ----------------------------------------------------------
    const pool = [];
    const seen = new Set();
    for (let i = 0; i < plan.length; i += 1) {
      if (onProgress) onProgress({ phase: "scrape", done: i, total: plan.length });
      report.tabs += 1;
      const listings = await scrapeDiscoverUrl(plan[i]);
      for (const listing of listings) {
        const key = Tracker.normalizeUrl(listing.url) || `${discoverWords(listing.title)}|${discoverWords(listing.company)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pool.push(listing);
      }
      if (pool.length >= DISCOVER_MAX_POOL) break;
    }
    if (onProgress) onProgress({ phase: "scrape", done: plan.length, total: plan.length });
    report.scanned = pool.length;

    if (!pool.length) {
      return await fail(
        "No listings found. If LinkedIn showed a sign-in page, sign in to LinkedIn once in Chrome and try again."
      );
    }

    // ---- score -----------------------------------------------------------
    if (onProgress) onProgress({ phase: "score", done: 0, total: pool.length });
    const board = await Tracker.list();
    const scored = [];
    for (const listing of pool) {
      const match = scoreDiscoverListing(listing, profile, roles);
      const tracked = Tracker.matchIndex(board, {
        url: listing.url,
        title: listing.title,
        company: listing.company,
        matchLoose: true
      });
      if (tracked >= 0) {
        report.alreadyTracked += 1;
        continue;
      }
      scored.push({ ...listing, match });
    }

    // Best first: the local percentage ranks the pool, and after the AI pass
    // the shortlist chance re-ranks the survivors — the board keeps the order
    // the user should triage in.
    scored.sort((a, b) => b.match.pct - a.match.pct || b.match.shortlist - a.match.shortlist);
    const top = scored.slice(0, maxJobs);

    report.aiScored = await scoreShortlistWithAi(top, profile, settings);
    if (report.aiScored) {
      top.sort((a, b) => b.match.shortlist - a.match.shortlist || b.match.pct - a.match.pct);
    }

    // ---- save ------------------------------------------------------------
    if (onProgress) onProgress({ phase: "save", done: 0, total: top.length });
    for (let i = 0; i < top.length; i += 1) {
      const item = top[i];
      if (onProgress) onProgress({ phase: "save", done: i + 1, total: top.length });

      const known = Tracker.matchIndex(board, { url: item.url, title: item.title, company: item.company, matchLoose: true }) >= 0;
      const saved = await Tracker.save({
        url: item.url,
        title: item.title,
        company: item.company,
        source: Tracker.sourceFromUrl(item.url) || item.site,
        status: "saved",
        notes: `Discovered from ${item.site} — ${item.match.reasons.join("; ") || "matched your roles"}`,
        match: item.match,
        matchLoose: true
      });
      // Folded back in so a second listing for the same job later in this run
      // is counted as an update rather than a second "added" card — the same
      // live-board trick the mail importer uses.
      if (saved) board.push(saved);
      if (known) report.updated += 1;
      else report.added += 1;
    }

    report.ok = true;
    if (!report.added && !report.updated && report.alreadyTracked) {
      report.notes.push("Everything matching is already on the board.");
    }
    await writeDiscoverState(report);
    if (onProgress) onProgress({ phase: "done", done: top.length, total: top.length });
    return report;
  } catch (err) {
    return await fail(err.message || String(err));
  }
}

const Discover = {
  STATE_KEY: DISCOVER_STATE_KEY,
  AUTO_INTERVAL_MS: DISCOVER_AUTO_INTERVAL_MS,
  DEFAULT_MAX_JOBS: DISCOVER_DEFAULT_MAX_JOBS,
  normalizeRoles: normalizeDiscoverRoles,
  searchPlan: discoverSearchPlan,
  roleScore: discoverRoleScore,
  scoreListing: scoreDiscoverListing,
  starsFor: discoverStars,
  shouldAutoRun: shouldAutoRunDiscover,
  readState: readDiscoverState,
  run: runDiscover
};
