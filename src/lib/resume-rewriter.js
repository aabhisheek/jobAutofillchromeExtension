// Role-based resume rewriting + smart experience-date scaling.
//
// Two independent capabilities, composed by rewriteForRole():
//
// 1. Date engine (deterministic, no network). Given a target "years of
//    experience" (1-7), the whole employment timeline is rescaled so the span
//    from the first start date to today equals that many years. Role durations
//    and gaps keep their proportions, "Present" for the current employer stays
//    anchored to today, and the company list/order never changes. This is what
//    makes one base resume answer "3 years" and "6 years" applications alike.
//
// 2. Role playbooks. Each supported target role (Java Developer, AI Full Stack
//    Developer, Cloud Full Stack Developer, Data Engineer, …) carries a
//    headline, summary framing, skill emphasis, job titles and "angle bullets".
//    Angle bullets and the cloud/Kubernetes/Docker claims are the one place this
//    file asserts facts beyond the base resume — they are user-verified truths
//    the user asked to be surfaced for those roles (e.g. cloud deployment,
//    Kubernetes and Docker for the cloud-fullstack role). Everything else —
//    companies, dates, locations, base bullets — is copied from the candidate's
//    own profile.json / context.md, only ever reordered or reframed, never
//    invented.
//
// An optional LLM polish pass (settings.useLLM + settings.rewritePolish) can
// rephrase the wording of bullets toward the role/JD language. It never sees
// companies or dates and may only use technologies already present in the
// tailored output, so it cannot fabricate employers, timelines or stacks.
//
// Runs in the resume tab (chrome-extension:// page). Pure functions take their
// inputs as arguments so the whole file is testable under tests/harness.js.

// ---- Role playbooks -------------------------------------------------------
// Order matters: detection ties go to the earlier entry, so the most specific
// roles are listed ahead of the generic fullstack/backend fallbacks.
const REWRITE_ROLE_PLAYBOOKS = [
  {
    id: "ai-fullstack",
    label: "AI Full Stack Developer",
    title: "AI Full Stack Developer",
    headline: "AI Full Stack Developer | LLM Applications, Spring Boot & React",
    summaryBody:
      "building full-stack applications on a strong backend foundation (Java, Spring Boot, Node.js, Express.js) with Generative AI capabilities — LLM applications, AI agents and prompt engineering — delivering end-to-end features from REST APIs and databases to React/Next.js interfaces.",
    skillFocus: ["Generative AI", "Agentic AI", "LLM Applications", "Prompt Engineering", "Java", "Spring Boot", "Node.js", "Express.js", "React", "Next.js", "REST APIs", "Docker"],
    verifiedSkills: [],
    angleBullets: [
      "Apply Generative AI, Agentic AI and LLM tooling with prompt engineering to backend and full-stack delivery."
    ],
    projectAngle: "Extended with Generative AI / LLM experimentation (prompt engineering).",
    keywordTags: ["ai", "llm", "generative", "agentic", "prompt", "agent", "full stack", "react", "spring"],
    match: [[/ai\s*full[\s-]?stack/i, 5], [/full[\s-]?stack[^\n]{0,40}\bai\b/i, 3], [/\bgenai\b|generative\s*ai/i, 2]]
  },
  {
    id: "cloud-fullstack",
    label: "Cloud Full Stack Developer",
    title: "Cloud Full Stack Developer",
    headline: "Cloud Full Stack Developer | Cloud Deployment, Docker & Kubernetes",
    summaryBody:
      "building and deploying full-stack applications to the cloud. Strong backend (Java, Spring Boot, Node.js, Express.js) and frontend (React, Next.js) skills with hands-on containerization using Docker, orchestration using Kubernetes and cloud deployment through CI/CD pipelines for production-ready services.",
    skillFocus: ["Docker", "Kubernetes", "CI/CD", "Cloud Deployment", "Java", "Spring Boot", "Node.js", "React", "Next.js", "REST APIs", "PostgreSQL"],
    // User-verified facts the base resume does not spell out: cloud deployment,
    // Kubernetes and CI/CD pipelines (Docker is already a real skill).
    verifiedSkills: ["Kubernetes", "CI/CD", "Cloud Deployment"],
    angleBullets: [
      "Deployed and operated services in the cloud using Docker and Kubernetes, with CI/CD pipelines for production-ready releases.",
      "Built cloud-hosted backend services for a cloud-based core banking platform."
    ],
    projectAngle: "Containerized with Docker and deployed via CI/CD for cloud delivery.",
    keywordTags: ["cloud", "docker", "kubernetes", "deploy", "ci/cd", "core banking", "production", "devops"],
    match: [[/cloud\s*(?:full[\s-]?stack|engineer|developer)/i, 4], [/\bkubernetes\b|\bk8s\b/i, 3], [/\baws\b|\bazure\b|\bgcp\b/i, 2], [/cloud[\s-]?based|cloud[\s-]?native|cloud\s*platform/i, 2], [/\bdocker\b/i, 1], [/devops/i, 1]]
  },
  {
    id: "go-fintech",
    label: "Go / FinTech Developer",
    title: "Go Developer",
    headline: "Go / FinTech Developer | Go, Gin & Cloud Core Banking",
    summaryBody:
      "building high-throughput backend services in Go (Gin, goroutines, channels, concurrency) for fintech systems, including a cloud-based core banking platform used by financial institutions, with SQL databases and REST API design.",
    skillFocus: ["Go (Golang)", "Gin", "Goroutines & Channels", "Concurrency", "Java", "Spring Boot", "PostgreSQL", "Docker", "REST APIs", "Microservices"],
    verifiedSkills: [],
    angleBullets: [
      "Develop Go backend services (Gin, goroutines, channels) for a cloud-based core banking platform serving financial institutions."
    ],
    projectAngle: "",
    keywordTags: ["go", "golang", "gin", "concurrency", "goroutine", "banking", "fintech", "core banking"],
    match: [[/go\s*developer|golang/i, 4], [/\bfin ?tech\b/i, 4], [/\bcore\s*banking\b/i, 3], [/\bbanking\b/i, 1], [/\bgin\b/i, 1]]
  },
  {
    id: "data-engineer",
    label: "Data Engineer",
    title: "Data Engineer",
    headline: "Data Engineer | SQL, PostgreSQL, MySQL & Data Pipelines",
    summaryBody:
      "working with relational data — PostgreSQL and MySQL schema design, SQL query writing and optimization, and reliable data flows feeding backend services and reporting, built on Java/Python services.",
    skillFocus: ["SQL", "PostgreSQL", "MySQL", "MongoDB", "Schema Design", "Query Optimization", "Data Modeling", "Java", "Python", "Docker"],
    verifiedSkills: [],
    angleBullets: [
      "Design and optimize SQL queries and relational schemas in PostgreSQL and MySQL for reliable data flows."
    ],
    projectAngle: "",
    keywordTags: ["sql", "postgres", "mysql", "schema", "database", "query", "optimiz", "pipeline", "etl", "data"],
    match: [[/data\s*engineer/i, 5], [/data\s*warehouse|data\s*pipeline/i, 3], [/\betl\b/i, 2], [/\bairflow\b/i, 2], [/\bspark\b/i, 2]]
  },
  {
    id: "data-analyst",
    label: "Data Analyst",
    title: "Data Analyst",
    headline: "Data Analyst | SQL, PostgreSQL & Product Analytics",
    summaryBody:
      "turning data into decisions: SQL query writing and optimization across PostgreSQL and MySQL, relational schema design, and product analytics including GTM/GA4 event tracking.",
    skillFocus: ["SQL", "PostgreSQL", "MySQL", "Data Modeling", "Analytics", "GTM / GA4 Event Tracking", "Reporting", "Python"],
    verifiedSkills: [],
    angleBullets: [
      "Track and analyze product usage events via GTM/GA4 and back analytics with optimized SQL queries."
    ],
    projectAngle: "",
    keywordTags: ["sql", "analytics", "ga4", "gtm", "report", "data", "tracking", "dashboard", "bi"],
    match: [[/data\s*analyst/i, 5], [/tableau|power\s*bi|looker/i, 2], [/dashboard/i, 1], [/\bbi\b|business\s*intelligence/i, 1]]
  },
  {
    id: "cybersecurity",
    label: "Cybersecurity Engineer",
    title: "Cybersecurity Engineer",
    headline: "Cybersecurity Engineer | Spring Security, JWT, Okta & Secure APIs",
    summaryBody:
      "building secure backend systems: authentication and authorization with Spring Security, JWT and Okta, role-based access control, secure API design and production incident debugging.",
    skillFocus: ["Spring Security", "JWT", "Okta", "Role-Based Access Control", "Secure API Design", "Linux", "Docker", "Java"],
    verifiedSkills: [],
    angleBullets: [
      "Implement authentication and authorization using Spring Security, JWT and Okta with role-based access control."
    ],
    projectAngle: "",
    keywordTags: ["security", "jwt", "okta", "auth", "rbac", "role-based", "secure", "vulnerability"],
    match: [[/cyber\s*security|cybersecurity|info\s*sec/i, 5], [/security\s*engineer/i, 3], [/vulnerability/i, 2], [/penetration|pentest/i, 2]]
  },
  {
    id: "superset",
    label: "Apache Superset Developer",
    title: "Superset Developer",
    headline: "Apache Superset Developer | SQL Analytics & Data Visualization",
    summaryBody:
      "building analytics on SQL data sources — PostgreSQL/MySQL query design and optimization, relational modeling, and product event tracking (GTM/GA4) ready for visualization tools like Apache Superset.",
    skillFocus: ["SQL", "PostgreSQL", "MySQL", "Data Modeling", "Analytics", "GTM / GA4 Event Tracking", "Reporting"],
    verifiedSkills: [],
    angleBullets: [
      "Prepare analytics-ready SQL datasets (PostgreSQL/MySQL) and track product events (GTM/GA4) for dashboarding."
    ],
    projectAngle: "",
    keywordTags: ["sql", "data", "analytics", "dashboard", "tracking", "schema", "report", "superset"],
    match: [[/superset/i, 5]]
  },
  {
    id: "android",
    label: "Android Developer",
    title: "Android Developer",
    headline: "Android Developer | Java, REST APIs & React",
    summaryBody:
      "building mobile-ready applications with Java fundamentals, REST API integration and React-based client UIs, with a focus on clean API contracts and secure authentication.",
    skillFocus: ["Java", "REST APIs", "React", "JavaScript", "HTML", "CSS", "JWT"],
    verifiedSkills: [],
    angleBullets: [
      "Deliver mobile-ready features: Java-based logic and REST API integration consumed by React client UIs."
    ],
    projectAngle: "",
    keywordTags: ["java", "api", "react", "client", "mobile", "android"],
    match: [[/android/i, 4], [/\bkotlin\b/i, 2], [/mobile\s*developer/i, 3]]
  },
  {
    id: "dotnet",
    label: ".NET Developer",
    title: ".NET Developer",
    headline: ".NET Developer | Object-Oriented Design, REST APIs & SQL",
    summaryBody:
      "building object-oriented, layered backend applications with strong design-pattern fundamentals, REST API development and SQL databases — skills that transfer directly to the .NET/C# ecosystem.",
    skillFocus: ["Object-Oriented Programming", "Design Patterns", "REST APIs", "SQL", "PostgreSQL", "MySQL", "JavaScript"],
    verifiedSkills: [],
    angleBullets: [
      "Object-oriented backend development in layered architectures using design patterns, REST APIs and SQL databases."
    ],
    projectAngle: "",
    keywordTags: ["object-oriented", "design pattern", "rest", "sql", "layered", "api", "c#"],
    match: [[/\.net\b|\bdotnet\b/i, 4], [/\bc#\b/i, 3], [/asp\.net/i, 3], [/entity\s*framework/i, 2]]
  },
  {
    id: "react-js",
    label: "React / JavaScript Developer",
    title: "React Developer",
    headline: "React / JavaScript Developer | React, Next.js & TypeScript",
    summaryBody:
      "building interactive web applications with React, Next.js, JavaScript and TypeScript, integrated with REST APIs, JWT authentication and MongoDB/PostgreSQL backends.",
    skillFocus: ["React", "Next.js", "JavaScript", "TypeScript", "HTML", "CSS", "REST APIs", "Node.js", "Express.js", "MongoDB"],
    verifiedSkills: [],
    angleBullets: [
      "Built and integrated React/Next.js frontends with REST APIs, JWT-protected routes and form/data rendering."
    ],
    projectAngle: "",
    keywordTags: ["react", "next", "javascript", "frontend", "ui", "component"],
    match: [[/react/i, 3], [/\bnext\.?js\b/i, 2], [/javascript/i, 2], [/typescript/i, 1]]
  },
  {
    id: "java-developer",
    label: "Java Developer",
    title: "Java Developer",
    headline: "Java Developer | Spring Boot, Microservices & REST APIs",
    summaryBody:
      "building backend services and REST APIs using Java, Spring Boot, Spring Data JPA, Hibernate and SQL databases. Experienced in authentication and authorization (Spring Security, JWT), production debugging and Agile delivery, including Java and Spring Boot services for a cloud-based core banking platform.",
    skillFocus: ["Java", "Spring Boot", "Spring Data JPA", "Hibernate", "Spring Security", "REST APIs", "Microservices", "SQL", "PostgreSQL", "MySQL", "Docker"],
    verifiedSkills: [],
    angleBullets: [],
    projectAngle: "",
    keywordTags: ["java", "spring", "jpa", "hibernate", "sql", "microservice"],
    match: [[/spring\s*boot/i, 3], [/\bjava\b/i, 2], [/spring\s*security/i, 1], [/\bhibernate\b/i, 1]]
  },
  {
    id: "ai-engineer",
    label: "AI Engineer",
    title: "AI Engineer",
    headline: "AI Engineer | Generative AI, LLM Applications & Backend Services",
    summaryBody:
      "building backend services and LLM-powered applications. Skills span Java, Spring Boot and Node.js services, REST API design and SQL/NoSQL data modeling, plus Generative AI, agentic AI, LLM applications and prompt engineering.",
    skillFocus: ["Generative AI", "Agentic AI", "LLM Applications", "Prompt Engineering", "Python", "Java", "Spring Boot", "REST APIs", "PostgreSQL", "Docker"],
    verifiedSkills: [],
    angleBullets: [
      "Apply Generative AI, Agentic AI and LLM tooling with prompt engineering to backend delivery."
    ],
    projectAngle: "Extended with Generative AI / LLM experimentation (prompt engineering).",
    keywordTags: ["ai", "llm", "generative", "agentic", "prompt", "agent", "machine learning"],
    match: [[/\bai\s*engineer\b/i, 5], [/\bllm\b/i, 2], [/prompt\s*engineering/i, 2], [/agentic/i, 2], [/machine\s*learning/i, 1], [/generative\s*ai/i, 1]]
  },
  {
    id: "fullstack",
    label: "Full Stack Developer",
    title: "Full Stack Developer",
    headline: "Full Stack Developer | React, Next.js, Node.js & REST APIs",
    summaryBody:
      "building end-to-end web applications across REST APIs, databases (PostgreSQL, MySQL, MongoDB) and responsive frontends with React and Next.js — from schema design and authentication to delivery.",
    skillFocus: ["React", "Next.js", "JavaScript", "TypeScript", "Node.js", "Express.js", "REST APIs", "MongoDB", "PostgreSQL", "Docker"],
    verifiedSkills: [],
    angleBullets: [],
    projectAngle: "",
    keywordTags: ["react", "next", "rest", "api", "frontend", "backend", "database", "full stack"],
    match: [[/full[\s-]?stack/i, 3], [/\bmern\b/i, 2], [/\bmean\b/i, 2]]
  },
  {
    id: "backend",
    label: "Backend Developer",
    title: "Backend Developer",
    headline: "Backend Developer | Java, Spring Boot, Node.js & REST APIs",
    summaryBody:
      "building and maintaining backend services and REST APIs using Java, Spring Boot, Node.js and Express.js with PostgreSQL, MySQL and MongoDB, authentication (Spring Security, JWT, Okta) and production debugging.",
    skillFocus: ["Java", "Spring Boot", "Node.js", "Express.js", "REST APIs", "PostgreSQL", "MySQL", "MongoDB", "JWT", "Docker", "Linux"],
    verifiedSkills: [],
    angleBullets: [],
    projectAngle: "",
    keywordTags: ["api", "rest", "backend", "service", "database", "debug"],
    match: [[/backend/i, 2], [/server[\s-]?side/i, 1]]
  }
];

const REWRITE_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rewriteGetPlaybook(id) {
  return REWRITE_ROLE_PLAYBOOKS.find((p) => p.id === id) || null;
}

// Boundary-aware phrase check, same idea as resume-tailor.js's containsPhrase
// (re-declared here so this file has no load-order dependency on it).
function rewriteContainsPhrase(text, phrase) {
  if (!text || !phrase) return false;
  const escaped = String(phrase).trim().replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(^|[^a-zA-Z0-9])${escaped}($|[^a-zA-Z0-9])`, "i").test(` ${text} `);
}

// ---- Role detection -------------------------------------------------------
// Scores every playbook's weighted regexes against the text. Highest score
// wins; ties go to the earlier (more specific) playbook. Returns null when
// nothing scores, so the UI can leave the dropdown untouched.
function detectRoleFromText(text) {
  if (!text || !text.trim()) return null;
  let best = null;
  let bestScore = 0;
  for (const playbook of REWRITE_ROLE_PLAYBOOKS) {
    let score = 0;
    for (const [pattern, weight] of playbook.match) {
      if (pattern.test(text)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = playbook;
    }
  }
  return best ? { id: best.id, label: best.label, score: bestScore } : null;
}

// A role typed by hand that matches no playbook still gets a playbook-shaped
// rewrite: its own title/headline, and a focus list picked out of the words it
// contains that we recognize as real skills.
function buildCustomPlaybook(roleText) {
  const label = String(roleText || "").trim();
  const dictionary = typeof LOCAL_TECH_KEYWORDS !== "undefined" ? LOCAL_TECH_KEYWORDS : [];
  const focus = dictionary.filter((term) => rewriteContainsPhrase(label, term)).slice(0, 8);
  return {
    id: "custom",
    label,
    title: label,
    headline: label,
    summaryBody:
      "applying a strong backend and full-stack foundation (Java, Spring Boot, Node.js, Express.js, REST APIs, SQL databases) to this role, with production debugging and Agile delivery experience.",
    skillFocus: focus.length ? focus : ["Java", "Spring Boot", "Node.js", "Express.js", "REST APIs", "SQL", "Docker"],
    verifiedSkills: [],
    angleBullets: [],
    projectAngle: "",
    keywordTags: focus.map((f) => f.toLowerCase()),
    match: []
  };
}

function resolveRolePlaybook(roleId, customRole, jdText) {
  if (roleId && roleId !== "custom") {
    const byId = rewriteGetPlaybook(roleId);
    if (byId) return byId;
  }
  if (roleId === "custom" && customRole && customRole.trim()) {
    return buildCustomPlaybook(customRole);
  }
  const detected = detectRoleFromText(jdText || "");
  if (detected) return rewriteGetPlaybook(detected.id);
  return rewriteGetPlaybook("fullstack");
}

// ---- Required experience from a job description ---------------------------
// Pulls the number of years a posting asks for ("2+ years", "minimum 3 years",
// "3-5 years") so the timeline can be rescaled to match. A range takes its
// lower bound (the number the posting actually requires); a missing or
// implausible number yields null, so nothing gets rescaled.
function detectRequiredYears(text) {
  const t = String(text || "");
  if (!t.trim()) return null;

  const clamp = (n) => (Number.isFinite(n) && n > 0 && n <= 15 ? Math.round(n) : null);

  const range = t.match(/\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i);
  if (range) return clamp(Number(range[1]) || Number(range[2]));

  const plus = t.match(/\b(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/i);
  if (plus) return clamp(Number(plus[1]));

  const single = t.match(/\b(\d{1,2})\s*(?:years?|yrs?)\b/i);
  if (single) return clamp(Number(single[1]));

  return null;
}

// ---- Date engine ----------------------------------------------------------
// "YYYY-MM" (or bare "YYYY") month-index arithmetic. Month index 0 = Jan year 0;
// only differences and ordering ever matter.
function parseYmMonth(value) {
  const match = String(value == null ? "" : value).trim().match(/^(\d{4})(?:-(\d{1,2}))?$/);
  if (!match) return null;
  const month = match[2] ? Number(match[2]) : 1;
  if (month < 1 || month > 12) return null;
  return Number(match[1]) * 12 + (month - 1);
}

function ymMonthToValue(monthIndex) {
  if (monthIndex == null) return "";
  const y = Math.floor(monthIndex / 12);
  const m = String((monthIndex % 12) + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function ymMonthToLabel(monthIndex) {
  if (monthIndex == null) return "";
  const y = Math.floor(monthIndex / 12);
  const m = monthIndex % 12;
  // Bare-year ends read as December, bare-year starts as January (parseYmMonth
  // already normalized both to that).
  return `${REWRITE_MONTH_ABBR[m]} ${y}`;
}

// Rescales the employment timeline so the span from the first start date to
// today is exactly targetYears. Role durations and inter-role gaps keep their
// proportions (each role keeps at least one month), the timeline is rebuilt
// backwards from today, and the current employer keeps an open-ended "Present".
// Companies, their order and their relative tenure shape never change.
function shiftExperienceDates(experience, targetYears, today) {
  const list = Array.isArray(experience) ? experience : [];
  const now = today instanceof Date ? today : new Date();
  const nowM = now.getFullYear() * 12 + now.getMonth();

  const roles = list.map((entry, index) => {
    const startM = parseYmMonth(entry.startDate);
    const isCurrent = !!entry.current || !String(entry.endDate || "").trim();
    const endM = parseYmMonth(entry.endDate);
    return {
      entry,
      index,
      startM,
      // An open-ended or unparseable end lands on today; a end before its own
      // start is clamped onto the start so durations never go negative.
      endM: isCurrent || endM == null ? nowM : Math.max(endM, startM == null ? endM : startM),
      isCurrent
    };
  });

  const usable = roles.filter((r) => r.startM != null && r.startM <= nowM);
  const unparseable = roles.filter((r) => !usable.includes(r));
  const sorted = [...usable].sort((a, b) => a.startM - b.startM || a.index - b.index);

  const unchanged = {
    experience: list.map((e) => ({ ...e })),
    deltaMonths: 0,
    actualMonths: 0,
    targetYears: null,
    shifted: false
  };

  if (sorted.length === 0) return { ...unchanged, skipped: unparseable.length > 0 };

  const span = nowM - sorted[0].startM;
  const actualMonths = span;
  const target = Math.max(1, Math.round((Number(targetYears) || 0) * 12));
  if (!(Number(targetYears) > 0) || span <= 0 || target === span) {
    return { ...unchanged, actualMonths, targetYears: Number(targetYears) || null };
  }

  // Durations and gaps, scaled to the target span.
  const durations = sorted.map((r) => Math.max(1, r.endM - r.startM));
  const gaps = sorted.map((r, i) => (i === 0 ? 0 : Math.max(0, r.startM - sorted[i - 1].endM)));
  const k = target / span;
  const scaledDurations = durations.map((d) => Math.max(1, Math.round(d * k)));
  const scaledGaps = gaps.map((g) => Math.round(g * k));

  // Rounding can drift the total off the target by a few months; walk the
  // residual onto the longest roles so the overall span lands exactly.
  let total = scaledDurations.reduce((a, b) => a + b, 0) + scaledGaps.reduce((a, b) => a + b, 0);
  let residual = target - total;
  let guard = Math.abs(residual) * 4 + 10;
  while (residual !== 0 && guard > 0) {
    guard -= 1;
    let pick = 0;
    for (let i = 1; i < scaledDurations.length; i += 1) {
      if (scaledDurations[i] > scaledDurations[pick]) pick = i;
    }
    if (residual > 0) {
      scaledDurations[pick] += 1;
      residual -= 1;
    } else if (scaledDurations[pick] > 1) {
      scaledDurations[pick] -= 1;
      residual += 1;
    } else {
      // Every role is already at its one-month floor; stop rather than invert.
      break;
    }
  }

  // Rebuild backwards from today: the newest role ends at today (Present),
  // each earlier role ends where the next one begins minus the gap.
  const placed = [];
  let cursor = nowM;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const endM = cursor;
    const startM = endM - scaledDurations[i];
    placed[i] = { startM, endM };
    cursor = startM - (scaledGaps[i] || 0);
  }

  const byIndex = new Map();
  sorted.forEach((r, i) => {
    byIndex.set(r.index, {
      startM: placed[i].startM,
      // The current employer stays open-ended; everyone else gets a concrete end.
      endM: r.isCurrent ? null : placed[i].endM
    });
  });

  const shifted = list.map((entry, index) => {
    const slot = byIndex.get(index);
    if (!slot) return { ...entry };
    return {
      ...entry,
      startDate: ymMonthToValue(slot.startM),
      endDate: slot.endM == null ? "" : ymMonthToValue(slot.endM),
      current: !!entry.current || !String(entry.endDate || "").trim()
    };
  });

  return {
    experience: shifted,
    deltaMonths: target - span,
    actualMonths: target,
    targetMonths: target,
    targetYears: Number(targetYears),
    shifted: true
  };
}

// When the timeline is rescaled, the graduation year moves with the first job:
// the degree keeps its length but ends in the year the earliest scaled role
// begins, so the resume keeps reading as study-then-work. A degree line with no
// year range is left alone.
function shiftEducationDates(education, endYear) {
  if (!endYear) return education;
  return (education || []).map((entry) => {
    const line = String(entry.degreeLine || "");
    const match = line.match(/(\d{4})\s*(?:--|–|—|-)\s*(\d{4}|Present)/);
    if (!match) return entry;
    const startYear = Number(match[1]);
    const oldEnd = /^\d{4}$/.test(match[2]) ? Number(match[2]) : null;
    const duration = oldEnd && oldEnd > startYear ? oldEnd - startYear : 4;
    const newStart = Math.max(1900, endYear - duration);
    return { ...entry, degreeLine: line.replace(match[0], `${newStart} -- ${endYear}`) };
  });
}

// The year the earliest role (after any rescale) begins — where the degree
// should end.
function earliestExperienceYear(experience) {
  const years = (Array.isArray(experience) ? experience : [])
    .map((e) => parseYmMonth(e.startDate))
    .filter((v) => v != null)
    .map((v) => Math.floor(v / 12));
  return years.length ? Math.min(...years) : null;
}

// Profile stores "2025-07"; the rewritten resume shows "Jul 2025".
function rewriteFormatDates(entry) {
  const start = parseYmMonth(entry.startDate);
  const startLabel = start == null ? String(entry.startDate || "") : ymMonthToLabel(start);
  if (entry.current || !String(entry.endDate || "").trim()) {
    return { startLabel, endLabel: "Present", current: true };
  }
  const end = parseYmMonth(entry.endDate);
  return {
    startLabel,
    endLabel: end == null ? String(entry.endDate || "") : ymMonthToLabel(end),
    current: false
  };
}

// ---- context.md parsing ---------------------------------------------------
// The bundled context.md is the long-form source of truth (bullets for every
// employer, grouped skills, projects with tech lines). When it is present the
// rewrite is built from it; when it is missing or unparseable the rewrite falls
// back to profile.json's prose descriptions.
function splitSectionLines(md, headingPattern) {
  const lines = String(md || "").split(/\r?\n/);
  const starts = [];
  lines.forEach((line, i) => {
    if (headingPattern.test(line.trim())) starts.push(i);
  });
  if (!starts.length) return [];
  const from = starts[0] + 1;
  let to = lines.length;
  for (let i = from; i < lines.length; i += 1) {
    if (/^[A-Z][A-Z &/]{2,}$/.test(lines[i].trim())) {
      to = i;
      break;
    }
  }
  return lines.slice(from, to);
}

function groupBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function parseContextResume(md) {
  const text = String(md || "");
  const result = { summary: "", skillGroups: [], experience: [], projects: [], education: [] };
  if (!text.trim()) return result;

  result.summary = splitSectionLines(text, /^PROFESSIONAL SUMMARY$/i)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  for (const line of splitSectionLines(text, /^TECHNICAL SKILLS$/i)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const label = line.slice(0, idx).trim();
    const items = line
      .slice(idx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (label && items.length) result.skillGroups.push({ label, items });
  }

  for (const block of groupBlocks(splitSectionLines(text, /^EXPERIENCE$/i))) {
    const [company, titleLine, datesLine, ...rest] = block;
    if (!company || company.startsWith("-")) continue;
    const titleParts = String(titleLine || "").split("|").map((s) => s.trim());
    const dates = String(datesLine || "").trim();
    const bullets = rest.filter((l) => l.startsWith("-")).map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
    result.experience.push({
      company: company.trim(),
      title: titleParts[0] || "",
      location: titleParts[1] || "",
      dates,
      bullets
    });
  }

  for (const block of groupBlocks(splitSectionLines(text, /^PROJECTS$/i))) {
    const [nameLine, techLine, ...rest] = block;
    if (!nameLine || nameLine.startsWith("-")) continue;
    const nameParts = String(nameLine || "").split("|").map((s) => s.trim());
    result.projects.push({
      name: nameParts[0] || "",
      year: nameParts[1] || "",
      tech: String(techLine || "").replace(/^Tech:\s*/i, "").trim(),
      bullets: rest.filter((l) => l.startsWith("-")).map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
    });
  }

  for (const block of groupBlocks(splitSectionLines(text, /^EDUCATION$/i))) {
    const [institution, degreeLine, location] = block;
    if (!institution) continue;
    result.education.push({
      institution: institution.trim(),
      degreeLine: String(degreeLine || "").trim(),
      location: String(location || "").trim()
    });
  }

  return result;
}

// ---- Base fact assembly ---------------------------------------------------
function descriptionToBullets(description) {
  return String(description || "")
    .split(/(?<=[.!?])\s+|\n+|\u2022|\n-\s*/)
    .map((s) => s.replace(/^[-\u2022]\s*/, "").replace(/[.\s]+$/, "").trim())
    .filter((s) => s.length > 12)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

function buildRewriteBase(profile, parsed) {
  const profileExp = Array.isArray(profile.experience) ? profile.experience : [];
  const parsedByCompany = new Map(
    (parsed.experience || []).map((e) => [e.company.toLowerCase(), e])
  );

  const experience = profileExp.map((entry) => {
    const fromText = parsedByCompany.get(String(entry.company || "").toLowerCase());
    const bullets =
      fromText && fromText.bullets.length ? fromText.bullets : descriptionToBullets(entry.description);
    return {
      company: String(entry.company || "").trim(),
      title: (fromText && fromText.title) || String(entry.title || "").trim(),
      location: (fromText && fromText.location) || "",
      startDate: entry.startDate,
      endDate: entry.endDate,
      current: !!entry.current || !String(entry.endDate || "").trim(),
      technologies: Array.isArray(entry.technologies) ? [...entry.technologies] : [],
      bullets: bullets.slice(0, 8)
    };
  });

  // Employers that only exist in context.md still belong on the rewritten resume.
  for (const [companyKey, fromText] of parsedByCompany) {
    if (experience.some((e) => e.company.toLowerCase() === companyKey)) continue;
    experience.push({
      company: fromText.company,
      title: fromText.title,
      location: fromText.location,
      startDate: "",
      endDate: "",
      current: false,
      technologies: [],
      bullets: fromText.bullets.slice(0, 8)
    });
  }

  const profileProjects = Array.isArray(profile.projects) ? profile.projects : [];
  const parsedByName = new Map((parsed.projects || []).map((p) => [p.name.toLowerCase(), p]));
  const projects = profileProjects.map((entry) => {
    const fromText = parsedByName.get(String(entry.name || "").toLowerCase());
    return {
      name: String(entry.name || "").trim(),
      year: (fromText && fromText.year) || "",
      tech: (fromText && fromText.tech) || (Array.isArray(entry.technologies) ? entry.technologies.join(", ") : ""),
      bullets: fromText && fromText.bullets.length ? fromText.bullets : descriptionToBullets(entry.description)
    };
  });
  for (const [nameKey, fromText] of parsedByName) {
    if (projects.some((p) => p.name.toLowerCase() === nameKey)) continue;
    projects.push({ name: fromText.name, year: fromText.year, tech: fromText.tech, bullets: fromText.bullets });
  }

  return {
    experience,
    projects,
    skillGroups: parsed.skillGroups || [],
    parsedSummary: parsed.summary || "",
    education: parsed.education || []
  };
}

// ---- Tailoring ------------------------------------------------------------
function scoreByTags(text, tags) {
  const hay = String(text || "").toLowerCase();
  let score = 0;
  for (const tag of tags || []) {
    if (!tag) continue;
    if (hay.includes(String(tag).toLowerCase())) score += 1;
  }
  return score;
}

function dedupeSimilar(bullets) {
  const seen = new Set();
  const out = [];
  for (const bullet of bullets) {
    const key = String(bullet).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const fingerprint = key.split(" ").slice(0, 5).join(" ");
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(bullet);
  }
  return out;
}

function tailorExperienceEntries(base, playbook, dateResult) {
  const datedByCompany = new Map(
    (dateResult.experience || []).map((e) => [String(e.company || "").toLowerCase(), e])
  );
  const focus = playbook.skillFocus || [];
  const angles = playbook.angleBullets || [];

  return base
    .map((entry, index) => {
      const dated = datedByCompany.get(entry.company.toLowerCase());
      const source = dated || entry;
      const dates = rewriteFormatDates(source);
      const isCurrent = dates.current || index === 0;

      const title = /intern/i.test(entry.title)
        ? `${playbook.title} Intern`
        : playbook.title;

      // Bullets reordered by how well they speak the role's language; the
      // original order breaks ties so rewrites stay stable.
      const scored = entry.bullets.map((bullet, i) => ({
        bullet,
        i,
        score: scoreByTags(bullet, playbook.keywordTags)
      }));
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      // Five base bullets (four when an angle bullet is added) keeps the
      // one-page layout intact; six overflowed onto a second page.
      let bullets = scored.map((s) => s.bullet).slice(0, 5);

      // Role angle bullets land on the current employer only — that is where
      // "what I did day-to-day" framing matters most, and it keeps older roles
      // untouched.
      if (isCurrent && angles.length) {
        bullets = dedupeSimilar([...bullets.slice(0, 4), ...angles]);
      }

      const technologies = dedupeCaseInsensitiveLocal([
        ...focus.slice(0, 5),
        ...entry.technologies
      ]);

      return {
        company: entry.company,
        title,
        location: entry.location,
        startLabel: dates.startLabel,
        endLabel: dates.endLabel,
        current: dates.current,
        startDate: source.startDate || "",
        endDate: source.endDate || "",
        bullets,
        technologies
      };
    })
    .filter((entry) => entry.company);
}

function dedupeCaseInsensitiveLocal(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const trimmed = String(item || "").trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

function tailorProjects(base, playbook) {
  const scored = base.map((project, i) => ({
    project,
    i,
    score: scoreByTags(`${project.name} ${project.tech} ${project.bullets.join(" ")}`, playbook.keywordTags)
  }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  return scored.slice(0, 3).map(({ project }, rank) => {
    let bullets = project.bullets.slice(0, 3);
    if (rank === 0 && playbook.projectAngle) {
      bullets = dedupeSimilar([...bullets, playbook.projectAngle]);
    }
    return { name: project.name, year: project.year, tech: project.tech, bullets };
  });
}

function tailorSkills(playbook, base, profile, extraSkills) {
  const realSkills = dedupeCaseInsensitiveLocal([
    ...(Array.isArray(profile.skills) ? profile.skills : []),
    ...base.skillGroups.flatMap((g) => g.items)
  ]);
  const verified = playbook.verifiedSkills || [];
  const pool = [...realSkills, ...verified];

  const focus = [];
  for (const term of playbook.skillFocus || []) {
    const match = pool.find((s) => rewriteContainsPhrase(s, term) || rewriteContainsPhrase(term, s));
    if (match) focus.push(match);
    else if (verified.some((v) => v.toLowerCase() === term.toLowerCase())) focus.push(term);
  }
  const focusSet = new Set(focus.map((f) => f.toLowerCase()));

  // Matched JD keywords are surfaced here, in the Focus line, rather than in a
  // separate "Additional Relevant Keywords" block — an ATS still sees the exact
  // term, but the resume keeps reading like a resume. Only terms that are real
  // skills/technologies of the candidate (present in the pool or the local tech
  // dictionary) are folded in, and long prose phrases are skipped, so the Focus
  // line stays a skill list.
  const dictionary = typeof LOCAL_TECH_KEYWORDS !== "undefined" ? LOCAL_TECH_KEYWORDS : [];
  const addedFocus = [];
  for (const term of dedupeCaseInsensitiveLocal(extraSkills || [])) {
    if (term.length > 40) continue;
    const key = term.toLowerCase();
    if (focusSet.has(key) || addedFocus.some((f) => f.toLowerCase() === key)) continue;
    const inPool = pool.some((s) => rewriteContainsPhrase(s, term) || rewriteContainsPhrase(term, s));
    const isTech = dictionary.some((d) => d.toLowerCase() === key);
    if (!inPool && !isTech) continue;
    addedFocus.push(term);
    focusSet.add(key);
  }
  focus.push(...addedFocus);

  const finalFocusSet = new Set(focus.map((f) => f.toLowerCase()));
  const groups = base.skillGroups
    .map((g) => ({ label: g.label, items: g.items.filter((i) => !finalFocusSet.has(i.toLowerCase())) }))
    .filter((g) => g.items.length);
  return { focus: dedupeCaseInsensitiveLocal(focus), groups, addedFocus };
}

function yearsLabel(months) {
  const years = Math.max(1, Math.round(months / 12));
  return `${years}+ year${years === 1 ? "" : "s"}`;
}

// ---- Canonical resume JSON -------------------------------------------------
// The single intermediate representation everything downstream agrees on:
//
//   source files (profile.json + context.md)
//        -> buildCanonicalResume()   (parse + normalize)
//        -> tailorCanonicalResume()  (edits only the permitted fields)
//        -> renderCanonicalTex()     (fixed LaTeX template)
//        -> validateCanonicalResume() / validateRewriteTex()
//
// The canonical object never carries raw LaTeX. The renderer owns layout and
// the model owns wording, which is what keeps the document structure stable
// when the wording changes.
const CANONICAL_RESUME_VERSION = 1;

// Contact block is derived from profile.json and is identical for every role.
function canonicalContact(profile) {
  const personal = (profile && profile.personal) || {};
  const links = (profile && profile.links) || {};
  const contactLine = [
    [personal.city, personal.country].filter(Boolean).join(", "),
    personal.phone,
    personal.email
  ]
    .filter(Boolean)
    .join(" | ");

  const linkLine = [
    links.linkedin ? `LinkedIn: ${links.linkedin.replace(/^https?:\/\//, "")}` : "",
    links.github ? `GitHub: ${links.github.replace(/^https?:\/\//, "")}` : "",
    links.portfolio ? links.portfolio.replace(/^https?:\/\//, "") : ""
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    name: personal.fullName || [personal.firstName, personal.lastName].filter(Boolean).join(" "),
    contactLine,
    linkLine
  };
}

// context.md degree lines win; profile.json education is the fallback and is
// normalized into the same degreeLine / location shape.
function canonicalEducationList(base, profile) {
  const source = base.education.length
    ? base.education
    : (Array.isArray(profile.education) ? profile.education : []).map((e) => ({
        institution: e.institution || "",
        degreeLine: [
          Array.isArray(e.degree) ? e.degree.join(" / ") : e.degree,
          e.field,
          e.startDate && e.endDate ? `${e.startDate} -- ${e.endDate}` : ""
        ]
          .filter(Boolean)
          .join(" | "),
        location: ""
      }));
  return source.map((e) => ({
    institution: e.institution || "",
    degreeLine: e.degreeLine || "",
    location: e.location || ""
  }));
}

// No role applied — this is the parsed source resume, the truth a rewrite is
// validated against. Dates are kept both raw (for invariant checks) and
// displayed (for the renderer).
function buildCanonicalResume({ profile, contextMd }) {
  const p = profile || {};
  const parsed = parseContextResume(contextMd || "");
  const base = buildRewriteBase(p, parsed);
  const contact = canonicalContact(p);

  return {
    version: CANONICAL_RESUME_VERSION,
    name: contact.name,
    contactLine: contact.contactLine,
    linkLine: contact.linkLine,
    headline: "",
    summary: base.parsedSummary || "",
    skills: {
      focus: [],
      groups: base.skillGroups.map((g) => ({ label: g.label, items: [...g.items] }))
    },
    experience: base.experience.map((e) => {
      const d = rewriteFormatDates(e);
      return {
        company: e.company,
        title: e.title,
        location: e.location,
        startLabel: d.startLabel,
        endLabel: d.endLabel,
        current: d.current,
        startDate: e.startDate || "",
        endDate: e.endDate || "",
        technologies: [...e.technologies],
        bullets: [...e.bullets]
      };
    }),
    projects: base.projects.map((pr) => ({
      name: pr.name,
      year: pr.year,
      tech: pr.tech,
      bullets: [...pr.bullets]
    })),
    education: canonicalEducationList(base, p),
    skillsFocusAdded: [],
    role: null,
    yearsLabel: "",
    dateInfo: { shifted: false, deltaMonths: 0, actualMonths: 0, targetYears: null }
  };
}

// Edits only the permitted fields of the canonical resume: headline, summary,
// experience titles/bullets/dates, project bullets, and skills. Company list,
// order, and the education entries are carried through untouched (except the
// graduation range, which follows an explicitly requested rescale).
function tailorCanonicalResume(canonical, opts) {
  const profile = (opts && opts.profile) || {};
  const playbook = opts.playbook;
  const dateResult = opts.dateResult;
  const experienceMonths = dateResult.shifted
    ? dateResult.actualMonths
    : Math.max(1, dateResult.actualMonths || 12);

  const base = {
    experience: canonical.experience,
    projects: canonical.projects,
    skillGroups: canonical.skills.groups
  };
  const skills = tailorSkills(playbook, base, profile, opts.extraSkills);
  const educationEndYear = dateResult.shifted ? earliestExperienceYear(dateResult.experience) : null;

  return {
    version: CANONICAL_RESUME_VERSION,
    role: { id: playbook.id, label: playbook.label },
    yearsLabel: yearsLabel(experienceMonths),
    headline: playbook.headline,
    summary: `${playbook.label} with ${yearsLabel(experienceMonths)} of experience ${playbook.summaryBody}`,
    name: canonical.name,
    contactLine: canonical.contactLine,
    linkLine: canonical.linkLine,
    skills,
    skillsFocusAdded: skills.addedFocus || [],
    experience: tailorExperienceEntries(base.experience, playbook, dateResult),
    projects: tailorProjects(base.projects, playbook),
    education: shiftEducationDates(canonical.education, educationEndYear),
    dateInfo: {
      shifted: !!dateResult.shifted,
      deltaMonths: dateResult.deltaMonths || 0,
      actualMonths: dateResult.actualMonths || 0,
      targetYears: dateResult.targetYears || null
    }
  };
}

// ---- Optional LLM polish --------------------------------------------------
// Rephrases bullet wording toward the role/JD language. The model never sees
// companies' dates, never invents technologies (the whitelist below is the only
// vocabulary allowed), and a failure at any point leaves the deterministic
// rewrite in place.
function buildRewritePolishPrompt(tailored, jdText) {
  const vocabulary = dedupeCaseInsensitiveLocal([
    ...tailored.skills.focus,
    ...tailored.skills.groups.flatMap((g) => g.items),
    ...tailored.experience.flatMap((e) => e.technologies)
  ]);
  const payload = {
    role: tailored.role.label,
    headline: tailored.headline,
    summary: tailored.summary,
    experience: tailored.experience.map((e) => ({ company: e.company, title: e.title, bullets: e.bullets })),
    projects: tailored.projects.map((p) => ({ name: p.name, bullets: p.bullets }))
  };
  return [
    "You rewrite resume bullet wording so it speaks the language of a target role.",
    `Target role: ${tailored.role.label}`,
    jdText ? `Job description (for vocabulary only):\n${jdText.slice(0, 3000)}` : "",
    "",
    "CANDIDATE FACTS (the only allowed content — never add employers, dates, metrics, technologies or claims beyond these):",
    JSON.stringify(payload, null, 1),
    "",
    `Allowed technology/skill vocabulary: ${vocabulary.join(", ")}`,
    "",
    "Rewrite rules:",
    "- Rephrase each bullet to emphasize the target role's language. Keep every claim a restatement of the input bullet.",
    "- Never invent employers, job titles, dates, numbers, metrics or technologies.",
    "- Keep the same number of companies and projects, same order, same company names.",
    "- 1-2 sentences per bullet, resume style, past tense for previous roles and present tense for the current role.",
    "",
    'Respond with ONLY a JSON object: {"headline": string, "summary": string, "experience": [{"company": string, "bullets": [string]}], "projects": [{"name": string, "bullets": [string]}]}. No prose, no markdown fences.'
  ]
    .filter(Boolean)
    .join("\n");
}

function parseRewritePolishJSON(text) {
  const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a JSON object");
  return parsed;
}

function applyPolishToTailored(tailored, polished) {
  const next = { ...tailored };
  if (typeof polished.headline === "string" && polished.headline.trim()) {
    next.headline = polished.headline.trim();
  }
  if (typeof polished.summary === "string" && polished.summary.trim()) {
    next.summary = polished.summary.trim();
  }
  if (Array.isArray(polished.experience)) {
    const byCompany = new Map(
      polished.experience
        .filter((e) => e && e.company)
        .map((e) => [String(e.company).toLowerCase(), e])
    );
    next.experience = tailored.experience.map((entry) => {
      const hit = byCompany.get(entry.company.toLowerCase());
      const bullets = hit && Array.isArray(hit.bullets) && hit.bullets.length
        ? hit.bullets.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim()).slice(0, 7)
        : entry.bullets;
      return { ...entry, bullets };
    });
  }
  if (Array.isArray(polished.projects)) {
    const byName = new Map(
      polished.projects.filter((p) => p && p.name).map((p) => [String(p.name).toLowerCase(), p])
    );
    next.projects = tailored.projects.map((project) => {
      const hit = byName.get(project.name.toLowerCase());
      const bullets = hit && Array.isArray(hit.bullets) && hit.bullets.length
        ? hit.bullets.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim()).slice(0, 5)
        : project.bullets;
      return { ...project, bullets };
    });
  }
  return next;
}

async function refineRewriteWithLLM(tailored, jdText, settings) {
  if (!(settings && settings.useLLM && settings.rewritePolish)) return { tailored, used: null };
  if (typeof configuredProviders !== "function" || typeof sendProviderPrompt !== "function") {
    return { tailored, used: null };
  }
  const prompt = buildRewritePolishPrompt(tailored, jdText);
  for (const provider of configuredProviders(settings)) {
    try {
      const text = await sendProviderPrompt({ provider, settings, prompt, maxTokens: 2200 });
      return { tailored: applyPolishToTailored(tailored, parseRewritePolishJSON(text)), used: provider.id };
    } catch {
      // try the next configured provider, then ship the deterministic rewrite
    }
  }
  return { tailored, used: null };
}

// ---- LaTeX output ---------------------------------------------------------
function rewriteEscapeLatex(value) {
  return String(value == null ? "" : value)
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// Same house preamble pdf-extract.js uses, so the rewritten resume renders in
// the identical layout as a PDF-imported one on both preview engines.
const REWRITE_PREAMBLE = [
  "\\documentclass[9pt,a4paper]{article}",
  "\\usepackage[left=0.62in, right=0.62in, top=0.38in, bottom=0.38in]{geometry}",
  "\\usepackage{enumitem}",
  "\\usepackage[hidelinks]{hyperref}",
  "\\usepackage{titlesec}",
  "\\usepackage{tabularx}",
  "\\usepackage{xcolor}",
  "\\pagenumbering{gobble}",
  "\\setlength{\\parindent}{0pt}",
  "\\setlength{\\parskip}{0pt}",
  "\\setlist[itemize]{leftmargin=1.2em,noitemsep,topsep=1pt,parsep=0pt,partopsep=0pt}",
  "\\titleformat{\\section}{\\normalsize\\bfseries}{}{0em}{}[\\titlerule]",
  "\\titlespacing*{\\section}{0pt}{5pt}{3pt}",
  "\\begin{document}"
].join("\n");

// Fixed template. Given a canonical resume JSON, produce the LaTeX. The
// canonical fields only supply text; every margin, section rule and line break
// is decided here, so the layout cannot drift with the wording.
function renderCanonicalTex(tailored) {
  const esc = rewriteEscapeLatex;
  const out = [REWRITE_PREAMBLE, ""];

  if (tailored.name) {
    // \begin{center} (not {\centering …\par}) so the header also centers in the
    // bundled fast preview renderer, which does not implement \centering.
    out.push("\\begin{center}");
    out.push(`\\Large \\textbf{${esc(tailored.name)}} \\\\`);
    if (tailored.contactLine) out.push(`${esc(tailored.contactLine)} \\\\`);
    if (tailored.linkLine) out.push(esc(tailored.linkLine));
    out.push("\\end{center}");
    out.push("");
  }

  // The target-role headline is a normal bold line, not a \section*: a ruled
  // section here reads as a document section and distorts the hierarchy.
  if (tailored.headline) {
    out.push(`\\textbf{${esc(tailored.headline)}}`);
    out.push("");
  }
  out.push(esc(tailored.summary));
  out.push("");

  if (tailored.skills.focus.length || tailored.skills.groups.length) {
    out.push("\\section*{Technical Skills}");
    const skillLines = [];
    if (tailored.skills.focus.length) {
      skillLines.push(`\\textbf{Focus:} ${tailored.skills.focus.map(esc).join(", ")}`);
    }
    for (const group of tailored.skills.groups) {
      skillLines.push(`\\textbf{${esc(group.label)}:} ${group.items.map(esc).join(", ")}`);
    }
    // A bare newline is not a line break in LaTeX, so without the explicit \\
    // between categories the Focus and category lines run together as one
    // paragraph (in pdflatex and in the bundled preview renderer alike).
    skillLines.forEach((line, i) => {
      out.push(i < skillLines.length - 1 ? `${line} \\\\` : line);
    });
    out.push("");
  }

  if (tailored.experience.length) {
    out.push("\\section*{Experience}");
    for (const entry of tailored.experience) {
      const range = [entry.startLabel, entry.endLabel].filter(Boolean).join(" -- ");
      out.push(`\\textbf{${esc(entry.company)}}${range ? ` \\hfill ${esc(range)}` : ""} \\\\`);
      const titleLine = [entry.title, entry.location].filter(Boolean).map(esc).join(" | ");
      if (titleLine) out.push(titleLine);
      if (entry.bullets.length) {
        out.push("\\begin{itemize}");
        for (const bullet of entry.bullets) out.push(`\\item ${esc(bullet)}`);
        out.push("\\end{itemize}");
      }
      out.push("");
    }
  }

  if (tailored.projects.length) {
    out.push("\\section*{Projects}");
    for (const project of tailored.projects) {
      out.push(
        project.year
          ? `\\textbf{${esc(project.name)}} \\hfill ${esc(project.year)}`
          : `\\textbf{${esc(project.name)}}`
      );
      if (project.tech) out.push(`Tech: ${esc(project.tech)}`);
      if (project.bullets.length) {
        out.push("\\begin{itemize}");
        for (const bullet of project.bullets) out.push(`\\item ${esc(bullet)}`);
        out.push("\\end{itemize}");
      }
      out.push("");
    }
  }

  if (tailored.education.length) {
    out.push("\\section*{Education}");
    for (const entry of tailored.education) {
      // context.md writes "2021 – 2025" with an en-dash; the profile fallback
      // writes "2021 -- 2025". Accept either, plus "Present".
      const yearRange = /(\d{4})\s*(?:--|–|—|-)\s*(\d{4}|Present)/.exec(entry.degreeLine || "");
      const degreeText = (entry.degreeLine || "")
        .replace(/\s*\|\s*\d{4}\s*(?:--|–|—|-)\s*(?:\d{4}|Present)\s*$/, "")
        .trim();
      out.push(`\\textbf{${esc(entry.institution)}}${yearRange ? ` \\hfill ${esc(`${yearRange[1]} -- ${yearRange[2]}`)}` : ""} \\\\`);
      const tail = [degreeText, entry.location].filter(Boolean).map(esc).join(" | ");
      if (tail) out.push(tail);
      out.push("");
    }
  }

  out.push("\\end{document}");
  out.push("");
  return out.join("\n");
}

// ---- Validation -----------------------------------------------------------
// A rewrite may change wording but must not change the resume's shape. These
// checks are the programmatic counterpart to the LLM rules: if the model (or a
// future generator) invents an employer, drops a job, reorders companies, or
// emits a prohibited section, the run is flagged instead of silently shipping.
function validateCanonicalResume(source, tailored) {
  const errors = [];

  if (!tailored || typeof tailored !== "object") {
    return { ok: false, errors: ["tailored resume is missing"] };
  }
  if (tailored.version !== CANONICAL_RESUME_VERSION) {
    errors.push(`unexpected schema version: ${tailored.version}`);
  }

  const srcCompanies = (source.experience || []).map((e) => String(e.company || "").toLowerCase());
  const outCompanies = (tailored.experience || []).map((e) => String(e.company || "").toLowerCase());
  if (outCompanies.length !== srcCompanies.length) {
    errors.push(`experience count changed: ${srcCompanies.length} -> ${outCompanies.length}`);
  } else if (outCompanies.some((c, i) => c !== srcCompanies[i])) {
    errors.push("experience companies changed or reordered");
  }

  const srcNames = (source.projects || []).map((p) => String(p.name || "").toLowerCase());
  const outProjects = tailored.projects || [];
  if (outProjects.length > (source.projects || []).length) {
    errors.push("a project was invented");
  }
  if (outProjects.some((p) => !srcNames.includes(String(p.name || "").toLowerCase()))) {
    errors.push("a project name is not present in the source");
  }

  if ((tailored.education || []).length !== (source.education || []).length) {
    errors.push("education entries changed");
  }

  // Dates must stay internally consistent (an end before its start is a bug).
  for (const entry of tailored.experience || []) {
    const start = parseYmMonth(entry.startDate);
    const end = parseYmMonth(entry.endDate);
    if (start != null && end != null && end < start) {
      errors.push(`role ends before it starts: ${entry.company}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// LaTeX-level structure checks: the document must be well-formed and contain
// only the known sections. This catches a malformed render before it reaches
// the preview or a PDF.
const CANONICAL_SECTIONS = ["Technical Skills", "Experience", "Projects", "Education"];
function validateRewriteTex(tex) {
  const errors = [];
  const t = String(tex || "");

  if (!/\\begin\{document\}/.test(t)) errors.push("missing \\begin{document}");
  if (!/\\end\{document\}/.test(t)) errors.push("missing \\end{document}");
  if (/Additional Relevant Keywords|ATS Keywords/i.test(t)) {
    errors.push("a prohibited keyword section is present");
  }

  const itemizeBegins = (t.match(/\\begin\{itemize\}/g) || []).length;
  const itemizeEnds = (t.match(/\\end\{itemize\}/g) || []).length;
  if (itemizeBegins !== itemizeEnds) errors.push("unbalanced itemize environments");

  const allowed = new Set(CANONICAL_SECTIONS);
  const sections = [...t.matchAll(/\\section\*\{([^}]*)\}/g)].map((m) => m[1]);
  for (const s of sections) {
    if (!allowed.has(s)) errors.push(`unexpected section: ${s}`);
  }

  return { ok: errors.length === 0, errors };
}

// ---- Entry point ----------------------------------------------------------
// Parses the source into canonical JSON, tailors it for a role, optionally
// rescales the timeline, renders it with the fixed template, and validates the
// result. Everything stays in the returned object — nothing is written to
// storage — so the caller decides what to preview or download.
async function rewriteForRole(options) {
  const opts = options || {};
  const profile = opts.profile || {};
  const source = buildCanonicalResume({ profile, contextMd: opts.contextMd });
  const playbook = resolveRolePlaybook(opts.roleId, opts.customRole, opts.jdText);

  const dateResult = opts.targetYears
    ? shiftExperienceDates(profile.experience, opts.targetYears, opts.today)
    : (() => {
        const months = estimateExperienceMonths(profile.experience, opts.today);
        return {
          experience: Array.isArray(profile.experience) ? profile.experience.map((e) => ({ ...e })) : [],
          deltaMonths: 0,
          actualMonths: months,
          targetYears: null,
          shifted: false
        };
      })();

  let tailored = tailorCanonicalResume(source, {
    profile,
    playbook,
    dateResult,
    extraSkills: opts.extraSkills
  });
  const polish = await refineRewriteWithLLM(tailored, opts.jdText || "", opts.settings);
  tailored = polish.tailored;

  const dataValidation = validateCanonicalResume(source, tailored);
  const tex = renderCanonicalTex(tailored);
  const texValidation = validateRewriteTex(tex);

  return {
    tex,
    source,
    tailored,
    playbook: { id: playbook.id, label: playbook.label },
    dateResult,
    polishedWith: polish.used,
    validation: {
      ok: dataValidation.ok && texValidation.ok,
      errors: [...dataValidation.errors, ...texValidation.errors],
      data: dataValidation,
      tex: texValidation
    }
  };
}

// Months between the earliest start and today — the "current" experience size
// when the user chooses not to rescale.
function estimateExperienceMonths(experience, today) {
  const now = today instanceof Date ? today : new Date();
  const nowM = now.getFullYear() * 12 + now.getMonth();
  let earliest = null;
  for (const entry of Array.isArray(experience) ? experience : []) {
    const start = parseYmMonth(entry.startDate);
    if (start != null && (earliest == null || start < earliest)) earliest = start;
  }
  if (earliest == null || earliest >= nowM) return 12;
  return nowM - earliest;
}
