const GreenhouseAtsAdapter = {
  id: "greenhouse",
  name: "Greenhouse",
  matches(url) {
    try {
      return /(^|\.)(greenhouse\.io|grnh\.se)$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  pageConfig: {
    // Greenhouse's post-application wizard is a single <button> in the card
    // footer whose label changes per step ("Submit" on the last one). The shared
    // engine already refuses to click a submit, so naming the footer is enough.
    advanceButton: 'button[type="submit"][class*="btn" i], form button[type="submit"]'
  }
};
