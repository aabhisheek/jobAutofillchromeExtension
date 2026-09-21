// Shared profile schema + field-matching dictionary.
// Loaded as a plain script (no modules) so both popup.js and options.js can use
// the globals DEFAULT_PROFILE and FIELD_DICTIONARY.

const DEFAULT_PROFILE = {
  personal: {
    firstName: "",
    lastName: "",
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
  answers: {
    workAuthorization: "",
    requiresSponsorship: "",
    noticePeriod: "",
    currentSalary: "",
    expectedSalary: "",
    salaryExpectation: "", // generic fallback, used only when a form asks one plain "salary expectation" question instead of splitting current/expected
    willingToRelocate: "",
    veteranStatus: "",
    disabilityStatus: "",
    gender: "",
    race: "",
    howDidYouHear: ""
  }
};

// Each entry: profile path -> list of substrings matched against the
// normalized (lowercased, punctuation-stripped) field label.
// Order matters when labels could match multiple keys: more specific
// phrases are listed for the more specific key.
const FIELD_DICTIONARY = [
  { path: "personal.firstName", sensitive: false, phrases: ["first name", "given name", "legal first name"] },
  { path: "personal.lastName", sensitive: false, phrases: ["last name", "family name", "surname", "legal last name"] },
  { path: "personal.email", sensitive: false, phrases: ["email"] },
  { path: "personal.phone", sensitive: false, phrases: ["phone", "mobile", "contact number", "telephone"] },
  { path: "personal.address", sensitive: false, phrases: ["address line", "street address", "address"] },
  { path: "personal.city", sensitive: false, phrases: ["city", "town"] },
  { path: "personal.state", sensitive: false, phrases: ["state", "province", "region"] },
  { path: "personal.country", sensitive: false, phrases: ["country"] },
  { path: "personal.zip", sensitive: false, phrases: ["zip", "postal code"] },
  { path: "links.linkedin", sensitive: false, phrases: ["linkedin"] },
  { path: "links.github", sensitive: false, phrases: ["github"] },
  { path: "links.portfolio", sensitive: false, phrases: ["portfolio", "website", "personal site"] },
  { path: "education.0.institution", sensitive: false, phrases: ["university", "school", "institution", "college"] },
  { path: "education.0.degree", sensitive: false, phrases: ["degree", "level of education"] },
  { path: "education.0.field", sensitive: false, phrases: ["field of study", "major", "discipline"] },
  { path: "experience.0.company", sensitive: false, phrases: ["most recent employer", "current employer", "company name", "employer"] },
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
  { path: "answers.veteranStatus", sensitive: true, phrases: ["veteran"] },
  { path: "answers.disabilityStatus", sensitive: true, phrases: ["disability"] },
  { path: "answers.gender", sensitive: true, phrases: ["gender"] },
  { path: "answers.race", sensitive: true, phrases: ["race", "ethnicity"] },
  { path: "answers.howDidYouHear", sensitive: false, phrases: ["how did you hear", "referral source"] }
];

const DEFAULT_SETTINGS = {
  useLLM: false,
  groqApiKey: "",
  groqModel: "openai/gpt-oss-120b",
  geminiApiKey: "",
  geminiModel: "gemini-flash-latest",
  // Mixpanel product analytics. The token is a project's public write-only
  // token (the same one a website ships in its page source), not a secret —
  // it can only write events, never read them. Analytics stay dormant until
  // one is set: src/background.js queues nothing it can't deliver.
  analyticsEnabled: true,
  mixpanelToken: ""
};

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
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}
