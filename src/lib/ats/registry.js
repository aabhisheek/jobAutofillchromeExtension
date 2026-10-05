// One place to select the adapter for the active tab. The generic adapter is
// always last so unknown platforms retain the existing fallback behavior.
const AtsAdapters = [
  WorkdayAtsAdapter,
  LinkedInAtsAdapter,
  GreenhouseAtsAdapter,
  LeverAtsAdapter,
  GoogleFormsAtsAdapter,
  GenericAtsAdapter
];

const AtsRegistry = {
  resolve(url) {
    return AtsAdapters.find((adapter) => adapter.matches(url)) || GenericAtsAdapter;
  }
};
