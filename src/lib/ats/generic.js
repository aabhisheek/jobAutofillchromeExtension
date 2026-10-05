// Baseline adapter. It intentionally contains no site-specific selectors;
// page-scripts.js uses ordinary HTML controls for this fallback.
const GenericAtsAdapter = {
  id: "generic",
  name: "Generic application form",
  matches() {
    return true;
  },
  pageConfig: {}
};
