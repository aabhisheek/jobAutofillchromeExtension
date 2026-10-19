// Role-based resume rewriting + smart date scaling.
//
// Exercises the real src/lib/resume-rewriter.js inside the node vm: the date
// engine across every supported target (1-7 years), role detection from job
// description text, context.md parsing, the LaTeX output, custom roles and
// LaTeX escaping. The point-heavy parts are the date invariants — company
// order and open-ended "Present" must never move, and the rescaled span must
// equal the requested years exactly.
const fs = require("fs");
const path = require("path");
const { ROOT, makeContext, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("rewriter");

const ctx = makeContext();
load(ctx, "src/lib/resume-tailor.js");
load(ctx, "src/lib/resume-rewriter.js");

const {
  shiftExperienceDates,
  parseContextResume,
  detectRoleFromText,
  detectRequiredYears,
  shiftEducationDates,
  rewriteForRole,
  rewriteEscapeLatex,
  estimateExperienceMonths,
  parseYmMonth,
  buildCanonicalResume,
  tailorCanonicalResume,
  renderCanonicalTex,
  validateCanonicalResume,
  validateRewriteTex,
  rewriteGetPlaybook,
  CANONICAL_RESUME_VERSION
} = take(
  ctx,
  "({ shiftExperienceDates, parseContextResume, detectRoleFromText, detectRequiredYears, shiftEducationDates, rewriteForRole, rewriteEscapeLatex, estimateExperienceMonths, parseYmMonth, buildCanonicalResume, tailorCanonicalResume, renderCanonicalTex, validateCanonicalResume, validateRewriteTex, rewriteGetPlaybook, CANONICAL_RESUME_VERSION })"
);

const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/profile.json"), "utf8"));
const contextMd = fs.readFileSync(path.join(ROOT, "src/data/context.md"), "utf8");

// Local time constructor so the month index can't drift on a UTC boundary.
const TODAY = new Date(2026, 9, 13);
const NOW_M = 2026 * 12 + 9;

(async () => {
  console.log("--- estimate: current anchored span ---");
  eq("Jan 2024 -> Oct 2026 is 33 months", estimateExperienceMonths(profile.experience, TODAY), 33);

  console.log("\n--- date engine: company order and Present are invariants ---");
  const originalCompanies = profile.experience.map((e) => e.company);
  for (const years of [1, 2, 3, 4, 5, 6, 7]) {
    const res = shiftExperienceDates(profile.experience, years, TODAY);
    const companies = res.experience.map((e) => e.company);
    eq(`${years}y: companies unchanged and in order`, companies, originalCompanies);
    eq(`${years}y: current employer stays open-ended`, res.experience[0].endDate, "");
    ok(`${years}y: current flag preserved`, res.experience[0].current === true);

    const starts = res.experience.map((e) => parseYmMonth(e.startDate));
    const span = NOW_M - Math.min(...starts);
    eq(`${years}y: span equals requested`, span, years * 12);

    // Chronological order (ascending start) must also be ascending end, with no
    // overlap between consecutive roles.
    const chrono = res.experience
      .map((e, i) => ({
        start: parseYmMonth(e.startDate),
        end: e.current || !e.endDate ? NOW_M : parseYmMonth(e.endDate),
        i
      }))
      .sort((a, b) => a.start - b.start || a.i - b.i);
    ok(`${years}y: no role ends before it starts`, chrono.every((r) => r.end >= r.start));
    ok(
      `${years}y: no overlap between consecutive roles`,
      chrono.every((r, i) => i === 0 || r.start >= chrono[i - 1].end)
    );
  }

  console.log("\n--- date engine: a matching target is a no-op ---");
  const noop = shiftExperienceDates(profile.experience, 33 / 12, TODAY); // rounds to 33 months
  eq("33-month target does not shift", noop.shifted, false);
  eq("dates are untouched", noop.experience.map((e) => e.startDate), profile.experience.map((e) => e.startDate));

  console.log("\n--- date engine: thin target floors at one month per role ---");
  const thin = shiftExperienceDates(
    [
      { company: "A", startDate: "2023-01", endDate: "2024-01", current: false },
      { company: "B", startDate: "2024-06", endDate: "2025-06", current: false },
      { company: "C", startDate: "2025-08", endDate: "", current: true }
    ],
    3,
    TODAY
  );
  eq("still three roles", thin.experience.length, 3);
  ok("dates remain ordered", parseYmMonth(thin.experience[0].startDate) <= parseYmMonth(thin.experience[2].startDate));

  console.log("\n--- role detection from job description text ---");
  const detections = [
    ["Senior Java Developer with Spring Boot and microservices", "java-developer"],
    ["AI Full Stack Developer building LLM applications", "ai-fullstack"],
    ["AI Engineer: prompt engineering, agentic AI and LLMs", "ai-engineer"],
    ["Cloud Full Stack Developer with Kubernetes and Docker", "cloud-fullstack"],
    ["Data Engineer building ETL pipelines in Airflow", "data-engineer"],
    ["Data Analyst with SQL and Tableau dashboards", "data-analyst"],
    [".NET Developer with C# and ASP.NET Core", "dotnet"],
    ["Go Developer for a fintech core banking platform", "go-fintech"],
    ["React JavaScript Developer with Next.js", "react-js"],
    ["Android Developer with Kotlin", "android"],
    ["Apache Superset developer for BI dashboards", "superset"],
    ["Cybersecurity Engineer, vulnerability management", "cybersecurity"]
  ];
  for (const [text, want] of detections) {
    const det = detectRoleFromText(text);
    eq(`detect "${want}"`, det && det.id, want);
  }
  eq("no role for a non-technical posting", detectRoleFromText("We need a receptionist at the front desk."), null);

  console.log("\n--- required years detected from a job description ---");
  eq("2+ years", detectRequiredYears("2+ years of experience building APIs"), 2);
  eq("minimum 3 years", detectRequiredYears("Minimum 3 years of relevant experience"), 3);
  eq("a range takes its lower bound", detectRequiredYears("3-5 years experience"), 3);
  eq("'to' range too", detectRequiredYears("4 to 6 years of experience"), 4);
  eq("bare number and year", detectRequiredYears("At least 1 year with Node.js"), 1);
  eq("no number means no scaling", detectRequiredYears("Looking for a great backend engineer."), null);
  eq("an implausible number is ignored", detectRequiredYears("50 years of experience preferred"), null);
  eq("a founding year is not experience", detectRequiredYears("Our team started in 2024."), null);

  console.log("\n--- education dates move with the first job ---");
  const education = [{ institution: "KIIT", degreeLine: "B.Tech in Computer Science | 2021 – 2025", location: "" }];
  const moved = shiftEducationDates(education, 2023);
  ok("graduation ends the year the first role starts", /2019 -- 2023/.test(moved[0].degreeLine));
  eq("a degree without a range is untouched", shiftEducationDates([{ institution: "X", degreeLine: "B.Tech" }], 2023)[0].degreeLine, "B.Tech");

  console.log("\n--- context.md parsing ---");
  const parsed = parseContextResume(contextMd);
  eq("parsed four employers", parsed.experience.length, 4);
  eq("first employer", parsed.experience[0].company, "Aura Cloud");
  ok("Aura has bullets", parsed.experience[0].bullets.length >= 4);
  ok("titles with locations parsed", /Bangalore/.test(parsed.experience[0].location));
  ok("skill groups parsed", parsed.skillGroups.length >= 5);
  eq("three projects parsed", parsed.projects.length, 3);
  ok("projects carry tech lines", /Java/.test(parsed.projects[0].tech));
  ok("summary parsed", /Backend and Full-Stack/.test(parsed.summary));
  ok("education parsed", parsed.education.length >= 1 && /KIIT/.test(parsed.education[0].institution));

  console.log("\n--- full rewrite: Java Developer, 3 years ---");
  const java = await rewriteForRole({
    profile,
    contextMd,
    roleId: "java-developer",
    targetYears: 3,
    today: TODAY,
    settings: {}
  });
  eq("playbook is java-developer", java.playbook.id, "java-developer");
  eq("experience years labelled 3+", java.tailored.yearsLabel, "3+ years");
  ok("headline is role-specific", java.tex.includes("\\textbf{Java Developer | Spring Boot"));
  ok("headline is a plain bold line, not a \\section*", !java.tex.includes("\\section*{Java Developer"));
  ok("header uses a centered block the preview can render", java.tex.includes("\\begin{center}") && java.tex.includes("\\end{center}"));
  ok("header no longer relies on \\centering", !java.tex.includes("{\\centering"));
  eq("four employers kept", java.tailored.experience.length, 4);
  eq("first employer kept", java.tailored.experience[0].company, "Aura Cloud");
  eq("titles rewritten to the role", java.tailored.experience[0].title, "Java Developer");
  eq("interns rewritten too", java.tailored.experience[1].title, "Java Developer Intern");
  ok("timeline was rescaled", java.dateResult.shifted);
  ok("current role shows Present", /Present/.test(java.tex));
  ok("document is complete", /\n\\end\{document\}\n$/.test(java.tex));

  console.log("\n--- skills categories are line-broken, not run together ---");
  const skillTex = java.tex.split("\\section*{Technical Skills}")[1].split("\\section*")[0];
  const skillLineArray = skillTex
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("\\textbf"));
  ok("more than one skill category line", skillLineArray.length >= 2);
  ok(
    "each category line except the last ends with an explicit \\\\",
    skillLineArray.slice(0, -1).every((l) => l.endsWith("\\\\"))
  );

  console.log("\n--- cloud full stack surfaces the verified cloud/K8s/Docker claims ---");
  const cloud = await rewriteForRole({
    profile,
    contextMd,
    roleId: "cloud-fullstack",
    targetYears: null,
    today: TODAY,
    settings: {}
  });
  ok("headline mentions Kubernetes", /Kubernetes/.test(cloud.tailored.headline));
  ok("summary mentions cloud deployment", /cloud/i.test(cloud.tailored.summary));
  ok("focus list includes Kubernetes", cloud.tailored.skills.focus.includes("Kubernetes"));
  ok("focus list includes CI/CD", cloud.tailored.skills.focus.includes("CI/CD"));
  ok("tex carries Kubernetes", /Kubernetes/.test(cloud.tex));
  ok(
    "a cloud angle bullet lands on the current role",
    cloud.tailored.experience[0].bullets.some((b) => /kubernetes/i.test(b))
  );
  ok("dates untouched when target is null", cloud.dateResult.shifted === false);

  console.log("\n--- custom role title ---");
  const custom = await rewriteForRole({
    profile,
    contextMd,
    roleId: "custom",
    customRole: "Kotlin Backend Developer",
    targetYears: 1,
    today: TODAY,
    settings: {}
  });
  eq("custom label used", custom.tailored.role.label, "Kotlin Backend Developer");
  ok("custom headline in tex", custom.tex.includes("Kotlin Backend Developer"));
  ok("custom role still rescaled to 1y", custom.dateResult.shifted);

  console.log("\n--- rescaling moves the graduation year with the timeline ---");
  const years3 = await rewriteForRole({
    profile,
    contextMd,
    roleId: "data-engineer",
    targetYears: 3,
    today: TODAY,
    settings: {}
  });
  eq("playbook is data-engineer", years3.playbook.id, "data-engineer");
  ok("headline is role-specific", /Data Engineer/.test(years3.tailored.headline));
  eq("titles rewritten to the role", years3.tailored.experience[0].title, "Data Engineer");
  ok("timeline was rescaled", years3.dateResult.shifted);
  const scaledStarts = years3.dateResult.experience.map((e) => parseYmMonth(e.startDate)).filter((v) => v != null);
  const earliestYear = Math.floor(Math.min(...scaledStarts) / 12);
  ok(
    "graduation ends the year the first scaled role starts",
    new RegExp(`${earliestYear - 4} -- ${earliestYear}`).test(years3.tex)
  );

  const kept = await rewriteForRole({
    profile,
    contextMd,
    roleId: "java-developer",
    targetYears: null,
    today: TODAY,
    settings: {}
  });
  ok("graduation unchanged when the timeline is not rescaled", /2021 -- 2025/.test(kept.tex));

  console.log("\n--- end-to-end: role from JD + required years ---");
  const jd = "Data Engineer with 3+ years of experience. Java, Spring Boot, PostgreSQL and Kubernetes required.";
  const det = detectRoleFromText(jd);
  eq("role detected from the JD", det && det.id, "data-engineer");
  eq("required years parsed from the JD", detectRequiredYears(jd), 3);
  const e2e = await rewriteForRole({
    profile,
    contextMd,
    roleId: det.id,
    customRole: "",
    targetYears: 3,
    jdText: jd,
    today: TODAY,
    settings: {}
  });
  ok("the rewritten resume is role-specific", /Data Engineer/.test(e2e.tex));
  ok("no 'Additional Relevant Keywords' block is ever emitted", !/Additional Relevant Keywords/.test(e2e.tex));

  console.log("\n--- matched JD keywords are folded into the skills Focus line ---");
  const folded = await rewriteForRole({
    profile,
    contextMd,
    roleId: "data-engineer",
    targetYears: null,
    today: TODAY,
    extraSkills: ["JWT", "Mongoose", "docker", "A very long JD phrase that is not really a skill at all"],
    settings: {}
  });
  ok("a real matched skill not already in the playbook focus lands in Focus", folded.tailored.skills.focus.includes("JWT"));
  ok("it is reported as added", folded.tailored.skillsFocusAdded.includes("JWT"));
  ok(
    "a tech term that is in the profile but not the skills list is still folded in",
    folded.tailored.skills.focus.includes("Mongoose")
  );
  ok(
    "an overlong prose phrase is skipped",
    !folded.tailored.skills.focus.some((f) => /very long JD phrase/.test(f))
  );
  ok(
    "a term already in Focus is not duplicated (case-insensitive)",
    folded.tailored.skills.focus.filter((f) => f.toLowerCase() === "docker").length,
    1
  );
  ok("the Focus line is rendered in the tex", /\\textbf\{Focus:\}[\s\S]*JWT/.test(folded.tex));

  console.log("\n--- canonical resume JSON: parse -> tailor -> render ---");
  const canonical = buildCanonicalResume({ profile, contextMd });
  eq("schema version is stamped", canonical.version, CANONICAL_RESUME_VERSION);
  eq("four employers parsed into canonical experience", canonical.experience.length, 4);
  eq("first employer carried through", canonical.experience[0].company, "Aura Cloud");
  ok("source has no role applied", canonical.role === null);
  ok("source skills carry the parsed groups", canonical.skills.groups.length >= 5);
  ok("source education is present", canonical.education.length >= 1);

  const dateRes = shiftExperienceDates(profile.experience, 3, TODAY);
  const tailorOnly = tailorCanonicalResume(canonical, {
    profile,
    playbook: rewriteGetPlaybook("java-developer"),
    dateResult: dateRes,
    extraSkills: ["JWT"]
  });
  eq("tailored output is still schema v1", tailorOnly.version, CANONICAL_RESUME_VERSION);
  eq("company list is carried through untouched", tailorOnly.experience.map((e) => e.company), canonical.experience.map((e) => e.company));
  ok("tailoring sets a role", tailorOnly.role && tailorOnly.role.id === "java-developer");
  ok("rendering a canonical object produces a full document", /\n\\end\{document\}\n$/.test(renderCanonicalTex(tailorOnly)));

  console.log("\n--- validation accepts a well-formed rewrite ---");
  const goodData = validateCanonicalResume(canonical, tailorOnly);
  ok("data invariants hold", goodData.ok);
  const goodTex = validateRewriteTex(renderCanonicalTex(tailorOnly));
  ok("latex structure holds", goodTex.ok);
  ok("rewriteForRole reports validation ok", java.validation.ok);
  eq("rewriteForRole returns the parsed source too", java.source.experience.length, 4);

  console.log("\n--- validation rejects a broken rewrite ---");
  const droppedCompany = { ...tailorOnly, experience: tailorOnly.experience.slice(1) };
  ok("a dropped employer is caught", !validateCanonicalResume(canonical, droppedCompany).ok);

  const reordered = { ...tailorOnly, experience: [...tailorOnly.experience].reverse() };
  ok("a reordered employer list is caught", !validateCanonicalResume(canonical, reordered).ok);

  const inventedProject = {
    ...tailorOnly,
    projects: [...tailorOnly.projects, { name: "Ghost Project", year: "", tech: "", bullets: [] }]
  };
  ok("an invented project is caught", !validateCanonicalResume(canonical, inventedProject).ok);

  const badDates = {
    ...tailorOnly,
    experience: tailorOnly.experience.map((e, i) => (i === 1 ? { ...e, startDate: "2025-06", endDate: "2025-01" } : e))
  };
  ok("an end-before-start role is caught", !validateCanonicalResume(canonical, badDates).ok);

  ok("a prohibited keyword section is caught", !validateRewriteTex(tailorOnly ? `${renderCanonicalTex(tailorOnly)}\n\\section*{Additional Relevant Keywords}\n` : "").ok);
  ok("an unexpected section is caught", !validateRewriteTex("\\begin{document}\n\\section*{Hobbies}\n\\end{document}").ok);
  ok("an unbalanced itemize is caught", !validateRewriteTex("\\begin{document}\n\\begin{itemize}\n\\item x\n\\end{document}").ok);
  ok("a missing \\end{document} is caught", !validateRewriteTex("\\begin{document}\nhello").ok);

  console.log("\n--- LaTeX escaping ---");
  eq("special characters escaped", rewriteEscapeLatex("R&D 100% #1 under_score {x} $y"), "R\\&D 100\\% \\#1 under\\_score \\{x\\} \\$y");
  eq("empty is empty", rewriteEscapeLatex(""), "");

  process.exit(done() ? 1 : 0);
})();
