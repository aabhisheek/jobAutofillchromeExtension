// Pure matching logic. Runs in the popup context (has access to FIELD_DICTIONARY
// from schema.js). No DOM access here — scanned fields arrive as plain objects.

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

// Returns the first dictionary entry (in FIELD_DICTIONARY order) whose phrase
// matches as a whole word/phrase — array order is the priority, so more
// specific keys (e.g. "email") are listed ahead of generic ones (e.g. "address")
// that would otherwise falsely match inside compound labels like "Email Address".
function findDictionaryMatch(normalizedLabel) {
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

// scannedFields: array from scanFormFields() (see page-scripts.js)
// profile: the user's profile object
// returns: array of row objects for the review UI
function matchFields(scannedFields, profile) {
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
        status: "resume-upload",
        include: false
      };
    }

    const normalized = normalizeLabel(field.label);
    const dictEntry = findDictionaryMatch(normalized);

    let value = "";
    let status = "unmatched"; // unmatched | auto | review
    let matchedPath = "";

    if (dictEntry) {
      matchedPath = dictEntry.path;
      const raw = getByPath(profile, dictEntry.path);
      if (Array.isArray(raw)) {
        value = raw.join(", ");
      } else if (raw != null) {
        value = String(raw);
      }

      if (dictEntry.sensitive) {
        status = value ? "review" : "unmatched";
      } else {
        status = value ? "auto" : "unmatched";
      }
    }

    return {
      uid: field.uid,
      label: field.label || "(no label found)",
      tagName: field.tagName,
      inputType: field.inputType,
      options: field.options || [],
      matchedPath,
      value,
      status,
      include: status !== "unmatched"
    };
  });
}
