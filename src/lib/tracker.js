// Job application tracker: the store behind the Dashboard page and the popup's
// "Track Job" button.
//
// Everything lives in one chrome.storage.local key (`applications`) so the board
// and the popup can never disagree about what has been applied to. Nothing here
// talks to a server — the whole point of this extension is that the application
// history never leaves the machine.

const APPLICATION_STATUSES = ["saved", "applied", "interview", "offer", "rejected"];

const APPLICATIONS_KEY = "applications";

// Column order on the board. The order runs left to right: saved -> applied ->
// interview -> offer, with rejected parked at the end where a loss is out of the
// way of the pipeline you are still working.
const APPLICATION_COLUMNS = [
  { id: "saved", label: "Saved" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejected", label: "Rejected" }
];

const DAY_MS = 86_400_000;

// ---- Source detection -------------------------------------------------
//
// The board shows where each application came from. It is derived from the URL
// rather than typed by hand: the ATS adapters already know which platforms they
// match, and a job URL is the one thing every tracked application is guaranteed
// to have. Anything unrecognised becomes "Other" instead of a wrong guess.

const SOURCE_PATTERNS = [
  [/\bmyworkdayjobs\.com|\bmyworkdaysite\.com|\bwd\d+\.myworkdayjobs\.com/i, "Workday"],
  [/\bjobs\.lever\.co|\bhire\.lever\.co/i, "Lever"],
  [/\bboards\.greenhouse\.io|\bjob-boards\.greenhouse\.io/i, "Greenhouse"],
  [/\bapply\.ashbyhq\.com|\bjobs\.ashbyhq\.com/i, "Ashby"],
  [/\bsmartrecruiters\.com|\bjobs\.smartrecruiters\.com/i, "SmartRecruiters"],
  [/\bworkable\.com/i, "Workable"],
  [/\bicims\.com/i, "iCIMS"],
  [/\bjobs\.lever\./i, "Lever"],
  [/\bindeed\.com/i, "Indeed"],
  [/\bdocs\.google\.com\/forms|\bgoogle\.com\/forms/i, "Google Forms"],
  [/\blinkedin\.com\/jobs/i, "LinkedIn"],
  [/\bgithub\.com/i, "GitHub"],
  [/\bcareers\./i, "Careers"],
  [/\b(job|career|jobs)\b/i, "Careers"]
];

function sourceFromUrl(url) {
  const text = String(url || "");
  if (!text) return "";
  for (const [pattern, label] of SOURCE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  try {
    return new URL(text).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---- URL identity ------------------------------------------------------
//
// Deduplication used to be raw string equality, which is only ever right by
// luck: the same posting reached two different ways as
// "…/jobs/42?gh_src=abc" and "…/jobs/42", and email import makes that the
// normal case rather than the exception, because every confirmation mail
// carries its own campaign parameters. Comparing a normalized form is what
// stops the board growing a second card for a job already on it.
//
// The stored url is left exactly as it arrived — only the comparison uses the
// normalized key, so a row still opens the link the user (or the mail) gave.

const NOISE_PARAM_NAMES = new Set([
  "source", "src", "ref", "referrer", "cmp", "campaign", "campaignid",
  "trackingid", "trkid", "trk", "elqtrackid", "elq", "hss_channel",
  "gh_src", "gh_jid", "ghcid", "gclid", "fbclid", "msclkid", "twclid",
  "mc_cid", "mc_eid", "vero_id", "vero_conv",
  // Mailchimp/HubSpot click ids, which ATS mail templates append liberally.
  "mkt_tok", "hsa_cam", "hsctatracking", "vero_conv",
  "lipi", "licu", "lipj", "eid", "mid", "sid", "cid", "akeyl", "akeylp"
]);

function isNoiseParam(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith("utm_") || lower.startsWith("hsa_") || NOISE_PARAM_NAMES.has(lower);
}

// Best-effort canonical form. Anything that does not parse as a URL is handed
// back untouched rather than discarded: the board prefers an un-deduplicated
// row over a silently dropped one.
function normalizeUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return text;
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // A fragment never identifies a posting — Workday uses one to carry form state.
  parsed.hash = "";

  const kept = [...parsed.searchParams.entries()].filter(([name]) => !isNoiseParam(name));
  parsed.search = "";
  for (const [name, value] of kept) parsed.searchParams.append(name, value);
  // Parameter order is arbitrary, so it cannot be part of identity.
  parsed.searchParams.sort();

  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path || "/";

  return parsed.toString();
}

// ---- Dates ------------------------------------------------------------

// "today" / "yesterday" / "6d ago" / "1mo ago". Deliberately coarse: this is a
// glanceable "when did I last touch this", not a date the user has to parse.
function relativeTime(ts) {
  const time = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(time)) return "";
  const days = Math.floor((Date.now() - time) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ---- Store ------------------------------------------------------------

function makeId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// A tracked application always has a title and a status, even when the user only
// pasted a URL. Everything else may be blank — the board renders "Unknown" for
// the gaps rather than refusing to show the row.
function normalizeApplication(input, previous = {}) {
  const base = { ...previous, ...input };
  const status = APPLICATION_STATUSES.includes(base.status) ? base.status : "saved";
  const now = Date.now();
  // The moment the event this input describes actually happened: the email's
  // own date when the input came from the importer, the clock otherwise. It is
  // deliberately not persisted — appliedAt / rejectedAt are — so a later save
  // with no mail behind it can never re-stamp a row with a stale import time.
  const eventAt = Number.isFinite(base.emailAt) ? base.emailAt : now;

  const application = {
    id: base.id || makeId(),
    url: String(base.url || "").trim(),
    title: String(base.title || "").trim(),
    company: String(base.company || "").trim(),
    source: String(base.source || sourceFromUrl(base.url) || "").trim(),
    status,
    notes: String(base.notes || ""),
    // Set only by the email importer, to the Gmail message id the row came
    // from. It is what makes a re-sync idempotent: the same mail is recognised
    // as already imported instead of becoming a second card, which a URL
    // cannot always do because confirmation mails often carry no job link.
    sourceEmailId: String(base.sourceEmailId || "").trim(),
    // The discovery rating, when the card came from the job finder: { pct,
    // stars, shortlist, reasons, scoredAt }. Kept as-is rather than
    // recomputed, so the board shows the number the run actually decided —
    // and a later save with no rating behind it leaves it untouched.
    match: base.match && typeof base.match === "object" ? base.match : null,
    savedAt: Number.isFinite(base.savedAt) ? base.savedAt : now,
    appliedAt: Number.isFinite(base.appliedAt) ? base.appliedAt : null,
    // When the rejection arrived — the rejection email's date for an imported
    // row, the moment of the manual move otherwise. The board shows this in
    // place of the applied date while the card sits in Rejected, so the card
    // answers "when did this outcome happen" instead of "when was it synced".
    rejectedAt: Number.isFinite(base.rejectedAt) ? base.rejectedAt : null,
    updatedAt: now
  };

  // Every status except "saved" is evidence that an application was actually
// sent, so every status except "saved" gets the moment stamped if it is not
// already known. The rule reads as if "rejected" were the odd one out, and it
// is — but only historically: "Applied this week" counts rows with an
// appliedAt, and an email importer learns about a rejection *first*. Without
// this, every rejection that arrived as mail was an application the board
// claimed had never happened.
  //
  // Moving *to* applied stamps the moment if it isn't already known, because
  // "Applied this week" is otherwise unanswerable for a job tracked from the
  // start. Moving back off applied keeps the original stamp, so the weekly count
  // doesn't quietly forget an application the user really did send.
  if (status !== "saved" && !application.appliedAt) application.appliedAt = eventAt;
  if (status === "rejected" && !application.rejectedAt) application.rejectedAt = eventAt;
  return application;
}

async function listApplications() {
  const stored = await chrome.storage.local.get(APPLICATIONS_KEY);
  const items = stored[APPLICATIONS_KEY];
  return Array.isArray(items) ? items.filter((item) => item && typeof item === "object") : [];
}

// Newest activity first, which is how the board and the popup both read.
async function listApplicationsByRecency() {
  const items = await listApplications();
  return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function writeApplications(items) {
  await chrome.storage.local.set({ [APPLICATIONS_KEY]: items });
  return items;
}

// One application per job, matched on a normalized URL. Tracked rows and
// imported mail arrive at the same posting by different URLs all the time
// (a clicked link vs a link inside a confirmation email), and comparing the
// normalized form is what keeps that one card rather than two.
function findByUrl(items, url) {
  const target = normalizeUrl(url);
  if (!target) return -1;
  return items.findIndex((item) => item.url && normalizeUrl(item.url) === target);
}

// Same job, found by the mail that mentioned it. Checked before the URL so a
// re-sync updates the row it created last time rather than matching some other
// row that happens to share a normalized link.
function findByEmailId(items, emailId) {
  const target = String(emailId || "").trim();
  if (!target) return -1;
  return items.findIndex((item) => item.sourceEmailId && item.sourceEmailId === target);
}

// Same role at the same employer, found by text rather than by link. This is the
// only way to connect a follow-up mail to its application, because the common
// sequence — applied, then interview, then offer — arrives as three separate
// mails whose links point at three different status pages, none of them the
// posting.
//
// Compared on a normalized form (case and punctuation ignored) rather than
// loosely: "Backend Engineer" and "backend engineer" are the same job, but
// "Engineer II" and "Engineer I" are not, and a token-overlap score would call
// them the same row.
function normalizeTextKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function findByTitleCompany(items, title, company) {
  const roleKey = normalizeTextKey(title);
  const companyKey = normalizeTextKey(company);
  if (!roleKey || !companyKey) return -1;

  return items.findIndex((item) => {
    if (!item.title || !item.company) return false;
    return normalizeTextKey(item.title) === roleKey && normalizeTextKey(item.company) === companyKey;
  });
}

// A mail or a heuristic parse is evidence, not authority. It must not be able to
// walk a row backwards: an auto-reply arriving after a user moved a job to
// Interview cannot drag it back to Applied, and a "we have no longer moved
// forward" mail for one role cannot demote a different row's offer.
const STATUS_RANK = { saved: 0, applied: 1, rejected: 2, interview: 3, offer: 4 };

// Rejected sits above applied and below the two live stages: a rejection mail
// is the outcome that follows an application, so it must be able to move an
// Applied card to Rejected (and carry its date with it), while still never
// being able to demote an interview or an offer. The mirror rule falls out of
// the same ordering — a stale "application received" mail cannot un-reject a
// card either. The only thing this guards is the two stages above Rejected.
function shouldAdoptStatus(currentStatus, incomingStatus) {
  if (!APPLICATION_STATUSES.includes(incomingStatus)) return false;
  if (!APPLICATION_STATUSES.includes(currentStatus)) return true;
  return (STATUS_RANK[incomingStatus] || 0) > (STATUS_RANK[currentStatus] || 0);
}

// The one place that answers "which existing row does this input mean?".
// Exported because the email importer has to know whether a mail was already
// imported before it saves, and two copies of this ordering is exactly how the
// board ends up with a card the importer did not think it created.
function matchIndex(items, input) {
  if (input.id) {
    const byId = items.findIndex((item) => item.id === input.id);
    if (byId >= 0) return byId;
  }
  if (input.sourceEmailId) {
    const byEmail = findByEmailId(items, input.sourceEmailId);
    if (byEmail >= 0) return byEmail;
  }

  const byUrl = findByUrl(items, input.url);
  if (byUrl >= 0) return byUrl;

  // Opt-in only. Manual adds deliberately do not fall back to text matching:
  // two genuinely different postings at one company can share a job title, and
  // a typed-in row has a URL to be matched on. An imported mail often does not,
  // which is the case this is for.
  if (input.matchLoose) return findByTitleCompany(items, input.title, input.company);
  return -1;
}

async function upsertApplication(input) {
  const items = await listApplications();
  const existing = matchIndex(items, input);

  if (existing >= 0) {
    const patch = { ...input };
    // A duplicate must not silently undo a stage the user set by hand, and an
    // imported row with no url must not wipe a URL the user typed in.
    if (!shouldAdoptStatus(items[existing].status, patch.status)) delete patch.status;
    if (!patch.url) delete patch.url;
    if (!patch.title) delete patch.title;
    if (!patch.company) delete patch.company;
    // Notes and the creating message id move only when the caller addressed a row
    // by id, which is a deliberate edit. A second mail about the same job
    // arrives with no id: it must not overwrite what the user typed into the
    // row the first mail made, and the row's provenance stays "the mail that
    // created this". Tracking which mails have been imported at all is the
    // importer's own ledger, not a property of any one row.
    if (!patch.id) {
      delete patch.notes;
      delete patch.sourceEmailId;
    }
    delete patch.matchLoose;

    const merged = normalizeApplication(patch, items[existing]);
    // Keep the original save date unless the row is only just being saved.
    if (items[existing].savedAt) merged.savedAt = items[existing].savedAt;
    items[existing] = merged;
    await writeApplications(items);
    return merged;
  }

  const created = normalizeApplication(input);
  items.push(created);
  await writeApplications(items);
  return created;
}

async function setApplicationStatus(id, status) {
  if (!APPLICATION_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  const items = await listApplications();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  items[index] = normalizeApplication({ status }, items[index]);
  await writeApplications(items);
  return items[index];
}

async function deleteApplication(id) {
  const items = await listApplications();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return false;
  await writeApplications(next);
  return true;
}

async function clearApplications() {
  await chrome.storage.local.set({ [APPLICATIONS_KEY]: [] });
}

// ---- Popup integration -------------------------------------------------

// Grabs whatever the active tab looks like. Deliberately best-effort: a job
// board page has a title long before it has a company name, and the dashboard
// is more useful with a row the user then edits than with nothing at all.
async function trackActiveTab(status = "saved") {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;

  const url = tab.url;
  // Never track a chrome:// or extension page — the user clicked the button on
  // the side panel itself often enough for this to matter.
  if (/^(chrome|edge|about|chrome-extension|moz-extension):/i.test(url)) return null;

  const existingIndex = findByUrl(await listApplications(), url);
  if (existingIndex >= 0) {
    const items = await listApplications();
    return items[existingIndex];
  }

  return upsertApplication({
    url,
    title: (tab.title || "").trim(),
    company: companyFromTitle(tab.title || ""),
    source: sourceFromUrl(url),
    status
  });
}

// A very small heuristic for the company name, used only to prefill the field so
// the user can correct it. Job titles are almost always "<Role> at <Company>" or
// "<Role> - <Company>", sometimes with a trailing location or work mode.
//
// " at " is tried first and on its own: "<Role> - <Team> at <Company>" is a real
// shape (LinkedIn does this), and a single alternation would match the *last*
// separator and hand back "Backend Team at Acme" as the company.
function companyFromTitle(title) {
  const text = String(title || "").trim();
  if (!text) return "";

  const tail = (match) => {
    if (!match) return "";
    // "<Company> | Remote" / "<Company> - Bengaluru": keep the first segment,
    // which is the part that names the employer.
    return match[1].split(/\s[|–—]\s|\s\|\s/)[0].trim();
  };

  return tail(text.match(/\s+at\s+(.+)$/i)) ||
    tail(text.match(/\s+[-–—]\s+(.+)$/)) ||
    tail(text.match(/\s*@\s*(.+)$/)) ||
    "";
}

// ---- Insights ----------------------------------------------------------

// The six dashboard tiles.
//
// The two rates are deliberately different denominators. "Response rate" is
// interviews+offers out of everything actually applied to — a rejection is a
// response, silence is not. "Offer rate" is offers out of everything that got
// as far as an interview, because that is the only number that says whether
// interviewing is converting. Either returns null when its denominator is zero,
// which renders as "—" rather than a misleading 0%.
function computeInsights(items) {
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const monthAgo = now - 30 * DAY_MS;

  const applied = items.filter((item) => Number.isFinite(item.appliedAt));
  const week = applied.filter((item) => item.appliedAt >= weekAgo).length;
  const month = applied.filter((item) => item.appliedAt >= monthAgo).length;

  const positive = applied.filter((item) => item.status === "interview" || item.status === "offer");
  const offers = items.filter((item) => item.status === "offer");
  const interviewed = items.filter((item) => item.status === "interview" || item.status === "offer");

  return {
    week,
    month,
    responseRate: applied.length ? positive.length / applied.length : null,
    offerRate: interviewed.length ? offers.length / interviewed.length : null,
    interviews: interviewed.length,
    total: items.length
  };
}

function formatPercent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function countsByStatus(items) {
  const counts = {};
  for (const status of APPLICATION_STATUSES) counts[status] = 0;
  for (const item of items) {
    if (counts[item.status] == null) counts[item.status] = 0;
    counts[item.status] += 1;
  }
  return counts;
}

// ---- CSV export --------------------------------------------------------

function csvCell(value) {
  const text = value == null ? "" : String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula, so
  // anything starting with one is prefixed with a quote to force it as text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(items) {
  const header = ["Title", "Company", "Status", "Source", "URL", "Saved", "Applied", "Rejected", "Updated", "Notes"];
  const rows = items.map((item) => [
    item.title,
    item.company,
    item.status,
    item.source,
    item.url,
    isoOrEmpty(item.savedAt),
    isoOrEmpty(item.appliedAt),
    isoOrEmpty(item.rejectedAt),
    isoOrEmpty(item.updatedAt),
    item.notes
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function isoOrEmpty(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : "";
}

const Tracker = {
  STATUSES: APPLICATION_STATUSES,
  COLUMNS: APPLICATION_COLUMNS,
  list: listApplications,
  listByRecency: listApplicationsByRecency,
  save: upsertApplication,
  matchIndex,
  setStatus: setApplicationStatus,
  remove: deleteApplication,
  clear: clearApplications,
  trackActiveTab,
  sourceFromUrl,
  normalizeUrl,
  relativeTime,
  computeInsights,
  countsByStatus,
  formatPercent,
  toCsv
};