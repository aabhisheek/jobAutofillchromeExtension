// Country / dial-code option matching.
//
// The bug this covers: a profile saying country "India" selecting
// "British India" or "British Indian Ocean Territory" out of a country list,
// because both contain the substring "india" — and country lists sort those
// entries ahead of the real one. The rules that decide (standaloneMatch, the
// matchOption pass order, and the radio-group PREDICATES) are lifted out of
// fillFormFields the way verify-frames.js lifts describeFrames, so the
// shipped source is what runs.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, expect } = require("./harness");

const pageScripts = fs.readFileSync(path.join(ROOT, "src/lib/page-scripts.js"), "utf8");

// standaloneMatch sits directly above matchOption; together they run from the
// helper to the banner of the section that follows matchOption.
const fillBanner = pageScripts.indexOf("// FILL A CUSTOM DROPDOWN");
const sectionStart = pageScripts.lastIndexOf("// ==========", fillBanner);
const optionSrc = pageScripts.slice(
  pageScripts.indexOf("function standaloneMatch"),
  sectionStart
);

const predicatesAt = pageScripts.indexOf("const PREDICATES = [");
const predicatesSrc = pageScripts.slice(
  predicatesAt,
  pageScripts.indexOf("];", predicatesAt) + 2
);

const ctx = vm.createContext({});
vm.runInContext(
  "function textOf(el) { return String((el && el.textContent) || \"\").replace(/\\s+/g, \" \").trim(); }",
  ctx
);
vm.runInContext(optionSrc, ctx, { filename: "page-scripts.js#matchOption" });
vm.runInContext(predicatesSrc, ctx, { filename: "page-scripts.js#PREDICATES" });

// matchOption over options given as plain texts; returns the picked text or
// null, the way the filler would see it.
const pick = (options, wanted) =>
  vm.runInContext(
    `(() => {
      const texts = ${JSON.stringify(options)};
      const opts = texts.map((t) => ({ textContent: t }));
      const hit = matchOption(opts, ${JSON.stringify(wanted)});
      return hit ? hit.textContent : null;
    })()`,
    ctx
  );

// The radio-group loop from fillFormFields, verbatim in shape: per wanted
// text, the PREDICATES in order, first hit wins.
const tick = (options, wanted) =>
  vm.runInContext(
    `(() => {
      const texts = ${JSON.stringify(options)}.map((t) => t.toLowerCase());
      const wants = ${JSON.stringify(wanted)}.map((v) => String(v).toLowerCase()).filter(Boolean);
      const picked = [];
      const taken = new Set();
      for (const want of wants) {
        let found = -1;
        for (const predicate of PREDICATES) {
          const index = texts.findIndex((t, i) => !taken.has(i) && predicate(t, want));
          if (index !== -1) { found = index; break; }
        }
        if (found === -1) continue;
        taken.add(found);
        picked.push(${JSON.stringify(options)}[found]);
        break;
      }
      return picked[0] || null;
    })()`,
    ctx
  );

const { eq, ok, done } = expect("country");

// ---- the reported bug ----

eq("exact India wins even when British India is listed first",
  pick(["British India", "India"], ["india"]), "India");

eq("British India is never picked for an answer of India",
  pick(["British India", "British Indian Ocean Territory"], ["india"]), null);

eq("a decorated India is picked over British India (British listed first)",
  pick(["British India", "\u{1F1EE}\u{1F1F3} India"], ["india"]), "\u{1F1EE}\u{1F1F3} India");

eq("...and with the flag row first",
  pick(["\u{1F1EE}\u{1F1F3} India", "British India"], ["india"]), "\u{1F1EE}\u{1F1F3} India");

eq("prefix form wins: India (IN)",
  pick(["British India", "India (IN)"], ["india"]), "India (IN)");

eq("the prefix rule still prefers the real entry over a buried one",
  pick(["Sikkim (India)", "India (IN)"], ["india"]), "India (IN)");

eq("a fragment of a longer name is not an answer: Indian Ocean Territory",
  pick(["Indian Ocean Territory"], ["india"]), null);

eq("nor is a name India only appears inside of",
  pick(["Republic of India"], ["india"]), null);

// ---- the loose match the standalone rule exists to preserve ----

eq("a word inside a sentence still matches",
  pick(["Yes — authorized to work"], ["authorized"]), "Yes — authorized to work");

eq("Yes still matches Yes, I am willing",
  pick(["Yes, I am willing"], ["yes"]), "Yes, I am willing");

eq("No no longer matches None",
  pick(["None"], ["no"]), null);

// ---- dial codes: the OR the country answer also accepts ----

eq("the +91 alias satisfies a dial-code select",
  pick(["+44 United Kingdom", "+91 India"], ["india", "+91", "91"]), "+91 India");

eq("a bare code row is matched by its own alias",
  pick(["44", "91"], ["india", "+91", "91"]), "91");

eq("a name after a code is found without any code alias",
  pick(["+1 Canada", "+1 United States"], ["united states", "+1"]), "+1 United States");

eq("the United States answer does not fall into India's 91 code",
  pick(["91 (India)", "1 (United States)"], ["united states", "+1", "1"]), "1 (United States)");

// ---- the same rules on radio / checkbox groups ----

eq("radio group picks the real India",
  tick(["British India", "India"], ["india"]), "India");

eq("radio group refuses British India",
  tick(["British India"], ["india"]), null);

eq("radio group accepts the +91 alias",
  tick(["British India", "+91 India"], ["india", "+91", "91"]), "+91 India");

ok("the pieces under test were found in the shipped source",
  optionSrc.includes("function standaloneMatch") &&
  optionSrc.includes("function matchOption") &&
  predicatesSrc.includes("standaloneMatch(text, want)"));

process.exit(done());
