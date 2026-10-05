// Pure matching logic. Runs in the popup context (has access to FIELD_DICTIONARY
// from schema.js and, optionally, the user's approved learned rules from
// learned.js). No DOM access here — scanned fields arrive as plain objects.

function normalizeLabel(label) {
  return (label || "")
    .toLowerCase()
    .replace(/[*:]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getByPath(obj, path) {
  return path.split(".").reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

// Returns the first dictionary entry whose phrase matches as a whole
// word/phrase — array order is the priority, so more specific keys (e.g.
// "email") are listed ahead of generic ones (e.g. "address") that would
// otherwise falsely match inside compound labels like "Email Address".
//
// Three tiers, highest first:
//
//   1. approved learned rules (see findLearnedMatch)
//   2. an entry's `exact` phrases, which must be the WHOLE label
//   3. an entry's `phrases`, matched as a substring
//
// The `exact` tier exists because some labels are only safe to read whole. A
// bare "name" is a candidate's name on almost every application form, but as a
// substring it would also capture "Preferred Name", "Maiden Name", "Project
// Name" and "Employer Name" — and typing the candidate's own name into an
// Employer Name box is a mistake that reaches the employer. Matching "name"
// only when it is the entire label fixes the first without causing the rest.
function findDictionaryMatch(normalizedLabel, field, learned) {
  const learnedEntry = findLearnedMatch(normalizedLabel, field, learned);
  if (learnedEntry) return learnedEntry;

  for (const entry of FIELD_DICTIONARY) {
    if (!Array.isArray(entry.exact)) continue;
    for (const phrase of entry.exact) {
      if (normalizedLabel === phrase) return entry;
    }
  }

  for (const entry of FIELD_DICTIONARY) {
    for (const phrase of entry.phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      //
      const re = new RegExp(String.raw`(^|\s)${escaped}($|\s)`);
      //
      if (re.test(normalizedLabel)) {
        return entry;
      }
    }
  }
  return null;
}

// What kind of control a field is, for the purpose of filing a learned rule:
// "choice" for the option lists, "text" for everything that takes a typed value.
// The tag rather than the exact element, because the same question is a
// <textarea> on one platform and an <input> on another, and a rule should
// survive that. It is also what stops a rule learned from a text box from firing
// on a <select> that happens to share its name.
function fieldKind(field) {
  const tag = (field && field.tagName) || "";
  return tag === "radiogroup" || tag === "select" ? "choice" : "text";
}

// The identity a learned rule is stored under. Both halves are needed: the label
// says which question, the kind says what kind of answer it takes.
function ruleSignature(label, field) {
  return `${fieldKind(field)}|${normalizeLabel(label)}`;
}

// A rule the user has reviewed and approved for this exact label, as a
// dictionary-shaped entry the rest of this file cannot tell apart from a bundled
// one.
//
// Approved-only: pending rules exist to be looked at, never to fill silently.
// Ahead of FIELD_DICTIONARY on purpose — a rule is the user's own decision about
// a label they have seen on a real form, so it should not be quietly overruled by
// a phrase added to the bundled table afterwards.
//
// `answers.*` is marked sensitive no matter how the rule came about: an EEO or
// eligibility answer is review-never-auto as a matter of policy, not because of
// which table it happens to sit in.
function findLearnedMatch(normalizedLabel, field, learned) {
  if (!Array.isArray(learned) || !learned.length) return null;

  const sig = ruleSignature(normalizedLabel, field);
  for (const rule of learned) {
    if (!rule || rule.status !== "approved" || !rule.path || rule.sig !== sig) continue;
    return {
      path: rule.path,
      learned: true,
      sensitive: String(rule.path).startsWith("answers.")
    };
  }
  return null;
}

// The answer's own text plus every alias listed alongside it in the profile,
// as a flat list of non-empty strings. Returned to the filler so a single
// answer can satisfy differently-worded options on different platforms
// (see the `answers` comment in schema.js). Empty when the profile holds a
// plain string or nothing at all.
function acceptedValues(profile, dictEntry) {
  if (!dictEntry) return [];
  const raw = getByPath(profile, dictEntry.path);
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v ?? "").trim()).filter(Boolean);
}

// Everything a multi-select checklist can legitimately match on: the skills
// list plus the technologies named on each role and project. Stored as word
// tokens rather than whole strings — see optionTokens() for why.
function technologyPool(profile, dictEntry) {
  const pool = new Set();
  const add = (value) => optionTokens(value).forEach(({ token, weak }) => {
    if (!weak) pool.add(token);
  });

  (profile.skills || []).forEach(add);
  (profile.experience || []).forEach((role) => (role.technologies || []).forEach(add));
  (profile.projects || []).forEach((project) => (project.technologies || []).forEach(add));

  if (dictEntry) {
    const raw = getByPath(profile, dictEntry.path);
    if (Array.isArray(raw)) raw.forEach(add);
    else if (raw != null) add(raw);
  }

  return pool;
}

// Split a label into comparable lowercase word tokens.
//
// Token membership rather than substring matching is the whole point. A
// checklist also contains non-technology options, and raw `includes` conflates
// them: "No" is a substring of "Node.js", so substring matching silently ticks
// "No" for anyone who lists Node. Splitting first means "node.js" and
// "Next JS" both yield {node|next, js} and match on the word they share,
// while "no" matches only a real "no".
// Split a label into comparable lowercase word tokens, flagging the ones that
// are file extensions rather than technologies.
//
// "node.js" splits into "node" and "js", but only "node" names something the
// candidate can have. The extension is flagged weak, and weak tokens never
// trigger a match on their own: otherwise "Vue.js" matches anyone who merely
// lists "Node.js", because the two share the fragment "js".
function optionTokens(text) {
  // Capturing the separator is what makes the dot visible — a plain split
  // discards it and "node.js" becomes indistinguishable from "node js".
  const chunks = String(text || "").toLowerCase().split(/([^a-z0-9+#]+)/);
  const tokens = [];

  chunks.forEach((chunk, index) => {
    if (!chunk) return;
    // Odd indices are the separators themselves, not tokens.
    if (index % 2 === 1) return;
    const separator = index > 0 ? chunks[index - 1] : "";
    tokens.push({ token: chunk, weak: separator.includes(".") });
  });

  return tokens;
}

// Select every offered option the candidate genuinely has. Returns the option
// texts, in the order the question lists them.
function matchMultiSelect(field, profile, dictEntry) {
  const options = Array.isArray(field.options) ? field.options : [];
  if (!options.length) return [];

  // Without a dictionary entry the pool is simply every skill the candidate
  // lists, so the only thing making that a reasonable answer to *this* question
  // is the question itself. A group whose label never resolved isn't a skills
  // question — it's a question nobody has read yet, and ticking "everything I
  // know" against it is a guess. Left unmatched instead, which routes it to the
  // AI choice path where the real question text can be reasoned about.
  if (!dictEntry) {
    const label = normalizeLabel(field.label);
    if (!label || label === "untitled question") return [];
  }

  const pool = technologyPool(profile, dictEntry);

  return options
    .map((option) => option.text || option.value)
    .filter((text) =>
      optionTokens(text).some(({ token, weak }) => !weak && pool.has(token))
    )
    .map((text) => String(text).trim())
    .filter(Boolean);
}

// The display texts of the options a choice group actually offers.
function optionTextsFor(field) {
  return (Array.isArray(field.options) ? field.options : [])
    .map((option) => (option.text || option.value || "").trim())
    .filter(Boolean);
}

// Does any of the answers we hold name one of the options on offer?
//
// A dictionary hit on a choice group is only worth anything if the answer it
// found can actually select something. "Are you a graduate of a Tier-1
// engineering college?" matches the dictionary's college entry, but that entry
// holds a university name — which is neither "Yes" nor "No". Without this check
// the row is marked filled, ticked as a success, and selects nothing, which is
// worse than admitting defeat and letting the AI answer from the real options.
function answerMatchesOptions(answers, options) {
  const wanted = answers
    .map((answer) => normalizeLabel(answer))
    .filter(Boolean);
  if (!wanted.length) return false;

  const labels = options.map((option) => normalizeLabel(option)).filter(Boolean);
  if (!labels.length) return true;

  return wanted.some((answer) =>
    labels.some(
      (label) =>
        label === answer ||
        label.startsWith(answer) ||
        answer.startsWith(label) ||
        label.includes(answer) ||
        answer.includes(label)
    )
  );
}

// scannedFields: array from scanFormFields() (see page-scripts.js)
// profile: the user's profile object
// returns: array of row objects for the review UI
function matchFields(scannedFields, profile, learned) {
  return scannedFields.map((field) => {
    // scanFormFields only ever emits file inputs it already recognized as a
    // resume/CV upload (see RESUME_UPLOAD_KEYWORDS there) — no dictionary
    // path applies here, popup.js decides fillability from whether a
    // compiled PDF is stored.
    if (field.inputType === "file") {
      return {
        uid: field.uid,
        label: field.label || "(no label found)",
        tagName: field.tagName,
        inputType: field.inputType,
        options: [],
        matchedPath: "",
        value: "",
        accepts: [],
        status: "resume-upload",
        // True when the site builds its file input on demand behind a click
        // (Google Forms), so there is nothing to assign a File to. Carried
        // through so the popup can say that instead of counting a failed
        // attachment the user had no way to prevent.
        ...(field.resumeRequiresClick ? { resumeRequiresClick: true } : {}),
        include: false
      };
    }

    const normalized = normalizeLabel(field.label);
    const dictEntry = findDictionaryMatch(normalized, field, learned);

    let value = "";
    let status = "unmatched"; // unmatched | auto | review
    let matchedPath = "";

    if (dictEntry) {
      matchedPath = dictEntry.path;
      const raw = getByPath(profile, dictEntry.path);
      if (Array.isArray(raw)) {
        // Some entries store a list of accepted texts rather than one answer:
        // every `answers.*` key, plus any dictionary entry explicitly marked
        // `aliases: true` (see the `answers` comment in schema.js). Only the
        // first entry is shown and filled; the rest travel along in `accepts`
        // so the filler can match a dropdown's own wording — Workday's Degree
        // offers "Bachelor's Degree" and would reject a literal "B.Tech".
        //
        // Everything else that is an array is a genuine multi-value answer
        // (skills), which joins into one comma-separated string.
        const usesAliasList =
          dictEntry.path.startsWith("answers.") ||
          dictEntry.aliases === true;

        value = usesAliasList
          ? String(raw.find((v) => String(v ?? "").trim()) ?? "")
          : raw.join(", ");
      } else if (raw != null) {
        value = String(raw);
      }

      if (dictEntry.sensitive) {
        status = value ? "review" : "unmatched";
      } else {
        status = value ? "auto" : "unmatched";
      }
    }

    // Extra option texts this answer is also allowed to match, beyond the
    // displayed `value`. See the `answers` comment in schema.js: an answer
    // can be an array when the same question is worded differently across
    // platforms ("Authorized to work" vs a Yes/No authorized-to-work
    // dropdown). Only the first entry is shown/editable; the whole list is
    // handed to fillFormFields so it can pick whichever option the page
    // actually offers.
    const accepts = acceptedValues(profile, dictEntry);

    const isChoiceGroup = field.tagName === "radiogroup";


    // Multi-select choice group (a technologies checklist, say). The answer is
    // the set of offered options the candidate actually has, so it is resolved
    // against the options rather than reduced to one dictionary value — a
    // single comma-joined string would let the filler tick only the first box.
    //
    // Declared out of the branch because the common return below also reports
    // `values`: scoping it to the `if` left that line reading an undeclared
    // name on every row that isn't a matched multi-select.
    const selected =
      field.multiple === true ? matchMultiSelect(field, profile, dictEntry) : [];

    if (selected.length) {
      return {
        uid: field.uid,
        label: field.label || "(no label found)",
        tagName: field.tagName,
        inputType: field.inputType,
        options: field.options || [],
        matchedPath: matchedPath || (dictEntry ? dictEntry.path : ""),
        value: selected.join(", "),
        values: selected,
        accepts,
        multiple: true,
        status: dictEntry && dictEntry.sensitive ? "review" : "auto",
        include: true
      };
    }


    // A single-select group whose dictionary answer names none of the options is
    // not an answer. Drop it so the row falls through to the AI choice path,
    // which reasons over the real option list instead of guessing.
    let resolvedValue = value;
    let resolvedStatus = status;

    if (
      isChoiceGroup &&
      field.multiple !== true &&
      resolvedValue &&
      !answerMatchesOptions([resolvedValue, ...accepts], optionTextsFor(field))
    ) {
      resolvedValue = "";
      resolvedStatus = "unmatched";
    }


    return {
      uid: field.uid,
      label: field.label || "(no label found)",
      tagName: field.tagName,
      inputType: field.inputType,
      options: field.options || [],
      matchedPath: resolvedStatus === "unmatched" ? "" : matchedPath,
      value: resolvedValue,
      values: selected,
      accepts,
      // Carried through so the filler knows whether it may tick more than one
      // box. Absent on every non-group row, which keeps the default at one.
      ...(field.multiple === true ? { multiple: true } : {}),
      // This label was matched by a rule the user approved, not by the bundled
      // table. Purely for the UI to say so: an answer from a learned rule is
      // worth knowing about precisely because nobody wrote it into the table.
      ...(dictEntry && dictEntry.learned ? { learned: true } : {}),
      status: resolvedStatus,
      include: resolvedStatus !== "unmatched"
    };
  });
}
