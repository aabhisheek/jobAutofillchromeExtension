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
  pageConfig: {}
};
