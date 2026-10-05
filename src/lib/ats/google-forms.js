// Google Forms builds its choice widgets out of ARIA roles on <div>s rather than
// native inputs: a question is a [role="radiogroup"] or [role="list"] whose
// options are [role="radio"] / [role="checkbox"] descendants. Because
// scanFormFields() enumerates "input, textarea, select", none of that is
// reachable — every choice question on a Google Form is invisible to the scan,
// and the only thing that does show up is the trailing "Other response" input.
//
// The selectors live here rather than in page-scripts.js so the shared scan
// engine keeps working off ordinary HTML controls for every other platform, and
// so a second ARIA-built form kit only needs another adapter.
const GoogleFormsAtsAdapter = {
  id: "google-forms",
  name: "Google Forms",
  matches(url) {
    try {
      const { hostname, pathname } = new URL(url);
      return (
        /(^|\.)docs\.google\.com$/i.test(hostname) &&
        /\/forms(\/|$)/i.test(pathname)
      );
    } catch {
      return false;
    }
  },
  pageConfig: {
    // Google Forms exposes the question text on the container, not on the
    // options, so labels have to be read upward from the group.
    choiceGroups: {
      containerSelector: "div[role='radiogroup'], div[role='list']",
      optionSelector: "[role='radio'], [role='checkbox']",
      // A group is multi-select when any option is a checkbox; radio options
      // are mutually exclusive by definition.
      multiSelectWhenRole: "checkbox",
      // Submitted value, most specific first. aria-label is the last resort
      // because it repeats the visible text.
      valueAttributes: ["data-value", "data-answer-value", "value", "aria-label"],
      // Google Forms options render their text in a nested span rather than
      // directly on the role element.
      optionTextSelector: "span.aDTYNe, .MocG8c, .vRMGwf"
    },
    // "Other response" inputs carry only that generic aria-label, so they match
    // nothing and arrive as junk rows. The real question lives on the
    // [role="listitem"] wrapper, so borrow it.
    genericLabelRescue: {
      // Labels this bare mean "the question is above me, not here".
      genericPattern: "^(other|another|specify|please specify|enter (your )?|n/a|more details|additional (information|details))\\b",
      wrapperSelector: "[role='listitem'], [data-question-id]",
      labelSelector: "[role='heading'], .M7eMe"
    },
    // A Google Form has no <input type="file"> until its "Add file" button is
    // clicked — the input is then built inside a shadow root behind the OS file
    // picker, so a scan can neither see it nor assign a File to it. Workday
    // ships a persistent hidden input, which is why resume attachment works
    // there and not here.
    //
    // Naming the trigger lets the scanner at least report the field, so the
    // popup can say "click Add file and choose your resume" rather than the
    // form looking unsupported.
    resumeUpload: {
      triggerSelector: "div[jsname='mWZCyf'][role='button']"
    }
  }
};