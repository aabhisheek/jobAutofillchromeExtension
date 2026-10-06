const LeverAtsAdapter = {
  id: "lever",
  name: "Lever",
  matches(url) {
    try {
      return /(^|\.)lever\.co$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  pageConfig: {
    // Lever's application wizard advances from a button in the application card
    // whose label is plain "Continue" / "Submit". The shared engine matches that
    // text on its own; this is here so a markup change shows up as a failing
    // adapter rather than as a silent fall-through to text matching.
    advanceButton: '.application-form button[type="submit"], .btn-primary'
  }
};
