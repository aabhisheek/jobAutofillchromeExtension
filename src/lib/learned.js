// Learned field rules — the mapping from a form's own wording to a profile path,
// remembered between forms so the same question never needs the AI twice.
//
// Loaded as a plain script (no modules), alongside schema.js and matcher.js, by
// the pages that match fields: the popup and the options page.
//
// ============================================================
// WHY A RULE AND NOT THE ANSWER
// ============================================================
//
// A rule stores "this label wants that profile field", never "…and the answer
// was Abhishek Anand". The distinction is the whole design: a stored answer goes
// stale the moment the profile is corrected, and a stale full name in an
// application is a mistake nobody notices until a recruiter reads it. A stored
// path is re-read from the profile on every scan, so fixing the profile fixes
// every rule that points at it, retroactively.
//
// ============================================================
// WHY NOTHING IS APPLIED WITHOUT A HUMAN
// ============================================================
//
// The input to all of this is text a web page chose. Nothing here executes
// anything, and nothing is applied silently — but the reason is not taste. A page
// can render a field labelled "Confirm your password", and a learned rule is
// permanent, survives restarts, and applies on every site from then on. If such a
// rule could be created without being looked at, the extension would become a
// channel that any page can aim at the profile. So a rule is:
//
//   - a mapping, never an answer and never code
//   - verified against the profile before it is stored at all (see verifiedSource)
//   - filed as pending, and inert until the user approves it
//   - listed in the options page with the exact label it was learned from, so
//     approving means approving a sentence the user can read
//   - deletable, one click, with no other trace left behind
//
// The model is asked which profile value it copied (the batch contract's
// "source"), and the claim is only believed when the answer it gave is
// character-for-character the value at that path. A model that paraphrases, or
// that names a path it did not use, produces no rule at all.

const LEARNED_RULES_KEY = "learnedFieldRules";

// Rules as loaded, kept in memory because matching is synchronous and happens
// mid-scan: awaiting storage per field would mean an await per row. Loaded once
// at startup and rewritten in place on every change.
let learnedRulesCache = null;

// Reads the value at a dotted profile path, refusing anything that is not a
// plain read. Own properties only, so a crafted path cannot walk into the
// prototype chain (`__proto__.constructor` and friends resolve to nothing here
// rather than to a function).
function profileValueAt(profile, path) {
  if (typeof path !== "string" || !path) return undefined;

  const parts = path.split(".");
  let node = profile;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

// The value a rule would fill, as one string: the first entry of an alias list
// (every `answers.*` key is one — see the `answers` comment in schema.js), or a
// multi-value answer joined the way matchFields joins it. Mirrors matcher.js on
// purpose: a rule verified against a differently-shaped value would either be
// rejected for no reason or, worse, accepted for the wrong one.
function profileAnswerText(profile, path) {
  const raw = profileValueAt(profile, path);
  if (Array.isArray(raw)) {
    const usesAliasList = String(path).startsWith("answers.");
    const text = usesAliasList
      ? String(raw.find((v) => String(v ?? "").trim()) ?? "")
      : raw.join(", ");
    return text.trim();
  }
  if (raw == null) return "";
  return String(raw).trim();
}

// Whether a claimed "source" can be believed, and what it resolves to.
//
// The test is deliberately strict, because the whole safety argument rests on
// it: the answer the model gave must be *exactly* the value at the path it named.
// That rules out paraphrases, assembled answers, invented paths, and any path
// pointing at something the profile does not hold. A claim that fails is dropped
// silently — a missed optimisation is not worth a wrong answer, and the field
// has already been answered correctly for this click either way.
function verifiedSource(profile, claim) {
  if (!claim || typeof claim.path !== "string") return null;

  const path = claim.path.trim();
  if (!isSafePath(path)) return null;

  const value = profileAnswerText(profile, path);
  if (!value) return null;
  if (value !== String(claim.text || "").trim()) return null;

  return path;
}

// A rule id that cannot collide with another rule's, and does not depend on the
// clock alone: two rules learned in the same millisecond still differ.
function newRuleId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Whether a path is one this file is willing to read or store: dotted segments
// only, and never a step onto the prototype chain. Checked on the way in *and* on
// the way back out of storage, because a hand-edited or synced storage record is
// exactly as capable of carrying "__proto__" as anything the model says.
function isSafePath(path) {
  if (typeof path !== "string" || !path) return false;
  if (/[[\]]/.test(path)) return false;
  return !path
    .split(".")
    .some((part) => part === "__proto__" || part === "constructor" || part === "prototype");
}

async function readStoredRules() {
  try {
    const stored = await chrome.storage.local.get(LEARNED_RULES_KEY);
    const list = stored && stored[LEARNED_RULES_KEY];
    if (!Array.isArray(list)) return [];
    // Anything unreadable in the array is dropped rather than trusted: this file
    // is the only thing standing between a hand-edited storage record and a field
    // filled with it.
    return list.filter(
      (rule) =>
        rule &&
        typeof rule.sig === "string" &&
        rule.sig &&
        isSafePath(rule.path) &&
        (rule.status === "pending" || rule.status === "approved")
    );
  } catch {
    return [];
  }
}

async function writeStoredRules(rules) {
  learnedRulesCache = rules;
  await chrome.storage.local.set({ [LEARNED_RULES_KEY]: rules });
  return rules;
}

// The rules as the matcher sees them. Empty until loadLearnedRules() has run,
// which is what makes a missing load harmless rather than a crash: matching
// without them simply falls back to the bundled dictionary.
function learnedRules() {
  return Array.isArray(learnedRulesCache) ? learnedRulesCache : [];
}

async function loadLearnedRules() {
  learnedRulesCache = await readStoredRules();
  return learnedRulesCache;
}

// Whether a label is already answered by the bundled dictionary, and so has
// nothing left for a rule to teach it. Checked with no learned rules passed, so
// an existing rule cannot mask the very label a new rule is competing for —
// otherwise "Name" would look covered by the rule that was learned for it, and
// the rule could never be re-pointed at a different profile field.
function coveredByDictionary(field) {
  return findDictionaryMatch(normalizeLabel(field.label), field, []);
}

// Turns one resolution's unverified claims into pending rules.
//
// Returns { added, existing, rejected, rules } for reporting: counts and the
// stored list, never the claims themselves, because the labels in here come off
// a web page. `rejected` is deliberately not broken down by reason — the reasons
// are not the user's to act on and a page should not learn what tripped it.
async function learnFromResolution(claims, rows, profile) {
  const existing = learnedRules();
  const added = [];
  let duplicates = 0;
  let rejected = 0;

  const byUid = new Map(rows.map((row) => [row.uid, row]));

  for (const claim of claims || []) {
    const row = byUid.get(claim && claim.uid);
    if (!row) continue;

    // Only typed fields. A choice group is answered by picking one of the
    // options it offers, so a path that reads well on one form's dropdown says
    // nothing about the next form's.
    if (fieldKind(row) !== "text") continue;

    const label = String(row.label || "").trim();
    if (!label) continue;

    const path = verifiedSource(profile, claim);
    if (!path) {
      rejected += 1;
      continue;
    }

    const sig = ruleSignature(label, row);

    // The bundled dictionary already answers this one, so there is no call to
    // save and no ambiguity for the user to rule on.
    if (coveredByDictionary(row)) continue;

    const clash = existing.find((rule) => rule.sig === sig);
    if (clash) {
      // Same label, different answer. The earlier rule wins and the newer claim
      // is dropped: which of two profile fields a label means is a judgement
      // about the form, and two rounds of guessing are not more informative than
      // one. Approving the rule as it stands, or deleting it and redoing the
      // field, are both one click.
      if (clash.path !== path) rejected += 1;
      else duplicates += 1;
      continue;
    }

    const rule = {
      id: newRuleId(),
      sig,
      label,
      kind: "text",
      path,
      status: "pending",
      createdAt: Date.now(),
      approvedAt: null
    };
    added.push(rule);
  }

  if (!added.length) {
    return { added: 0, existing: duplicates, rejected, rules: existing };
  }

  const rules = await writeStoredRules([...existing, ...added]);
  return { added: added.length, existing: duplicates, rejected, rules };
}

async function approveRule(id) {
  const rules = learnedRules();
  const next = rules.map((rule) =>
    rule.id === id ? { ...rule, status: "approved", approvedAt: Date.now() } : rule
  );
  return writeStoredRules(next);
}

async function approveAllRules() {
  const now = Date.now();
  return writeStoredRules(
    learnedRules().map((rule) =>
      rule.status === "approved" ? rule : { ...rule, status: "approved", approvedAt: now }
    )
  );
}

async function deleteRule(id) {
  return writeStoredRules(learnedRules().filter((rule) => rule.id !== id));
}

async function deleteAllRules() {
  return writeStoredRules([]);
}

function pendingRuleCount() {
  return learnedRules().filter((rule) => rule.status === "pending").length;
}
