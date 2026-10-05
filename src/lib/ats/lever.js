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
  pageConfig: {}
};
