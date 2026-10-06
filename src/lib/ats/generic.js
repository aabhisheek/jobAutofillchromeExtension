// Baseline adapter. It intentionally contains no site-specific selectors;
// page-scripts.js uses ordinary HTML controls for this fallback.
const GenericAtsAdapter = {
  id: "generic",
  name: "Generic application form",
  matches() {
    return true;
  },
  pageConfig: {
    // No selector on purpose. Naming a generic button here would be worse than
    // having none: advanceStep()'s label matching already finds a Next/Continue
    // control on an unmarked form, and a hardcoded selector would win over that
    // matching and click whatever it happened to name. See advanceButton in
    // page-scripts.js for why an adapter entry outranks text matching.
    advanceButton: ""
  }
};
