// schema.js — the profile shape, the label dictionary, settings merge order, and
// the bundled-file resolution both the popup and the Resume page rely on.
//
// The dictionary integrity tests at the bottom are the load-bearing ones: they are
// what makes "add a phrase to FIELD_DICTIONARY" a safe edit rather than a gamble.

import test from "node:test";
import assert from "node:assert/strict";

import { loadLib, memoryStorage } from "./helpers/load.mjs";
import { makeSettings } from "./helpers/fixtures.mjs";

const S = loadLib("schema.js", [
  "DEFAULT_PROFILE",
  "DEFAULT_SETTINGS",
  "FIELD_DICTIONARY",
  "CONTEXT_FILE_EXTENSIONS",
  "mergeSettings",
  "bundledPathProblem",
  "bundledFileUrl",
  "bundledFileBasename",
  "loadResumePdf",
  "loadBundledContext",
  "buildDraftContext",
  "arrayBufferToBase64",
  "base64ToArrayBuffer"
]);

test("DEFAULT_PROFILE", async (t) => {
  await t.test("is empty of personal answers, so nothing is filled until asked", () => {
    // Every leaf must start blank. A non-empty default here would be a value
    // typed into a real application without the user ever entering it.
    const blank = [
      S.DEFAULT_PROFILE.personal,
      S.DEFAULT_PROFILE.links,
      S.DEFAULT_PROFILE.answers
    ];
    for (const section of blank) {
      for (const [key, value] of Object.entries(section)) {
        assert.equal(value, "", `personal/links/answers.${key} should default to ""`);
      }
    }
    assert.deepEqual(S.DEFAULT_PROFILE.skills, []);
  });

  await t.test("keeps fullName separate from first/last name", () => {
    // "Full Name" boxes are common, and mapping that to firstName would type a
    // half-name where the form wants both halves.
    assert.ok("fullName" in S.DEFAULT_PROFILE.personal);
    assert.ok("firstName" in S.DEFAULT_PROFILE.personal);
    assert.ok("lastName" in S.DEFAULT_PROFILE.personal);
  });

  await t.test("leaves export-control consent blank", () => {
    // Consent is a legal acknowledgement; defaulting it would be the extension
    // agreeing to terms on the user's behalf.
    assert.equal(S.DEFAULT_PROFILE.answers.exportControlConsent, "");
  });

  await t.test("ships education and experience arrays with one empty template each", () => {
    assert.equal(S.DEFAULT_PROFILE.education.length, 1);
    assert.deepEqual(S.DEFAULT_PROFILE.projects, []);
    assert.equal(S.DEFAULT_PROFILE.experience[0].current, false);
    assert.deepEqual(S.DEFAULT_PROFILE.experience[0].technologies, []);
  });
});

test("mergeSettings", async (t) => {
  await t.test("returns defaults plus the bundled file when nothing is stored", () => {
    const merged = S.mergeSettings({ resumePdfPath: "src/data/resume.pdf" }, null);
    assert.equal(merged.resumePdfPath, "src/data/resume.pdf");
    assert.equal(merged.theme, "system");
    assert.equal(merged.useLLM, false);
  });

  await t.test("lets a stored override win over the bundled file", () => {
    const merged = S.mergeSettings({ resumePdfPath: "a.pdf" }, { resumePdfPath: "b.pdf" });
    assert.equal(merged.resumePdfPath, "b.pdf");
  });

  await t.test("treats only '' as unset, so editing settings.json still lands", () => {
    // The whole point of the "" rule: one saved record must not shadow every
    // field the user never explicitly set in the UI.
    const merged = S.mergeSettings({ groqModel: "bundled/model" }, { groqModel: "" });
    assert.equal(merged.groqModel, "bundled/model");
  });

  await t.test("lets a false override beat a bundled true", () => {
    const merged = S.mergeSettings(
      { analyticsEnabled: true, emailUseAi: true },
      { analyticsEnabled: false, emailUseAi: false }
    );
    assert.equal(merged.analyticsEnabled, false);
    assert.equal(merged.emailUseAi, false);
  });

  await t.test("honours clearing draftContext, unlike every other string field", () => {
    // draftContext is a textarea the user empties on purpose; refusing "" there
    // would make the box impossible to clear.
    const merged = S.mergeSettings({ draftContext: "be concise" }, { draftContext: "" });
    assert.equal(merged.draftContext, "");
  });

  await t.test("ignores keys it does not know about", () => {
    const merged = S.mergeSettings({}, { somethingElse: "x", __proto__: { polluted: true } });
    assert.equal(merged.somethingElse, undefined);
    assert.equal({}.polluted, undefined, "must not pollute Object.prototype");
  });

  await t.test("does not treat undefined as an override", () => {
    const merged = S.mergeSettings({ contextFilePath: "src/data/context.md" }, { contextFilePath: undefined });
    assert.equal(merged.contextFilePath, "src/data/context.md");
  });

  await t.test("never returns a key the defaults do not declare", () => {
    const merged = S.mergeSettings({}, { theme: "dark" });
    for (const key of Object.keys(merged)) {
      assert.ok(key in S.DEFAULT_SETTINGS, `merged key ${key} is not a declared setting`);
    }
  });
});

test("bundledPathProblem", async (t) => {
  const ok = (p, key = "resumePdfPath", exts = [".pdf"]) =>
    assert.equal(S.bundledPathProblem(p, key, exts), null, `${p} should be accepted`);

  await t.test("accepts an extension-relative path", () => {
    ok("src/data/resume.pdf");
  });

  await t.test("rejects an unset path and says which key to edit", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      const problem = S.bundledPathProblem(bad, "resumePdfPath", [".pdf"]);
      assert.match(problem, /resumePdfPath/);
      assert.match(problem, /settings\.json/);
    }
  });

  await t.test("names an absolute path as absolute, with a usable example", () => {
    const problem = S.bundledPathProblem("/Users/me/Desktop/resume.pdf", "resumePdfPath", [".pdf"]);
    assert.match(problem, /absolute path/);
    assert.match(problem, /src\/data\/resume\.pdf/);
  });

  await t.test("names a Windows absolute path and a URL", () => {
    assert.match(
      S.bundledPathProblem("C:\\Users\\me\\resume.pdf", "resumePdfPath", [".pdf"]),
      /absolute path|URL/
    );
    assert.match(
      S.bundledPathProblem("https://example.com/resume.pdf", "resumePdfPath", [".pdf"]),
      /URL/
    );
  });

  await t.test("rejects traversal out of the extension folder", () => {
    assert.match(S.bundledPathProblem("../secrets.pdf", "resumePdfPath", [".pdf"]), /\.\./);
    assert.match(S.bundledPathProblem("src/../../x.pdf", "resumePdfPath", [".pdf"]), /\.\./);
    assert.match(S.bundledPathProblem("src\\..\\x.pdf", "resumePdfPath", [".pdf"]), /\.\./);
  });

  await t.test("rejects the wrong extension for the slot", () => {
    // The PDF is attached as application/pdf and the .tex is fed to the tailorer,
    // so a mismatch is read as the wrong format entirely.
    assert.match(S.bundledPathProblem("src/data/resume.tex", "resumePdfPath", [".pdf"]), /\.pdf \/ /);
    assert.match(S.bundledPathProblem("src/data/resume.pdf", "resumeTexPath", [".tex"]), /\.tex/);
  });

  await t.test("answers a .tex mistake with a .tex example", () => {
    const problem = S.bundledPathProblem("src/data/resume.pdf", "resumeTexPath", [".tex"]);
    assert.match(problem, /src\/data\/resume\.tex/);
    assert.doesNotMatch(problem, /resume\.pdf/);
  });

  await t.test("matches the extension case-insensitively and tolerates padding", () => {
    ok("  src/data/Resume.PDF  ");
  });

  await t.test("accepts every declared context-file extension", () => {
    for (const ext of S.CONTEXT_FILE_EXTENSIONS) {
      ok(`src/data/context${ext}`, "contextFilePath", S.CONTEXT_FILE_EXTENSIONS);
    }
    // JSON is excluded on purpose: the contents go straight into a prompt.
    assert.ok(!S.CONTEXT_FILE_EXTENSIONS.includes(".json"));
  });
});

test("bundledFileUrl", async (t) => {
  await t.test("resolves a good path to an extension URL", () => {
    const resolved = S.bundledFileUrl("src/data/resume.pdf", "resumePdfPath", [".pdf"]);
    assert.equal(resolved.error, null);
    assert.equal(resolved.path, "src/data/resume.pdf");
    assert.match(resolved.url, /^chrome-extension:\/\//);
    assert.match(resolved.url, /src\/data\/resume\.pdf$/);
  });

  await t.test("returns a displayable error instead of a URL for a bad path", () => {
    const resolved = S.bundledFileUrl("/nope/resume.pdf", "resumePdfPath", [".pdf"]);
    assert.equal(resolved.url, null);
    assert.equal(resolved.path, "");
    assert.ok(resolved.error.length > 10);
  });

  await t.test("bundledFileBasename handles both separators", () => {
    assert.equal(S.bundledFileBasename("src/data/2026-10.pdf"), "2026-10.pdf");
    assert.equal(S.bundledFileBasename("src\\data\\2026-10.pdf"), "2026-10.pdf");
  });
});

test("loadResumePdf", async (t) => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"

  const okResponse = (bytes = pdfBytes) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer,
    text: async () => new TextDecoder().decode(bytes)
  });

  await t.test("prefers a stored upload over the configured file", async () => {
    const storage = memoryStorage({
      resumePdf: { base64: "dXB", filename: "mine.pdf", mimeType: "application/pdf", size: 3, savedAt: 1 }
    });
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage,
      fetchImpl: async () => {
        throw new Error("must not fetch when an upload exists");
      }
    });
    const result = await loadResumePdf(makeSettings());
    assert.equal(result.source, "upload");
    assert.equal(result.error, null);
    assert.equal(result.pdf.filename, "mine.pdf");
    assert.equal(result.pdf.savedAt, 1);
  });

  await t.test("falls back to the bundled file, reporting it as a file", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => okResponse()
    });
    const result = await loadResumePdf(makeSettings());
    assert.equal(result.source, "file");
    assert.equal(result.error, null);
    assert.equal(result.pdf.filename, "resume.pdf");
    assert.equal(result.pdf.mimeType, "application/pdf");
    assert.equal(result.pdf.size, pdfBytes.byteLength);
    // savedAt === null is how callers tell "uploaded" from "configured file".
    assert.equal(result.pdf.savedAt, null);
  });

  await t.test("uses the real file name so a dated resume shows under its own name", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => okResponse()
    });
    const result = await loadResumePdf(makeSettings({ resumePdfPath: "src/data/2026-10.pdf" }));
    assert.equal(result.pdf.filename, "2026-10.pdf");
  });

  await t.test("reports an unset path instead of guessing a default", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => okResponse()
    });
    const result = await loadResumePdf(makeSettings({ resumePdfPath: "" }));
    assert.equal(result.pdf, null);
    assert.match(result.error, /resumePdfPath/);
  });

  await t.test("reports a missing file by HTTP status rather than throwing", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => ({ ok: false, status: 404 })
    });
    const result = await loadResumePdf(makeSettings());
    assert.equal(result.pdf, null);
    assert.match(result.error, /404/);
  });

  await t.test("reports a zero-byte file as empty", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => okResponse(new Uint8Array(0))
    });
    const result = await loadResumePdf(makeSettings());
    assert.equal(result.pdf, null);
    assert.match(result.error, /0 bytes/);
  });

  await t.test("never throws when storage or fetch is unavailable", async () => {
    // A missing resume is a normal state, not an error; a rejected promise here
    // would break the popup's render path entirely.
    for (const opts of [
      { storage: memoryStorage({}, { failOn: ["get"] }), fetchImpl: async () => okResponse() },
      { storage: memoryStorage(), fetchImpl: async () => { throw new Error("offline"); } }
    ]) {
      const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], opts);
      const result = await loadResumePdf(makeSettings());
      assert.equal(result.pdf, null);
      assert.ok(typeof result.error === "string" && result.error.length > 0);
    }
  });

  await t.test("tolerates a missing settings object entirely", async () => {
    const { loadResumePdf } = loadLib("schema.js", ["loadResumePdf"], {
      storage: memoryStorage(),
      fetchImpl: async () => okResponse()
    });
    const result = await loadResumePdf(undefined);
    assert.match(result.error, /resumePdfPath/);
  });
});

test("base64 <-> ArrayBuffer round trip", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66]);
  const b64 = S.arrayBufferToBase64(bytes.buffer);
  assert.deepEqual(new Uint8Array(S.base64ToArrayBuffer(b64)), bytes);
  // Every byte value has to survive, not just ASCII: these are PDF bytes.
  for (let i = 0; i < 256; i++) {
    const all = new Uint8Array([i]);
    assert.equal(S.arrayBufferToBase64(all.buffer), Buffer.from([i]).toString("base64"));
  }
});

test("loadBundledContext", async (t) => {
  await t.test("reads and trims the configured text file", async () => {
    const { loadBundledContext } = loadLib("schema.js", ["loadBundledContext"], {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "\n  standing notes  \n\n" })
    });
    const result = await loadBundledContext(makeSettings());
    assert.equal(result.text, "standing notes");
    assert.equal(result.error, null);
    assert.equal(result.path, "src/data/context.md");
  });

  await t.test("reports an unset path with the key to edit", async () => {
    const { loadBundledContext } = loadLib("schema.js", ["loadBundledContext"], {
      fetchImpl: async () => ({ ok: true, text: async () => "x" })
    });
    const result = await loadBundledContext(makeSettings({ contextFilePath: "" }));
    assert.equal(result.text, "");
    assert.match(result.error, /contextFilePath/);
  });

  await t.test("reports a missing or unreadable file without throwing", async () => {
    for (const impl of [async () => ({ ok: false, status: 500 }), async () => { throw new Error("offline"); }]) {
      const { loadBundledContext } = loadLib("schema.js", ["loadBundledContext"], { fetchImpl: impl });
      const result = await loadBundledContext(makeSettings());
      assert.equal(result.text, "");
      assert.ok(result.error.length > 0);
    }
  });

  await t.test("refuses a .json file", async () => {
    const { loadBundledContext } = loadLib("schema.js", ["loadBundledContext"], {
      fetchImpl: async () => ({ ok: true, text: async () => "{}" })
    });
    const result = await loadBundledContext(makeSettings({ contextFilePath: "src/data/settings.json" }));
    assert.match(result.error, /context\.md|context\.txt/);
  });
});

test("buildDraftContext", async (t) => {
  await t.test("puts the file first so the popup's per-application note reads last", () => {
    // The later, more specific word is the one a model follows.
    const merged = S.buildDraftContext("use a warmer tone", { text: "never invent metrics", path: "src/data/context.md" });
    const fileAt = merged.indexOf("never invent metrics");
    const typedAt = merged.indexOf("use a warmer tone");
    assert.ok(fileAt >= 0 && typedAt > fileAt, "typed context must come after file context");
  });

  await t.test("labels both sources so the model can tell them apart", () => {
    const merged = S.buildDraftContext("typed note", { text: "file note", path: "src/data/context.md" });
    assert.match(merged, /FROM src\/data\/context\.md:\nfile note/);
    assert.match(merged, /FROM THE AI CONTEXT BOX IN THE POPUP:\ntyped note/);
  });

  await t.test("uses the configured path when reporting the file", () => {
    const merged = S.buildDraftContext("", { text: "notes", path: "src/data/notes.txt" });
    assert.match(merged, /FROM src\/data\/notes\.txt/);
  });

  await t.test("returns only the typed box when there is no file", () => {
    const merged = S.buildDraftContext("just this", { text: "   ", path: "" });
    assert.equal(merged, "FROM THE AI CONTEXT BOX IN THE POPUP:\njust this");
  });

  await t.test("returns only the file when the popup box is empty", () => {
    const merged = S.buildDraftContext("   ", { text: "just this", path: "p.md" });
    assert.equal(merged, "FROM p.md:\njust this");
  });

  await t.test("is the empty string when there is nothing at all", () => {
    assert.equal(S.buildDraftContext("", { text: "", path: "" }), "");
    assert.equal(S.buildDraftContext(null, null), "");
    assert.equal(S.buildDraftContext(undefined, undefined), "");
  });
});

// ---------------------------------------------------------------------------
// FIELD_DICTIONARY integrity
//
// These are the tests that catch a new phrase silently breaking existing
// matches. Array order is load-bearing: an entry inserted too high steals labels
// from the entries below it, and nothing at runtime will complain.
// ---------------------------------------------------------------------------

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[*:]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("FIELD_DICTIONARY integrity", async (t) => {
  await t.test("every entry is well formed", () => {
    for (const entry of S.FIELD_DICTIONARY) {
      assert.equal(typeof entry.path, "string", "entry needs a path");
      assert.ok(entry.path.length > 0);
      assert.equal(typeof entry.sensitive, "boolean", `${entry.path} needs a boolean sensitive flag`);
      assert.ok(
        Array.isArray(entry.phrases) && entry.phrases.length > 0,
        `${entry.path} needs at least one phrase`
      );
      for (const phrase of entry.phrases) {
        assert.equal(typeof phrase, "string", `${entry.path} phrase must be a string`);
        assert.ok(phrase.trim().length > 0, `${entry.path} has an empty phrase`);
      }
      if (entry.exact !== undefined) {
        assert.ok(Array.isArray(entry.exact) && entry.exact.length > 0, `${entry.path} exact must be non-empty`);
      }
      if (entry.aliases !== undefined) {
        assert.equal(entry.aliases, true, `${entry.path} aliases must be true when present`);
      }
    }
  });

  await t.test("no entry repeats a path", () => {
    // Two entries for one path is almost always a copy-paste that silently
    // shadows the first.
    const paths = S.FIELD_DICTIONARY.map((e) => e.path);
    assert.deepEqual([...new Set(paths)], paths);
  });

  await t.test("every path exists in DEFAULT_PROFILE", () => {
    // getByPath returning undefined makes the entry permanently unmatched — a
    // phrase that can never fill anything.
    for (const entry of S.FIELD_DICTIONARY) {
      const value = entry.path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), S.DEFAULT_PROFILE);
      assert.notEqual(value, undefined, `${entry.path} is not a path in DEFAULT_PROFILE`);
    }
  });

  await t.test("every answers.* path is a real answers key", () => {
    for (const entry of S.FIELD_DICTIONARY) {
      if (!entry.path.startsWith("answers.")) continue;
      const key = entry.path.slice("answers.".length);
      assert.ok(key in S.DEFAULT_PROFILE.answers, `answers.${key} is not declared`);
      assert.notEqual(key, "", "answers. must name a key");
    }
  });

  await t.test("every indexed education/experience path resolves on the defaults", () => {
    for (const entry of S.FIELD_DICTIONARY) {
      if (!/^(education|experience|projects)\.\d+\./.test(entry.path)) continue;
      const value = entry.path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), S.DEFAULT_PROFILE);
      assert.notEqual(value, undefined, `${entry.path} does not resolve against DEFAULT_PROFILE`);
    }
  });

  await t.test("every phrase is reachable after label normalization", () => {
    // The matcher only ever sees a normalized label, so a phrase carrying
    // punctuation or capitals can never fire. Listing both spellings is fine as
    // long as the normalized form is covered by a sibling.
    for (const entry of S.FIELD_DICTIONARY) {
      const all = [...entry.phrases, ...(entry.exact || [])];
      const normalizedForms = new Set(all.map(normalize));
      for (const phrase of all) {
        const normalized = normalize(phrase);
        assert.ok(
          normalizedForms.has(normalized),
          `${entry.path}: "${phrase}" normalizes to "${normalized}", which no listed phrase covers — it can never match`
        );
      }
    }
  });

  await t.test("no phrase is a bare compound-substring trap", () => {
    // A single word in `phrases` also fires inside every label that merely
    // contains it as its own word. "name" is the canonical case and lives in
    // `exact` instead; guard the other bare-noun offenders.
    const bareNouns = new Set([
      "name", "title", "address", "email", "phone", "city", "state", "country",
      "race", "gender", "veteran", "disability", "sponsorship", "relocation",
      "skills", "college", "university", "school", "institution", "employer",
      "position", "degree", "major", "region", "town", "portfolio", "website"
    ]);
    for (const entry of S.FIELD_DICTIONARY) {
      for (const phrase of entry.phrases) {
        assert.ok(
          !bareNouns.has(normalize(phrase)),
          `${entry.path}: "${phrase}" should be in \`exact\` (or reworded), not \`phrases\``
        );
      }
    }
  });

  await t.test("every phrase resolves to its own entry, in the current order", () => {
    // The order-sensitive check. If a new entry is inserted above one that used
    // to win, its own phrase now resolves elsewhere and this fails.
    const { findDictionaryMatch } = loadLib("matcher.js", ["findDictionaryMatch"]);
    for (const entry of S.FIELD_DICTIONARY) {
      for (const phrase of [...(entry.exact || []), ...entry.phrases]) {
        const resolved = findDictionaryMatch(normalize(phrase), { tagName: "input" }, []);
        assert.ok(resolved, `${entry.path}: "${phrase}" matches nothing at all`);
        assert.equal(
          resolved.path,
          entry.path,
          `${entry.path}: label "${normalize(phrase)}" is claimed by ${resolved.path} instead`
        );
      }
    }
  });

  await t.test("entries marked exact are not also reachable as substrings", () => {
    // "name" must fire for "Name" and nothing else. If it also sat in phrases,
    // "Preferred Name" and "Employer Name" would receive the candidate's name.
    const { findDictionaryMatch } = loadLib("matcher.js", ["findDictionaryMatch"]);
    for (const entry of S.FIELD_DICTIONARY) {
      for (const phrase of entry.exact || []) {
        const compound = `${phrase} of something`;
        const resolved = findDictionaryMatch(normalize(compound), { tagName: "input" }, []);
        if (resolved) {
          assert.notEqual(
            resolved.path,
            entry.path,
            `${entry.path}: exact phrase "${phrase}" also fired inside "${compound}"`
          );
        }
      }
    }
  });

  await t.test("'name' reaches fullName and no compound name label does", () => {
    // The specific mistake this exact-tier design exists to prevent.
    const { findDictionaryMatch } = loadLib("matcher.js", ["findDictionaryMatch"]);
    const hit = (label) => {
      const found = findDictionaryMatch(normalize(label), { tagName: "input" }, []);
      return found && found.path;
    };
    assert.equal(hit("Name"), "personal.fullName");
    assert.equal(hit("Name *"), "personal.fullName");
    assert.equal(hit("Full Name"), "personal.fullName");
    assert.notEqual(hit("Preferred Name"), "personal.fullName");
    assert.notEqual(hit("Maiden Name"), "personal.fullName");
    assert.notEqual(hit("Project Name"), "personal.fullName");
    assert.notEqual(hit("Employer Name"), "personal.fullName");
    // ...and the compounds that do have their own answer still resolve.
    assert.equal(hit("Employer Name"), "experience.0.company");
    assert.equal(hit("First Name"), "personal.firstName");
    assert.equal(hit("Last Name"), "personal.lastName");
  });

  await t.test("specific ATS wording beats the generic word it contains", () => {
    // These long questions contain "country", "name" and "consent". Ordered
    // wrongly they would be answered "India" or the candidate's own name.
    const { findDictionaryMatch } = loadLib("matcher.js", ["findDictionaryMatch"]);
    const hit = (label) => {
      const found = findDictionaryMatch(normalize(label), { tagName: "select" }, []);
      return found && found.path;
    };
    assert.equal(
      hit("Do you currently hold permanent residence or citizenship in another country?"),
      "answers.otherCountryResidency"
    );
    assert.equal(
      hit("Do you hold citizenship in any of the countries listed?"),
      "answers.restrictedCountryCitizenship"
    );
    assert.equal(
      hit("In line with U.S. export control laws, read and consent to the terms and conditions"),
      "answers.exportControlConsent"
    );
    assert.equal(hit("Country of residence"), "personal.country");
  });

  await t.test("every answers.* entry is classified, and only howDidYouHear is public", () => {
    // A new answers.* entry must consciously choose sensitive or not. EEO and
    // eligibility answers are review-never-auto as policy, independent of which
    // table they sit in.
    const deliberate = new Set(["answers.howDidYouHear"]);
    for (const entry of S.FIELD_DICTIONARY) {
      if (!entry.path.startsWith("answers.")) continue;
      if (deliberate.has(entry.path)) {
        assert.equal(entry.sensitive, false, `${entry.path} is deliberately not sensitive`);
      } else {
        assert.equal(entry.sensitive, true, `${entry.path} must be marked sensitive`);
      }
    }
  });

  await t.test("no non-answers path is marked sensitive by accident", () => {
    // Only answers.* is review-gated; a stray sensitive flag on personal.email
    // would force the user to approve their own email address on every form.
    for (const entry of S.FIELD_DICTIONARY) {
      if (entry.path.startsWith("answers.")) continue;
      assert.equal(entry.sensitive, false, `${entry.path} should not be sensitive`);
    }
  });

  await t.test("every answers.* entry resolves its answer from the profile", async () => {
    // End-to-end proof the entry is wired to a real key: fill a field with each
    // entry's label and check a value comes back for a profile that has one.
    const { matchFields } = loadLib("matcher.js", ["matchFields"]);
    const profile = {
      personal: { fullName: "A B", firstName: "A", lastName: "B", email: "a@b.c", phone: "1", address: "x", city: "C", state: "S", country: "I", zip: "1" },
      links: { linkedin: "l", github: "g", portfolio: "p" },
      education: [{ degree: "B.Tech", field: "CS", institution: "AU" }],
      experience: [{ company: "Acme", title: "SWE", technologies: [] }],
      projects: [],
      skills: ["JS"],
      answers: Object.fromEntries(Object.keys(S.DEFAULT_PROFILE.answers).map((k) => [k, `answer-${k}`]))
    };
    for (const entry of S.FIELD_DICTIONARY) {
      const label = entry.phrases[0];
      const [row] = matchFields(
        [{ uid: `${entry.path}#${label}`, label, tagName: "input", inputType: "text", options: [] }],
        profile,
        []
      );
      assert.equal(row.matchedPath, entry.path, `label "${label}" should match ${entry.path}`);
      assert.ok(row.value.length > 0, `label "${label}" produced an empty value for ${entry.path}`);
    }
  });
});
