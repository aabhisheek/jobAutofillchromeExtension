const editor = document.getElementById("editor");
const status = document.getElementById("status");

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
    status.textContent = "No saved profile in storage — loaded from bundled src/data/profile.json.";
  } catch (err) {
    editor.value = JSON.stringify(DEFAULT_PROFILE, null, 2);
    status.textContent = `Could not load bundled profile.json (${err.message}) — showing blank template.`;
  }
}

document.getElementById("reload-bundled").addEventListener("click", async () => {
  try {
    const bundled = await fetchBundledProfile();
    editor.value = JSON.stringify(bundled, null, 2);
    status.textContent = "Reloaded from bundled src/data/profile.json (not saved yet — click Save to keep it).";
  } catch (err) {
    status.textContent = `Could not load bundled profile.json: ${err.message}`;
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
    status.textContent = "Downloaded — replace src/data/profile.json with this file to make it the new bundled default.";
  } catch (err) {
    status.textContent = `Invalid JSON: ${err.message}`;
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
    howDidYouHear: "Company website"
  };
  editor.value = JSON.stringify(sample, null, 2);
  status.textContent = "Sample loaded — edit and Save.";
  Analytics.track("Sample Profile Loaded", {});
});

document.getElementById("save").addEventListener("click", async () => {
  try {
    const parsed = JSON.parse(editor.value);
    await chrome.storage.local.set({ profile: parsed });
    status.textContent = "Saved.";

    // Shape only — how complete the profile is, never what is in it.
    Analytics.track("Profile Saved", {
      skill_count: Array.isArray(parsed.skills) ? parsed.skills.length : 0,
      experience_count: Array.isArray(parsed.experience) ? parsed.experience.length : 0,
      education_count: Array.isArray(parsed.education) ? parsed.education.length : 0,
      project_count: Array.isArray(parsed.projects) ? parsed.projects.length : 0,
      answered_question_count: Object.values(parsed.answers || {}).filter((v) => v).length
    });
  } catch (err) {
    status.textContent = `Invalid JSON: ${err.message}`;
    Analytics.track("Profile Save Failed", { error: "invalid json" });
  }
});

// ---- AI settings ----
const useLLMCheckbox = document.getElementById("use-llm");
const llmFields = document.getElementById("llm-fields");
const groqKeyInput = document.getElementById("groq-key");
const groqModelInput = document.getElementById("groq-model");
const geminiKeyInput = document.getElementById("gemini-key");
const geminiModelInput = document.getElementById("gemini-model");
const settingsStatus = document.getElementById("settings-status");
const analyticsEnabledCheckbox = document.getElementById("analytics-enabled");
const analyticsFields = document.getElementById("analytics-fields");
const mixpanelTokenInput = document.getElementById("mixpanel-token");
const analyticsStatus = document.getElementById("analytics-status");

const GROQ_ORIGIN = "https://api.groq.com/*";
const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/*";

// Bundled with the extension source (src/data/settings.json), same idea as
// BUNDLED_PROFILE_URL above: a wiped chrome.storage.local shouldn't mean
// re-typing API keys. Note this file ships inside the extension package in
// cleartext — fine for a local/unpublished tool, but add it to .gitignore
// before this project ever goes into version control.
const BUNDLED_SETTINGS_URL = chrome.runtime.getURL("src/data/settings.json");

async function fetchBundledSettings() {
  const res = await fetch(BUNDLED_SETTINGS_URL);
  if (!res.ok) throw new Error(`Could not load bundled settings.json (${res.status})`);
  return res.json();
}

function applySettingsToFields(s) {
  useLLMCheckbox.checked = !!s.useLLM;
  groqKeyInput.value = s.groqApiKey || "";
  groqModelInput.value = s.groqModel || DEFAULT_SETTINGS.groqModel;
  geminiKeyInput.value = s.geminiApiKey || "";
  geminiModelInput.value = s.geminiModel || DEFAULT_SETTINGS.geminiModel;
  analyticsEnabledCheckbox.checked = s.analyticsEnabled !== false;
  mixpanelTokenInput.value = s.mixpanelToken || "";
  syncLLMFieldsVisibility();
  syncAnalyticsFieldsVisibility();
}

function syncLLMFieldsVisibility() {
  llmFields.classList.toggle("hidden", !useLLMCheckbox.checked);
}

function syncAnalyticsFieldsVisibility() {
  analyticsFields.classList.toggle("hidden", !analyticsEnabledCheckbox.checked);
}

// The AI and Analytics sections both live in the single `settings` record, so
// each Save writes the full object read back off the form — otherwise saving
// one section would wipe the other's fields.
function settingsFromFields() {
  return {
    useLLM: useLLMCheckbox.checked,
    groqApiKey: groqKeyInput.value.trim(),
    groqModel: groqModelInput.value.trim() || DEFAULT_SETTINGS.groqModel,
    geminiApiKey: geminiKeyInput.value.trim(),
    geminiModel: geminiModelInput.value.trim() || DEFAULT_SETTINGS.geminiModel,
    analyticsEnabled: analyticsEnabledCheckbox.checked,
    mixpanelToken: mixpanelTokenInput.value.trim()
  };
}

async function loadSettings() {
  const { settings: override } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    bundled = await fetchBundledSettings();
  } catch (err) {
    settingsStatus.textContent = `Could not load bundled settings.json (${err.message}) — showing saved/default values only.`;
  }

  applySettingsToFields(mergeSettings(bundled, override));
  if (!settingsStatus.textContent) {
    settingsStatus.textContent = override
      ? "Loaded — bundled src/data/settings.json fills in any field you haven't explicitly saved here."
      : "No saved AI settings yet — loaded from bundled src/data/settings.json.";
  }
}

document.getElementById("reload-bundled-settings").addEventListener("click", async () => {
  try {
    const bundled = await fetchBundledSettings();
    applySettingsToFields(bundled);
    settingsStatus.textContent = "Reloaded from bundled src/data/settings.json (click Save AI Settings to keep it — you'll be asked to re-grant permission).";
  } catch (err) {
    settingsStatus.textContent = `Could not load bundled settings.json: ${err.message}`;
  }
});

document.getElementById("download-settings").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(settingsFromFields(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "settings.json";
  a.click();
  URL.revokeObjectURL(url);
  settingsStatus.textContent = "Downloaded — replace src/data/settings.json with this file to make it the new bundled default.";
});

document.getElementById("save-settings").addEventListener("click", async () => {
  const wantsLLM = useLLMCheckbox.checked;
  const groqKey = groqKeyInput.value.trim();
  const geminiKey = geminiKeyInput.value.trim();

  if (wantsLLM) {
    if (!groqKey && !geminiKey) {
      settingsStatus.textContent = "Enter a Groq and/or Gemini API key to enable LLM drafts.";
      return;
    }

    const origins = [];
    if (groqKey) origins.push(GROQ_ORIGIN);
    if (geminiKey) origins.push(GEMINI_ORIGIN);

    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      settingsStatus.textContent = "Permission was denied — LLM drafts stay off.";
      useLLMCheckbox.checked = false;
      syncLLMFieldsVisibility();
      return;
    }

    // Drop permission for whichever provider was left blank.
    if (!groqKey) chrome.permissions.remove({ origins: [GROQ_ORIGIN] }).catch(() => {});
    if (!geminiKey) chrome.permissions.remove({ origins: [GEMINI_ORIGIN] }).catch(() => {});
  } else {
    // Revoking is best-effort; not blocking on it.
    chrome.permissions.remove({ origins: [GROQ_ORIGIN, GEMINI_ORIGIN] }).catch(() => {});
  }

  await chrome.storage.local.set({ settings: settingsFromFields() });
  settingsStatus.textContent = "AI settings saved.";

  Analytics.track("AI Settings Saved", {
    use_llm: wantsLLM,
    has_groq_key: !!groqKey,
    has_gemini_key: !!geminiKey,
    groq_model: groqModelInput.value.trim() || DEFAULT_SETTINGS.groqModel,
    gemini_model: geminiModelInput.value.trim() || DEFAULT_SETTINGS.geminiModel
  });
});

useLLMCheckbox.addEventListener("change", syncLLMFieldsVisibility);
analyticsEnabledCheckbox.addEventListener("change", syncAnalyticsFieldsVisibility);

document.getElementById("save-analytics").addEventListener("click", async () => {
  const enabled = analyticsEnabledCheckbox.checked;
  const token = mixpanelTokenInput.value.trim();

  await chrome.storage.local.set({ settings: settingsFromFields() });

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

Analytics.init("options");

load();
loadSettings().then(() => {
  Analytics.track("Options Page Opened", {
    use_llm: useLLMCheckbox.checked,
    has_groq_key: !!groqKeyInput.value.trim(),
    has_gemini_key: !!geminiKeyInput.value.trim()
  });
});
