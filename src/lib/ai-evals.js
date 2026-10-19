// Local, privacy-conscious evidence for the extension's AI features. A run
// contains only the small input needed to identify the decision and its parsed
// result; callers deliberately do not send full mail bodies or profile values.

const AI_EVALS_KEY = "aiEvalRuns";
const AI_EVALS_PROMPT_VERSION_KEY = "aiEvalPromptVersion";
const AI_EVALS_LIMIT = 150;

function aiEvalId() {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function aiEvalText(value, limit = 500) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function aiEvalObject(value) {
  if (!value || typeof value !== "object") return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

function aiEvalSame(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const AiEvals = {
  async list() {
    const stored = await chrome.storage.local.get(AI_EVALS_KEY);
    const runs = Array.isArray(stored[AI_EVALS_KEY]) ? stored[AI_EVALS_KEY] : [];
    return runs.filter((run) => run && typeof run.id === "string");
  },

  async record({ task, input, output, provider = "", note = "" } = {}) {
    if (!task) return null;
    const [runs, settings] = await Promise.all([this.list(), chrome.storage.local.get(AI_EVALS_PROMPT_VERSION_KEY)]);
    const cleanInput = aiEvalObject(input);
    // An expected result belongs to a task/input pair. When the same example is
    // seen again after a prompt edit, it is graded automatically instead of
    // making the user establish the baseline again.
    const baseline = runs.find((item) => item.task === task && item.expected && aiEvalSame(item.input, cleanInput));
    const run = {
      id: aiEvalId(), task: aiEvalText(task, 60), at: Date.now(),
      input: cleanInput, output: aiEvalObject(output),
      expected: baseline ? aiEvalObject(baseline.expected) : null, provider: aiEvalText(provider, 80), note: aiEvalText(note, 300),
      promptVersion: aiEvalText(settings[AI_EVALS_PROMPT_VERSION_KEY] || "default", 80)
    };
    runs.unshift(run);
    await chrome.storage.local.set({ [AI_EVALS_KEY]: runs.slice(0, AI_EVALS_LIMIT) });
    return run;
  },

  async setExpected(id, expected) {
    const runs = await this.list();
    const run = runs.find((item) => item.id === id);
    if (!run) return null;
    run.expected = aiEvalObject(expected);
    run.gradedAt = Date.now();
    await chrome.storage.local.set({ [AI_EVALS_KEY]: runs });
    return run;
  },

  async remove(id) {
    const runs = await this.list();
    await chrome.storage.local.set({ [AI_EVALS_KEY]: runs.filter((run) => run.id !== id) });
  },

  async clear() { await chrome.storage.local.remove(AI_EVALS_KEY); },

  async getPromptVersion() {
    const stored = await chrome.storage.local.get(AI_EVALS_PROMPT_VERSION_KEY);
    return aiEvalText(stored[AI_EVALS_PROMPT_VERSION_KEY] || "default", 80);
  },

  async setPromptVersion(value) {
    await chrome.storage.local.set({ [AI_EVALS_PROMPT_VERSION_KEY]: aiEvalText(value || "default", 80) || "default" });
  },

  verdict(run) {
    if (!run || !run.expected) return "unreviewed";
    return aiEvalSame(run.output, run.expected) ? "pass" : "needs-review";
  },

  summary(runs) {
    return runs.reduce((totals, run) => {
      totals[this.verdict(run)] += 1;
      return totals;
    }, { pass: 0, "needs-review": 0, unreviewed: 0 });
  }
};
