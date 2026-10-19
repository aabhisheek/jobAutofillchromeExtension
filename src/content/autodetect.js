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
//
// A form being present also arms auto-open of the side panel. Chrome refuses
// chrome.sidePanel.open() unless it is called from a user gesture, and a
// form-detected report carries none: the gesture has to start here, in the
// page. So once a real application form is on screen the first ordinary
// click or keypress on the page opens the panel — no toolbar icon involved.
// One attempt per document, so a page the user later closes the panel on stays
// closed.
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

  // Auto-open state. `armed` is true while a gesture listener is installed (so
  // repeated reports don't stack listeners); `openRequested` latches once the
  // panel has been asked for, so a second gesture never pops it back over a
  // panel the user has since dismissed.
  let armed = false;
  let openRequested = false;

  // The side panel is per-window, and this script runs in every frame
  // (all_frames). Only the top frame arms the gesture, or a click inside an ad
  // iframe could drive the panel of the page it happens to sit in. `window` is
  // absent in the test realm, which reads as "top frame" — the only frame the
  // tests describe.
  function isTopFrame() {
    return typeof window === "undefined" || window.top === window;
  }

  function requestOpen() {
    if (openRequested) return;
    openRequested = true;
    // The worker's sidePanel.open() only succeeds because this message is sent
    // from inside a real gesture handler. A report, by contrast, has no
    // gesture and would be rejected there.
    chrome.runtime
      .sendMessage({ type: "autofill:open-panel", href: location.href })
      .catch(() => {});
  }

  function armOpenOnInteraction() {
    if (armed || openRequested || !isTopFrame()) return;
    armed = true;

    const onGesture = () => {
      armed = false;
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
      requestOpen();
    };

    // capture so the panel opens even when the page's own handlers stop
    // propagation, and passive so this listener can never delay the
    // interaction it is riding on.
    document.addEventListener("pointerdown", onGesture, { capture: true, once: true, passive: true });
    document.addEventListener("keydown", onGesture, { capture: true, once: true, passive: true });
  }

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

    // Arm auto-open before the dedupe below: a form that has not changed is
    // still a form the user is about to interact with. This only installs a
    // listener; it sends nothing until the user actually touches the page.
    armOpenOnInteraction();

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
