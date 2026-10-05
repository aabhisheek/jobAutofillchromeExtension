// Test data shaped like what the extension actually meets: profile records with
// the fields a real candidate fills in, and scanned-field rows in the exact shape
// page-scripts.js's scanFormFields() emits.
//
// The scanned-row fixtures matter more than they look. matchFields() is a pure
// function over these objects, so if its contract drifts, every downstream row —
// the review UI, the filler, the learned-rule filing — drifts with it, and none of
// it is reachable from a unit test that invents its own row shape.

/** A complete, realistic profile. Override anything with the second argument. */
export function makeProfile(overrides = {}) {
  const base = {
    personal: {
      firstName: "Abhishek",
      lastName: "Anand",
      fullName: "Abhishek Anand",
      email: "abhishek.anand@example.com",
      phone: "+91 98765 43210",
      address: "221B Baker Street",
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      zip: "560001"
    },
    links: {
      linkedin: "https://linkedin.com/in/abhishekanand",
      github: "https://github.com/abhishekanand",
      portfolio: "https://abhishekanand.dev"
    },
    education: [
      {
        degree: "B.Tech",
        field: "Computer Science",
        institution: "Anna University",
        startDate: "2019-08-01",
        endDate: "2023-05-31",
        gpa: "8.7"
      }
    ],
    experience: [
      {
        company: "Acme Corp",
        title: "Senior Software Engineer",
        startDate: "2023-08-01",
        endDate: "",
        current: true,
        technologies: ["Node.js", "React", "PostgreSQL"],
        description: "Built internal tooling."
      }
    ],
    projects: [{ name: "Job Autofill", technologies: ["Vue.js", "TypeScript"], description: "" }],
    skills: ["JavaScript", "TypeScript", "Python", "Node.js", "React", "SQL"],
    answers: {
      workAuthorization: "Yes",
      requiresSponsorship: "No",
      noticePeriod: "30 days",
      currentSalary: "1800000",
      expectedSalary: "2400000",
      salaryExpectation: "",
      willingToRelocate: "Yes",
      previouslyEmployed: "No",
      familyMembersAtCompany: "No",
      hasNonCompete: "No",
      restrictedCountryCitizenship: "No",
      otherCountryResidency: "No",
      exportControlConsent: "",
      veteranStatus: "I am not a protected veteran",
      disabilityStatus: "No",
      gender: "Male",
      race: "Asian",
      howDidYouHear: "LinkedIn"
    }
  };
  return deepMerge(base, overrides);
}

/** The shape mergeSettings/DEFAULT_SETTINGS produces, with the AI side switched on. */
export function makeSettings(overrides = {}) {
  return deepMerge(
    {
      useLLM: true,
      groqApiKey: "test-groq-key",
      groqModel: "openai/gpt-oss-120b",
      resumePdfPath: "src/data/resume.pdf",
      resumeTexPath: "src/data/resume.tex",
      contextFilePath: "src/data/context.md",
      theme: "system",
      analyticsEnabled: false,
      mixpanelToken: "",
      emailSyncEnabled: false,
      emailUseAi: false,
      emailMaxAiPerRun: 20,
      emailLookbackDays: 30,
      emailSyncTime: "09:00",
      gmailClientId: "test-client-id.apps.googleusercontent.com"
    },
    overrides
  );
}

let uidCounter = 0;

/** A scanned text input, exactly as scanFormFields() describes one. */
export function textField(label, extra = {}) {
  return {
    uid: `u${++uidCounter}`,
    label,
    tagName: "input",
    inputType: "text",
    options: [],
    ...extra
  };
}

/** A scanned <select>. */
export function selectField(label, options, extra = {}) {
  return {
    uid: `u${++uidCounter}`,
    label,
    tagName: "select",
    inputType: "select-one",
    options: (Array.isArray(options) ? options : []).map((o) =>
      typeof o === "string" ? { text: o, value: o } : o
    ),
    ...extra
  };
}

/**
 * A scanned ARIA choice group ([role=radiogroup] on Workday/Google Forms),
 * which is what the matcher treats as a "choice group" rather than a control.
 */
export function choiceGroup(label, options, extra = {}) {
  return {
    uid: `u${++uidCounter}`,
    label,
    tagName: "radiogroup",
    inputType: "",
    options: (Array.isArray(options) ? options : []).map((o) =>
      typeof o === "string" ? { text: o, value: o } : o
    ),
    ...extra
  };
}

/** A scanned textarea. */
export function textareaField(label, extra = {}) {
  return textField(label, { tagName: "textarea", ...extra });
}

/** A scanned file input the scanner already recognized as a resume/CV upload. */
export function fileField(label, extra = {}) {
  return textField(label, { inputType: "file", ...extra });
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!isPlainObject(patch)) return patch;
  const out = Array.isArray(base) ? [] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out && isPlainObject(out[key]) && isPlainObject(value)
      ? deepMerge(out[key], value)
      : deepMerge(undefined, value);
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
