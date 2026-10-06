// Shared profile schema + field-matching dictionary.
// Loaded as a plain script (no modules) so both popup.js and options.js can use
// the globals DEFAULT_PROFILE and FIELD_DICTIONARY.

const DEFAULT_PROFILE = {
  personal: {
    firstName: "",
    lastName: "",
    // Kept separate from first + last because a great many forms ask for one
    // "Full Name" box. Mapping that to firstName would type "Abhishek" where the
    // form wants "Abhishek Anand", which reads as a typo to a recruiter.
    fullName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    country: "",
    zip: ""
  },
  links: {
    linkedin: "",
    github: "",
    portfolio: ""
  },
  education: [
    {
      degree: "",
      field: "",
      institution: "",
      startDate: "",
      endDate: "",
      gpa: ""
    }
  ],
  experience: [
    {
      company: "",
      title: "",
      startDate: "",
      endDate: "",
      current: false,
      technologies: [],
      description: ""
    }
  ],
  projects: [
    {
      name: "",
      technologies: [],
      description: ""
    }
  ],
  skills: [],
  // Sensitive / EEO / logistics answers. Filled ONLY from here, never guessed.
  // Leave a value as "" to force the extension to flag it "unmatched" instead
  // of guessing.
  //
  // A value may be a string, or an ARRAY of strings when the same question
  // is worded differently across ATS platforms. The first entry is what the
  // popup shows and edits; the rest are extra option texts the filler will
  // also accept, so one answer can satisfy both
  // <select>Authorized to work</select> and a Yes/No combobox asking
  // "Are you legally authorized to work for our company in the location which
  // you applied?" without guessing or hardcoding a per-platform mapping.
  // See acceptedValues in matcher.js and matchOption in page-scripts.js.
  answers: {
    workAuthorization: "",
    requiresSponsorship: "",
    noticePeriod: "",
    currentSalary: "",
    expectedSalary: "",
    salaryExpectation: "", // generic fallback, used only when a form asks one plain "salary expectation" question instead of splitting current/expected
    willingToRelocate: "",
    previouslyEmployed: "",
    familyMembersAtCompany: "",
    hasNonCompete: "",
    restrictedCountryCitizenship: "",
    otherCountryResidency: "",
    // Workday's export-control consent. Left blank by default: consent is a
    // legal acknowledgement and must be given deliberately, never filled in on
    // the user's behalf by a default. Set it in your profile once you have
    // read the terms.
    exportControlConsent: "",
    veteranStatus: "",
    disabilityStatus: "",
    gender: "",
    race: "",
    // Workday hierarchy paths use `Parent > Child`, for example
    // "Social Media > LinkedIn". Plain strings still work on ordinary selects.
    howDidYouHear: ""
  }
};

// Each entry: profile path -> list of substrings matched against the
// normalized (lowercased, punctuation-stripped) field label.
// Order matters when labels could match multiple keys: more specific
// phrases are listed for the more specific key.
//
// An entry may also carry `exact`: phrases that only match when they are the
// *whole* label. It exists for the labels that are only safe to read that way —
// see personal.fullName's "name". `exact` is tested before any `phrases`, so it
// is read as "this label, and nothing else". Adding a bare noun to `phrases`
// instead would capture every compound label that ends in it, which is how
// "name" would end up typing the candidate's name into an Employer Name box.
//
// `aliases: true` means an array at this path is a list of alternate wordings
// for one answer rather than a multi-value answer — see the `answers` comment
// below.
//
// The first block is deliberately the long, highly specific ATS question
// wordings. They have to be tested before the generic entries below, because
// they *contain* generic words: "Do you currently hold permanent residence or
// citizenship in another country?" contains "country" (personal.country ->
// "India") and "citizenship", and would otherwise be answered "India".
const FIELD_DICTIONARY = [
  { path: "answers.restrictedCountryCitizenship", sensitive: true, phrases: ["held citizenship in any of the countries", "citizenship in any of the countries listed", "citizenship of any of the countries listed"] },
  { path: "answers.otherCountryResidency", sensitive: true, phrases: ["permanent residence or citizenship in another country", "permanent residence in another country", "residency in another country", "permanent residence or citizenship"] },
  { path: "answers.familyMembersAtCompany", sensitive: true, phrases: ["family members that currently work", "family members currently work", "family members who currently work", "family members that work", "relatives currently work"] },
  { path: "answers.hasNonCompete", sensitive: true, phrases: ["non-compete", "noncompete", "non compete"] },
  // Workday's export-control questionnaire ends with an explicit consent
  // acknowledgement. Phrased as a statement rather than a yes/no question, so
  // it needs its own entry — and it deliberately sits above the generic
  // "terms"/"consent" wording below so it can't be captured by that instead.
  { path: "answers.exportControlConsent", sensitive: true, phrases: ["read and consent to the terms and conditions", "consent to the terms and conditions", "read and agree to the terms and conditions", "export control"] },
  // Ahead of the first/last-name entries below: "Full Name" contains neither
  // "first name" nor "last name", so this can't shadow them, but a form asking
  // for both a full name and a first name must resolve to whichever it actually
  // asked for.
  // "name" is deliberately absent from phrases and present in `exact` instead.
  // A form whose only label is "Name" means the candidate's name — that is what
  // the box is for — but the word appears inside plenty of labels that mean
  // something else entirely, and this dictionary matches phrases anywhere inside
  // a label. Read whole, it fixes "Name" and "Name *"; read as a substring it
  // would type the candidate's name into "Preferred Name", "Maiden Name",
  // "Project Name" and "Employer Name". Compounds that do have their own entry
  // ("company name", "employer") are unaffected either way — they are matched by
  // that entry, and this one is only consulted when nothing else claims the label.
  { path: "personal.fullName", sensitive: false, exact: ["name"], phrases: ["full name", "full legal name", "name as per your", "candidate name", "applicant name"] },
  { path: "personal.firstName", sensitive: false, phrases: ["first name", "given name", "legal first name"] },
  { path: "personal.lastName", sensitive: false, phrases: ["last name", "family name", "surname", "legal last name"] },
  // "mail id" / "email id" are how the same field is labelled across Indian
  // forms, which favour the local spelling over "Email".
  { path: "personal.email", sensitive: false, phrases: ["email", "e mail", "mail id", "email id", "email address"] },
  // A dial-code select beside the phone number is a country question wearing
  // a different label: it wants "India" (or its "+91", see acceptedValues in
  // matcher.js), not the number itself. The entry sits above personal.phone
  // because "Phone country code" contains "phone" and would otherwise resolve
  // to the number — the same ordering reason the long ATS questions sit at the
  // top of this array.
  { path: "personal.country", sensitive: false, phrases: ["country", "country code", "dial code", "isd code"] },
  // "contact no" abbreviates "contact number", which whole-word matching cannot
  // see through — "contact no" is not the phrase "contact number".
  { path: "personal.phone", sensitive: false, phrases: ["phone", "mobile", "contact number", "contact no", "telephone"] },
  { path: "personal.address", sensitive: false, phrases: ["address line", "street address", "address"] },
  { path: "personal.city", sensitive: false, phrases: ["city", "town"] },
  { path: "personal.state", sensitive: false, phrases: ["state", "province", "region"] },
  { path: "personal.zip", sensitive: false, phrases: ["zip", "postal code"] },
  { path: "links.linkedin", sensitive: false, phrases: ["linkedin"] },
  { path: "links.github", sensitive: false, phrases: ["github"] },
  { path: "links.portfolio", sensitive: false, phrases: ["portfolio", "website", "personal site"] },
  { path: "education.0.institution", sensitive: false, phrases: ["university", "school", "institution", "college"] },
  // `aliases: true` lets this entry hold a LIST of accepted texts instead of a
  // single string. The first entry is what free-text fields get; the others are
  // alternative wordings the filler will also accept, which is what a fixed
  // option dropdown requires. Workday's "Degree" is a select offering
  // "Bachelor's Degree" and never "B.Tech", so the same entry has to satisfy
  // both that dropdown and any plain text input elsewhere.
  // See the `answers` comment above, and acceptedValues in matcher.js.
  { path: "education.0.degree", sensitive: false, aliases: true, phrases: ["degree", "level of education", "education level", "highest education", "highest qualification", "academic qualification"] },
  { path: "education.0.field", sensitive: false, phrases: ["field of study", "major", "discipline"] },
  // "current company" is the same field as "current employer"; whole-word
  // matching can't bridge the two spellings on its own.
  { path: "experience.0.company", sensitive: false, phrases: ["most recent employer", "current employer", "current company", "company name", "employer", "present employer"] },
  { path: "experience.0.title", sensitive: false, phrases: ["job title", "current title", "title", "position"] },
  { path: "skills", sensitive: false, phrases: ["skills", "technical skills"] },
  // Sensitive / logistics — matched from answers only, always flagged for review.
  { path: "answers.requiresSponsorship", sensitive: true, phrases: ["require sponsorship", "visa sponsorship", "sponsorship"] },
  { path: "answers.workAuthorization", sensitive: true, phrases: ["authorized to work", "work authorization", "legally authorized"] },
  { path: "answers.noticePeriod", sensitive: true, phrases: ["notice period", "availability", "start date availability", "preferred start date", "desired start date"] },
  { path: "answers.currentSalary", sensitive: true, phrases: ["current salary", "current ctc", "present salary", "current compensation"] },
  { path: "answers.expectedSalary", sensitive: true, phrases: ["expected salary", "expected ctc", "desired salary", "desired ctc"] },
  { path: "answers.salaryExpectation", sensitive: true, phrases: ["salary expectation", "compensation expectation"] },
  { path: "answers.willingToRelocate", sensitive: true, phrases: ["willing to relocate", "relocation"] },
  { path: "answers.previouslyEmployed", sensitive: true, phrases: ["previously employed with us", "previously employed", "prior employment", "former employee"] },
  { path: "answers.veteranStatus", sensitive: true, phrases: ["veteran"] },
  { path: "answers.disabilityStatus", sensitive: true, phrases: ["disability"] },
  { path: "answers.gender", sensitive: true, phrases: ["gender"] },
  { path: "answers.race", sensitive: true, phrases: ["race", "ethnicity"] },
  { path: "answers.howDidYouHear", sensitive: false, phrases: ["how did you hear", "referral source"] }
];

const DEFAULT_SETTINGS = {
  useLLM: false,
  // ---- AI provider keys ----
  //
  // One key + one model per provider, and the ids/names/defaults all match the
  // entries in src/lib/providers.js — that catalog is what the API Keys screen
  // renders and what draft.js walks, so these fields are just its storage.
  //
  // They exist here (rather than being invented on read) because mergeSettings
  // only honours a stored override for a key it recognises, and the keys screen
  // reads/writes by name.
  //
  // Edit real values in src/data/settings.json, NOT here — see mergeSettings.
  // Free tier / fast:
  groqApiKey: "",
  groqModel: "openai/gpt-oss-120b",
  geminiApiKey: "",
  geminiModel: "gemini-flash-latest",
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
  openrouterApiKey: "",
  openrouterModel: "anthropic/claude-3.5-sonnet",
  togetherApiKey: "",
  togetherModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  mistralApiKey: "",
  mistralModel: "mistral-small-latest",
  xaiApiKey: "",
  xaiModel: "grok-2-latest",
  // Self-hosted / OpenAI-compatible (Ollama, LM Studio, vLLM). The key is
  // genuinely allowed to be blank here — a local server usually needs none —
  // which is also why this provider is keyed off customEndpoint rather than off
  // the presence of a key.
  customApiKey: "",
  customModel: "llama3.1",
  customEndpoint: "",
  // Paid, tried last as the safety net:
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  anthropicApiKey: "",
  anthropicModel: "claude-opus-4-7",
  // Candidate's custom context and instructions passed to AI models when drafting.
  // Edited on the API Keys screen and in the popup, and persists across sessions.
  draftContext: "",
  // Mixpanel product analytics. The token is a project's public write-only
  // token (the same one a website ships in its page source), not a secret —
  // it can only write events, never read them. Analytics stay dormant until
  // one is set: src/background.js queues nothing it can't deliver.
  analyticsEnabled: true,
  mixpanelToken: "",
  // Appearance: "system" | "light" | "dark". Owned by src/lib/theme.js, which
  // sets data-theme on <html>; theme.css resolves its light-dark() tokens
  // against the resulting color-scheme. Listed here so mergeSettings keeps it
  // (it only honours stored values for keys it knows) alongside every other
  // persisted preference.
  theme: "system",
  // ---- Where the compiled resume PDF lives ----
  //
  // Edit this in src/data/settings.json, NOT here. mergeSettings() spreads the
  // bundled settings file over these defaults, so a real value in settings.json
  // always wins over whatever sits in this object — putting the path here too
  // would just be a second, silently-shadowed place to look in.
  //
  // Kept as a key (with an empty value) rather than dropped, because
  // mergeSettings only honours stored/Options overrides for keys that exist
  // here, and "" counts as "unset" — so an empty default lets settings.json
  // supply the value without fighting it.
  //
  // The value must be a path *inside the extension*, not an absolute path on
  // your disk: an MV3 extension can only read the files it ships with (via
  // chrome.runtime.getURL), so "/Users/you/Desktop/resume.pdf" cannot work no
  // matter how it's spelled.
  //
  // There is deliberately NO fallback constant here. A hardcoded second path
  // would be a second place to edit, and a wrong one is worse than an honest
  // error: an empty value reports "set resumePdfPath in src/data/settings.json"
  // instead of silently reading whichever file the code happened to name.
  resumePdfPath: "",
  // Same deal for the LaTeX source the Resume page tailors. Grouped here so
  // one file — src/data/settings.json — is the only place either resume file
  // is pointed at.
  resumeTexPath: "",
  // A plain-text file inside the extension whose ENTIRE contents are sent as
  // context to the AI drafter, alongside draftContext above. It exists because
  // draftContext is a single-line textarea: long-form standing notes (target
  // roles, tone rules, answers you keep retyping) don't fit in it, and an MV3
  // extension cannot write to its own bundled files — so a real file on disk is
  // the only place that content can live.
  //
  // Same rules as resumePdfPath above: edit the path in src/data/settings.json,
  // not here, and it must point inside the extension folder.
  //
  // Left unset in settings.json's absence? No — this one ships with a real
  // default value there, because an empty path would mean the file silently
  // never reaches the model.
  contextFilePath: "",

  // ---- Email import (Gmail) ----
  //
  // Reads application-confirmation emails and turns them into rows on the
  // dashboard board, so "Applied this week" counts things you applied to
// without pressing Track Job. Owned by src/lib/mail-import.js, driven by a
  // chrome.alarms schedule from src/background.js, configured from the
  // dashboard's "Import from Gmail" panel.
  //
  // gmailClientId is Google's OAuth *client* id for this extension, not the
  // user's id: a public client from console.cloud.google.com with type
  // "Chrome Extension". It is not a secret and it is the one field that has to
  // be copied from a Google Cloud project before anything else here can run.
  gmailClientId: "",
  // Only needed by Google Cloud "Web application" client ids, whose token
  // endpoint rejects the exchange with `client_secret is missing`. A
  // "Chrome Extension" client id has no secret and leaves this blank.
  //
  // Treat it as a public value, which is Google's own position for installed
  // apps: "…you embed in the source code of your application. (In this context,
  // the client secret is obviously not treated as a secret.)" It is kept in
  // chrome.storage.local so it never reaches this repository, which is public.
  gmailClientSecret: "",
  // The Gmail search the daily sync runs. A raw Gmail query, so the user can
  // tune it to the exact phrasing their target employers send. The default
  // covers the phrasing that actually shows up in confirmation mails across
  // Greenhouse / Lever / Workday / Ashby / SuccessFactors. The {…} braces are
  // Gmail's OR grouping.
  // Kept as a literal here rather than referencing MailImport.DEFAULT_QUERY
  // because schema.js is loaded first and by pages that have no reason to pull
  // in the importer. The two are kept identical by hand; buildQuery() also adds
  // its own date floor, so this string is about which phrases match, not about
  // how far back the search reaches.
  emailSyncQuery:
    'newer_than:30d {"application received" "application submitted" "we have received your application" "thank you for applying" "we received your application"}',
  // Wall-clock time for the daily run, "HH:MM" in the machine's local zone.
  // Chrome alarms only fire while the browser is running; an alarm that was
  // missed is not replayed, which is why the panel also offers Sync now.
  emailSyncTime: "09:00",
  // How often the background check runs: "1h", "2h" or "daily" (at the
  // emailSyncTime above, which also anchors the interval schedules' first
  // run). Every-hour is cheap — a check with nothing new in it makes zero AI
  // calls, and the ledger means only genuinely new messages are ever read.
  emailSyncEvery: "2h",
  // On by default once the extension is installed: the daily check, the
  // startup catch-up and the dashboard's own check all read this, and each of
  // them is inert until Gmail is connected — which is the deliberate grant
  // (an OAuth consent click), not this flag. The panel's checkbox turns the
  // background schedule off without giving up the connection.
  emailSyncEnabled: true,
  // Let the configured AI provider turn the subject / sender / snippet into a
  // clean {title, company, status}. Off falls back to the purely local parse,
  // which is free and never leaves the machine.
  emailUseAi: true,
  // Ceiling on AI calls per sync, because every parsed email is one billable
  // request and a large backlog would otherwise spend real money unattended.
  // Anything over the cap is still imported — just with the local parse.
  emailMaxAiPerRun: 20,
  // How many days of mail a sync looks at. The query's own newer_than: term is
  // the real bound; this is the belt-and-braces one, and it also stops a
  // hand-edited query that dropped its date filter from importing a decade.
  emailLookbackDays: 30,

  // ---- job discovery -------------------------------------------------
  // The roles the user wants to be found. Each one becomes a jobs search on
  // LinkedIn (and other boards), and the results are scored against the
  // profile before the best few land on the board. Empty means "fall back to
  // the titles in the profile's experience", so the feature works before
  // anyone fills in a single field.
  discoverRoles: [],
  // Optional location filter for those searches, "Bangalore, India" style.
  // Empty searches everywhere the board defaults to.
  discoverLocations: "",
  // How many matched jobs a run may put on the board. 20 is a day's worth of
  // triage; a bigger number is a longer list to scroll, not more applications.
  discoverMaxJobs: 20,
  // Run automatically when the dashboard opens — throttled to once every
  // AUTO_INTERVAL so a frequently-reopened board does not hammer job sites
  // with tabs. The button runs regardless.
  discoverAuto: true,
  // Score the shortlist chance with the configured AI provider when there is
  // one. Off (or unconfigured) still yields the local match score and stars;
  // this only replaces the "chance of shortlist" number and adds reasons.
  discoverUseAi: true
};

// Extensions accepted for the bundled context file. Plain text only: the
// contents are concatenated straight into the prompt, so a JSON file would
// only work by accident.
const CONTEXT_FILE_EXTENSIONS = [".md", ".txt", ".markdown"];

// src/data/settings.json is the base default; whatever's saved in
// chrome.storage.local (from the Options page) overrides it field-by-field —
// an override only "counts" for a field if it's non-empty, so editing the
// bundled file always takes effect for any field you haven't explicitly set
// via the UI, instead of one saved settings record shadowing the whole file.
// Note only "" is treated as unset, so a `false` override (e.g. turning
// analyticsEnabled off) correctly wins over a bundled `true`.
function mergeSettings(bundled, override) {
  const merged = { ...DEFAULT_SETTINGS, ...bundled };
  if (!override) return merged;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = override[key];
    if (value !== undefined) {
      if (key === "draftContext") {
        merged[key] = value;
      } else if (value !== "") {
        merged[key] = value;
      }
    }
  }
  return merged;
}


// ============================================================
// RESUME PDF RESOLUTION — single source of truth
// ============================================================
//
// Both the popup (which attaches the PDF to a resume-upload field) and the
// Resume page (which reports what will be attached) need to answer "which PDF
// is this?", so the answer is defined once, here, rather than being fetched
// twice in two places that then drift apart.
//
// Precedence:
//   1. A PDF uploaded through the Resume page's "Compiled PDF" input, held in
//      chrome.storage.local. User intent always beats a bundled file.
//   2. settings.resumePdfPath in src/data/settings.json — the single line to
//      edit when swapping resumes. Nothing else names a PDF.
//
// Lives in schema.js rather than in either caller because schema.js is the one
// script all three extension pages (popup, resume, options) already load.
// ============================================================

// Why a configured path can't be used, or null when it is fine. Returns a
// sentence rather than a bare boolean because the whole point is to be shown to
// the user: a typo in resumePdfPath has to say what was wrong with it, not
// silently leave the Fill button disabled.
//
// `key` is the settings.json key to name in the message, and `extensions` the
// file types that make sense for that slot — so the same rules serve both the
// PDF and the LaTeX source without either growing its own copy.
function bundledPathProblem(path, key, extensions) {

  const extList = extensions.join(" / ");

  // A valid example for *this* slot, so a .tex mistake is never answered with
  // a .pdf example.
  const example = `src/data/resume${extensions[0]}`;

  if (typeof path !== "string" || !path.trim()) {
    return `no path configured (set ${key} in src/data/settings.json)`;
  }

  const p = path.trim();

  // An absolute filesystem path is the mistake worth naming explicitly: people
  // paste one out of habit, and chrome.runtime.getURL would turn it into a
  // nonsense extension URL that 404s with no explanation.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[a-z]:[\\/]/i.test(p)) {
    return `"${p}" is a URL or an absolute path — it must point at a file inside this extension folder, e.g. "${example}"`;
  }

  if (p.startsWith("/") || p.startsWith("\\")) {
    return `"${p}" is an absolute path — use a path relative to the extension root, e.g. "${example}"`;
  }

  // ".." would let the resolved URL climb out of the extension's own directory.
  if (p.split(/[\\/]/).includes("..")) {
    return `"${p}" must not contain ".."`;
  }

  // The PDF is attached with a hardcoded application/pdf MIME type and the .tex
  // is fed to the tailorer as LaTeX, so a mismatched extension would be read as
  // the wrong format entirely.
  if (!extensions.some((ext) => p.toLowerCase().endsWith(ext))) {
    return `"${p}" is not a ${extList} file`;
  }

  return null;
}

// Resolves a configured bundled-file path to a fetchable extension URL.
// Returns { url, path, error } — the error is a sentence ready to display, so
// a bad settings.json value is reported where the user can act on it.
function bundledFileUrl(path, key, extensions) {
  const problem = bundledPathProblem(path, key, extensions);
  if (problem) {
    return { url: null, path: "", error: problem };
  }

  const clean = path.trim();

  return {
    url: chrome.runtime.getURL(clean),
    path: clean,
    error: null
  };
}

function bundledFileBasename(path) {
  return path.trim().split(/[\\/]/).pop();
}

// Resolves the resume PDF record: { base64, filename, mimeType, size,
// savedAt }, where savedAt === null means "came from the configured file"
// rather than "uploaded by the user". Both callers key their UI off that.
//
// Returns { pdf, source, error } rather than a bare record so a bad
// resumePdfPath can be reported instead of looking identical to "no resume
// saved yet" — with only a record to go on, those two are indistinguishable.
//
// Never throws: a missing or unreadable PDF is a normal state, not an error.
async function loadResumePdf(settings) {

  // 1. An uploaded PDF always wins.
  try {
    const { resumePdf } = await chrome.storage.local.get("resumePdf");
    if (resumePdf && resumePdf.base64) {
      return { pdf: resumePdf, source: "upload", error: null };
    }
  } catch {
    // Storage unavailable — fall through to the configured file.
  }

  // 2. The configured file inside the extension. No fallback: an unset key is
  // reported rather than silently replaced by a hardcoded path.
  const path = (settings && settings.resumePdfPath) || "";

  const resolved = bundledFileUrl(path, "resumePdfPath", [".pdf"]);

  if (resolved.error) {
    return { pdf: null, source: "file", error: resolved.error };
  }

  try {
    const res = await fetch(resolved.url);
    if (!res.ok) {
      return {
        pdf: null,
        source: "file",
        error: `could not read "${resolved.path}" from the extension (HTTP ${res.status}) — is the file actually there?`
      };
    }

    const buffer = await res.arrayBuffer();

    if (!buffer.byteLength) {
      return { pdf: null, source: "file", error: `"${resolved.path}" is empty (0 bytes)` };
    }

    return {
      pdf: {
        base64: arrayBufferToBase64(buffer),
        // The real file name, so a resume called "2026-10.pdf" shows up under
        // its own name in the popup instead of a hardcoded "resume.pdf".
        filename: bundledFileBasename(resolved.path),
        mimeType: "application/pdf",
        size: buffer.byteLength,
        savedAt: null
      },
      source: "file",
      error: null
    };
  } catch {
    return { pdf: null, source: "file", error: `could not read "${resolved.path}" from the extension` };
  }
}

// Shared binary -> base64. Lived in both popup.js and resume.js before; one
// copy here means the two can't drift.
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// The inverse, for reading a stored resume PDF back as bytes (PDF in, LaTeX out).
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}


// ============================================================
// BUNDLED CONTEXT FILE — the long-form half of the AI context
// ============================================================
//
// Two sources feed the model's context today: settings.draftContext (the popup's
// textarea, short and per-application) and one plain-text file inside the
// extension (settings.contextFilePath, long and standing). Both are needed
// because an MV3 extension can read its own package but cannot write to it, so
// anything worth keeping beyond one short box has to be a file on disk the user
// edits directly.
//
// Same shape as loadResumePdf — { text, path, error } — so an unset or
// mistyped path can be reported rather than looking identical to "you wrote no
// context".
async function loadBundledContext(settings) {
  const path = (settings && settings.contextFilePath) || "";

  const resolved = bundledFileUrl(path, "contextFilePath", CONTEXT_FILE_EXTENSIONS);
  if (resolved.error) {
    return { text: "", path: "", error: resolved.error };
  }

  try {
    const res = await fetch(resolved.url);
    if (!res.ok) {
      return {
        text: "",
        path: resolved.path,
        error: `could not read "${resolved.path}" from the extension (HTTP ${res.status}) — is the file actually there?`
      };
    }

    // Trimmed whole: a file of only whitespace is the same as no file, and
    // untrimmed content would smuggle indentation into the middle of a prompt.
    // Nothing here caps the length — the user decides how much goes over the
    // wire by how much they write.
    const text = (await res.text()).trim();
    return { text, path: resolved.path, error: null };
  } catch {
    return { text: "", path: resolved.path, error: `could not read "${resolved.path}" from the extension` };
  }
}

// Merges the two context sources into the single string draft.js sends.
//
// Order is deliberate: the file goes first and the popup's textarea last, so a
// per-application instruction ("this one needs a cover-letter tone") reads as
// the later, more specific word and wins over the standing brief. Labels keep
// the model from reading the popup box as a continuation of the file.
function buildDraftContext(typedContext, fileContext) {
  const typed = (typedContext || "").trim();
  const file = (fileContext && fileContext.text ? fileContext.text : "").trim();
  const filePath = (fileContext && fileContext.path) || "the bundled context file";

  const sections = [];
  if (file) sections.push(`FROM ${filePath}:\n${file}`);
  if (typed) sections.push(`FROM THE AI CONTEXT BOX IN THE POPUP:\n${typed}`);

  return sections.join("\n\n");
}
