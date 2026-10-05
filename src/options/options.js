const editor = document.getElementById("editor");
const status = document.getElementById("status");

// One place that writes the status line, so success and failure are told apart by
// colour everywhere on the page rather than by ad-hoc class juggling at each site.
function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status-msg status-line ${kind}`;
}

// Bundled with the extension source (src/data/profile.json) so a wiped/empty
// chrome.storage.local (fresh install, dev reload, "Clear extension data")
// never leaves you starting from a blank profile again. Storage is still the
// live copy that Save writes to — this file is the durable fallback/reset.
const BUNDLED_PROFILE_URL = chrome.runtime.getURL("src/data/profile.json");

async function fetchBundledProfile() {
  const res = await fetch(BUNDLED_PROFILE_URL);
  if (!res.ok) throw new Error(`Could not load bundled profile.json (${res.status})`);
  return res.json();
}

async function load() {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile) {
    editor.value = JSON.stringify(profile, null, 2);
    return;
  }

  try {
    const bundled = await fetchBundledProfile();
    editor.value = JSON.stringify(bundled, null, 2);
    setStatus("No saved profile in storage — loaded from bundled src/data/profile.json.");
  } catch (err) {
    editor.value = JSON.stringify(DEFAULT_PROFILE, null, 2);
    setStatus(`Could not load bundled profile.json (${err.message}) — showing blank template.`, "err");
  }
}

document.getElementById("reload-bundled").addEventListener("click", async () => {
  try {
    const bundled = await fetchBundledProfile();
    editor.value = JSON.stringify(bundled, null, 2);
    setStatus("Reloaded from bundled src/data/profile.json — not saved yet, click Save to keep it.");
  } catch (err) {
    setStatus(`Could not load bundled profile.json: ${err.message}`, "err");
  }
});

document.getElementById("download-profile").addEventListener("click", () => {
  try {
    const parsed = JSON.parse(editor.value);
    const blob = new Blob([JSON.stringify(parsed, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "profile.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded — replace src/data/profile.json with this to make it the bundled default.", "ok");
  } catch (err) {
    setStatus(`Invalid JSON: ${err.message}`, "err");
  }
});

document.getElementById("load-sample").addEventListener("click", () => {
  const sample = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  sample.personal = {
    firstName: "Abhishek",
    lastName: "Anand",
    email: "you@example.com",
    phone: "+91-90000-00000",
    address: "",
    city: "Bengaluru",
    state: "Karnataka",
    country: "India",
    zip: ""
  };
  sample.links = { linkedin: "https://linkedin.com/in/yourhandle", github: "https://github.com/yourhandle", portfolio: "" };
  sample.education[0] = { degree: "B.Tech", field: "Computer Science", institution: "Your University", startDate: "2018", endDate: "2022", gpa: "" };
  sample.experience[0] = {
    company: "Your Company",
    title: "Software Engineer",
    startDate: "2022",
    endDate: "",
    current: true,
    technologies: ["Java", "Spring Boot", "Go", "Docker", "Kubernetes"],
    description: "Backend services and infrastructure."
  };
  sample.skills = ["Java", "Spring Boot", "Go", "Python", "Docker", "Kubernetes"];
  sample.answers = {
    workAuthorization: "Authorized to work",
    requiresSponsorship: "No",
    noticePeriod: "30 days",
    salaryExpectation: "",
    willingToRelocate: "Yes",
    veteranStatus: "",
    disabilityStatus: "",
    gender: "",
    race: "",
    howDidYouHear: "Social Media > LinkedIn"
  };
  editor.value = JSON.stringify(sample, null, 2);
  setStatus("Sample loaded — edit and Save.");
  Analytics.track("Sample Profile Loaded", {});
});

document.getElementById("save").addEventListener("click", async () => {
  try {
    const parsed = JSON.parse(editor.value);
    await chrome.storage.local.set({ profile: parsed });
    setStatus("Saved.", "ok");

    // Shape only — how complete the profile is, never what is in it.
    Analytics.track("Profile Saved", {
      skill_count: Array.isArray(parsed.skills) ? parsed.skills.length : 0,
      experience_count: Array.isArray(parsed.experience) ? parsed.experience.length : 0,
      education_count: Array.isArray(parsed.education) ? parsed.education.length : 0,
      project_count: Array.isArray(parsed.projects) ? parsed.projects.length : 0,
      answered_question_count: Object.values(parsed.answers || {}).filter((v) => v).length
    });
  } catch (err) {
    setStatus(`Invalid JSON: ${err.message}`, "err");
    Analytics.track("Profile Save Failed", { error: "invalid json" });
  }
});

// ---- Analytics settings ----
//
// The AI keys and models live on their own screen now (../keys/keys.html), but
// they share this one `settings` record. So this section reads the saved record
// and writes only the two fields it owns — the AI half is carried through
// untouched rather than being rebuilt from a form that is no longer here.
const analyticsEnabledCheckbox = document.getElementById("analytics-enabled");
const analyticsFields = document.getElementById("analytics-fields");
const mixpanelTokenInput = document.getElementById("mixpanel-token");
const analyticsStatus = document.getElementById("analytics-status");

function syncAnalyticsFieldsVisibility() {
  analyticsFields.classList.toggle("hidden", !analyticsEnabledCheckbox.checked);
}

async function loadAnalyticsSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const saved = settings || {};
  analyticsEnabledCheckbox.checked = saved.analyticsEnabled !== false;
  mixpanelTokenInput.value = saved.mixpanelToken || "";
  syncAnalyticsFieldsVisibility();
}

analyticsEnabledCheckbox.addEventListener("change", syncAnalyticsFieldsVisibility);

document.getElementById("save-analytics").addEventListener("click", async () => {
  const enabled = analyticsEnabledCheckbox.checked;
  const token = mixpanelTokenInput.value.trim();

  const { settings: current = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: { ...current, analyticsEnabled: enabled, mixpanelToken: token }
  });

  // Tracked after the write, so background.js reads the new value: enabling
  // records the opt-in even if analytics were previously off. Opting out is
  // deliberately never tracked — by this point the record says disabled and
  // background.js drops the event, which is exactly the intent.
  Analytics.track("Analytics Settings Saved", { analytics_enabled: enabled, has_mixpanel_token: !!token });

  if (!enabled) {
    analyticsStatus.textContent = "Analytics off — no events are sent.";
  } else if (!token) {
    analyticsStatus.textContent = "Analytics on, but no Mixpanel token set — events stay queued locally until you add one.";
  } else {
    analyticsStatus.textContent = "Analytics settings saved.";
  }
});

// ============================================================
// LEARNED FIELD RULES
// ============================================================
//
// The review surface for rules the popup has offered (see learned.js for what a
// rule is and why it cannot fill anything until it is approved here).
//
// Every row shows the label exactly as the page rendered it and the profile path
// it points at, because approving a rule is approving that pairing — a label on
// its own says nothing about which profile field it means. `textContent` is used
// throughout: a rule's label is page-authored text, and this is the one page that
// has to render it without giving it a chance to become markup.
//
// Approving one rule approves only that one. There is a bulk approve for the case
// where a batch of new labels is obviously right, and a bulk delete, because the
// rules that need removing are the ones you no longer remember creating.

const learnedList = document.getElementById("learned-rules");
const learnedStatus = document.getElementById("learned-status");

function setLearnedStatus(text, kind = "") {
  learnedStatus.textContent = text;
  learnedStatus.className = `status-msg ${kind}`;
}

function learnedStatusKind(count) {
  return count ? "warn" : "";
}

function shortPath(path) {
  return String(path).replace(/^answers\./, "");
}

// One rule row: the label, the profile field it reads, and the two buttons.
function renderLearnedRule(rule) {
  const row = document.createElement("div");
  row.className = `learned-rule ${rule.status}`;

  const text = document.createElement("div");
  text.className = "learned-rule-text";

  const label = document.createElement("span");
  label.className = "learned-rule-label";
  label.textContent = rule.label;
  text.appendChild(label);

  const detail = document.createElement("span");
  detail.className = "muted small";
  detail.textContent = ` → ${shortPath(rule.path)}`;
  text.appendChild(detail);

  const badge = document.createElement("span");
  badge.className = `pill ${rule.status}`;
  badge.textContent = rule.status === "approved" ? "active" : "pending";
  text.appendChild(badge);

  row.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "learned-rule-actions";

  if (rule.status !== "approved") {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve";
    approve.addEventListener("click", async () => {
      await approveRule(rule.id);
      // Counted, not described: the label is page text and has no business in an
      // analytics event.
      Analytics.track("Field Rules Approved", { count: 1, from: "options" });
      setLearnedStatus("Approved.");
      await renderLearnedRules();
    });
    actions.appendChild(approve);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    await deleteRule(rule.id);
    Analytics.track("Field Rules Deleted", { count: 1, from: "options" });
    setLearnedStatus("Deleted.");
    await renderLearnedRules();
  });
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

async function renderLearnedRules() {
  if (!learnedList) return;

  const rules = learnedRules();
  learnedList.innerHTML = "";

  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "muted small note";
    empty.textContent =
      "No learned rules yet. They appear here after the AI answers a field your dictionary doesn't recognise — approve the ones that were right and the same question won't need the AI again.";
    learnedList.appendChild(empty);
    document.getElementById("learned-approve-all").disabled = true;
    document.getElementById("learned-delete-all").disabled = true;
    return;
  }

  // Pending first: those are the ones waiting on a decision, and a list whose
  // actionable rows are below the fold is a list nobody reads.
  const ordered = [...rules].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  ordered.forEach((rule) => learnedList.appendChild(renderLearnedRule(rule)));

  const pending = rules.filter((rule) => rule.status === "pending").length;
  document.getElementById("learned-approve-all").disabled = pending === 0;
  document.getElementById("learned-delete-all").disabled = false;
  setLearnedStatus(
    pending
      ? `${rules.length} rule${rules.length === 1 ? "" : "s"}, ${pending} waiting on you.`
      : `${rules.length} rule${rules.length === 1 ? "" : "s"}, all active.`,
    learnedStatusKind(pending)
  );
}

document.getElementById("learned-approve-all").addEventListener("click", async () => {
  const count = pendingRuleCount();
  if (!count) return;
  await approveAllRules();
  Analytics.track("Field Rules Approved", { count, from: "options" });
  await renderLearnedRules();
});

document.getElementById("learned-delete-all").addEventListener("click", async () => {
  const count = learnedRules().length;
  if (!count) return;
  await deleteAllRules();
  Analytics.track("Field Rules Deleted", { count, from: "options" });
  setLearnedStatus("All rules deleted.");
  await renderLearnedRules();
});

// Opened from the popup's "Review" link, which has no anchor to jump to. The list
// is short and this is the only place it can be reached from, so it simply loads.
async function initLearnedRules() {
  await loadLearnedRules();
  await renderLearnedRules();
}

Analytics.init("options");

load();
loadAnalyticsSettings();
initLearnedRules();