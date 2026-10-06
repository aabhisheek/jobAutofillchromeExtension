// Workday's UI is built from custom controls rather than native <select>s.
// Keep selectors and route-specific behavior here; page-scripts.js provides
// the reusable scan/fill engine that interprets this data.
const WorkdayAtsAdapter = {
  id: "workday",
  name: "Workday",
  matches(url) {
    try {
      const { hostname } = new URL(url);
      return /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com)$/i.test(hostname);
    } catch {
      return false;
    }
  },
  pageConfig: {
    // Workday's degree menu uses the broad education level rather than the
    // profile's exact credential (for example, B.Tech -> Bachelors).
    valueOverrides: {
      "education.0.degree": {
        value: "Bachelors",
        accepts: ["Bachelor's", "Bachelor Degree"]
      },
      // Field of Study is a searchable prompt with its own short vocabulary
      // (four entries on this form), and it labels the engineering option
      // "Computer Engineering". The profile keeps the broader name every other
      // site wants; only Workday sees this one. Both are accepted so the fill
      // still lands if a given form offers the broader wording instead.
      "education.0.field": {
        value: "Computer Engineering",
        accepts: ["Computer Science"]
      }
    },
    comboboxSelectors: [
      '[data-uxi-widget-type="selectinput"]',
      '[data-automation-id="multiSelectContainer"]',
      '[data-automation-id="multiselectInputContainer"]',
      '[data-uxi-widget-type="multiselect"]'
    ],
    optionSelectors: [
      '[data-automation-id="menuItem"]',
      '[data-automation-id="promptOption"]'
    ],
    // Some Workday education menus expose only a styled trigger rather than a
    // native input or an ARIA combobox. Discover these required widgets by
    // their field container and visible label.
    requiredWidgetFields: [
      {
        labelPhrase: "degree",
        containerSelector: '[data-automation-id*="formField" i]',
        triggerSelectors: [
          '[data-automation-id="selectWidget"]',
          '[data-automation-id="dropdownWidget"]',
          '[data-uxi-widget-type="selectinput"]',
          '[role="combobox"]',
          '[aria-haspopup="listbox"]',
          'button'
        ]
      }
    ],
    resumeStep: {
      hostnameSuffix: "myworkdayjobs.com",
      pathContains: "/apply/autofillwithresume"
    },
    hierarchicalMultiSelect: {
      fieldPath: "answers.howDidYouHear",
      inputSelector: '[data-uxi-widget-type="selectinput"]',
      containerSelector: '[data-automation-id="multiSelectContainer"]',
      menuItemSelectors: [
        '[data-automation-id="menuItem"]',
        '[data-automation-id="promptOption"]',
        '[role="option"]'
      ],
      selectedListSelector: '[data-automation-id="selectedItemList"]',
      selectedItemSelector: '[data-automation-id="selectedItem"]'
    },
    // Workday's wizard footer. Named here rather than left to the shared text
    // matching because Workday's forward button is a plain <button> whose label
    // is often just "Next" with an arrow in a child span — and because the final
    // step of every Workday application shows "Submit" in the same place, which
    // the shared engine refuses on its own (see SUBMIT_PATTERN in advanceStep).
    advanceButton: [
      '[data-automation-id="footer-next-button"]',
      '[data-automation-id*="nextButton" i]',
      'button[data-automation-id*="next" i]'
    ].join(", ")
  }
};
