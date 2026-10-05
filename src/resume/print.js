// Print page for a tailored resume. Opens in its own tab (the Tailor page hands
// the job over through chrome.storage.session), lays the sheets out in this very
// document instead of an iframe — Chrome does not reliably print iframe content
// — and then calls window.print() so "Save as PDF" is one click away.

const PRINT_JOB_KEY = "resumePrintJob";

function setStatus(text, isError) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("error", !!isError);
}

function loadDocIntoFrame(frame, doc) {
  return new Promise((resolve) => {
    frame.addEventListener("load", () => resolve(frame.contentDocument), { once: true });
    frame.srcdoc = doc;
  });
}

async function buildSheets(job) {
  const engine = job.engine === "latexjs" ? "latexjs" : "fast";
  const layout = parseLatexLayout(job.tex);

  const probe = document.createElement("iframe");
  probe.style.cssText = "position:absolute;left:-10000px;top:0;border:none;visibility:hidden";
  probe.style.width = `${paperWidthPx(layout)}px`;
  probe.style.height = `${paperHeightPx(layout)}px`;
  document.body.appendChild(probe);

  let sheets;
  try {
    sheets = await paginatePaperPages({
      tex: job.tex,
      engine,
      layout,
      highlightText: job.highlightText,
      loadDoc: (doc) => loadDocIntoFrame(probe, doc)
    });
  } finally {
    probe.remove();
  }

  const { style, pagesHtml } = paperDocumentParts({
    pages: sheets.pages,
    layout: sheets.layout,
    engine: sheets.engine,
    engineCss: engine === "latexjs" ? await loadLatexCss() : ""
  });

  return { style, pagesHtml, pageCount: sheets.pageCount, warnings: sheets.warnings };
}

// Replaces the loading screen with the sheets themselves. The status line is
// re-created afterwards because it lived in the body we just replaced.
function showSheets({ style, pagesHtml, pageCount }) {
  document.head.innerHTML = `<meta charset="utf-8" />
<style>
${style}
.hint {
  position: fixed;
  right: 8px;
  bottom: 8px;
  z-index: 10;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.95);
  font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #1a1a1a;
}
.hint.error { color: #b91c1c; border-color: #fca5a5; }
.hint button {
  cursor: pointer;
  margin-left: 12px;
  padding: 6px 14px;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #f5f5f5;
  font-size: 13px;
}
@media print { .hint { display: none; } }
</style>`;

  document.body.innerHTML = pagesHtml;
  document.body.style.margin = "0";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.id = "status";
  document.body.appendChild(hint);

  return pageCount;
}

// Chrome names the "Save as PDF" file after the document title, so it has to be
// set before the print dialog opens — and derived from the resume the tailored
// one came from ("go (3).pdf (PDF → LaTeX)" → "go (3) - tailored").
function printFileTitle(label) {
  const base = String(label || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, " ")
    .trim();
  return `${base || "resume"} - tailored`;
}

async function run() {
  const { [PRINT_JOB_KEY]: job } = await chrome.storage.session.get(PRINT_JOB_KEY);

  if (!job || !job.tex) {
    setStatus("No tailored resume to print — go back to the Tailor Resume page and run the analysis first.", true);
    return;
  }

  // Consumed once: reloading this tab must not re-print a stale job.
  await chrome.storage.session.remove(PRINT_JOB_KEY);

  let sheets;
  try {
    sheets = await buildSheets(job);
  } catch (err) {
    setStatus(`Could not render the resume: ${err.message}`, true);
    return;
  }

  const pageCount = showSheets(sheets);

  // Wait for the browser to finish laying the sheets out, otherwise the print
  // dialog can open against a half-measured document and drop the last page.
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  document.title = printFileTitle(job.label);
  window.print();

  // Printed automatically; keep a manual escape hatch if the dialog was
  // cancelled. The hint itself is hidden in print output (see .hint above).
  const dropped = [...new Set(sheets.warnings || [])];
  const droppedNote = dropped.length ? ` Dropped unsupported LaTeX: ${dropped.join(", ")}.` : "";
  setStatus(
    `${pageCount} page(s) — pick "Save as PDF" as the print destination.${droppedNote}`
  );
  const button = document.createElement("button");
  button.textContent = "Print again";
  button.addEventListener("click", () => window.print());
  document.getElementById("status").appendChild(button);
}

run().catch((err) => setStatus(`Could not render the resume: ${err.message}`, true));