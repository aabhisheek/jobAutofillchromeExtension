// LinkedIn Easy Apply uses a multi-step modal. Form fields use the shared
// HTML-control fallback; navigation is where the modal differs from a full-page
// wizard.
const LinkedInAtsAdapter = {
  id: "linkedin",
  name: "LinkedIn Easy Apply",
  matches(url) {
    try {
      return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  pageConfig: {
    // Easy Apply is a modal whose steps advance with a footer "Next" button and
    // whose last step says "Submit". The shared engine's text matching handles
    // both, and refuses the submit — which is the desired outcome here, since
    // LinkedIn's submit is the real application.
    advanceButton: '[data-id*="jobs-apply-next" i], form footer button[type="submit"]'
  }
};
