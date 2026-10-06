// Automatic form detection.
//
// Declared statically in manifest.json (document_idle, all_frames, http/https)
// so every page and frame announces itself without anyone clicking Scan. This
// script only COUNTS form controls and reports changes; it never reads field
// values and never fills anything. The side panel is the only listener that
// acts on the report, which keeps the review step exactly where it is: a form
// being present causes the review list to appear, not an autofill.
//
// The report is sent only when the control count CHANGES (or on the first
// check after load). That is what stops the extension's own work from feeding
// back into it: a scan stamps data-autofill-uid attributes and a fill may add
// helper nodes, but neither changes how many input/textarea/select elements
// exist. The observer watches childList only — not attributes — for the same
// reason, since the scan's attribute stamping would otherwise re-trigger it.
(function () {
  // Below this the page is a search box or a cookie banner, not an
  // application. Each report makes the panel re-render its review list, so
  // the first one waits for something worth scanning.
  const MIN_CONTROLS = 3;
  // ATS pages mutate constantly while hydrating — one report per settled
  // burst rather than one per mutation.
  const DEBOUNCE_MS = 600;

  // The count and href of the last report, so unchanged pages stay quiet and
  // an SPA route change (same count, new URL) is still noticed.
  let lastSent = null;
  let timer = null;

  // Open shadow roots are pierced the same way describeFrames() in
  // page-scripts.js does it: several form widgets (date pickers, custom
  // selects) render their controls inside one.
  function countControls() {
    let count = 0;
    const visit = (root) => {
      count += root.querySelectorAll("input, textarea, select").length;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return count;
  }

  function report() {
    timer = null;
    const controlCount = countControls();
    const href = location.href;
    if (controlCount < MIN_CONTROLS) return;
    if (lastSent && lastSent.controlCount === controlCount && lastSent.href === href) return;
    lastSent = { controlCount, href };

    // The normal case is no listener at all: the panel is closed almost all
    // the time, and a report into that silence is not an error.
    chrome.runtime
      .sendMessage({ type: "autofill:form-detected", controlCount, href })
      .catch(() => {});
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, DEBOUNCE_MS);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Not debounced: a page that already has the form at document_idle should
  // announce it immediately rather than one idle period later.
  report();
})();
