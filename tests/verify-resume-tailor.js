// Keyword extraction + matching — the piece resume tailoring is built on.
//
// The old "tailored resume" flow appended an "Additional Relevant Keywords"
// line to make the output differ from the input. That line is gone: matched
// keywords are now folded into the rewritten skills by resume-rewriter.js, so
// this file covers the extraction/matching that feeds it — what counts as a JD
// keyword, what the candidate's "truth" set is, and how matches/gaps split.
const fs = require("fs");
const path = require("path");
const { ROOT, makeContext, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("resume-tailor");

const ctx = makeContext();
load(ctx, "src/lib/resume-tailor.js");

const {
  extractKeywords,
  extractKeywordsLocal,
  analyzeMatch,
  buildTruthVocabulary,
  dedupeCaseInsensitive
} = take(
  ctx,
  "({ extractKeywords, extractKeywordsLocal, analyzeMatch, buildTruthVocabulary, dedupeCaseInsensitive })"
);

const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/profile.json"), "utf8"));

(async () => {
  console.log("--- the candidate's truth set comes from the profile ---");
  const truth = buildTruthVocabulary(profile);
  ok("includes a listed skill", truth.includes("Java"));
  ok("includes a technology from experience", truth.includes("MongoDB"));
  ok("does not invent unknown terms", !truth.includes("Kubernetes"));

  console.log("\n--- local extraction finds dictionary + profile terms in the JD ---");
  const jd =
    "We need Java, Spring Boot, Kubernetes, Rust and MongoDB experience. Own a core banking platform.";
  const local = extractKeywordsLocal(jd, profile);
  ok("Java found", local.includes("Java"));
  ok("Spring Boot found", local.includes("Spring Boot"));
  ok("Kubernetes found", local.includes("Kubernetes"));
  ok("MongoDB found", local.includes("MongoDB"));
  ok(
    "a JD-only phrase with no dictionary/profile backing is not invented",
    !local.some((t) => t.toLowerCase() === "core banking")
  );
  eq("no duplicate terms", local.length, new Set(local.map((t) => t.toLowerCase())).size);

  console.log("\n--- match splits JD keywords into matched vs. missing ---");
  const { matched, missing } = analyzeMatch(["Java", "Docker", "Kubernetes", "Rust"], profile);
  ok("Java is matched (real skill)", matched.includes("Java"));
  ok("Docker is matched", matched.includes("Docker"));
  ok("Kubernetes is a gap", missing.includes("Kubernetes"));
  ok("Rust is a gap", missing.includes("Rust"));

  console.log("\n--- extraction falls back to local when the LLM is off ---");
  const off = await extractKeywords(jd, profile, { useLLM: false });
  eq("same as the local pass", off, local);

  console.log("\n--- the LLM pass unions its terms with the local pass ---");
  ctx.configuredProviders = () => [{ id: "stub" }];
  ctx.sendProviderPrompt = async () => '["Core Banking", "Java"]';
  const union = await extractKeywords(jd, profile, { useLLM: true });
  ok("LLM-only term is added", union.includes("Core Banking"));
  ok("local terms are kept", union.includes("Kubernetes"));
  eq("overlap is de-duplicated", union.filter((t) => t.toLowerCase() === "java").length, 1);

  console.log("\n--- a failing LLM provider still yields the local result ---");
  ctx.sendProviderPrompt = async () => {
    throw new Error("boom");
  };
  const failed = await extractKeywords(jd, profile, { useLLM: true });
  eq("falls back to local terms", failed, local);

  console.log("\n--- case-insensitive de-dupe keeps the first spelling ---");
  eq("dedupe", dedupeCaseInsensitive(["Java", "java", "Node.js", "NODE.JS"]), ["Java", "Node.js"]);

  process.exit(done() ? 1 : 0);
})();
