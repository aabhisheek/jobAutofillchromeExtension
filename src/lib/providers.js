// Every AI provider the extension can draft with, in one list.
//
// This is the single source of truth shared by three places that would otherwise
// drift apart: the API Keys screen that renders a form field per provider, the
// draft path in draft.js that decides which model actually answers a question,
// and the origin permissions the manifest asks for. Adding a provider is a new
// entry here plus its host permission in manifest.json — no branching anywhere.
//
// Array order IS the preference order the draft path walks: free and cheap
// providers first, paid ones last as the safety net. Reorder this array to
// change that everywhere at once.

const AI_PROVIDERS = [
  {
    id: "groq",
    label: "Groq",
    blurb: "Free tier, very fast. Good default for bulk drafting.",
    keyLabel: "Groq API key",
    keyPlaceholder: "gsk_…",
    modelLabel: "Groq model",
    modelPlaceholder: "openai/gpt-oss-120b",
    defaultModel: "openai/gpt-oss-120b",
    docs: "console.groq.com/keys",
    origin: "https://api.groq.com/*"
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Free tier, large context. Good for long job descriptions.",
    keyLabel: "Gemini API key",
    keyPlaceholder: "AIza…",
    modelLabel: "Gemini model",
    modelPlaceholder: "gemini-flash-latest",
    defaultModel: "gemini-flash-latest",
    docs: "aistudio.google.com/apikey",
    origin: "https://generativelanguage.googleapis.com/*"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "Very cheap, OpenAI-compatible API.",
    keyLabel: "DeepSeek API key",
    keyPlaceholder: "sk-…",
    modelLabel: "DeepSeek model",
    modelPlaceholder: "deepseek-chat",
    defaultModel: "deepseek-chat",
    docs: "platform.deepseek.com",
    origin: "https://api.deepseek.com/*"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key, every model on its marketplace.",
    keyLabel: "OpenRouter API key",
    keyPlaceholder: "sk-or-…",
    modelLabel: "OpenRouter model",
    modelPlaceholder: "anthropic/claude-3.5-sonnet",
    defaultModel: "anthropic/claude-3.5-sonnet",
    docs: "openrouter.ai/keys",
    origin: "https://openrouter.ai/*"
  },
  {
    id: "together",
    label: "Together AI",
    blurb: "Open models at low cost, OpenAI-compatible API.",
    keyLabel: "Together API key",
    keyPlaceholder: "",
    modelLabel: "Together model",
    modelPlaceholder: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    docs: "api.together.ai/settings/api-keys",
    origin: "https://api.together.xyz/*"
  },
  {
    id: "mistral",
    label: "Mistral",
    blurb: "European provider, OpenAI-compatible API.",
    keyLabel: "Mistral API key",
    keyPlaceholder: "",
    modelLabel: "Mistral model",
    modelPlaceholder: "mistral-small-latest",
    defaultModel: "mistral-small-latest",
    docs: "console.mistral.ai/api-keys",
    origin: "https://api.mistral.ai/*"
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    blurb: "Grok models, OpenAI-compatible API.",
    keyLabel: "xAI API key",
    keyPlaceholder: "xai-…",
    modelLabel: "xAI model",
    modelPlaceholder: "grok-2-latest",
    defaultModel: "grok-2-latest",
    docs: "console.x.ai",
    origin: "https://api.x.ai/*"
  },
  {
    id: "custom",
    label: "Custom / self-hosted",
    blurb: "Anything OpenAI-compatible: Ollama, LM Studio, vLLM, llama.cpp.",
    keyLabel: "API key (leave blank if the server needs none)",
    keyPlaceholder: "",
    modelLabel: "Model",
    modelPlaceholder: "llama3.1",
    defaultModel: "llama3.1",
    docs: "http://localhost:11434/v1",
    origin: "http://localhost/*",
    // No default endpoint: this one is the user's own server, so the base URL is
    // a required field rather than something that can be guessed.
    requiresEndpoint: true,
    endpointLabel: "Base URL",
    endpointPlaceholder: "http://localhost:11434/v1"
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "Paid. Tried last as the safety net for the others.",
    keyLabel: "OpenAI API key",
    keyPlaceholder: "sk-…",
    modelLabel: "OpenAI model",
    modelPlaceholder: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
    docs: "platform.openai.com/api-keys",
    origin: "https://api.openai.com/*"
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    blurb: "Paid. Strongest long-form writing; tried last.",
    keyLabel: "Anthropic API key",
    keyPlaceholder: "sk-ant-…",
    modelLabel: "Claude model",
    modelPlaceholder: "claude-opus-4-7",
    defaultModel: "claude-opus-4-7",
    docs: "console.anthropic.com/settings/keys",
    origin: "https://api.anthropic.com/*"
  }
];

// Wire format families. Everything except Gemini and Anthropic speaks the
// OpenAI chat-completions shape, which is why one caller covers most of this
// list and a new OpenAI-compatible vendor is a config change, not new code.
const PROVIDER_FAMILY = {
  groq: "openai",
  gemini: "gemini",
  deepseek: "openai",
  openrouter: "openai",
  together: "openai",
  mistral: "openai",
  xai: "openai",
  custom: "openai",
  openai: "openai",
  anthropic: "anthropic"
};

// Per-provider endpoints. `{model}` is substituted at call time.
const PROVIDER_ENDPOINT = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  deepseek: "https://api.deepseek.com/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages"
};

// Newer OpenAI models reject `max_tokens` in favour of `max_completion_tokens`;
// everything else in the family still takes the older name.
const PROVIDER_MAX_TOKENS_KEY = {
  groq: "max_completion_tokens",
  deepseek: "max_tokens",
  openrouter: "max_tokens",
  together: "max_tokens",
  mistral: "max_tokens",
  xai: "max_tokens",
  custom: "max_tokens",
  openai: "max_completion_tokens"
};

// Whether an output cap has to be sent with a request at all.
//
// "omit" is the default, and the right answer nearly everywhere: the parameter is
// only an upper bound that a well-behaved model never reaches, so leaving it off
// hands the decision to the provider, which knows the model's real output limit.
// Sending a number instead is how a batch ends up truncated by a ceiling picked in
// this file — and that ceiling can only be wrong downwards, because a model that
// would have finished in 12,000 tokens gets cut at 8,000.
//
// It cannot simply be dropped everywhere, though:
//   anthropic — `max_tokens` is a required parameter; omitting it is a 400.
//   custom    — a self-hosted endpoint's default is whatever its server was
//               configured with, which cannot be looked up from here.
// Sending a value *above* a model's own limit is a 400 on OpenAI and Gemini,
// which is why the number is never guessed upward either.
const OUTPUT_CAP_MODE = {
  anthropic: "required",
  custom: "explicit"
};

function outputCapMode(providerId) {
  return OUTPUT_CAP_MODE[providerId] || "omit";
}

// Anthropic requires an explicit API version header and has no notion of a
// system/user split — it takes one user turn and an optional system block.
const ANTHROPIC_VERSION = "2023-06-01";

function getProvider(id) {
  return AI_PROVIDERS.find((provider) => provider.id === id) || null;
}

function providerFamily(id) {
  return PROVIDER_FAMILY[id] || "openai";
}

function providerEndpoint(id, settings) {
  if (id === "custom") {
    const base = String((settings && settings.customEndpoint) || "").trim().replace(/\/+$/, "");
    return base ? `${base}/chat/completions` : "";
  }
  return PROVIDER_ENDPOINT[id] || "";
}

// A provider is only usable once it has whatever it actually needs. The custom
// entry needs an endpoint; everything else needs a key (blank is a legitimate
// state for a local server, which is why `custom` is exempt).
function providerReady(provider, settings) {
  if (!provider || !settings) return false;
  if (provider.requiresEndpoint) return !!String(settings.customEndpoint || "").trim();
  return !!String(settings[`${provider.id}ApiKey`] || "").trim();
}

function providerKey(provider, settings) {
  return String((settings && settings[`${provider.id}ApiKey`]) || "").trim();
}

function providerModel(provider, settings) {
  return (
    String((settings && settings[`${provider.id}Model`]) || "").trim() ||
    provider.defaultModel
  );
}

// Origins worth requesting for the providers that actually have a key. The
// custom entry is always included when it has an endpoint because a local server
// may well need no key at all, and without the origin permission the request
// fails before any auth is even considered.
function requiredOrigins(settings) {
  return AI_PROVIDERS.filter((provider) => {
    if (provider.requiresEndpoint) return !!String(settings.customEndpoint || "").trim();
    return !!String(settings[`${provider.id}ApiKey`] || "").trim();
  }).map((provider) => provider.origin);
}

function allOrigins() {
  return AI_PROVIDERS.map((provider) => provider.origin);
}

// No key, no permission, no entry in the draft path. Used by both the keys
// screen and draft.js so "configured" means exactly one thing.
function configuredProviders(settings) {
  return AI_PROVIDERS.filter((provider) => providerReady(provider, settings));
}

// ---- Sending a prompt -------------------------------------------------
//
// One function per wire-format family instead of one per vendor: eight of the
// ten entries above speak the OpenAI chat-completions shape, so Groq, DeepSeek,
// OpenRouter, Together, Mistral, xAI, OpenAI and a self-hosted server are all
// the same three lines of JSON with a different URL. Both callers — the draft
// path in draft.js and the "Test" button on the keys screen — go through here,
// so a provider that works when tested is the same provider that works when
// drafting.

// How many times a rate-limited request is re-sent before it is called a
// failure. A 429 is a capacity signal, not a bad request: the same prompt
// succeeds seconds later, and rotating to the next provider instead only
// spends a second key to be told the same thing.
const RATE_LIMIT_RETRIES = 2;

// fetch() plus the one retry behaviour every provider shares. Only 429 is
// retried — a 401 or a 400 will fail identically forever, and retrying those
// only delays the error the user needs to see.
async function fetchWithRateLimitRetry(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);

    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;

    // Honour the server's own backoff when it sends one. Groq and Gemini both
    // do, and their number is larger than any fixed delay worth guessing at.
    const header = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(header) && header > 0
        ? Math.min(header * 1000, 30000)
        : 2500 * (attempt + 1) ** 2;

    // Drain the body so the connection can be reused, then wait.
    await res.text().catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function readError(res, label) {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text);
    // OpenAI-shaped errors put the useful part in error.message; Anthropic puts
    // it in error.message too, but Gemini uses error[0].message.
    const message =
      (parsed.error && (parsed.error.message || parsed.error.status)) ||
      (Array.isArray(parsed.error) && parsed.error[0] && parsed.error[0].message);
    if (message) detail = String(message).slice(0, 200);
  } catch {
    // Not JSON — the raw text above is the best we have.
  }

  const error = new Error(
    res.status === 429
      ? `${label} is rate limiting this key — try again in a minute.`
      : `${label} request failed (${res.status}): ${detail}`
  );
  error.status = res.status;
  error.rateLimited = res.status === 429;
  return error;
}

// Did the reply stop because it ran out of output budget?
//
// This is the one wire-level fact that explains a whole class of "the AI
// resolved some fields and then needed another click": the answer was not
// refused, it was cut off. Each family names it differently and all three are
// normalized to a boolean here so the callers never have to know which one they
// are talking to.
function isTruncationReason(reason) {
  return /^(length|max_tokens)$/i.test(String(reason || ""));
}

function replyFromOpenAiShape(data, provider) {
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  const text = message && typeof message.content === "string" ? message.content : "";
  if (!text) throw new Error(`${provider.label} response had no text content.`);
  return { text: text.trim(), truncated: isTruncationReason(choice.finish_reason) };
}

async function sendOpenAiCompatible({ provider, settings, prompt, maxTokens }) {
  const endpoint = providerEndpoint(provider.id, settings);
  if (!endpoint) throw new Error(`No endpoint configured for ${provider.label}.`);

  const capKey = PROVIDER_MAX_TOKENS_KEY[provider.id] || "max_tokens";
  const cap = outputCapMode(provider.id) === "omit" ? null : maxTokens || 600;

  const res = await fetchWithRateLimitRetry(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${providerKey(provider, settings)}`
    },
    body: JSON.stringify({
      model: providerModel(provider, settings),
      // Absent rather than zero when the provider applies its own limit.
      ...(cap ? { [capKey]: cap } : {}),
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) throw await readError(res, provider.label);

  return replyFromOpenAiShape(await res.json(), provider);
}

async function sendGemini({ provider, settings, prompt, maxTokens }) {
  const model = providerModel(provider, settings);
  const cap = outputCapMode(provider.id) === "omit" ? null : maxTokens;

  const res = await fetchWithRateLimitRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(providerKey(provider, settings))}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Left to the model's own outputTokenLimit unless a budget was asked
        // for, which no Gemini-configured path does — the endpoint knows the
        // number and this file would only be guessing at it.
        ...(cap ? { generationConfig: { maxOutputTokens: cap } } : {})
      })
    }
  );

  if (!res.ok) throw await readError(res, provider.label);

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = Array.isArray(parts) ? parts.map((part) => part.text || "").join("") : "";
  if (!text) throw new Error(`${provider.label} response had no text content.`);
  return { text: text.trim(), truncated: isTruncationReason(candidate.finishReason) };
}

async function sendAnthropic({ provider, settings, prompt, maxTokens }) {
  const res = await fetchWithRateLimitRetry(providerEndpoint(provider.id, settings), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": providerKey(provider, settings),
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: providerModel(provider, settings),
      // The one provider that will not take the request without it.
      max_tokens: maxTokens || 600,
      // Anthropic has no "user" role to put the prompt in — it takes a single
      // user turn, with the instructions as a separate top-level system block.
      system: "You are filling in one field of a job application form. Answer with the field's value only — no preamble, no explanation.",
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) throw await readError(res, provider.label);

  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((block) => block.type === "text").map((block) => block.text || "").join("")
    : "";
  if (!text) throw new Error(`${provider.label} response had no text content.`);
  return { text: text.trim(), truncated: isTruncationReason(data.stop_reason) };
}

// Detailed form: the reply text plus whether it was cut short. Used by the batch
// path, where a truncated reply is a recoverable partial answer rather than an
// error — the difference decides whether the fields in the cut-off half survive.
async function sendProviderPromptDetailed({ provider, settings, prompt, maxTokens }) {
  if (!providerReady(provider, settings)) {
    throw new Error(
      provider.requiresEndpoint
        ? `${provider.label} needs a base URL before it can be used.`
        : `${provider.label} needs an API key before it can be used.`
    );
  }

  if (providerFamily(provider.id) === "gemini") return sendGemini({ provider, settings, prompt, maxTokens });
  if (providerFamily(provider.id) === "anthropic") return sendAnthropic({ provider, settings, prompt, maxTokens });
  return sendOpenAiCompatible({ provider, settings, prompt, maxTokens });
}

// Plain form: the text only, for callers that have nothing useful to do with a
// stop reason (the per-field draft path, resume tailoring, the keys-screen test).
async function sendProviderPrompt({ provider, settings, prompt, maxTokens }) {
  return (await sendProviderPromptDetailed({ provider, settings, prompt, maxTokens })).text;
}