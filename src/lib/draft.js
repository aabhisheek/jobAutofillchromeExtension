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
  // A choice group the dictionary couldn't resolve. The AI is asked to pick from
  // the options the form actually offers, so it can only ever answer with
  // something selectable — unlike free text, which it can decline with SKIP.
  if (row.tagName === "radiogroup" && Array.isArray(row.options) && row.options.length) return true;
  if (row.tagName === "textarea") return true;
  if (row.tagName === "input" && !NON_DRAFTABLE_INPUT_TYPES.has(row.inputType)) return true;
  return false;
}

function pickPrimary(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

// Local template draft (no network, no API key). Structured like the LLM path —
// a bare value rather than a paragraph — so switching providers on or off
// changes the quality of the fill, not the shape of what gets typed.
function generateLocalDraft(row, profile, customContext = "") {
  const normalized = normalizeLabel(row.label);
  const project = pickPrimary(profile.projects);
  const experience = pickPrimary(profile.experience);
  const skillsLine = (profile.skills || []).slice(0, 6).join(", ");
  const trimmed = (customContext || "").trim();

  let draft = "";
  if (/\bproject\b/.test(normalized) && project && project.name) {
    const tech = (project.technologies || []).join(", ");
    draft = [
      `In my project "${project.name}"${tech ? ` (built with ${tech})` : ""},`,
      project.description || ""
    ]
      .join(" ")
      .trim();
  } else if (/(why|interest|motivat)/.test(normalized)) {
    const expPart = experience ? ` and my experience as ${experience.title} at ${experience.company}` : "";
    draft = `I'm interested in this role because it aligns with my background in ${skillsLine}${expPart}.`;
  } else if (/(experience|background|about yourself|tell us about)/.test(normalized) && experience) {
    const tech = (experience.technologies || []).join(", ");
    const verb = experience.current ? "I currently work" : "I worked";
    draft = [`${verb} as ${experience.title} at ${experience.company}, focused on ${tech}.`, experience.description || ""]
      .join(" ")
      .trim();
  } else if (experience) {
    draft = `${experience.title} at ${experience.company}, with hands-on experience in ${skillsLine}. ${experience.description || ""}`.trim();
  }

  if (draft && trimmed) {
    return `${draft} ${trimmed}`.trim();
  }
  return draft || trimmed || "";
}

// ---- Optional LLM value resolution ----
// The LLM is the last matcher in the chain, not a writing assistant: the
// deterministic dictionary (matcher.js) runs first, and only genuinely unmatched
// free-text fields reach this. So the whole profile goes over the wire rather
// than a curated subset — anything withheld is a field the model can never fill,
// and "Full Name" failing for lack of a name is exactly that kind of hole.
//
// It goes over the wire compactly. The profile is re-sent on every round and
// every per-field retry, and pretty-printing it costs ~20% of its tokens in
// whitespace that no model needs — input tokens are the half of the bill that
// the batch path cannot avoid paying, so they are the half worth trimming.
//
// Output contract is a bare value, not prose. This string gets typed straight
// into a form control, so any preamble or "Answer:" wrapper ends up inside the
// input box. SKIP is the single escape hatch for a field the profile can't
// answer, which keeps the "never invent" rule enforceable without a second trip.
//
// Requires the relevant API key and host permission to already be granted (see
// options.js).
function buildLLMPrompt(row, profile, customContext = "") {
  const isTextarea = row.tagName === "textarea";
  const control = isTextarea
    ? "long free-text box (textarea)"
    : `single-line ${row.inputType || "text"} input`;

  const sections = [
    "You are the value-filling stage of an automated job application form. One field, one value.",
    "",
    "FIELD",
    `Label: ${row.label}`,
    `Control: ${control}`
  ];

  if (Array.isArray(row.options) && row.options.length) {
    sections.push(`Options this field offers: ${row.options.join(" | ")}`);
  }

  sections.push(
    "",
    "CANDIDATE PROFILE (JSON — the single source of truth; copy values out of it verbatim)",
    JSON.stringify(profile)
  );

  const trimmed = (customContext || "").trim();
  if (trimmed) {
    sections.push(
      "",
      "CANDIDATE'S OWN CONTEXT AND INSTRUCTIONS (these override any default judgement below)",
      trimmed
    );
  }

  sections.push(
    "",
    "OUTPUT RULES",
    "- Output ONLY the value to type into the field. Nothing else.",
    "- No preamble, no explanation, no 'Answer:', no quotes, no markdown, no bullets, no sign-off.",
    "- Copy names, emails, phone numbers, URLs, companies, dates, degrees and numbers exactly as written in the profile. Do not reformat, expand or 'improve' them.",
    isTextarea
      ? "- This is a long-answer box: write 2-4 sentences, first person, plain prose. Still no preamble."
      : "- This is a short-answer box: output a bare value, never a sentence.",
    "- Decide on the single best match yourself. Do not offer alternatives and do not ask which one to use.",
    "- Never invent an employer, date, degree, salary, certification or number that is not in the profile.",
    "- If the profile does not contain the answer, output exactly: SKIP"
  );

  return sections.join("\n");
}

// Models still occasionally wrap the value in quotes or a label. Only the two
// most common wrappers are stripped — anything more aggressive risks mangling a
// legitimate value, which is worse than a stray quote character.
function tidyModelValue(text) {
  let out = (text || "").trim();
  out = out.replace(/^(answer|value)\s*[:\-–]\s*/i, "");
  const quoted = out.match(/^"([\s\S]*)"$/);
  if (quoted) out = quoted[1].trim();
  return out;
}

// Exactly "SKIP", not merely text starting with the word — "Skip to line 40" or a
// pasted answer that happens to open with "Skip" must not be swallowed.
function isSkipResponse(text) {
  return /^skip[.!]?$/i.test((text || "").trim());
}


// ---- AI choice resolution (radio / checkbox groups) ----
//
// Last resort for a question the dictionary couldn't answer: "Notice Period",
// "Current Location", a Yes/No the profile phrases differently. The model is
// given the question and the exact options the form offers, and answers with the
// option text alone.
//
// The answer is then snapped back to a real option. That validation is the whole
// point — a model that answers "Bengaluru" for an option reading "Bangalore"
// would otherwise produce a value the filler cannot match, and the failure would
// surface as a silently unfilled box rather than as an obvious error.

// Providers in preference order, cheapest first. The list is not written here:
// it comes from src/lib/providers.js, which the API Keys screen renders from too,
// so a provider added there is draftable here with no second edit. Array order in
// that file is the order below — free tiers first, paid ones last as the safety
// net.
//
// maxTokens is a *floor* for the batch call, not a ceiling, and most providers
// never see it: one reply has to carry an answer per field, so wherever the API
// allows the parameter to be omitted it is (see outputCapMode in providers.js)
// and the model's own limit applies. The estimate is what a provider that
// demands the parameter gets, and it grows if that provider's reply is caught
// hitting the cap.
//
// run() resolves to { text, truncated } rather than a bare string: `truncated` is
// how the batch path tells "the model stopped at the output ceiling with half the
// answers already written" apart from "the model refused". The first is
// recoverable and cheap, the second is not.
function llmProviders(settings, { maxTokens } = {}) {
  return configuredProviders(settings).map((provider) => ({
    name: provider.label,
    run: (prompt) => sendProviderPromptDetailed({ provider, settings, prompt, maxTokens })
  }));
}

function buildChoicePrompt(row, profile, customContext = "") {
  const optionTexts = (row.options || [])
    .map((option) => (option.text || option.value || "").trim())
    .filter(Boolean);
  const multiple = row.multiple === true;

  const sections = [
    "You are filling in one multiple-choice field of an automated job application form.",
    "",
    "FIELD",
    `Question: ${row.label}`,
    `How many options may be selected: ${multiple ? "as many as apply" : "exactly one"}`,
    "",
    "OPTIONS ON THIS FORM (your answer must be copied from this list, character for character)",
    optionTexts.map((text, index) => `${index + 1}. ${text}`).join("\n"),
    "",
    "CANDIDATE PROFILE (JSON — the single source of truth; copy values out of it verbatim)",
    JSON.stringify(profile)
  ];

  const trimmed = (customContext || "").trim();
  if (trimmed) {
    sections.push(
      "",
      "CANDIDATE'S OWN INSTRUCTIONS (these override any default judgement below)",
      trimmed
    );
  }

  sections.push(
    "",
    "OUTPUT RULES",
    "- Output ONLY the chosen option text, copied exactly as written in the list above.",
    "- Never invent an option that is not on the list, and never reword or abbreviate one.",
    "- No preamble, no explanation, no numbering, no quotes, no markdown.",
    multiple
      ? "- Choose every option that genuinely applies. Put them on one line separated by commas."
      : "- Choose the single best option. Output just that one, nothing else.",
    "- If no option is a truthful answer for this candidate, output exactly: SKIP"
  );

  return sections.join("\n");
}

// Map free-text the model produced back onto the option strings the form
// actually offers, so what gets ticked is always something that exists.
function parseChoiceSelection(text, optionTexts, multiple) {
  if (isSkipResponse(text)) return [];

  const candidates = tidyModelValue(text)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const normalizedOptions = optionTexts.map((text) => normalizeLabel(text));
  const chosen = [];

  for (const candidate of candidates) {
    const wanted = normalizeLabel(candidate);
    if (!wanted) continue;

    let index = -1;
    for (const predicate of [
      (option, want) => option === want,
      (option, want) => option.startsWith(want) || want.startsWith(option),
      (option, want) => option.includes(want) || want.includes(option)
    ]) {
      const found = normalizedOptions.findIndex(
        (option, i) => option && !chosen.includes(i) && predicate(option, wanted)
      );
      if (found !== -1) {
        index = found;
        break;
      }
    }

    if (index === -1) continue;
    chosen.push(index);
    if (!multiple) break;
  }

  return chosen.map((index) => optionTexts[index]);
}

// Returns { values, source }. `values` is empty when every provider declined,
// which is not an error — the field simply stays for the user.
async function chooseOptions(row, profile, settings, customContext = undefined) {
  const effectiveContext = typeof customContext === "string" ? customContext : ((settings && settings.draftContext) || "");
  const optionTexts = (row.options || [])
    .map((option) => (option.text || option.value || "").trim())
    .filter(Boolean);

  if (!(settings && settings.useLLM) || !optionTexts.length) {
    return { values: [], source: "none" };
  }

  const providers = llmProviders(settings);
  if (!providers.length) {
    return { values: [], source: "none" };
  }

  const prompt = buildChoicePrompt(row, profile, effectiveContext);
  const errors = [];
  let skips = 0;

  for (const provider of providers) {
    try {
      const { text } = await provider.run(prompt);
      const values = parseChoiceSelection(text, optionTexts, row.multiple === true);
      if (!values.length) {
        skips += 1;
        continue;
      }
      return { values, source: `AI · ${provider.name}` };
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (skips && !errors.length) {
    return { values: [], source: "AI · no match in profile" };
  }

  throw new Error(errors.join(" — then — "));
}

// Single entry point used by popup.js. Providers are tried cheapest first — the
// order comes from src/lib/providers.js, free tiers ahead of paid ones.
//
// A provider answering SKIP counts as a miss rather than an error, so the next
// one still gets a turn. If every provider declines, the field is genuinely
// unanswerable from the profile and is left for the user — that is not a
// failure, so it must not surface as one.
async function generateDraft(row, profile, settings, customContext = undefined) {
  const effectiveContext = typeof customContext === "string" ? customContext : ((settings && settings.draftContext) || "");
  if (!(settings && settings.useLLM)) {
    return { text: generateLocalDraft(row, profile, effectiveContext), source: "template (AI drafts off)" };
  }

  const prompt = buildLLMPrompt(row, profile, effectiveContext);
  const errors = [];

  const providers = llmProviders(settings);

  if (!providers.length) {
    return { text: generateLocalDraft(row, profile, effectiveContext), source: "template (no API key configured)" };
  }

  let skips = 0;

  for (const provider of providers) {
    try {
      const { text: raw } = await provider.run(prompt);
      const text = tidyModelValue(raw);
      if (isSkipResponse(text)) {
        skips += 1;
        continue;
      }
      return { text, source: `AI · ${provider.name}` };
    } catch (err) {
      errors.push(err.message);
    }
  }

  // Everyone was asked and everyone declined: nothing in the profile answers
  // this field. popup.js already renders an empty draft as "fill manually".
  if (skips && !errors.length) {
    return { text: "", source: "AI · no match in profile" };
  }

  throw new Error(errors.join(" — then — "));
}


// ---- Batched resolution: every outstanding field in one click ----
//
// The per-field path costs one round trip *and* one full resend of the profile
// per field. On a form with a dozen unmatched fields that is a dozen uploads of
// the same JSON to answer questions that have nothing to do with each other.
//
// resolveFields() sends the whole outstanding list in one request. The profile is
// the bulk of the prompt, so it crosses the wire once for the whole form instead
// of once per field — which is also why the leftovers are re-asked internally
// rather than pushed back to the user: a second round carries only the stragglers
// behind a much smaller field list, so it costs a fraction of what a second click
// would have.
//
// The reply is still validated per field, exactly as the single-field path does —
// choice answers are snapped onto real options, and SKIP still means "leave this
// one alone". A single malformed entry costs that field its answer and nothing
// else, but unlike before it is also recorded as to *why*, which is what lets the
// retry tell a dropout (worth another round) apart from a decline (not).

// The starting output budget for a batch round, in tokens.
//
// This is a floor, not a ceiling, and the ceiling deliberately does not exist
// here. It is the provider's number to know: where the API lets the parameter be
// left out it is left out (see outputCapMode in providers.js), so the model's own
// output limit applies instead of a guess made in this file. A hardcoded ceiling
// could only ever be wrong in one direction — set below what the model would
// have produced, which truncates replies that had room to finish. That was the
// whole bug: an 8,000-token cap on a model that will emit 65,536, applied to a
// batch that also had reasoning tokens to pay for first.
//
// Where a budget genuinely has to be sent (Anthropic rejects the request without
// one; a self-hosted endpoint's default is whatever the server was configured
// with) it starts here and doubles each round the model is caught hitting it, so
// the size converges on what the form actually needs instead of being pinned to
// a number chosen before the form was ever seen.
const STARTING_BATCH_MAX_TOKENS = 1200;

function batchTokenBudget(rows) {
  const units = rows.reduce((total, row) => {
    if (row.tagName === "radiogroup") return total + 12 + (row.options || []).length * 4;
    if (row.tagName === "textarea") return total + 110;
    return total + 24;
  }, 0);

  // Tokens run a little above word count for prose, and the JSON wrapper adds its
  // own punctuation on top, so the multiplier carries the headroom.
  return Math.max(STARTING_BATCH_MAX_TOKENS, Math.round(units * 2.4));
}

// How many times one click may re-ask. Rounds after the first only carry the
// fields the model failed to answer, so the prompt shrinks each time and the
// whole sequence costs little more than the single request it replaces.
const MAX_BATCH_ROUNDS = 3;

function describeBatchRow(row, id) {
  const isGroup = row.tagName === "radiogroup";
  const optionTexts = (row.options || [])
    .map((option) => (option.text || option.value || "").trim())
    .filter(Boolean);

  const lines = [`  { "id": ${id}, "label": ${JSON.stringify(row.label)}`];

  if (isGroup) {
    lines[0] += `, "kind": "choice", "maxSelections": ${row.multiple === true ? "many" : 1}`;
    lines.push(`    "options": ${JSON.stringify(optionTexts)}`);
  } else if (row.tagName === "textarea") {
    lines[0] += `, "kind": "longtext"`;
  } else {
    lines[0] += `, "kind": "shorttext"`;
  }

  lines[0] += " }";
  return lines.join("\n");
}

function buildBatchPrompt(rows, profile, customContext = "") {
  const numbered = rows
    .map((row, index) => describeBatchRow(row, index + 1))
    .join("\n");

  const sections = [
    "You are the value-filling stage of an automated job application form. Answer EVERY field below in a single reply.",
    "",
    "FIELDS TO FILL",
    `[${numbered}]`,
    "",
    "CANDIDATE PROFILE (JSON — the single source of truth; copy values out of it verbatim)",
    JSON.stringify(profile)
  ];

  const trimmed = (customContext || "").trim();
  if (trimmed) {
    sections.push(
      "",
      "CANDIDATE'S OWN CONTEXT AND INSTRUCTIONS (these override any default judgement below)",
      trimmed
    );
  }

  sections.push(
    "",
    "OUTPUT RULES",
    `- Reply with ONLY a JSON array of ${rows.length} objects, one per field, in the same order.`,
    '- Each object: {"id": <the id given above>, "answer": <your answer>, "source": "<profile path the answer came from>"}. Output nothing else — no prose, no markdown fences.',
    '- "source" is optional, and only ever a dotted path into the profile JSON exactly as written there (e.g. "personal.fullName", "experience.0.company"). Give it when the answer is a profile value copied verbatim; omit it when the answer is written prose, or was assembled from more than one place. It is how a field the dictionary cannot name gets remembered for next time.',
    '- For a "choice" field, "answer" must be one of that field\'s "options", copied character for character — or an array of them when "maxSelections" is "many". Never invent, reword or abbreviate an option.',
    '- For a "shorttext" field, "answer" is a bare value only: a name, an email, a number, a link. Never a sentence.',
    '- For a "longtext" field, "answer" is 2-4 sentences, first person, plain prose.',
    "- Copy names, emails, phone numbers, URLs, companies, dates, degrees and numbers exactly as written in the profile.",
    "- Never invent an employer, date, degree, salary, certification or number that is not in the profile.",
    '- If a field genuinely has no answer in the profile, still include it with "answer": "SKIP" rather than leaving it out, so the count stays right.',
    "- Do not skip a field, merge two fields into one answer, or add ids that were not listed."
  );

  return sections.join("\n");
}

// Models wrap JSON in prose or fences no matter how firmly they are told not to.
// Take the outermost array/object and let JSON.parse judge it, rather than
// trying to repair the text.
function extractJsonArray(raw) {
  const text = String(raw || "").trim();
  const unfenced = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  const region = start === -1 ? "" : unfenced.slice(start, end === -1 ? unfenced.length : end + 1);

  // The whole-array parse is guaranteed to fail on exactly the replies worth
  // salvaging. A reply cut off at the output ceiling stops mid-object, so the
  // closing bracket never arrives — and a single JSON.parse over that text throws
  // away the answers that *were* complete, which is how one truncated round used
  // to cost every field in it. So: take the complete objects out of whatever
  // arrived and let the round loop re-ask only the tail.
  try {
    const parsed = JSON.parse(region);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Truncated, fenced oddly, or prose-wrapped — fall through to the salvage.
  }

  const salvaged = completeJsonObjects(region);
  if (salvaged.length) return salvaged;

  throw new Error(
    start === -1
      ? "reply contained no JSON array"
      : "reply was cut off before it contained any complete answer"
  );
}

// Every balanced {...} in a fragment, parsed individually.
//
// Brace counting has to be string-aware or an answer containing a brace — a
// sentence about JSON, a nested object, "{placeholder}" the model left in a
// template — would shift the depth and swallow the rest of the reply. The last
// object in a truncated reply is normally incomplete, and an unbalanced one is
// never closed so it is never emitted: it simply becomes an unanswered field.
function completeJsonObjects(region) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < region.length; i += 1) {
    const ch = region[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth !== 0 || start === -1) continue;
      // One unparseable object must not cost the others, so a failure here just
      // drops that entry and keeps walking.
      try {
        found.push(JSON.parse(region.slice(start, i + 1)));
      } catch {
        // Malformed entry — the fields it would have covered stay unanswered.
      }
      start = -1;
    }
  }

  return found;
}

// One malformed entry must not cost the whole batch, so each field is settled on
// its own terms. But "settled on its own terms" used to mean "silently dropped",
// which is what turned one click into a click-per-field hunt: the survivors were
// counted, the casualties were not, and every casualty stayed `unmatched` so the
// button kept offering to resolve it.
//
// The distinction that matters for a retry is why a field came back empty:
//
//   declined   — the model answered "SKIP". It looked, found nothing grounded
//                in the profile, and said so. Asking the same question with the
//                same profile gets the same answer, so this is final.
//   unanswered — the model never spoke for it: a lost id or an empty answer.
//                Recoverable, so these are the ones worth another round.
//   unstuck is a subset of unanswered, and is the one that another batch round
//   cannot fix: the model *did* pick an option, it just wasn't a string this
//   form offers. "Yes" against "Legally authorized to work in the United States"
//                is the correct answer and no substring can confirm it, so
//                re-batching only earns the same mismatch again. Those get
//                re-asked one at a time instead.
function applyBatchEntries(entries, rows) {
  const byId = new Map();
  const skipped = new Set();
  const unstuck = new Set();
  // The profile path each answer claims to have come from, as { uid, path, text }.
  // The claim is left unverified here on purpose: draft.js is the prompting layer
  // and has no business deciding what a rule may become. It only reports, and the
  // caller checks it against the profile before anything is stored.
  const sources = [];

  // Settle one entry against one row, on its own terms. Both passes below go
  // through here, so the id mapping and the positional fallback can never
  // disagree about what counts as answered.
  const applyEntry = (row, entry) => {
    const raw = entry && typeof entry === "object" ? entry.answer : entry;
    if (raw == null) return;

    const asText = Array.isArray(raw) ? raw.join(", ") : String(raw);
    if (isSkipResponse(asText)) {
      skipped.add(row.uid);
      return;
    }

    if (row.tagName === "radiogroup") {
      const optionTexts = (row.options || [])
        .map((option) => (option.text || option.value || "").trim())
        .filter(Boolean);
      const values = parseChoiceSelection(asText, optionTexts, row.multiple === true);
      if (values.length) byId.set(row.uid, { values });
      else unstuck.add(row.uid);
      return;
    }

    const text = tidyModelValue(asText);
    if (!text) return;
    byId.set(row.uid, { text });

    const claimed = entry && typeof entry === "object" ? entry.source : null;
    if (typeof claimed === "string" && claimed.trim()) {
      sources.push({ uid: row.uid, path: claimed.trim(), text });
    }
  };

  const list = Array.isArray(entries) ? entries : [];

  // Ids are positional, so a model that miscounts them loses every field it
  // actually answered. When not one entry carries a usable id at all, read the
  // reply in order rather than discarding a round of good answers over an
  // off-by-one.
  const byIdMode = list.some(
    (entry) => entry && typeof entry === "object" && entry.id != null
  );

  const leftovers = [];
  list.forEach((entry, position) => {
    if (!entry || typeof entry !== "object") return;

    const row = byIdMode ? rows[Number(entry.id) - 1] : rows[position];
    if (!row || byId.has(row.uid) || skipped.has(row.uid)) {
      leftovers.push(entry);
      return;
    }

    applyEntry(row, entry);
  });

  // Anything the id mapping could not place gets one more attempt against the
  // rows still unanswered, in the order the model listed them. Every round
  // renumbers its field list from 1, so a reply still carrying the *previous*
  // round's numbering lines up here — and an answer the model did give is never
  // discarded over an id it got wrong. cursor only moves forward, so an entry
  // with nowhere to go cannot overwrite a row already answered.
  if (leftovers.length) {
    const free = rows.filter((row) => !byId.has(row.uid) && !skipped.has(row.uid));
    let cursor = 0;
    for (const entry of leftovers) {
      const row = free[cursor];
      if (!row) break;
      cursor += 1;
      applyEntry(row, entry);
    }
  }

  const declined = [];
  const unanswered = [];
  rows.forEach((row) => {
    if (byId.has(row.uid)) return;
    if (skipped.has(row.uid)) {
      declined.push(row.uid);
      return;
    }
    unanswered.push(row.uid);
  });

  return {
    results: byId,
    declined,
    unanswered,
    unstuck: unanswered.filter((uid) => unstuck.has(uid)),
    sources
  };
}

// Returns { results: Map<uid, {text?, values?}>, source, requested, declined,
// unanswered, calls }.
//
// Throws only when every provider errored. A provider that returns something
// unparseable is treated as a miss and the next one is tried, because a single
// malformed reply should not cost the user the whole batch.
//
// Fields the model did not answer are re-asked here, in the same click, rather
// than being handed back for the user to trigger another round by hand. Only
// those: a field answered "SKIP" has already been settled and re-asking spends a
// round trip to be told the same thing. Each extra round carries a shorter field
// list, so it is also a shorter prompt.
async function resolveFields(rows, profile, settings, customContext = undefined) {
  const effectiveContext = typeof customContext === "string" ? customContext : ((settings && settings.draftContext) || "");
  const empty = { results: new Map(), source: "none", requested: rows.length, declined: [], unanswered: [], calls: 0, rounds: 0, truncatedReplies: 0, sources: [] };

  if (!(settings && settings.useLLM) || !rows.length) return empty;

  const results = new Map();
  const declined = [];
  const errors = [];
  let queue = rows.slice();
  let source = "none";
  let calls = 0;
  let misses = 0;
  let rounds = 0;
  let truncatedReplies = 0;
  let batchBudget = 0;
  const stuck = new Set();
  // Every profile path any round claimed, validated or not, merged across rounds
  // and de-duplicated by uid. Only the caller may turn these into rules.
  const claimedSources = new Map();

  // Rounds are counted separately from calls: a single-field re-ask is a call but
  // not a round, and letting it eat the round budget would cut the retry short
  // on exactly the forms that need it most.
  while (queue.length && rounds < MAX_BATCH_ROUNDS) {
    rounds += 1;

    // Only ever grows. The round after a truncation is asking for strictly more
    // room than the one that got cut off, and the queue is smaller by then, so
    // re-estimating it from scratch would hand back a smaller budget than the
    // request that already failed. Only providers that must be sent a budget see
    // this number at all (see outputCapMode in providers.js).
    batchBudget = Math.max(batchBudget, batchTokenBudget(queue));

    const providers = llmProviders(settings, { maxTokens: batchBudget });
    if (!providers.length) break;

    const prompt = buildBatchPrompt(queue, profile, effectiveContext);
    const roundDeclined = [];
    let stuckThisRound = [];
    let progressed = false;

    for (const provider of providers) {
      calls += 1;
      let report;
      try {
        const { text, truncated } = await provider.run(prompt);
        if (truncated) {
          truncatedReplies += 1;
          batchBudget *= 2;
        }
        report = applyBatchEntries(extractJsonArray(text), queue);
      } catch (err) {
        errors.push(err.message);
        continue;
      }

      report.declined.forEach((uid) => {
        if (!roundDeclined.includes(uid)) roundDeclined.push(uid);
      });

      // A partial reply is still worth having: four usable answers beat none,
      // and the round loop below exists to mop up the rest. A truncated reply is
      // the ordinary case of this, not a provider failure — which is why the
      // salvaged prefix has to reach here rather than dying inside the parse.
      if (!report.results.size) {
        misses += 1;
        stuckThisRound = report.unstuck;
        continue;
      }

      report.results.forEach((value, uid) => results.set(uid, value));
      // Later rounds re-ask the fields earlier ones missed, so the first round
      // to speak for a uid is the one that counts — same rule the result map
      // itself follows.
      (report.sources || []).forEach((claim) => {
        if (!claimedSources.has(claim.uid)) claimedSources.set(claim.uid, claim);
      });
      source = `AI · ${provider.name}`;
      stuckThisRound = report.unstuck;
      progressed = true;
      break;
    }

    roundDeclined.forEach((uid) => {
      if (!declined.includes(uid)) declined.push(uid);
    });

    // Every provider on this round came back unusable. Rotating has already cost
    // one attempt each, so repeating the identical prompt is money burnt.
    if (!progressed) break;

    // A choice the model answered but that would not snap onto a real option
    // fails the same way every time it is batched, so it is pulled out here and
    // asked on its own. buildChoicePrompt lists the options as a numbered list
    // and asks for exactly one answer, which is a far easier target than one
    // entry in a nine-element array — and it is the path that already works for
    // the per-row button.
    for (const uid of stuckThisRound) {
      if (stuck.has(uid)) continue;
      const row = queue.find((candidate) => candidate.uid === uid);
      if (!row) continue;
      stuck.add(uid);

      let values = [];
      try {
        ({ values } = await chooseOptions(row, profile, settings, effectiveContext));
        calls += 1;
      } catch (err) {
        errors.push(err.message);
        continue;
      }

      if (values.length) {
        results.set(uid, { values });
        continue;
      }

      // Asked on its own and still nothing: that is a decline, not a dropout.
      // Leaving it retryable would have the button offer it forever.
      if (!declined.includes(uid)) declined.push(uid);
    }

    queue = queue.filter(
      (row) => !results.has(row.uid) && !declined.includes(row.uid)
    );
  }

  // Derived from the full request rather than from whatever survived the last
  // round's filter, so a field dropped mid-sequence is still reported.
  const unanswered = rows
    .filter((row) => !results.has(row.uid) && !declined.includes(row.uid))
    .map((row) => row.uid);

  if (!results.size) {
    if (misses && !errors.length) {
      return { ...empty, source: "AI · no match in profile", declined, unanswered, calls, rounds, truncatedReplies, sources: [] };
    }
    if (errors.length) throw new Error(errors.join(" — then — "));
    return { ...empty, source, declined, unanswered, calls, rounds, truncatedReplies, sources: [] };
  }

  return {
    results,
    source,
    requested: rows.length,
    declined,
    unanswered,
    calls,
    rounds,
    // Unverified claims, in field order. See claimedSources.
    sources: [...claimedSources.values()],
    // How many replies stopped at the output ceiling. Non-zero here means the
    // round loop had to mop up a cut-off tail, which is the behaviour the popup
    // reports as "resolved across N AI calls" — without this number there is no
    // way to tell a form that needed several rounds from one that needed one.
    truncatedReplies
  };
}
