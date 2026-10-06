// Turns "application received" emails into rows on the dashboard board.
//
// The whole point of the dashboard is the answer to "how many jobs did I apply
// to this week", and until email import that answer only exists for jobs the
// user remembered to press Track Job on. This file closes that gap: it reads the
// mail that every ATS already sends unprompted, and derives title / company /
// stage / job link from it.
//
// Two parsers, on purpose:
//
//   1. A local heuristic (parseLocally) — free, offline, instant, and good
//      enough for the large majority of confirmation mail, because ATS
//      templates are formulaic.
//   2. The AI provider already configured in the API Keys screen (enrichWithAi)
//      — reads the messier real-world subjects where "Application Received -
//      Requisition 88123 - DEEP-DIVE" tells you nothing without context.
//
// The heuristic runs first and its output is *handed to the AI as context*
// rather than discarded. That is deliberate: the model is far better at
// correcting "Talent Acquisition Team" into "Acme Corp" when it is also told
// the sender was careers@acme.com, and far worse at inventing those facts when
// it is handed a bare subject line. If no provider is configured, or the AI call
// fails, the heuristic result is used as-is — the import never depends on it.
//
// Identity is the Gmail message id (Tracker.sourceEmailId), so a daily sync is
// idempotent: the same mail re-read tomorrow updates its own row instead of
// creating a second card.

// Identity is the Gmail message id, held in a ledger rather than on the row.
//
// The obvious place for it is Tracker.sourceEmailId, and that is where it goes
// for a row it creates — but it cannot be the whole answer. A job's applied mail
// and interview mail are two message ids and one card, and whichever field the
// second one writes would make the first look un-imported again, so it would be
// re-parsed (and re-billed to the AI) on every run forever. Worse, if the row is
// deleted the ids go with it and the mail silently comes back. So the set of
// imported ids lives here, separately, and the row keeps only provenance.

const EMAIL_SYNC_STATE_KEY = "emailSyncState";
const IMPORT_LEDGER_KEY = "emailImportedIds";

// 25 messages a day is the ceiling, so this is a few months of history. Bounded
// because chrome.storage.local is quota'd and a ledger that grows forever is a
// slow failure nobody notices. Dropping the oldest ids is safe: those messages
// are long gone from any 30-day search, and worst case they are re-parsed into
// rows that already exist.
const MAX_LEDGER = 2000;

// Ask Gmail for the newest two dozen matches at most. The user's own query is
// the real filter; this bounds the worst case when they hand-edit it into
// something broad and the AI cap has not kicked in yet.
const DEFAULT_MAX_MESSAGES = 25;

// The search a first-time user gets, and what the panel falls back to if the
// box is left blank. Grouped with braces because Gmail's operator is AND: four
// separate phrases would match mail containing all of them, which no employer
// has ever sent. The date term is appended by buildQuery, not written here.
const DEFAULT_QUERY =
  'newer_than:30d {"application received" "application submitted" "we have received your application" "thank you for applying" "we received your application"}';

// How many messages are fetched at once. Higher is faster but Gmail rate-limits
// aggressively per user, and a failed run that stops halfway is worse than one
// that takes a minute.
const FETCH_CONCURRENCY = 4;

// Characters of body text handed to the model. Enough for the first paragraph
// of any confirmation mail, and short enough that a long newsletter matched by a
// sloppy query does not blow the context window.
const AI_BODY_CHARS = 700;

// ---- local parsing -----------------------------------------------------

// Sender names on ATS mail are a handful of shapes, all of them company plus
// noise: "Acme Careers", "Acme Talent", "Acme University Recruiting", "no-reply
// @greenhouse.io". Stripping the noise word is a better guess than the domain,
// and it is the only place a company name appears when the subject is a
// requisition id.
const SENDER_NOISE_WORDS = new RegExp(
  [
    "recruiting", "recruitment", "recruiter", "talent\\s+acquisition", "talent",
    "human\\s+resources?", "hr\\s+team", "people\\s+team",
    "hiring", "careers?", "job\\s+board", "jobs?",
    "no[-.]?reply", "donotreply", "do[-.]?not[-.]?reply", "noreply",
    "notifications?", "alerts?", "mailer[-.]?daemon", "bounce",
    "administrator", "info", "support", "help", "the\\s+team", "team",
    "official", "autoreply", "mail", "email", "newsletter", "digest"
  ].join("|"),
  "gi"
);

// Companies whose recruiting mail comes from a platform's own domain. The
// platform is not the employer, so these are only ever a last-resort fallback
// for the company field — losing "Greenhouse" is better than losing the actual
// employer name, and the ATS name is already shown in the board's source chip.
const PLATFORM_SENDER_DOMAINS = {
  "greenhouse.io": "Greenhouse",
  "lever.co": "Lever",
  "myworkday.com": "Workday",
  "myworkdayjobs.com": "Workday",
  "wd1.myworkdayjobs.com": "Workday",
  "wd3.myworkdayjobs.com": "Workday",
  "ashbyhq.com": "Ashby",
  "workable.com": "Workable",
  "workablemail.com": "Workable",
  "smartrecruiters.com": "SmartRecruiters",
  "icims.com": "iCIMS",
  "successfactors.com": "SuccessFactors",
  "bamboohr.com": "BambooHR",
  "jobvite.com": "Jobvite",
  "taleo.net": "Taleo",
  "recruitee.com": "Recruitee",
  "teamtailor.com": "Teamtailor",
  "personio.com": "Personio",
  "personio.de": "Personio",
  "comeet.com": "Comeet",
  "pinpointhq.com": "Pinpointhq",
  "jazzhr.com": "JazzHR",
  "indeedemail.com": "Indeed",
  "linkedin.com": "LinkedIn",
  "naukri.com": "Naukri",
  "hirestage.com": "Hirext"
};

// Boilerplate that wraps the actual role in a subject line. Removed in a loop
// because these stack: "Re: Fwd: Application received: Your application for
// Backend Engineer at Acme" needs four passes before anything useful is left.
const SUBJECT_PREFIXES = [
  /^\s*(re|fw|fwd|aw|tr|sv)\s*[:>-]\s*/i,
  /^\s*\[(external|ext|secure|auto[-.]?reply|automated|auto)\]\s*/i,
  // Workday and Greenhouse lead every scheduling mail with the same three
  // words, and "Action required" is a near-universal interview-mandate subject.
  // Left in, they become the job title on the card, which is worse than no
  // title at all because it looks authoritative.
  /^\s*(interview\s+invitation|invitation\s+to\s+(an?\s+)?(interview|chat|call)|invite\s+to\s+(an?\s+)?(interview|chat|call)|action\s+(required|needed|requested)|next\s+steps?|phone\s+screen|screening\s+call)\s*[:>-]\s*/i,
  /^\s*(we\s+(have\s+)?)?received\s+(your\s+)?application\s*(for|to|at)?\s*[:>-]?\s*/i,
  /^\s*(thank|thanks)\s+you\s+(for|very\s+much\s+for)\s+(applying|your\s+application|your\s+interest)\s*(to|for|at|in)\s*/i,
  /^\s*you(r)?\s+(have\s+)?(just\s+)?(applied|application)\s*(for|to|at)\s*/i,
  /^\s*your\s+application\s+(for|to|at)\s+/i,
  /^\s*application\s+(received|submitted|confirmation)\s*[:>-]\s*/i,
  /^\s*application\s+(for|to|at)\s+/i,
  /^\s*(job\s+)?(application|apply)\s*(received|submitted)\s*[:>-]?\s*/i,
  /^\s*(confirmation|receipt)\s*[:>-]\s*/i,
  /^\s*job\s+application\s*[:>-]\s*/i
];

// …and the matching suffixes.
const SUBJECT_SUFFIXES = [
  /\s*[-|–—:]\s*(job\s+)?application(\s+(received|submitted|confirmation))?\s*$/i,
  /\s*[-|–—:]\s*(application\s+)?(received|submitted|confirmed)\s*$/i,
  /\s*[-|–—:]\s*careers?\s*$/i,
  /\s*[-|–—:]\s*(confirmation|acknowledg(e)?ment)\s*$/i,
  /\s*\(\s*(application\s+)?(received|submitted|confirmation)\s*\)\s*$/i,
  /\s*[-|–—:]\s*(job\s+)?(applied|application\s+sent)\s*$/i
];

function cleanSubject(subject) {
  let text = String(subject || "").trim();

  let previous;
  do {
    previous = text;
    for (const pattern of SUBJECT_PREFIXES) text = text.replace(pattern, "");
    text = text.trim();
  } while (text !== previous);

  for (const pattern of SUBJECT_SUFFIXES) text = text.replace(pattern, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

// "Backend Engineer at Acme Corp" → role / company. Split on the first " at "
// only: a title containing "at" ("Chat Engineer at Scale") is rarer than a
// company name containing one, and splitting on the last separator would hand
// back "Engineer at Acme" as the role.
function splitRoleCompany(text) {
  const value = String(text || "").trim();
  if (!value) return { title: "", company: "" };

  const at = value.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) return { title: cleanTail(at[1]), company: cleanTail(at[2]) };

  const separator = value.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (separator) return { title: cleanTail(separator[1]), company: cleanTail(separator[2]) };

  const colon = value.match(/^(.+?)\s+[:–—]\s+(.+)$/);
  if (colon) return { title: cleanTail(colon[1]), company: cleanTail(colon[2]) };

  return { title: value, company: "" };
}

// "Acme Corp | Bengaluru", "Acme Corp (Remote)", "Backend Engineer, Acme".
function cleanTail(value) {
  return String(value || "")
    .split(/\s*[|–—]\s*/)[0]
    .replace(/^\s*[-–—]\s*/, "")
    .replace(/\s*\((?:remote|hybrid|onsite|full[- ]?time|contract)\)\s*$/i, "")
    .replace(/\s*,\s*(?:bengaluru|bangalore|delhi|mumbai|hyderabad|pune|gurgaon|noida|chennai)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// The employer, guessed from whoever sent the mail.
//
// The domain is consulted first because it is the unambiguous signal: a sender
// of "acme.wd5.myworkdayjobs.com" is a Workday mail whatever the display name
// happened to be, whereas the display name is free text that may be "Acme
// Careers", "Acme University Recruiting", or the two-letter residue "WD" left
// after stripping the noise words. An empty company is corrected far more
// gracefully than a wrong one, because the dashboard shows "Unknown company"
// and the user can type the real one — so every guess here has to earn its
// place.
function companyFromSender(from) {
  const domain = String((from && from.domain) || "").toLowerCase();
  const name = String((from && from.name) || "");

  if (domain) {
    const platform = PLATFORM_SENDER_DOMAINS[domain];
    if (platform) return platform;
    // Subdomains of a known platform's mail service, e.g.
    // acme.wd5.myworkdayjobs.com.
    if (domain.endsWith("myworkdayjobs.com") || domain.endsWith("myworkdaysite.com")) return "Workday";
  }

  const cleaned = name
    .replace(SENDER_NOISE_WORDS, " ")
    .replace(/[^\p{L}\p{N}&+.'\- ]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Three characters, not two: "WD", "HR" and "IT" are what is left of several
  // real display names after the noise is removed, and none of them is a
  // company.
  if (cleaned.length >= 3 && cleaned.length <= 40) return cleaned;

  if (!domain) return "";

  // mail.acme.com / careers.acme.com -> acme.com
  const registrable = domain.split(".").filter(Boolean).slice(-2)[0] || "";
  return registrable.length >= 2 ? registrable.replace(/^./, (char) => char.toUpperCase()) : "";
}

// Links that are never the job: Google's own tracking hops, the sender's
// unsubscribe and preference pages, marketing links, and the social buttons in
// the footer. These outnumber the one useful link two to one.
const URL_NOISE =
  /(unsubscribe|opt[-_]?out|preferences?|manage[-_]?(your\s*)?(subscription|alerts)|privacy|terms|legal|cookie|help|support|survey|feedback|contact\s+us|blog|news|social|twitter|facebook|instagram|linkedin\.com\/(share|feed|company)|youtube|medium\.com|\bml_|\/[^\s]*\.(png|jpe?g|gif|webp|svg|css|js)(\?|$))/i;

const JOB_URL_HINT = /(job|career|position|opening|vacanc|requisition|req[-_]?id|myworkday|greenhouse|lever|ashby|workable|smartrecruiters|icims|successfactors|bamboohr|workday|taleo|personio|jobvite)/i;

const JOB_URL_LABEL_HINT = /(view|application|job|position|posting|details|status|track|role)/i;

// Picks the one link in an email that is plausibly the job.
//
// Ranked rather than first-match because ATS footers put "View this email in
// your browser" above the real link more often than not. A host that is a known
// ATS wins outright; then the hint in the href; then the anchor's own words.
function pickJobUrl(links) {
  const candidates = [];

  for (const link of links || []) {
    const href = String(link.href || "").trim();
    if (!/^https?:\/\//i.test(href)) continue;
    if (URL_NOISE.test(href)) continue;

    let score = 0;
    if (JOB_URL_HINT.test(href)) score += 5;
    if (JOB_URL_LABEL_HINT.test(String(link.text || ""))) score += 2;
    // A link with no anchor text is usually an image or a bare icon, which is
    // what the "view in browser" link is.
    if (link.text) score += 1;
    // Applied-status pages are more useful than the marketing home page, and
    // the sender's own domain is the least useful host of all.
    if (/(application|myapplication|status|applicant)/i.test(href)) score += 3;

    if (score > 0) candidates.push({ href, score });
  }

  if (!candidates.length) return "";

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].href;
}

// Which column a mail belongs in.
//
// Ordered most-decisive first and every pattern is checked against subject +
// snippet together, because employers put the outcome in different places: the
// subject for a rejection, the first line for an interview invite. Applied is
// last and doubles as the default, since the search query only matches mail
// about an application at all.
const STATUS_SIGNALS = [
  {
    status: "offer",
    pattern:
      /\b(offer\s+(letter|of\s+employment)|we'?re\s+(pleased\s+to\s+)?offer|pleased\s+to\s+offer|job\s+offer|your\s+offer|congratulat\w+|welcome\s+to\s+the\s+team)\b/i
  },
  {
    status: "interview",
    pattern:
      /\b(interview|phone\s+screen|screening\s+call|first\s+round|next\s+steps?|schedule\s+a\s+(call|chat|meeting)|invite\s+you\s+to\s+(an?\s+)?(interview|chat|call)|technical\s+assessment|assessment\s+(invitation|link)|take[\s-]?home|onsite)\b/i
  },
  {
    status: "rejected",
    pattern:
      /\b(unfortunately|not\s+(be\s+)?(moving|proceeding)\s+forward|move\s+your\s+application\s+forward|will\s+not\s+be\s+(moving|proceeding|considering)|decided\s+to\s+(move\s+forward\s+with\s+(other|another)|proceed\s+with\s+other)|we\s+(were\s+)?(unable|regret)|not\s+selected|no\s+longer\s+under\s+(consideration|review)|other\s+candidates?\s+(have|were)|keep\s+your\s+details\s+on\s+file)\b/i
  },
  {
    status: "applied",
    pattern:
      /\b(application\s+(was\s+)?(received|submitted|complete|successful)|we\s+(have\s+)?received\s+your\s+application|thank\s+you\s+for\s+(applying|your\s+application|your\s+interest)|successfully\s+(submitted|applied)|you'?ve\s+applied|application\s+confirmation)\b/i
  }
];

function inferStatus(message) {
  const haystack = `${message.subject || ""} ${message.snippet || ""} ${(message.body || "").slice(0, 400)}`;

  for (const signal of STATUS_SIGNALS) {
    if (signal.pattern.test(haystack)) return signal.status;
  }

  // The user's query matched this mail, so it is about an application. Landing
  // in Saved would mean the board never counts it in "Applied this week", which
  // is the number this feature exists to make correct.
  return "applied";
}

// The whole local parse. Returns the same shape the AI is asked to produce, so
// the two are trivially comparable.
function parseLocally(message) {
  const cleaned = cleanSubject(message.subject);
  const split = splitRoleCompany(cleaned);
  const from = message.from || {};

  return {
    title: split.title || cleaned || "",
    company: split.company || companyFromSender(from),
    url: pickJobUrl(message.links),
    status: inferStatus(message)
  };
}

// ---- AI enrichment -----------------------------------------------------

// Models wrap JSON in a code fence, prepend "Here's the JSON:", or both.
//
// Every balanced `{…}` in the reply is tried in turn rather than trusting the
// first one: a preamble like "Use a { placeholder } carefully" would otherwise
// be parsed, fail, and abort the whole extraction — losing an otherwise good
// answer that appears later in the same reply.
function parseJsonObject(text) {
  const source = String(text || "").replace(/```json/gi, "```");

  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const char = source[i];

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = !inString;
      } else if (!inString && char === "{") {
        depth += 1;
      } else if (!inString && char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1));
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            // Not the object we were looking for; keep scanning.
          }
          break;
        }
      }
    }
  }

  return null;
}

function buildExtractionPrompt(message, local) {
  const from = message.from || {};
  const sender = `${from.name || "(no name)"} <${from.address || "(no address)"}>`;

  return [
    "A job-application email was received. Extract the job application details.",
    "",
    `Subject: ${message.subject || "(none)"}`,
    `From: ${sender}`,
    `Sender domain: ${from.domain || "(none)"}`,
    `Body (first ${AI_BODY_CHARS} characters):`,
    (message.body || message.snippet || "(empty)").slice(0, AI_BODY_CHARS),
    "",
    "A local parser already ran on this email. Its output may be wrong — correct it, keep what is right, and fill in what it could not work out:",
    `  title:    ${local.title || "(empty)"}`,
    `  company:  ${local.company || "(empty)"}`,
    `  url:      ${local.url || "(empty)"}`,
    `  stage:    ${local.status}`,
    "",
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '{"title": "...", "company": "...", "url": "...", "stage": "saved|applied|interview|offer|rejected"}',
    "",
    "Rules:",
    '- title: the role applied for, without the company and without words like "application" or "interview". "" if the email never names one.',
    "- company: the employer, not the recruiting platform. If the sender is Greenhouse/Lever/Workday/Ashby/Workable/SmartRecruiters/iCIMS and no employer is named, use the platform name.",
    "- url: a direct link to the job posting or to the application status page. \"\" if the email has no such link — do not invent one.",
    "- stage: the outcome this email reports. \"applied\" for a received/submitted confirmation, \"interview\" for an interview invite, \"offer\" for an offer, \"rejected\" for a decline.",
    "- Never invent a value. An empty string is always better than a guess."
  ].join("\n");
}

// Returns null when no AI is available or the call fails — the caller then keeps
// the local parse, so an unreachable provider degrades the feature rather than
// breaking it.
//
// The reply's field is called `stage` because that is what the model is asked
// for, and it is translated to `status` on the way out. Renaming it here rather
// than at the call site is deliberate: this function's job is to produce the
// same shape as parseLocally, and the two are compared field by field after
// this.
async function enrichWithAi(message, local, settings) {
  const provider = configuredProviders(settings)[0];
  if (!provider) return null;

  const raw = await sendProviderPrompt({
    provider,
    settings,
    prompt: buildExtractionPrompt(message, local),
    maxTokens: 300
  });

  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const url = String(parsed.url || "").trim();
  return {
    // An empty or nonsense model answer must never erase a value the local
    // parser found — merge field by field, model first.
    title: String(parsed.title || "").trim() || local.title,
    company: String(parsed.company || "").trim() || local.company,
    url: /^https?:\/\//i.test(url) ? url : local.url,
    status: Tracker.STATUSES.includes(parsed.stage) ? parsed.stage : local.status
  };
}

const EmailLedger = {
  KEY: IMPORT_LEDGER_KEY,

  async read() {
    const { [IMPORT_LEDGER_KEY]: ids } = await chrome.storage.local.get(IMPORT_LEDGER_KEY);
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  },

  async write(ids) {
    const trimmed = [...ids].slice(-MAX_LEDGER);
    await chrome.storage.local.set({ [IMPORT_LEDGER_KEY]: trimmed });
    return trimmed;
  },

  async clear() {
    await chrome.storage.local.remove(IMPORT_LEDGER_KEY);
  }
};

// ---- the sync ----------------------------------------------------------

// How much time and string the model gets, so it cannot be talked into echoing
// the whole body back as a "title".
function tidyField(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// The query the user configured, plus a hard date floor. Google's date filter
// operator is applied last so it wins over any newer_than: the user typed,
// because "the last N days" is the one bound that is not the user's judgement
// call about which emails matter.
function buildQuery(settings) {
  const base = String((settings && settings.emailSyncQuery) || "").trim();
  const days = Math.max(1, Number((settings && settings.emailLookbackDays) || 30));
  const floor = `newer_than:${days}d`;
  if (!base) return floor;
  if (/\bnewer_than:\d+[dwmy]\b/i.test(base)) return base;
  return `${base} ${floor}`;
}

// When the mail itself says the event happened, as epoch milliseconds. Zero or
// absent means "unknown" and must never be guessed at: a caller that gets null
// leaves the row's dates alone rather than writing a plausible-looking lie.
function messageReceivedAt(message) {
  if (!message) return null;
  const internal = Number(message.receivedAt);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const parsed = Date.parse(message.date || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Bounded concurrency, preserving order. A plain Promise.all over 25 messages
// is 25 simultaneous requests to one Gmail quota, and one 429 there fails the
// whole run.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function readSyncState() {
  return chrome.storage.local.get(EMAIL_SYNC_STATE_KEY).then((stored) => stored[EMAIL_SYNC_STATE_KEY] || null);
}

function writeSyncState(state) {
  return chrome.storage.local.set({ [EMAIL_SYNC_STATE_KEY]: state });
}

// The one entry point. Called by the daily alarm and by the dashboard's
// "Sync now" button, which is the same function with force: true so the button
// works before the schedule has been switched on.
async function runSync({ settings, onProgress, force = false } = {}) {
  const report = {
    at: Date.now(),
    ok: false,
    scanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    // Rows whose applied / rejected date was stamped from the sync clock by an
    // older build and has now been repaired from the mail's own date.
    datesFixed: 0,
    aiEnriched: 0,
    aiSkipped: 0,
    aiFailed: 0,
    notes: []
  };

  const fail = async (message) => {
    report.notes.push(message);
    await writeSyncState(report);
    return report;
  };

  try {
    if (!settings || typeof settings !== "object") return await fail("Settings could not be read.");

    if (!settings.emailSyncEnabled && !force) {
      return await fail("Daily sync is switched off. Turn it on, or press Sync now.");
    }

    if (!String(settings.gmailClientId || "").trim()) {
      return await fail("Add your Google OAuth client id before the first sync.");
    }

    const connection = await Gmail.getConnection(settings);
    if (!connection.connected) return await fail("Gmail is not connected. Press Connect Gmail first.");

    const query = buildQuery(settings);
    const ids = await Gmail.listMessageIds(settings, { query, maxResults: DEFAULT_MAX_MESSAGES });
    report.scanned = ids.length;

    if (onProgress) onProgress({ phase: "fetch", done: 0, total: ids.length });
    if (!ids.length) {
      report.ok = true;
      await writeSyncState(report);
      return report;
    }

// Failures isolated per message, on both passes. A single malformed MIME
    // tree or a transient 500 must not end the run: the alternative is leaving
    // the other 24 confirmation emails of the morning unimported because one of
    // them arrived truncated. A failed id comes back as null and is filtered out.
    const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, async (id, index) => {
      const progress = () => onProgress && onProgress({ phase: "fetch", done: index + 1, total: ids.length });
      try {
        const message = await Gmail.getMessage(settings, id);
        progress();
        return message;
      } catch (err) {
        progress();
        report.failed += 1;
        report.notes.push(`Could not read one message: ${err.message}`);
        return null;
      }
    });

    const messages = fetched.filter(Boolean);

    // A live view of the board, kept current as rows are written. It answers
    // "did this mail create a row or update one" without a second storage read
    // per message, and without the stale-snapshot bug where a run's own second
    // mail about the same job would be miscounted as a new application.
    const board = await Tracker.list();
    // The ledger is the authority on what has been imported; the rows' own
    // sourceEmailId is folded in so a ledger cleared by hand cannot cause the
    // whole history to be re-imported on the next run.
    const imported = await EmailLedger.read();
    for (const item of board) if (item.sourceEmailId) imported.add(item.sourceEmailId);

    const aiCap = settings.emailUseAi ? Math.max(0, Number(settings.emailMaxAiPerRun) || 0) : 0;
    let aiSpent = 0;

    await mapWithConcurrency(messages, 1, async (message, index) => {
      if (onProgress) onProgress({ phase: "parse", done: index + 1, total: messages.length });

      // A message already turned into a row has nothing left to say — except
      // its date. Rows written by an older build were stamped with the moment
      // the sync ran instead of the moment the mail arrived, which is a lie
      // about when the application was sent or rejected; this pass repairs
      // them from the message already in hand, and costs one comparison per
      // message when the dates are already right. This is what still makes a
      // daily sync safe to leave switched on forever.
      if (imported.has(message.id)) {
        const emailAt = messageReceivedAt(message);
        if (!emailAt) {
          report.skipped += 1;
          return;
        }

        const local = parseLocally(message);
        const index = Tracker.matchIndex(board, {
          sourceEmailId: message.id,
          url: local.url,
          title: local.title,
          company: local.company,
          matchLoose: true
        });
        if (index === -1) {
          report.skipped += 1;
          return;
        }

        const row = board[index];
        const patch = {
          id: row.id,
          url: row.url,
          title: row.title,
          company: row.company,
          source: row.source,
          emailAt
        };

        // The mail that *created* the row is the authority on when the
        // application went out — no other message can speak to that date. A
        // rejection mail speaks to the rejection date whether or not it was
        // the row's first mail, because it is the only evidence of that
        // outcome there is.
        const createdRow = !!row.sourceEmailId && row.sourceEmailId === message.id;
        if (createdRow && row.status !== "saved" && local.status !== "saved" && row.appliedAt !== emailAt) {
          patch.appliedAt = emailAt;
        }
        if (local.status === "rejected" && row.rejectedAt !== emailAt) {
          patch.rejectedAt = emailAt;
        }
        // A rejection mail imported before the rank rule put Rejected above
        // Applied left the card stranded in Applied — with the right rejection
        // date and nowhere to show it. This flips the stage from the mail
        // already in hand; Tracker's own rank rule still refuses to demote an
        // interview or an offer.
        if (local.status === "rejected" && row.status === "applied") {
          patch.status = "rejected";
        }

        if (patch.appliedAt !== undefined || patch.rejectedAt !== undefined || patch.status !== undefined) {
          const repaired = await Tracker.save(patch);
          if (repaired) board[index] = repaired;
          report.datesFixed += 1;
        } else {
          report.skipped += 1;
        }
        return;
      }

      try {
        const local = parseLocally(message);
        let fields = local;

        if (aiCap > 0 && aiSpent < aiCap) {
          aiSpent += 1;
          // Isolated from the import itself: an expired API key or a provider
          // outage must fall back to the local parse, not skip the application.
          // That is the promise made at the top of this file — the feature
          // degrades to free-and-local rather than breaking.
          try {
            const enriched = await enrichWithAi(message, local, settings);
            if (enriched) {
              fields = enriched;
              report.aiEnriched += 1;
            }
          } catch (err) {
            report.aiFailed += 1;
          }
        } else if (aiCap > 0) {
          report.aiSkipped += 1;
        }

        const url = fields.url || "";
        const draft = {
          url,
          title: tidyField(fields.title, 120),
          company: tidyField(fields.company, 80),
          // The ATS name when the mail linked to a posting, so the board's
          // source chip agrees with where the job actually lives.
          source: url ? Tracker.sourceFromUrl(url) : "Email",
          status: fields.status,
          sourceEmailId: message.id,
          // The mail's own date, so a row created here records when the
          // application was sent (or rejected), not when this sync ran.
          emailAt: messageReceivedAt(message),
          notes: `Imported from Gmail — "${(message.subject || "").slice(0, 160) || "(no subject)"}"`,
          matchLoose: true
        };

        const known = Tracker.matchIndex(board, draft) >= 0;
        const saved = await Tracker.save(draft);
        if (saved) board.push(saved);
        imported.add(message.id);

        if (known) report.updated += 1;
        else report.added += 1;
      } catch (err) {
        // One unreadable message must not end the run: a malformed MIME tree or
        // a transient 500 is not a reason to leave the other 24 unimported.
        report.failed += 1;
        report.notes.push(`Skipped one message: ${err.message}`);
      }
    });

    // Written once at the end rather than per message: 25 storage writes is 25
    // chances for the service worker to be torn down mid-sync. If it is, the
    // messages processed so far are re-read next run and merge into the rows
    // they already created, so nothing is duplicated — only a few AI calls are
    // spent twice.
    await EmailLedger.write(imported);

    report.ok = true;
    await writeSyncState(report);
    if (onProgress) onProgress({ phase: "done", done: messages.length, total: messages.length });
    return report;
  } catch (err) {
    return await fail(err.message);
  }
}

// Same three layers as everywhere else in the extension: bundled
// src/data/settings.json is the base and chrome.storage.local overrides it
// field-by-field.
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    const res = await fetch(chrome.runtime.getURL("src/data/settings.json"));
    if (res.ok) bundled = await res.json();
  } catch {
    // mergeSettings still applies DEFAULT_SETTINGS and the stored overrides.
  }

  return mergeSettings(bundled, settings);
}

const MailImport = {
  STATE_KEY: EMAIL_SYNC_STATE_KEY,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_QUERY,
  cleanSubject,
  splitRoleCompany,
  companyFromSender,
  pickJobUrl,
  inferStatus,
  parseLocally,
  parseJsonObject,
  enrichWithAi,
  buildQuery,
  runSync,
  loadSettings,
  readSyncState,
  ledger: EmailLedger
};