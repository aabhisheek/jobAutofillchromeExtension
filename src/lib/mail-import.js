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
const EMAIL_RECLASSIFY_STATE_KEY = "emailReclassifyState";
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

// The manual "Read & Sync" reads the whole look-back window instead: every
// message in the last N days, paginated, not the first page of a query. Bounded
// because a busy inbox of 90 days can be thousands of messages and every one of
// them costs a messages.get to read.
const FULL_FETCH_CEILING = 1000;

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

// How many emails go into one AI request. The static instructions and rules are
// paid for once per batch instead of once per email, and the request count falls
// by this factor — which is what keeps a whole window's worth of mail under a
// provider's rate limit. Kept small enough that the model still returns one
// clean object per email rather than merging or dropping them.
const AI_BATCH_SIZE = 15;

// Output budget for a batch: a compact JSON object per email plus slack. A
// single-email reply is ~80 tokens, so this covers a full batch with room for a
// wordier model.
const AI_BATCH_MAX_TOKENS = 2400;

// Gap between batch requests during a re-check. A full window is far more
// requests than a sync ever makes, and free-tier keys rate-limit on requests
// per minute; without a pause the tail of the run comes back 429 and the cards
// it covered are silently unchecked.
const AI_PACING_MS = 1500;

// How hard one batch fights before it is given up on. A provider is attempted
// this many times, with the wait doubling between attempts, and only then does
// the batch move on to the next configured provider. This is the safety net
// behind the provider layer's own rate-limit retry: a transient 500, a timeout
// or a momentarily overloaded key is ridden out here instead of costing the
// emails in the batch their AI pass.
const AI_PROVIDER_ATTEMPTS = 3;

// The wait before the first retry. Doubles each attempt: 2s, 4s, then the next
// provider. The server's own retry-after still wins when it sends one deeper in
// the provider layer; this is only for the failures that arrive with no advice.
const AI_RETRY_BASE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// The same domains minus the job boards: mail from Greenhouse, Workday, Ashby
// and friends is an application event by definition, while LinkedIn and Naukri
// also send job-feed alerts that would become junk cards. Used only by the
// full-window read's relevance gate.
const APPLICATION_SENDER_SUFFIXES = Object.keys(PLATFORM_SENDER_DOMAINS).filter(
  (domain) => domain !== "linkedin.com" && domain !== "naukri.com"
);

// Boilerplate that wraps the actual role in a subject line. These stack:
// "Re: Fwd: Application received: Your application for Backend Engineer at
// Acme" strips to the role in one pass via SUBJECT_PREFIX_PATTERN below.
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

// Single-pass form of SUBJECT_PREFIXES: each entry's leading ^ is dropped so
// the alternatives can repeat inside one anchored ^(?:...)+ match. Built once
// here so the array stays the editable source of truth.
const SUBJECT_PREFIX_PATTERN = new RegExp(
  `^(?:${SUBJECT_PREFIXES.map((pattern) => `(?:${pattern.source.replace(/^\^/, "")})`).join("|")})+`,
  "i"
);

// …and the matching suffixes.
const SUBJECT_SUFFIXES = [
  /\s*[-|–—:]\s*(job\s+)?application(\s+(received|submitted|confirmation))?\s*$/i,
  /\s*[-|–—:]\s*(application\s+)?(received|submitted|confirmed)\s*$/i,
  /\s*[-|–—:]\s*careers?\s*$/i,
  /\s*[-|–—:]\s*(confirmation|acknowledg(e)?ment)\s*$/i,
  /\s*\(\s*(application\s+)?(received|submitted|confirmation)\s*\)\s*$/i,
  /\s*[-|–—:]\s*(job\s+)?(applied|application\s+sent)\s*$/i
];

//clean all subject_prefixes and subject_suffixes present in the subject.
function cleanSubject(subject) {
  // Convert subject to a string.
  // If subject is null/undefined/empty, use "" instead.
  let text = String(subject || "").trim();

  // One replace strips all stacked prefixes: the outer + repeats the
  // alternation, so removing one prefix can expose the next without an outer
  // do...while loop.
  text = text.replace(SUBJECT_PREFIX_PATTERN, "").trim();

  // Now remove anything defined as a suffix.
  for (const pattern of SUBJECT_SUFFIXES) {
    text = text.replace(pattern, "");
  }

  // Collapse multiple spaces into one and remove spaces at the ends.
  return text.replace(/\s{2,}/g, " ").trim();
}

// "Backend Engineer at Acme Corp" → role / company. Split on the first " at "
// only: a title containing "at" ("Chat Engineer at Scale") is rarer than a
// company name containing one, and splitting on the last separator would hand
// back "Engineer at Acme" as the role.
//the cleaned subject is passed into this from above function
function splitRoleCompany(text) {
  // Convert the input into a string and remove spaces from the beginning/end.
  // If text is null, undefined, or another falsy value, use an empty string instead.
  const value = String(text || "").trim();

  // If there is no text at all, return empty title and company.
  if (!value) return { title: "", company: "" };


  // Look for the format:
  // "Job Title at Company"
  //
  // ^       = start of the string
  // (.+?)   = capture the job title (non-greedy, so it stops at the first " at ")
  // \s+at\s+ = the word "at" surrounded by one or more spaces
  // (.+)    = capture everything after "at" as the company
  // $       = end of the string
  // i       = case-insensitive ("at", "AT", "At", etc.)
  const at = value.match(/^(.+?)\s+at\s+(.+)$/i);

  // If the "Job Title at Company" pattern matched,
  // clean both pieces and return them.
  if (at) return { title: cleanTail(at[1]), company: cleanTail(at[2]) };


  // Look for the format:
  // "Job Title - Company"
  // "Job Title – Company"
  // "Job Title — Company"
  //
  // (.+?) = capture the job title
  // \s+ = one or more spaces
  // [-–—] = either a normal hyphen (-), en dash (–), or em dash (—)
  // (.+) = capture the company
  const separator = value.match(/^(.+?)\s+[-–—]\s+(.+)$/);

  // If a dash-separated title/company was found,
  // clean both pieces and return them.
  if (separator) {
    return {
      title: cleanTail(separator[1]),
      company: cleanTail(separator[2])
    };
  }


  // Look for the format:
  // "Job Title : Company"
  // "Job Title – Company"
  // "Job Title — Company"
  //
  // This is similar to the separator pattern above,
  // but specifically allows a colon or dash as the separator.
  const colon = value.match(/^(.+?)\s+[:–—]\s+(.+)$/);

  // If the colon/dash pattern matched,
  // clean both pieces and return them.
  if (colon) {
    return {
      title: cleanTail(colon[1]),
      company: cleanTail(colon[2])
    };
  }


  // If none of the expected formats matched,
  // assume the entire text is the job title.
  // We don't have enough information to determine the company.
  return { title: value, company: "" };
}


// Clean unwanted information from the end of a title/company string.
// Examples:
// "Acme Corp | Bengaluru"     -> "Acme Corp"
// "Acme Corp (Remote)"        -> "Acme Corp"
// "Backend Engineer, Acme"    -> "Backend Engineer, Acme"
function cleanTail(value) {

  // Convert the input to a string.
  // If value is null/undefined/falsy, use an empty string.
  const cleanedValue = String(value || "");


  // Split the string wherever there is a "|" or dash surrounded by spaces.
  // [0] means "take only the first piece".
  //
  // Example:
  // "Acme Corp | Bengaluru"
  //        ↓
  // ["Acme Corp", "Bengaluru"]
  //        ↓
  // "Acme Corp"
  return cleanedValue
    .split(/\s*[|–—]\s*/)[0]


    // Remove a dash if it appears at the very beginning.
    //
    // Example:
    // "- Acme Corp"
    // ↓
    // "Acme Corp"
    .replace(/^\s*[-–—]\s*/, "")


    // Remove location/work-type information at the END of the string.
    //
    // Matches things such as:
    // " (Remote)"
    // " Remote"
    // " (Hybrid)"
    // " (Onsite)"
    // " (Full-time)"
    // " (Contract)"
    //
    // $ means this must occur at the END of the string.
    // i means case-insensitive.
    .replace(/\s*\((?:remote|hybrid|onsite|full[- ]?time|contract)\)\s*$/i, "")


    // Remove certain city names when they appear at the end
    // after a comma.
    //
    // Examples:
    // "Backend Engineer, Bengaluru" -> "Backend Engineer"
    // "Developer, Mumbai"           -> "Developer"
    // "Engineer, Hyderabad"         -> "Engineer"
    .replace(
      /\s*,\s*(?:bengaluru|bangalore|delhi|mumbai|hyderabad|pune|gurgaon|noida|chennai)$/i,
      ""
    )


    // Replace two or more consecutive spaces with one space.
    //
    // Example:
    // "Backend   Engineer"
    // ↓
    // "Backend Engineer"
    .replace(/\s{2,}/g, " ")


    // Remove spaces from the beginning and end.
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

    //regex preserves letters, numbers, and selected punctuation
    //2nd regex
    ////collapse repeated whitespaces


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

// Does this mail belong on the board?
//
// Only needed by the full-window read, which fetches every message in the
// look-back window with no Gmail query to pre-filter it. The query did that
// job before; without it the parser would turn newsletters into applications
// (inferStatus defaults to "applied"), so relevance is decided here instead:
// an outcome the status signals recognise, an application-flavoured subject,
// or a known ATS as the sender. Everything else is counted as ignored and
// never parsed — and the count is reported, so "my new mail is missing" is
// diagnosable from the status line rather than guessed at.
function looksLikeApplicationMail(message) {
  const subject = String(message.subject || "");
  const from = message.from || {};
  const haystack = `${subject} ${message.snippet || ""} ${(message.body || "").slice(0, 2000)}`;

  for (const signal of STATUS_SIGNALS) {
    if (signal.pattern.test(haystack)) return true;
  }

  if (/\b(application|applied|applying|candidacy|candidature|requisition)\b/i.test(subject)) return true;

  const domain = String(from.domain || String(from.address || from.email || "").split("@")[1] || "").toLowerCase();
  if (domain) {
    for (const suffix of APPLICATION_SENDER_SUFFIXES) {
      if (domain === suffix || domain.endsWith(`.${suffix}`)) return true;
    }
  }

  return false;
}

// The whole local parse. Returns the same shape the AI is asked to produce, so
// the two are trivially comparable.
function parseLocally(message) {
  const cleaned = cleanSubject(message.subject);
  const split = splitRoleCompany(cleaned);
  const from = message.from || {};

  const result = {
    title: split.title || cleaned || "",
    company: split.company || companyFromSender(from),
    url: pickJobUrl(message.links),
    status: inferStatus(message)
  };
  return result;
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

// The same tolerant extraction as parseJsonObject, for the batch reply's array.
// Every balanced `[…]` is tried in turn, and an array of objects is preferred
// over a plain one: a stray "[1]" in a preamble must not shadow the real answer
// that follows it. If only a non-object array is found it is returned anyway,
// and the caller's per-item checks discard it.
function parseJsonArray(text) {
  const source = String(text || "").replace(/```json/gi, "```");
  let fallback = null;

  for (let start = source.indexOf("["); start !== -1; start = source.indexOf("[", start + 1)) {
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
      } else if (!inString && (char === "[" || char === "{")) {
        depth += 1;
      } else if (!inString && (char === "]" || char === "}")) {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1));
            if (Array.isArray(parsed)) {
              if (parsed.length === 0 || parsed.every((item) => item && typeof item === "object")) return parsed;
              if (!fallback) fallback = parsed;
            }
          } catch {
            // Not the array we were looking for; keep scanning.
          }
          break;
        }
      }
    }
  }

  return fallback;
}

// Stage the model returns when the email is not about the user's own job
// application at all — advertisements, newsletters, promos, interview tips,
// product marketing (e.g. Adobe Acrobat). Deliberately NOT a Tracker status,
// so it can never be saved as a card status; it is only a reject signal the
// import loop turns into "ignored".
const AI_REJECT_STAGE = "not_job";

function normalizeAiStage(value) {
  return String(value || "").trim().toLowerCase();
}

// True when the model's answer is an explicit rejection of the email.
// Centralized so runSync and reclassify agree on what counts.
function isAiRejection(fields) {
  return !!fields && normalizeAiStage(fields.status) === AI_REJECT_STAGE;
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
    '{"title": "...", "company": "...", "url": "...", "stage": "saved|applied|interview|offer|rejected|not_job"}',
    "",
    "Rules:",
    '- title: the role applied for, without the company and without words like "application" or "interview". "" if the email never names one.',
    "- company: the employer, not the recruiting platform. If the sender is Greenhouse/Lever/Workday/Ashby/Workable/SmartRecruiters/iCIMS and no employer is named, use the platform name.",
    "- url: a direct link to the job posting or to the application status page. \"\" if the email has no such link — do not invent one.",
    "- stage: the outcome this email reports. \"applied\" for a received/submitted confirmation, \"interview\" for an interview invite, \"offer\" for an offer, \"rejected\" for a decline.",
    '- stage: "not_job" when this email is NOT about the user\'s own job application — advertisements, newsletters, promos, product marketing, interview tips. Leave title/company/url as "" with it.',
    "- Never invent a value. An empty string is always better than a guess."
  ].join("\n");
}

// The batch prompt. Same instructions and rules as the single-mail prompt, asked
// once, followed by one block per email tagged with the ref the answer must echo
// back. The tags are what make a batched reply safe: the model may answer out of
// order or skip an email, and each object still lands on the right row.
function buildBatchExtractionPrompt(messages, locals, refs) {
  const lines = [
    `Extract the job application details from each of these ${messages.length} job-application emails.`,
    "",
    "A local parser already ran on each one. Its output may be wrong — correct it, keep what is right, and fill in what it could not work out.",
    "",
    "Reply with ONLY a JSON array, no prose and no code fence — one object per email, echoing that email's ref exactly (the order of the objects does not matter):",
    '[{"ref": "e1", "title": "...", "company": "...", "url": "...", "stage": "saved|applied|interview|offer|rejected|not_job"}]',
    "",
    "Rules:",
    '- title: the role applied for, without the company and without words like "application" or "interview". "" if the email never names one.',
    "- company: the employer, not the recruiting platform. If the sender is Greenhouse/Lever/Workday/Ashby/Workable/SmartRecruiters/iCIMS and no employer is named, use the platform name.",
    '- url: a direct link to the job posting or to the application status page. "" if the email has no such link — do not invent one.',
    '- stage: the outcome this email reports. "applied" for a received/submitted confirmation, "interview" for an interview invite, "offer" for an offer, "rejected" for a decline.',
    '- stage: "not_job" when an email is NOT about the user\'s own job application — advertisements, newsletters, promos, product marketing, interview tips. Leave title/company/url as "" with it.',
    "- Never invent a value. An empty string is always better than a guess. Return one object for every ref, and never drop or merge two emails.",
    ""
  ];

  messages.forEach((message, index) => {
    const from = message.from || {};
    const sender = `${from.name || "(no name)"} <${from.address || "(no address)"}>`;
    const local = locals[index] || {};
    lines.push(
      `=== ref: ${refs[index]} ===`,
      `Subject: ${message.subject || "(none)"}`,
      `From: ${sender}`,
      `Sender domain: ${from.domain || "(none)"}`,
      `Body (first ${AI_BODY_CHARS} characters):`,
      (message.body || message.snippet || "(empty)").slice(0, AI_BODY_CHARS),
      `Local parse: title=${local.title || "(empty)"} company=${local.company || "(empty)"} url=${local.url || "(empty)"} stage=${local.status}`,
      ""
    );
  });

  return lines.join("\n");
}

// Folds a model answer onto the local parse, field by field, model first. An
// empty or nonsense model value must never erase a value the local parser found,
// and `stage` is translated to `status` here because that is what the model is
// asked for while the rest of the code speaks in Tracker statuses.
//
// The one exception is an explicit rejection (`not_job`): it is passed through
// untouched — never folded back to the local parse — so the model finally has a
// way to say "this email should never become a card".
function mergeAiFields(parsed, local) {
  const stage = normalizeAiStage(parsed && parsed.stage);
  if (stage === AI_REJECT_STAGE) {
    return { title: "", company: "", url: "", status: AI_REJECT_STAGE };
  }
  const url = String(parsed.url || "").trim();
  return {
    title: String(parsed.title || "").trim() || local.title,
    company: String(parsed.company || "").trim() || local.company,
    url: /^https?:\/\//i.test(url) ? url : local.url,
    status: Tracker.STATUSES.includes(parsed.stage) ? parsed.stage : local.status
  };
}

// Keep a short structural trace for local evaluation; never retain mail body.
function recordAiEval(message, local, result, provider) {
  if (typeof AiEvals === "undefined") return;
  AiEvals.record({
    task: "gmail-parse",
    input: { subject: tidyField(message.subject, 180), sender: tidyField((message.from || {}).name || (message.from || {}).email, 100), local: { title: local.title, company: local.company, status: local.status } },
    output: result,
    provider: provider.id || provider.label || ""
  }).catch(() => {});
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

  const result = mergeAiFields(parsed, local);
  recordAiEval(message, local, result, provider);
  return result;
}

// The batch form of the same request: many emails in one call, each tagged with
// a short ref we assign, so an answer can be matched back to its email even if
// the model reorders or drops items. Returns a Map of message id -> merged
// fields holding only the emails that came back; every message without an entry
// keeps its local parse, so a missing or mislabelled item degrades that one
// email instead of the whole batch.
async function enrichBatchWithAi(messages, locals, settings, provider) {
  const results = new Map();
  if (!messages.length) return results;
  provider = provider || configuredProviders(settings)[0];
  if (!provider) return results;

  const refs = messages.map((_, index) => `e${index + 1}`);
  const refToIndex = new Map(refs.map((ref, index) => [ref, index]));

  const raw = await sendProviderPrompt({
    provider,
    settings,
    prompt: buildBatchExtractionPrompt(messages, locals, refs),
    maxTokens: AI_BATCH_MAX_TOKENS
  });

  const parsed = parseJsonArray(raw);
  if (!Array.isArray(parsed)) return results;

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const ref = String(item.ref || "").trim();
    const index = refToIndex.get(ref);
    // An unknown or repeated ref costs that one email its enrichment and nothing
    // else: the result is simply not mapped, and the local parse stands in.
    if (index === undefined || results.has(messages[index].id)) continue;
    const local = locals[index];
    const merged = mergeAiFields(item, local);
    results.set(messages[index].id, merged);
    recordAiEval(messages[index], local, merged, provider);
  }

  return results;
}

// One batch, every configured provider, each with a few spaced-out attempts.
//
// This is the fallback the whole enrichment path rests on. It walks the
// provider list in its configured order and, for each, tries the batch
// AI_PROVIDER_ATTEMPTS times with an exponential wait in between. A provider
// that answers — even only partially — hands its results back and the still
// unanswered emails move on to the next provider, so a model that quietly drops
// an item from a batch does not sink that item. Only when no provider has
// anything for a set of emails does the caller see them as unenriched.
//
// Returns a Map of message id -> merged fields for whatever came back. Throws
// only when nothing came back at all and the last provider left an error, so
// the caller can tell "the model returned nothing usable" apart from "every
// provider is down" — the split-and-retry path keys off the throw.
async function enrichBatchAcrossProviders(messages, locals, settings) {
  const providers = configuredProviders(settings);
  if (!providers.length) throw new Error("No AI provider is configured.");

  // Timing is overridable from settings purely so the test suite does not sit
  // through real 2s/4s backoffs; nothing in the UI sets these.
  const attempts = Math.max(1, Math.floor(Number(settings && settings.aiProviderAttempts) || AI_PROVIDER_ATTEMPTS));
  const baseMs = Number.isFinite(Number(settings && settings.aiRetryBaseMs))
    ? Math.max(0, Number(settings.aiRetryBaseMs))
    : AI_RETRY_BASE_MS;

  const collected = new Map();
  let pending = messages.map((message, index) => ({ message, local: locals[index] }));
  let lastError = null;

  for (const provider of providers) {
    for (let attempt = 1; attempt <= attempts && pending.length; attempt += 1) {
      try {
        const got = await enrichBatchWithAi(
          pending.map((entry) => entry.message),
          pending.map((entry) => entry.local),
          settings,
          provider
        );
        for (const [id, fields] of got) collected.set(id, fields);
        // Drop the answered ones and let the next provider pick up the rest.
        // Breaking here (rather than retrying the same provider) is the point of
        // rotation: a model that dropped an item will very likely drop it again,
        // so the next provider is the better bet.
        pending = pending.filter((entry) => !collected.has(entry.message.id));
        break;
      } catch (err) {
        lastError = err;
        if (attempt < attempts && baseMs > 0) {
          await sleep(baseMs * 2 ** (attempt - 1));
        }
      }
    }
    if (!pending.length) break;
  }

  if (!collected.size && lastError) throw lastError;
  return collected;
}

// A batch that comes back with a hard failure — every provider and attempt
// exhausted — must not cost every email in it, because the batch may simply
// have been too big for the key's per-minute token budget. Split it in half and
// retry each half, so the size shrinks until it fits instead of being written
// off whole. Recursion stops at a single email: one email failing alone after
// every provider has been tried is a real problem (bad key, outage), not a
// batch that was too big, and is handed to `onLost` so the caller can count it.
// `messages` and `locals` are parallel arrays and are always split together.
async function enrichBatchResilient(messages, locals, settings, onLost) {
  try {
    return await enrichBatchAcrossProviders(messages, locals, settings);
  } catch (err) {
    if (messages.length <= 1) {
      if (onLost) onLost(err);
      return new Map();
    }
    const mid = Math.floor(messages.length / 2);
    const left = await enrichBatchResilient(
      messages.slice(0, mid), locals.slice(0, mid), settings, onLost
    );
    const right = await enrichBatchResilient(
      messages.slice(mid), locals.slice(mid), settings, onLost
    );
    for (const [id, fields] of right) left.set(id, fields);
    return left;
  }
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

// The window alone, with no search terms: what the full read uses, so a mail
// the phrase query never matched still gets its day in front of the parser.
function buildWindowQuery(settings) {
  const days = Math.max(1, Number((settings && settings.emailLookbackDays) || 30));
  return `newer_than:${days}d`;
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
  // Every persisted report is also one history entry — the dashboard's and the
  // side panel's "last synced" lists read the ring buffer, and this is the
  // single choke point (fail, stop, the empty-window finish and the real
  // finish all come through here), so a run cannot be the latest state
  // without being in the history. The typeof guard is for the standalone test
  // contexts that load this file without scheduler-state.js; on every real
  // page and in the worker the lib is loaded first.
  const history =
    typeof SchedulerState !== "undefined" && SchedulerState.appendEmailHistory
      ? SchedulerState.appendEmailHistory(state).catch(() => null)
      : Promise.resolve(null);

  return chrome.storage.local
    .set({ [EMAIL_SYNC_STATE_KEY]: state })
    .then(() => history);
}

function readReclassifyState() {
  return chrome.storage.local
    .get(EMAIL_RECLASSIFY_STATE_KEY)
    .then((stored) => stored[EMAIL_RECLASSIFY_STATE_KEY] || null);
}

function writeReclassifyState(state) {
  return chrome.storage.local.set({ [EMAIL_RECLASSIFY_STATE_KEY]: state });
}

// The one entry point. Called by the daily alarm and by the dashboard's
// "Read & Sync" button, which is the same function with force: true so the
// button works before the schedule has been switched on — and full: true, so
// it re-reads the whole look-back window instead of the newest query matches.
async function runSync({ settings, onProgress, force = false, full = false, signal } = {}) {
  const report = {
    at: Date.now(),
    ok: false,
    // Whether this run read the whole window rather than the query's newest
    // matches — persisted so the last-run line can label "scanned" honestly.
    full: !!full,
    // The user pressed Stop. Kept as its own flag so the panel can say what
    // happened without mistaking a stop for a failure or a clean finish.
    aborted: false,
    scanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    // Window messages the relevance gate turned away: fetched and read, but
    // not about an application, so no card was made from them.
    ignored: 0,
    // Rows whose applied / rejected date was stamped from the sync clock by an
    // older build and has now been repaired from the mail's own date.
    datesFixed: 0,
    aiEnriched: 0,
    aiSkipped: 0,
    aiFailed: 0,
    // Emails AI explicitly rejected as not about a job application
    // (advertisements, newsletters, promos). Counted separately from the
    // regex gate's `ignored` so the panel can say AI did the filtering.
    aiRejected: 0,
    // Emails left unimported because AI never read them and the board is set to
    // AI-only (emailRequireAi). They are not in the ledger, so the next sync
    // picks them up and tries again — this is the retry loop at run granularity.
    deferred: 0,
    // Whether AI was in play for this run, so the panel can keep showing the AI
    // tally (even all-zero) after the fact without guessing from the settings.
    aiOn: false,
    notes: []
  };

  // Cooperative cancellation: the signal is read between messages and between
  // Gmail pages, never handed to fetch(). A step already in flight is allowed
  // to finish, so a stop never masquerades as a network error and the importer
  // never has to tell an AbortError apart from a real Gmail failure.
  const isAborted = () => !!(signal && signal.aborted);

  const fail = async (message) => {
    report.notes.push(message);
    await writeSyncState(report);
    return report;
  };

  // The same shape as fail(), but a stop is not a failure: ok stays true so
  // every caller renders it as a finished run that simply ended early.
  const stop = async (message) => {
    report.aborted = true;
    report.ok = true;
    report.notes.push(message);
    await writeSyncState(report);
    return report;
  };

  try {
    if (!settings || typeof settings !== "object") return await fail("Settings could not be read.");

    if (!settings.emailSyncEnabled && !force) {
      return await fail("Daily sync is switched off. Turn it on, or press Read & Sync.");
    }

    if (!(await Gmail.hasCredentials(settings))) {
      return await fail("Gmail's OAuth client id is missing — reinstall the extension or add src/data/google-oauth.json.");
    }

    const connection = await Gmail.getConnection(settings);
    if (!connection.connected) return await fail("Gmail is not connected. Press Connect Gmail first.");

    const query = full ? buildWindowQuery(settings) : buildQuery(settings);
    const ids = full
      ? await Gmail.listAllMessageIds(settings, { query, ceiling: FULL_FETCH_CEILING, signal })
      : await Gmail.listMessageIds(settings, { query, maxResults: DEFAULT_MAX_MESSAGES });
    report.scanned = ids.length;
    if (isAborted()) return await stop("Stopped before reading any emails.");
    if (full && ids.length >= FULL_FETCH_CEILING) {
      report.notes.push(
        `The window holds at least ${FULL_FETCH_CEILING} messages — the oldest were not read. Shorten the look-back or press Read & Sync again after the next import.`
      );
    }
    // A live view of the board and the ledger of what has been imported, read
    // before the fetch so the enrichment stream below can judge a message's
    // candidacy the moment it arrives instead of after the whole window is in
    // hand. The ledger is the authority; the rows' own sourceEmailId is folded
    // in so a ledger cleared by hand cannot cause the whole history to be
    // re-imported on the next run.
    const board = await Tracker.list();
    const imported = await EmailLedger.read();
    for (const item of board) if (item.sourceEmailId) imported.add(item.sourceEmailId);

    // How many messages AI is allowed to read this run. A full read — the
    // manual Read & Sync and Reset & rebuild buttons — is a deliberate click, so
    // it reads the whole window and is not held to the unattended-run budget;
    // only the scheduled daily sync is capped. An uncapped run still counts as
    // AI-on, so every cap check below reads `aiCap > 0` and gets Infinity.
    const runCap = Math.max(0, Number(settings.emailMaxAiPerRun) || 0);
    const aiCap = settings.emailUseAi ? (full ? Infinity : runCap) : 0;
    report.aiOn = aiCap > 0;
    // AI-only mode: an email AI never read is not imported at all, so the board
    // holds only AI-checked cards. Meaningful only while AI is on. A truthy test
    // (not `!== false`) so a raw settings object that predates this key — as the
    // tests build — keeps the old local-parse fallback; production settings come
    // through mergeSettings, which supplies the `true` default.
    const requireAi = aiCap > 0 && !!settings.emailRequireAi;
    // Remembered for the panel so it can word the skip tally correctly after the
    // fact — "waiting for AI" rather than "read locally" — without re-deriving
    // it from settings that may since have changed.
    report.aiRequired = requireAi;

    // Running AI tallies, mirrored into every progress tick — including the
    // "reading emails" ticks — so the dashboard can show how much was read by
    // AI, how much fell back to the local parse, and how many calls failed
    // while the run is still in flight, not only in the final report.
    const aiCounts = () => ({
      aiOn: aiCap > 0,
      aiEnriched: report.aiEnriched,
      aiSkipped: report.aiSkipped,
      aiFailed: report.aiFailed,
      deferred: report.deferred,
      aiRejected: report.aiRejected
    });

    if (onProgress) onProgress({ phase: "fetch", done: 0, total: ids.length, ...aiCounts() });
    if (!ids.length) {
      report.ok = true;
      await writeSyncState(report);
      return report;
    }

    const aiFields = new Map();

    // Enrichment streams alongside the read rather than waiting for it to end.
    // A fetched message AI is eligible for is dropped into `aiQueue` right
    // away, and the consumer below drains it a batch at a time. That is what
    // makes "reading 240/1000 · AI: 2 enriched, 5 skipped" actually move during
    // the read instead of sitting at zero until the last message is in.
    const aiQueue = [];
    let aiWaiter = null;      // resolve() of the consumer parked for more mail
    let aiStreamClosed = false;
    let aiQueued = 0;         // eligible candidates accepted so far

    // Past the cap the message is counted as AI-skipped; its local parse still
    // stands, so the application is never lost over a budget.
    const offerToAi = (message) => {
      if (aiQueued >= aiCap) {
        report.aiSkipped += 1;
        return;
      }
      aiQueued += 1;
      aiQueue.push(message);
      if (aiWaiter) { const wake = aiWaiter; aiWaiter = null; wake(); }
    };

    // The enrichment consumer. It parks until either a full batch is queued or
    // the read is over, then sends that batch. One request per batch is what
    // keeps a whole window's mail under the provider's rate limit; an expired
    // key or an outage fails the batch and leaves the local parses standing, so
    // the feature degrades to free-and-local rather than breaking.
    const runAiStream = async () => {
      while (true) {
        while (!aiStreamClosed && aiQueue.length < AI_BATCH_SIZE) {
          await new Promise((resolve) => { aiWaiter = resolve; });
        }
        if (!aiQueue.length) break;
        const batch = aiQueue.splice(0, AI_BATCH_SIZE);
        const locals = batch.map((message) => parseLocally(message));
        // A failed batch is split and retried rather than dropped whole, so a
        // rate limit costs the run a couple of extra requests, not the emails.
        const enriched = await enrichBatchResilient(batch, locals, settings, () => {
          report.aiFailed += 1;
        });
        for (const [id, fields] of enriched) {
          aiFields.set(id, fields);
          report.aiEnriched += 1;
        }
        if (onProgress) {
          onProgress({ phase: "enrich", done: report.aiEnriched + report.aiFailed, total: Math.max(aiQueued, batch.length), ...aiCounts() });
        }
      }
    };
    const aiStream = aiCap > 0 ? runAiStream() : null;

    // Failures isolated per message, on both passes. A single malformed MIME
    // tree or a transient 500 must not end the run: the alternative is leaving
    // the other 24 confirmation emails of the morning unimported because one of
    // them arrived truncated. A failed id comes back as null and is filtered out.
    const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, async (id, index) => {
      if (isAborted()) return null;
      const progress = () => onProgress && onProgress({ phase: "fetch", done: index + 1, total: ids.length, ...aiCounts() });
      try {
        const message = await Gmail.getMessage(settings, id);
        // Everything not already imported, and in a window read everything the
        // relevance gate keeps, is handed to AI the moment it lands.
        if (aiCap > 0 && !imported.has(message.id) && !(full && !looksLikeApplicationMail(message))) {
          offerToAi(message);
        }
        progress();
        return message;
      } catch (err) {
        progress();
        // A step that failed because the run was stopped is not an unreadable
        // email, so it must not inflate the failures the panel reports.
        if (isAborted()) return null;
        report.failed += 1;
        report.notes.push(`Could not read one message: ${err.message}`);
        return null;
      }
    });

    // The read is over: release the consumer so it flushes whatever is left,
    // however small, and let it finish before the import loop needs aiFields.
    aiStreamClosed = true;
    if (aiWaiter) { const wake = aiWaiter; aiWaiter = null; wake(); }
    if (aiStream) await aiStream;

    const messages = fetched.filter(Boolean);
    // A stop during the read phase still imports the mail already fetched —
    // that is the whole point of "I only wanted to read a few". A stop during
    // the import phase ends it immediately. The distinction is captured here,
    // before the parse loop starts and could set it itself.
    const readStopped = isAborted();



    await mapWithConcurrency(messages, 1, async (message, index) => {
      // A stop during the import phase ends it at the next message; a stop
      // during the read phase leaves the mails already in hand to be imported.
      if (isAborted() && !readStopped) return;
      if (onProgress) onProgress({ phase: "parse", done: index + 1, total: messages.length, ...aiCounts() });

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

      // Relevance gate for the local-fallback path (both modes). The scheduled
      // sync trusts the Gmail query, but the query is user-editable and broad
      // queries match newsletters and promos — and inferStatus defaults unknown
      // mail to "applied", so without this every ad becomes a card. Real
      // application mail always carries a status signal, an
      // application-flavoured subject, or an ATS sender, so it passes.
      // Only applied when AI gave no answer: an AI verdict (including not_job
      // above) always wins over this heuristic. Deliberately not ledgered, so
      // a gate miss is retried next run instead of vanishing forever.
      // NOTE: in full-window mode this duplicates the earlier fetch-time gate,
      // which also keeps gate-failing mail away from AI to save budget.
      if (!aiFields.has(message.id) && !looksLikeApplicationMail(message)) {
        report.ignored += 1;
        return;
      }

      // AI-only mode: an email AI never got an answer for waits for a later run
      // rather than landing on the board from the local parse. It is deliberately
      // left out of the ledger below, so the next sync sees it as new and hands
      // it to AI again — that is the retry loop, one run wide.
      if (requireAi && !aiFields.has(message.id)) {
        report.deferred += 1;
        return;
      }

      try {
        const local = parseLocally(message);
        // The enrichment, if the model returned any for this email, was fetched
        // in batches before this loop; absent an answer, the local parse stands.
        const fields = aiFields.get(message.id) || local;

        // AI explicitly said "not about a job application" (advertisement,
        // newsletter, promo, tips). No card. Deliberately NOT ledgered: a false
        // rejection (a real confirmation the model misread) is retried on the
        // next run instead of vanishing forever — the same retry rule as
        // AI-only deferrals. The cost is re-billing AI for the same ad, which
        // is cheaper than losing a real rejection.
        if (aiFields.has(message.id) && isAiRejection(fields)) {
          report.ignored += 1;
          report.aiRejected += 1;
          return;
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

    // A stop after the read or import loop: the rows saved so far are real and
    // stay, the ledger records them the same as a finished run, and the report
    // says plainly that it ended early instead of claiming a clean scan of the
    // whole window. Written through stop() so the flag and ok-value live in one
    // place.
    if (isAborted()) {
      const kept = report.added + report.updated;
      const read = `${messages.length} email${messages.length === 1 ? "" : "s"}`;
      return await stop(
        `Stopped — kept ${kept} application${kept === 1 ? "" : "s"} from the ${read} read before you stopped.`
      );
    }

    report.ok = true;
    await writeSyncState(report);
    if (onProgress) onProgress({ phase: "done", done: messages.length, total: messages.length, ...aiCounts() });
    return report;
  } catch (err) {
    return await fail(err.message);
  }
}

// The AI re-check pass. The local parser files each confirmation mail into a
// column, and it is occasionally wrong — a rejection read as a received
// confirmation, an interview guessed from boilerplate. runSync deliberately
// never revisits mail already in the ledger, so those wrong cards stay wrong
// forever. This reads the whole look-back window again, runs every
// application-flavoured mail through AI (including the ones already imported),
// and moves each imported card to the stage the AI reads from the mail — in
// either direction.
//
// Cards added by hand (everything without a sourceEmailId) have no mail behind
// them and are never touched. Nothing is created or deleted here; the pass only
// re-stages rows the importer already made.
async function reclassifyWithAi({ settings, onProgress, signal } = {}) {
  const report = {
    at: Date.now(),
    ok: false,
    // Marks this as a re-check rather than a sync, so the dashboard's last-run
    // renderers never confuse the two persisted reports.
    reclassify: true,
    aborted: false,
    scanned: 0,
    considered: 0,
    // Imported cards re-examined, how many had a mail match, and how many had
    // no mail left in the look-back window to check against.
    rechecked: 0,
    matched: 0,
    unmatched: 0,
    // The look-back the pass actually used, so the panel can explain an
    // unmatched card as "older than this many days" without re-reading settings.
    lookbackDays: 0,
    // Cards whose stage moved, whose title/company changed, and the rest.
    moved: 0,
    renamed: 0,
    unchanged: 0,
    aiEnriched: 0,
    aiFailed: 0,
    aiOn: false,
    notes: []
  };

  const isAborted = () => !!(signal && signal.aborted);

  const fail = async (message) => {
    report.notes.push(message);
    await writeReclassifyState(report);
    return report;
  };

  const stop = async (message) => {
    report.aborted = true;
    report.ok = true;
    report.notes.push(message);
    await writeReclassifyState(report);
    return report;
  };

  try {
    if (!settings || typeof settings !== "object") return await fail("Settings could not be read.");
    report.lookbackDays = Math.max(1, Number(settings.emailLookbackDays) || 30);

    if (!(await Gmail.hasCredentials(settings))) {
      return await fail("Gmail's OAuth client id is missing — reinstall the extension or add src/data/google-oauth.json.");
    }

    const connection = await Gmail.getConnection(settings);
    if (!connection.connected) return await fail("Gmail is not connected. Press Connect Gmail first.");

    // The whole pass is an AI pass: without a provider there is nothing it can
    // do that the local parser has not already done once.
    if (!configuredProviders(settings)[0]) {
      return await fail("Re-checking tabs needs AI — add an API key on the API Keys page.");
    }

    // Only mail-imported rows are candidates. A hand-added card is the user's
    // own entry and there is no mail to re-read for it.
    const rows = (await Tracker.list()).filter((item) => item.sourceEmailId);
    report.rechecked = rows.length;
    if (!rows.length) {
      report.ok = true;
      await writeReclassifyState(report);
      return report;
    }
    report.aiOn = true;

    const query = buildWindowQuery(settings);
    const ids = await Gmail.listAllMessageIds(settings, { query, ceiling: FULL_FETCH_CEILING, signal });
    report.scanned = ids.length;
    if (isAborted()) return await stop("Stopped before reading any emails.");
    // Same ceiling warning the full sync raises: a capped window is the most
    // likely reason a card has no mail left to match, and it is indistinguishable
    // from "no mail" unless it is said out loud.
    if (ids.length >= FULL_FETCH_CEILING) {
      report.notes.push(
        `The window holds at least ${FULL_FETCH_CEILING} messages — the oldest were not read, so cards from those emails were skipped. Shorten the look-back.`
      );
    }

    if (onProgress) onProgress({ phase: "fetch", done: 0, total: ids.length });
    const fetched = await mapWithConcurrency(ids, FETCH_CONCURRENCY, async (id, index) => {
      try {
        return await Gmail.getMessage(settings, id);
      } catch (err) {
        if (!isAborted()) report.notes.push(`Could not read one message: ${err.message}`);
        return null;
      } finally {
        if (onProgress) onProgress({ phase: "fetch", done: index + 1, total: ids.length });
      }
    });
    if (isAborted()) return await stop("Stopped while reading your mail.");

    // Same relevance gate the full sync uses, so newsletters matched by a broad
    // window never reach the model or a card.
    const messages = fetched.filter(Boolean).filter(looksLikeApplicationMail);
    report.considered = messages.length;
    if (!messages.length) {
      report.ok = true;
      await writeReclassifyState(report);
      return report;
    }

    // Every eligible mail goes to AI — no cap. This is a deliberate, one-off
    // click, and capping it would leave exactly the backlog the user is trying
    // to fix half-checked. Batched, so it is one request per 15 emails.
    //
    // A whole window is now many more requests than a routine sync ever makes,
    // so the batches are paced. A free-tier key rate-limits within seconds of
    // back-to-back calls, and every one of those failures is a card left
    // unchecked. The pause costs a few seconds; the alternative costs the run.
    const aiFields = new Map();
    let firstAiError = "";
    if (onProgress) onProgress({ phase: "enrich", done: 0, total: messages.length });
    for (let start = 0; start < messages.length; start += AI_BATCH_SIZE) {
      if (isAborted()) break;
      if (start > 0) await new Promise((resolve) => setTimeout(resolve, AI_PACING_MS));
      const batch = messages.slice(start, start + AI_BATCH_SIZE);
      const locals = batch.map(parseLocally);
      // Split-and-retry on failure: a single too-large or rate-limited batch no
      // longer fails every email it held. Only an email that fails on its own is
      // counted, and the first real reason is kept — "0 enriched, 40 failed" with
      // no cause is unactionable, and the cause lives only in the exception.
      const enriched = await enrichBatchResilient(batch, locals, settings, (err) => {
        report.aiFailed += 1;
        if (!firstAiError) firstAiError = err && err.message ? err.message : String(err);
      });
      for (const [id, fields] of enriched) {
        aiFields.set(id, fields);
        report.aiEnriched += 1;
      }
      if (onProgress) {
        onProgress({ phase: "enrich", done: Math.min(start + AI_BATCH_SIZE, messages.length), total: messages.length });
      }
    }
    if (firstAiError) report.notes.push(`AI provider failed: ${firstAiError}`);

    // One proposal per card: the newest mail about that job wins, so an offer
    // that arrived after the applied confirmation is what the card ends up
    // reading. Mail AI never answered is left out entirely — falling back to the
    // local parse here would just re-apply the very guess being checked.
    //
    // Matching uses the AI's own title/company, not the local parse, and always
    // passes the message id. This matters because an imported card stores what
    // AI decided at import ("Acme Corp", corrected from the sender's "Talent
    // Acquisition Team"): matching against the local parse would fail to find
    // exactly the cards AI built. The id finds the card the mail created; the
    // loose title/company then finds follow-ups (an interview after the applied
    // confirmation) that arrived as separate messages.
    const proposals = new Map();
    for (const message of messages) {
      const fields = aiFields.get(message.id);
      if (!fields || isAiRejection(fields)) continue;
      const local = parseLocally(message);
      const index = Tracker.matchIndex(rows, {
        sourceEmailId: message.id,
        url: fields.url || local.url,
        title: fields.title || local.title,
        company: fields.company || local.company,
        matchLoose: true
      });
      if (index === -1) continue;
      const row = rows[index];
      const at = messageReceivedAt(message) || 0;
      const current = proposals.get(row.id);
      if (!current || at >= current.at) proposals.set(row.id, { row, message, fields, at });
    }
    report.matched = proposals.size;
    // Cards whose mail was not in the window at all (older than the look-back).
    // Counted so the panel can say so instead of silently reporting a short run.
    report.unmatched = report.rechecked - report.matched;

    let done = 0;
    if (onProgress) onProgress({ phase: "apply", done: 0, total: proposals.size });
    for (const { row, message, fields } of proposals.values()) {
      if (isAborted()) {
        return await stop(
          `Stopped — ${report.moved} card${report.moved === 1 ? "" : "s"} had been moved.`
        );
      }
      done += 1;
      if (onProgress) onProgress({ phase: "apply", done, total: proposals.size });

      const stage = Tracker.STATUSES.includes(fields.status) ? fields.status : "";
      const title = tidyField(fields.title, 120);
      const company = tidyField(fields.company, 80);

      const patch = {};
      if (stage && stage !== row.status) patch.status = stage;
      // Only a value AI actually produced replaces one on the card, so a model
      // that returned an empty title cannot blank a good one.
      if (title && title !== row.title) patch.title = title;
      if (company && company !== row.company) patch.company = company;

      if (!Object.keys(patch).length) {
        report.unchanged += 1;
        continue;
      }

      // A stage move carries the mail's own date, so "Applied this week" and the
      // rejection date stay honest after the card is re-staged.
      if (patch.status) patch.emailAt = messageReceivedAt(message);

      const saved = await Tracker.applyFields(row.id, patch);
      if (saved) {
        const at = rows.findIndex((item) => item.id === row.id);
        if (at >= 0) rows[at] = saved;
      }

      if (patch.status) report.moved += 1;
      else report.renamed += 1;
    }

    report.ok = true;
    await writeReclassifyState(report);
    if (onProgress) onProgress({ phase: "done", done: proposals.size, total: proposals.size });
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
  parseJsonArray,
  enrichWithAi,
  enrichBatchWithAi,
  buildExtractionPrompt,
  buildBatchExtractionPrompt,
  mergeAiFields,
  AI_BATCH_SIZE,
  AI_REJECT_STAGE,
  isAiRejection,
  buildQuery,
  buildWindowQuery,
  looksLikeApplicationMail,
  runSync,
  reclassifyWithAi,
  loadSettings,
  readSyncState,
  readSyncHistory: () =>
    typeof SchedulerState !== "undefined" && SchedulerState.readEmailHistory
      ? SchedulerState.readEmailHistory()
      : Promise.resolve([]),
  readReclassifyState,
  ledger: EmailLedger
};
