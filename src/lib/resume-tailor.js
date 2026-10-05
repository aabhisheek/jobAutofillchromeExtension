// ATS keyword matching + resume tailoring. Runs in the resume tab context
// (chrome-extension:// page, not a content script).
//
// Safety rule this whole file follows: we NEVER invent a claim that isn't
// already true of the candidate. "Matched" keywords are JD terms that exist
// somewhere in profile.json (skills / experience.technologies /
// projects.technologies) OR literally already in the resume text — those are
// safe to surface more prominently. "Missing" keywords are JD terms with no
// evidence anywhere in the profile — those are only ever shown to the user
// as a gap to consider, never auto-inserted into the resume. Same philosophy
// as draft.js's LLM drafting ("do not invent anything not present here").

// ---- Local keyword vocabulary (always available, no network/API key) ----
const LOCAL_TECH_KEYWORDS = [
  // languages
  "JavaScript", "TypeScript", "Java", "Python", "C++", "C#", "Go", "Golang", "Ruby", "PHP", "Kotlin", "Swift", "Rust", "Scala",
  // backend
  "Node.js", "Express.js", "Nest.js", "Spring Boot", "Spring Security", "Spring Data JPA", "Hibernate",
  "Django", "Flask", "FastAPI", "Laravel", "ASP.NET", "Mongoose",
  // frontend
  "React", "React.js", "Next.js", "Angular", "Vue.js", "Redux", "HTML", "CSS", "Tailwind CSS", "SASS",
  // databases
  "MongoDB", "PostgreSQL", "MySQL", "SQL", "NoSQL", "Redis", "Elasticsearch", "DynamoDB", "Oracle", "SQLite",
  // cloud/devops
  "AWS", "Azure", "GCP", "Docker", "Kubernetes", "CI/CD", "Jenkins", "Terraform", "Ansible", "Linux",
  // architecture/concepts
  "REST APIs", "RESTful APIs", "GraphQL", "Microservices", "JWT", "OAuth", "RBAC", "API Design",
  "System Design", "Design Patterns", "Data Structures", "Algorithms", "Object-Oriented Programming", "OOP",
  "Unit Testing", "Integration Testing", "TDD", "Agile", "Scrum", "Kanban",
  // tools
  "Git", "GitHub", "GitLab", "Postman", "Jira", "Webpack", "Babel", "VS Code", "Playwright", "Okta",
  // roles/quals
  "Full Stack", "Backend Developer", "Frontend Developer", "Software Engineer", "MERN", "MEAN"
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Boundary-aware "does phrase appear in text" check. Avoids \b because it
// doesn't behave for tokens containing "." or "+" (Node.js, C++).
function containsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const escaped = escapeRegex(phrase.trim());
  const re = new RegExp(String.raw`(^|[^a-zA-Z0-9])${escaped}($|[^a-zA-Z0-9])`, "i");
  return re.test(` ${text} `);
}

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item.trim());
    }
  }
  return out;
}

// Every real thing we know about the candidate — this is the "truth set"
// missing/matched is judged against, independent of what resume.tex happens
// to already say.
function buildTruthVocabulary(profile) {
  const terms = [];
  (profile.skills || []).forEach((s) => terms.push(s));
  (profile.experience || []).forEach((e) => (e.technologies || []).forEach((t) => terms.push(t)));
  (profile.projects || []).forEach((p) => (p.technologies || []).forEach((t) => terms.push(t)));
  return dedupeCaseInsensitive(terms);
}

// ---- Local (no-network) keyword extraction ----
// Vocabulary = curated tech dictionary ∪ everything in the candidate's own
// profile (so JD mentions of the candidate's specific stack are recognized
// even if not in the generic dictionary).
function extractKeywordsLocal(jdText, profile) {
  const vocabulary = dedupeCaseInsensitive([...LOCAL_TECH_KEYWORDS, ...buildTruthVocabulary(profile)]);
  return vocabulary.filter((term) => containsPhrase(jdText, term));
}

// ---- Optional LLM extraction (better recall on JD-specific phrasing) ----
// Only extracts terms FROM the JD text — never asked to talk about the
// candidate — so a bad/odd LLM response can at worst add noise to the
// "missing" list, never fabricate a resume claim.
function buildKeywordPrompt(jdText) {
  return [
    "Extract ATS (Applicant Tracking System) keywords from this job description:",
    "skills, tools, frameworks, languages, certifications, and key qualifications,",
    "using the exact wording/phrasing the job description uses.",
    "",
    "Job description:",
    jdText,
    "",
    'Respond with ONLY a JSON array of strings, e.g. ["Node.js","REST APIs","Agile"]. No prose, no markdown fences.'
  ].join("\n");
}

function parseKeywordJSON(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  return parsed.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

// Keyword extraction reuses the same provider catalog (and the same wire-format
// senders) as draft.js, so whichever keys are configured on the API Keys screen
// work here too — including Claude and the OpenAI-compatible vendors, which
// previously had no path into resume tailoring at all.
function extractKeywordsWith(provider, jdText, settings) {
  return sendProviderPrompt({
    provider,
    settings,
    prompt: buildKeywordPrompt(jdText),
    maxTokens: 500
  }).then(parseKeywordJSON);
}

// Single entry point. Providers are tried cheapest-first, in the catalog's order
// (free tiers ahead of paid ones). Always falls back to the local dictionary if
// the LLM is off, unconfigured, or every provider errors out — extraction never
// hard-fails.
async function extractKeywords(jdText, profile, settings) {
  const localResult = extractKeywordsLocal(jdText, profile);

  if (!(settings && settings.useLLM)) return localResult;

  const attempts = configuredProviders(settings).map((provider) => () => extractKeywordsWith(provider, jdText, settings));

  for (const attempt of attempts) {
    try {
      const llmResult = await attempt();
      // Union with the local pass so we never lose recall the dictionary
      // already had — LLM adds JD-specific phrasing on top.
      return dedupeCaseInsensitive([...llmResult, ...localResult]);
    } catch {
      // fall through to next provider, then to local
    }
  }

  return localResult;
}

// ---- Matching JD keywords against the candidate's real background ----
function analyzeMatch(jdKeywords, profile) {
  const truth = buildTruthVocabulary(profile);
  const matched = [];
  const missing = [];

  jdKeywords.forEach((kw) => {
    const isTrue = truth.some((t) => t.toLowerCase() === kw.toLowerCase()) || containsPhrase(truth.join(" | "), kw);
    (isTrue ? matched : missing).push(kw);
  });

  return { matched: dedupeCaseInsensitive(matched), missing: dedupeCaseInsensitive(missing) };
}

// ---- Tailoring: append a visible, ATS-scannable line of matched JD ----
// terms that are true but not already literally worded in the resume.
// Never touches Experience/Projects bullets, never adds unverified claims.

// Shared so the Tailor page can highlight the exact block this inserts in both
// the rendered preview and the source diff.
const ADDED_KEYWORDS_LABEL = "Additional Relevant Keywords";

function tailorResumeTex(resumeText, matched) {
  const alreadyPresent = new Set(matched.filter((kw) => containsPhrase(resumeText, kw)).map((k) => k.toLowerCase()));
  const toAdd = matched.filter((kw) => !alreadyPresent.has(kw.toLowerCase()));

  if (toAdd.length === 0) {
    return { tailoredText: resumeText, addedKeywords: [] };
  }

  const newLine = `\\textbf{${ADDED_KEYWORDS_LABEL}:} ${toAdd.join(", ")}`;
  const skillsHeading = /\\section\*\{Technical Skills\}/;

  if (!skillsHeading.test(resumeText)) {
    // No Technical Skills section found — append one just before \end{document}.
    const tailoredText = resumeText.replace(
      /\\end\{document\}/,
      `\n% -------------------- Additional Keywords --------------------\n\\section*{Technical Skills}\n${newLine}\n\n\\end{document}`
    );
    return { tailoredText, addedKeywords: toAdd };
  }

  // Insert the new line right after the Technical Skills section's last
  // existing content line, before the next \section* or \end{document}.
  const sectionStart = resumeText.search(skillsHeading);
  const rest = resumeText.slice(sectionStart);
  const nextBoundaryMatch = rest.slice(1).search(/\\section\*\{|\\end\{document\}/);
  const sectionEnd = nextBoundaryMatch === -1 ? resumeText.length : sectionStart + 1 + nextBoundaryMatch;

  const before = resumeText.slice(0, sectionEnd).replace(/\s*$/, "");
  const after = resumeText.slice(sectionEnd);
  const tailoredText = `${before} \\\\\n${newLine}\n${after}`;

  return { tailoredText, addedKeywords: toAdd };
}

// Full pipeline used by resume.js.
async function buildTailoredResume(resumeText, jdText, profile, settings) {
  const jdKeywords = await extractKeywords(jdText, profile, settings);
  const { matched, missing } = analyzeMatch(jdKeywords, profile);
  const { tailoredText, addedKeywords } = tailorResumeTex(resumeText, matched);

  return {
    originalText: resumeText,
    tailoredText,
    jdKeywords,
    matched,
    missing,
    addedKeywords
  };
}
