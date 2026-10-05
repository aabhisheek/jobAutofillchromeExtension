// LinkedIn Easy Apply uses a multi-step modal. It currently uses the shared
// HTML-control fallback; future modal-specific navigation belongs here.
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
  pageConfig: {}
};
