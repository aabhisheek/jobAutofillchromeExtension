// AI fallback for fields the deterministic matcher can't handle (free-text
// essay-style questions left "unmatched"). Two modes, controlled by
// settings.useLLM:
//   - local template draft (default, no network call, no API key)
//   - LLM-generated draft (optional, requires an API key, off by default)
// Both are always inserted as an EDITABLE draft that still requires the
// include-checkbox to be ticked before Fill — never auto-included, and never
// used for sensitive/EEO fields regardless of mode.

const SENSITIVE_KEYWORDS = [
  "veteran",
  "disability",
  "race",
  "ethnicity",
  "gender",
  "sponsorship",
  "visa",
  "authorized to work",
  "sexual orientation",
  "pronoun",
  // Legal attestations / e-signatures ("I confirm...", "I certify...") — no
  // free-text draft makes sense here regardless of how the field is
  // rendered (checkbox, dropdown, or a "type your name" text input): these
  // need the candidate's own explicit confirmation, never invented text.
  "i confirm",
  "i certify",
  "i attest",
  "i acknowledge",
  "true and correct",
  "false statements",
  // Compensation — matcher.js's FIELD_DICTIONARY already treats every
  // salary/compensation path as sensitive (filled only from profile.answers,
  // never guessed); drafting free text for these would contradict that —
  // an LLM has no real salary figure to draw from and inventing one, or
  // hedging text in a number field, is worse than leaving it unmatched.
  "salary",
  "compensation",
  "total comp",
  "ctc",
  "pay expectation"
];

function isSensitiveLabel(label) {
  const normalized = normalizeLabel(label);
  return SENSITIVE_KEYWORDS.some((kw) => normalized.includes(kw));
}

// A row is a draft candidate if it's a free-text field (textarea, or a plain
// text/email-less single-line input) the dictionary couldn't match, and it
// isn't one of the sensitive topics above. Excludes select/radiogroup/combobox,
// which have a fixed set of options an AI draft can't fill in anyway —
// "combobox" catches custom dropdown widgets (react-select and similar) that
// are a text-like <input> under the hood but are still a constrained choice,
// not free text (see isComboboxLike in page-scripts.js).
const DRAFTABLE_TAGS = new Set(["textarea", "input"]);
const NON_DRAFTABLE_INPUT_TYPES = new Set(["email", "tel", "date", "number", "checkbox", "radio", "select", "combobox"]);

function isDraftCandidate(row) {
  if (row.status !== "unmatched" || isSensitiveLabel(row.label)) return false;
  if (row.tagName === "textarea") return true;
  if (row.tagName === "input" && !NON_DRAFTABLE_INPUT_TYPES.has(row.inputType)) return true;
  return false;
}

function pickPrimary(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

// ---- Local template draft (no network, no API key) ----
function generateLocalDraft(row, profile) {
  const normalized = normalizeLabel(row.label);
  const project = pickPrimary(profile.projects);
  const experience = pickPrimary(profile.experience);
  const skillsLine = (profile.skills || []).slice(0, 6).join(", ");

  if (/\bproject\b/.test(normalized) && project && project.name) {
    const tech = (project.technologies || []).join(", ");
    return [
      `In my project "${project.name}"${tech ? ` (built with ${tech})` : ""},`,
      project.description || ""
    ]
      .join(" ")
      .trim();
  }

  if (/(why|interest|motivat)/.test(normalized)) {
    const expPart = experience ? ` and my experience as ${experience.title} at ${experience.company}` : "";
    return `I'm interested in this role because it aligns with my background in ${skillsLine}${expPart}.`;
  }

  if (/(experience|background|about yourself|tell us about)/.test(normalized) && experience) {
    const tech = (experience.technologies || []).join(", ");
    const verb = experience.current ? "I currently work" : "I worked";
    return [`${verb} as ${experience.title} at ${experience.company}, focused on ${tech}.`, experience.description || ""]
      .join(" ")
      .trim();
  }

  if (experience) {
    return `${experience.title} at ${experience.company}, with hands-on experience in ${skillsLine}. ${experience.description || ""}`.trim();
  }

  return "";
}

// ---- Optional LLM draft ----
// Sends ONLY the fields relevant to drafting (skills/projects/experience) —
// never `answers` (sensitive/EEO data) — with an explicit instruction not to
// invent facts. Requires the relevant API key and host permission to already
// be granted (see options.js). Groq is tried first; if it fails (missing
// key, network error, non-2xx response), Gemini is tried as a fallback.
function buildLLMPrompt(row, profile) {
  const facts = {
    skills: profile.skills || [],
    projects: profile.projects || [],
    experience: profile.experience || [],
    education: profile.education || []
  };

  return [
    `Question from a job application form: "${row.label}"`,
    "",
    "Relevant facts about the candidate (JSON, use ONLY these — do not invent anything not present here):",
    JSON.stringify(facts, null, 2),
    "",
    "Write a concise, first-person draft answer (3-5 sentences max) using only the facts above.",
    "If the facts are insufficient to answer, say so plainly instead of guessing."
  ].join("\n");
}

async function generateGroqDraft(prompt, settings) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.groqApiKey}`
    },
    body: JSON.stringify({
      model: settings.groqModel || "openai/gpt-oss-120b",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("Groq response had no text content.");
  return text.trim();
}

async function generateGeminiDraft(prompt, settings) {
  const model = settings.geminiModel || "gemini-flash-latest";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
  if (!text) throw new Error("Gemini response had no text content.");
  return text.trim();
}

// Single entry point used by popup.js. Tries Groq first, falls back to
// Gemini if Groq is unavailable or errors out. Falls back further to the
// local template if neither key is configured (or both fail).
async function generateDraft(row, profile, settings) {
  if (!(settings && settings.useLLM)) {
    return { text: generateLocalDraft(row, profile), source: "template (AI drafts off)" };
  }

  const prompt = buildLLMPrompt(row, profile);
  const errors = [];

  if (settings.groqApiKey) {
    try {
      return { text: await generateGroqDraft(prompt, settings), source: "AI · Groq" };
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (settings.geminiApiKey) {
    try {
      return { text: await generateGeminiDraft(prompt, settings), source: "AI · Gemini" };
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length) {
    throw new Error(errors.join(" — then — "));
  }

  return { text: generateLocalDraft(row, profile), source: "template (no API key configured)" };
}
