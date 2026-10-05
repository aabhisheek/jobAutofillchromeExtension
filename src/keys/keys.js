// API Keys screen.
//
// The provider list is never written here — it is rendered from
// src/lib/providers.js, which is the same catalog draft.js walks when it needs a
// model to answer something. So "configured" on this page means exactly what
// "will be used" means over there, and adding a vendor is one entry in one file.
//
// Keys live in chrome.storage.local under `settings`, alongside the rest of the
// AI configuration. Nothing is sent anywhere on save except the Chrome
// permission prompt; a key only leaves the machine when a draft is actually
// requested, and only to the provider it belongs to.

const providersEl = document.getElementById("providers");
const statusEl = document.getElementById("status");
const useLLMCheckbox = document.getElementById("use-llm");
const draftContextInput = document.getElementById("draft-context");
const contextFilePreview = document.getElementById("context-file-preview");
const contextFileStatus = document.getElementById("context-file-status");

const BUNDLED_SETTINGS_URL = chrome.runtime.getURL("src/data/settings.json");

let currentSettings = { ...DEFAULT_SETTINGS };
let keysVisible = false;

async function fetchBundledSettings() {
  const res = await fetch(BUNDLED_SETTINGS_URL);
  if (!res.ok) throw new Error(`Could not load bundled settings.json (${res.status})`);
  return res.json();
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status-msg ${kind}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

// Free-tier providers are worth trying before a paid one, so they are labelled
// rather than silently reordered: the draft path's preference order is the array
// order in providers.js, and this badge just explains what that order is for.
const PAID_PROVIDERS = new Set(["openai", "anthropic"]);

function renderProviders() {
  providersEl.innerHTML = AI_PROVIDERS.map((provider) => {
    const keyValue = currentSettings[`${provider.id}ApiKey`] || "";
    const modelValue = currentSettings[`${provider.id}Model`] || provider.defaultModel;
    const endpointField = provider.requiresEndpoint
      ? `<label class="field-label" for="${provider.id}-endpoint">${provider.endpointLabel}</label>
         <input type="text" id="${provider.id}-endpoint" data-field="customEndpoint"
                placeholder="${provider.endpointPlaceholder}" autocomplete="off" />`
      : "";

    return `
      <div class="card provider" data-provider="${provider.id}">
        <div class="provider-head">
          <span class="provider-name">${escapeHtml(provider.label)}</span>
          <span class="provider-tier ${PAID_PROVIDERS.has(provider.id) ? "paid" : ""}">${
            PAID_PROVIDERS.has(provider.id) ? "Paid" : "Free tier"
          }</span>
        </div>
        <p class="provider-blurb">${escapeHtml(provider.blurb)}<br /><span class="docs">Keys at ${escapeHtml(provider.docs)}</span></p>

        <label class="field-label" for="${provider.id}-key">${escapeHtml(provider.keyLabel)}</label>
        <div class="key-row">
          <input type="password" id="${provider.id}-key" data-field="${provider.id}ApiKey"
                 placeholder="${provider.keyPlaceholder}" autocomplete="off" />
          <button type="button" data-action="reveal" title="Show or hide this key">Show</button>
        </div>

        <label class="field-label" for="${provider.id}-model">${escapeHtml(provider.modelLabel)}</label>
        <input type="text" id="${provider.id}-model" data-field="${provider.id}Model"
               placeholder="${provider.modelPlaceholder}" autocomplete="off" />
        ${endpointField}

        <div class="provider-foot">
          <span class="state"><span class="dot"></span><span data-role="state-text">Not configured</span></span>
          <button type="button" class="ghost" data-action="test">Test</button>
          <span class="test-result" data-role="result"></span>
        </div>
      </div>`;
  }).join("");

  applyFieldValues();
  markConfigured();
}

// Fields are re-rendered wholesale on reload, so values are pushed back into the
// fresh inputs here rather than being preserved across the redraw.
function applyFieldValues() {
  providersEl.querySelectorAll("[data-field]").forEach((input) => {
    const value = currentSettings[input.dataset.field];
    input.value = value == null ? "" : String(value);
    if (input.type === "password") input.type = keysVisible ? "text" : "password";
  });
}

// A saved key that the bundled file doesn't carry still counts as configured —
// this reads what was loaded, not what's typed in the box right now.
function markConfigured() {
  providersEl.querySelectorAll("[data-provider]").forEach((card) => {
    const provider = getProvider(card.dataset.provider);
    const ready = providerReady(provider, currentSettings);
    card.classList.toggle("configured", ready);
    card.querySelector('[data-role="state-text"]').textContent = ready ? "Configured" : "Not configured";
  });
}

function readFields() {
  const values = {};
  providersEl.querySelectorAll("[data-field]").forEach((input) => {
    values[input.dataset.field] = input.value.trim();
  });
  return values;
}

providersEl.addEventListener("input", () => {
  // Keep the "configured" highlight honest while typing, without saving.
  const live = { ...currentSettings, ...readFields() };
  currentSettings = live;
  markConfigured();
});

providersEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const card = button.closest("[data-provider]");
  const provider = getProvider(card.dataset.provider);
  const result = card.querySelector('[data-role="result"]');

  if (button.dataset.action === "reveal") {
    const input = card.querySelector('input[type="password"], input[type="text"][data-field$="ApiKey"]');
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.textContent = hidden ? "Hide" : "Show";
    return;
  }

  // Test. The permission is requested here rather than assumed, because a key
  // can be pasted in before it has ever been saved — and this click is a user
  // gesture, which is the only moment Chrome will grant it.
  button.disabled = true;
  result.className = "test-result";
  result.textContent = "Testing…";
  try {
    if (!providerReady(provider, { ...currentSettings, ...readFields() })) {
      throw new Error(
        provider.requiresEndpoint ? "Add a base URL first." : "Add an API key first."
      );
    }

    const granted = await chrome.permissions.request({ origins: [provider.origin] });
    if (!granted) throw new Error("Network access denied.");

    await sendProviderPrompt({
      provider,
      settings: { ...currentSettings, ...readFields() },
      prompt: "Reply with the single word: ok",
      maxTokens: 16
    });
    result.className = "test-result ok";
    result.textContent = "Works";
  } catch (err) {
    result.className = "test-result err";
    result.textContent = err.message.slice(0, 120);
  } finally {
    button.disabled = false;
  }
});

useLLMCheckbox.addEventListener("change", () => {
  setStatus(
    useLLMCheckbox.checked
      ? "AI drafting on. Save to apply."
      : "AI drafting off — free-text questions fall back to a local template."
  );
});

document.getElementById("reveal-all").addEventListener("click", () => {
  keysVisible = !keysVisible;
  providersEl.querySelectorAll("[data-action='reveal']").forEach((button) => {
    button.textContent = keysVisible ? "Hide" : "Show";
  });
  applyFieldValues();
});

async function load() {
  const { settings: override } = await chrome.storage.local.get("settings");

  let bundled = {};
  let bundledError = "";
  try {
    bundled = await fetchBundledSettings();
  } catch (err) {
    bundledError = ` Could not load bundled settings.json (${err.message}).`;
  }

  // Same merge the popup uses, so a key added to the bundled file is picked up
  // here too without being retyped.
  currentSettings = mergeSettings(bundled, override);
  useLLMCheckbox.checked = !!currentSettings.useLLM;
  draftContextInput.value = currentSettings.draftContext || "";
  renderProviders();
  renderBundledContext(currentSettings);

  if (override) {
    setStatus(`Loaded — bundled settings.json fills in anything you haven't saved here.${bundledError}`);
  } else {
    setStatus(`Loaded from bundled settings.json.${bundledError}`);
  }
}

// Read-only preview of the bundled long-form context file. It lives on disk,
// outside the extension's reach, so without this the only way to know whether a
// draft picked it up is to read the generated answer and guess.
async function renderBundledContext(settings) {
  if (!contextFilePreview || typeof loadBundledContext !== "function") return;

  const { text, path, error } = await loadBundledContext(settings);
  contextFilePreview.value = text || "";

  if (!contextFileStatus) return;
  if (!path && error) {
    contextFileStatus.textContent = "";
  } else if (error) {
    contextFileStatus.textContent = `⚠️ Not loaded — ${error}`;
  } else if (!text) {
    contextFileStatus.textContent = `${path} is empty — nothing extra is being sent.`;
  } else {
    contextFileStatus.textContent = `${path} — ${text.length} chars sent with every draft.`;
  }
}

function settingsFromFields() {
  const values = readFields();
  const next = { useLLM: useLLMCheckbox.checked };

  for (const provider of AI_PROVIDERS) {
    // An empty model falls back to the catalog default rather than being stored
    // as "", so a later change to the default still takes effect.
    next[`${provider.id}Model`] = values[`${provider.id}Model`] || provider.defaultModel;
    // Custom is the one entry where a blank key is meaningful (a local server
    // may need none), so it is stored as-is instead of being dropped.
    next[`${provider.id}ApiKey`] = values[`${provider.id}ApiKey`] || "";
  }

  next.customEndpoint = values.customEndpoint || "";
  next.draftContext = draftContextInput.value.trim();
  return next;
}

document.getElementById("save").addEventListener("click", async () => {
  const wantsLLM = useLLMCheckbox.checked;
  const next = settingsFromFields();

  if (wantsLLM && !configuredProviders(next).length) {
    setStatus("Enter at least one provider key (or a base URL for a local model) to enable AI drafts.", "err");
    useLLMCheckbox.checked = false;
    return;
  }

  if (wantsLLM) {
    const wanted = requiredOrigins(next);
    const granted = await chrome.permissions.request({ origins: wanted });
    if (!granted) {
      setStatus("Network access was denied — AI drafting stays off.", "err");
      useLLMCheckbox.checked = false;
      return;
    }

    // Drop access to any provider left blank, so the extension never holds a
    // permission it isn't using.
    const unused = allOrigins().filter((origin) => !wanted.includes(origin));
    if (unused.length) chrome.permissions.remove({ origins: unused }).catch(() => {});
  } else {
    // Revoking is best-effort; not blocking on it.
    chrome.permissions.remove({ origins: allOrigins() }).catch(() => {});
  }

  // The AI record and the analytics record share one `settings` key, so the
  // existing analytics fields are carried over rather than overwritten.
  const { settings: existing = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...existing, ...next } });

  currentSettings = { ...currentSettings, ...next };
  renderProviders();
  setStatus(
    wantsLLM
      ? `Saved. Drafts will use: ${configuredProviders(next).map((p) => p.label).join(" → ")}.`
      : "Saved. AI drafting is off — free-text answers fall back to a local template.",
    "ok"
  );

  // Key *presence* only, never the keys themselves.
  Analytics.track("AI Settings Saved", {
    use_llm: wantsLLM,
    provider_count: configuredProviders(next).length,
    providers: configuredProviders(next).map((p) => p.id).join(","),
    models: configuredProviders(next).map((p) => providerModel(p, next)).join(",")
  });
});

document.getElementById("download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(settingsFromFields(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "settings.json";
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded — drop it over src/data/settings.json to make it the bundled default.", "ok");
});

document.getElementById("reload-bundled").addEventListener("click", async () => {
  try {
    const bundled = await fetchBundledSettings();
    currentSettings = mergeSettings(bundled, null);
    useLLMCheckbox.checked = !!currentSettings.useLLM;
    draftContextInput.value = currentSettings.draftContext || "";
    renderProviders();
    renderBundledContext(currentSettings);
    setStatus("Reloaded from bundled settings.json — click Save to keep it.", "ok");
  } catch (err) {
    setStatus(`Could not load bundled settings.json: ${err.message}`, "err");
  }
});

Analytics.init("keys");
load();