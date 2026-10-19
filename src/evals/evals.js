const runsEl = document.getElementById("runs");
const summaryEl = document.getElementById("summary");
const pretty = (value) => JSON.stringify(value || {}, null, 2);
const label = (task) => ({ "gmail-parse":"Gmail parsing", "field-detection":"Field detection", "job-scrape":"Job shortlist" }[task] || task);

function renderSummary(runs) {
  const summary = AiEvals.summary(runs);
  summaryEl.innerHTML = [[summary.pass, "Pass"], [summary["needs-review"], "Needs review"], [summary.unreviewed, "Unreviewed"]]
    .map(([value, name]) => `<div class="metric"><strong>${value}</strong><span>${name}</span></div>`).join("");
}
function render(runs) {
  renderSummary(runs);
  if (!runs.length) { runsEl.innerHTML = '<p class="empty">No AI runs yet. Use Gmail import, Resolve with AI, or Find jobs, then come back here to review the result.</p>'; return; }
  runsEl.innerHTML = runs.map((run) => {
    const verdict = AiEvals.verdict(run);
    return `<article class="eval-run" data-id="${run.id}"><div class="run-head"><div><h2>${label(run.task)}</h2><p class="run-meta">${new Date(run.at).toLocaleString()} · ${escapeHtml(run.promptVersion || "default")}${run.provider ? ` · ${escapeHtml(run.provider)}` : ""}</p></div><span class="badge ${verdict}">${verdict.replace("-", " ")}</span></div><div class="eval-grid"><section><h3>Input summary</h3><pre>${escapeHtml(pretty(run.input))}</pre></section><section><h3>AI output</h3><pre>${escapeHtml(pretty(run.output))}</pre></section></div>${run.expected ? `<div class="eval-grid"><section><h3>Expected result</h3><pre>${escapeHtml(pretty(run.expected))}</pre></section></div>` : ""}<div class="run-actions"><button data-action="baseline">Use output as expected</button><button data-action="edit" class="ghost">Edit expected</button><button data-action="delete" class="ghost">Delete</button></div><div class="editor"><textarea spellcheck="false">${escapeHtml(pretty(run.expected || run.output))}</textarea><div class="run-actions"><button data-action="save" class="primary">Save expected</button><span class="run-meta">Expected output is compared exactly with future runs.</span></div></div></article>`;
  }).join("");
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
async function refresh() { render(await AiEvals.list()); }
runsEl.addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; const card = button.closest(".eval-run"); const id = card.dataset.id; const action = button.dataset.action; if (action === "edit") card.querySelector(".editor").classList.toggle("open"); if (action === "delete") { await AiEvals.remove(id); await refresh(); } if (action === "baseline") { const run = (await AiEvals.list()).find((item) => item.id === id); await AiEvals.setExpected(id, run.output); await refresh(); } if (action === "save") { try { await AiEvals.setExpected(id, JSON.parse(card.querySelector("textarea").value)); await refresh(); } catch { button.textContent = "Expected valid JSON"; } } });
document.getElementById("clear").addEventListener("click", async () => { await AiEvals.clear(); await refresh(); });
const versionInput = document.getElementById("prompt-version");
const versionStatus = document.getElementById("version-status");
document.getElementById("save-version").addEventListener("click", async () => {
  await AiEvals.setPromptVersion(versionInput.value);
  versionInput.value = await AiEvals.getPromptVersion();
  versionStatus.textContent = "Saved. New runs use this version.";
});
AiEvals.getPromptVersion().then((value) => { versionInput.value = value; });
refresh();
