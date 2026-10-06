// ============================================================
// PAGE SCRIPTS
// ============================================================
//
// These functions are injected into the target webpage using
// chrome.scripting.executeScript().
//
// IMPORTANT:
// These functions must be completely self-contained.
//
// They cannot directly access variables/functions from the
// extension's outer JavaScript context because their source is
// serialized and executed inside the webpage's own JS context.===
// =========================================================


// ============================================================
// SCAN FORM FIELDS
// ============================================================
//
// Finds form fields on the current webpage and converts them into
// a normalized structure that the autofill system can understand.
//
// It detects:
//   - text inputs
//   - email inputs
//   - number inputs
//   - textarea
//   - select/dropdowns
//   - radio groups
//   - checkbox groups
//   - standalone checkboxes
//   - resume/CV file uploads
//   - custom combobox/dropdown inputs
//
// Each discovered field receives a unique data-autofill-uid
// attribute so that the field can later be found and filled.
// ============================================================

function scanFormFields(platformConfig = {}, options = {}) {

  // When true, fields whose label could not be resolved are reported as
  // `dropped` rows carrying their surrounding markup, instead of vanishing.
  // Off by default: a dropped field is not fillable, so surfacing it would show
  // the user rows they cannot act on. Set only by the popup's diagnostics
  // button, which needs the evidence to work out why a field was dropped.
  //
  const debugDropped = !!options.debugDropped;


  // Attribute used to uniquely identify each field after scanning.
  //
  // Example:
  //
  // <input id="email" data-autofill-uid="af-0">
  //
  // Later, fillFormFields() can find it using:
  //
  // [data-autofill-uid="af-0"]
  //
  const AUTOFILL_ATTR = "data-autofill-uid";


  // ============================================================
  // CLEAR STALE UIDS FROM EARLIER SCANS
  // ============================================================
  //
  // scanFormFields() runs many times on one page: the popup retries while the
  // form is still rendering, and "Scan Form" can be pressed any number of
  // times.
  //
  // The guards further down (notably `el.hasAttribute(AUTOFILL_ATTR)` in the
  // custom-dropdown pass) read the attribute to dedupe fields *within a single
  // run*. A uid left over from a previous run therefore reads as "already
  // handled" and silently hides the field from every later scan.
  //
  // That is exactly how Workday's Degree dropdown
  // (<button aria-haspopup="listbox" name="degree">BS</button>) disappeared
  // from the popup: the first scan stamped data-autofill-uid="af-21" on it,
  // so the second scan skipped it — while the element kept carrying af-21 in
  // the page, which is the tell-tale sign.
  //
  // Clearing up front makes the attribute mean "seen during this scan", which
  // is the only thing those guards ever assume.
  //
  Array.from(querySelectorDeep(`[${AUTOFILL_ATTR}]`))
    .forEach((el) => {
      el.removeAttribute(AUTOFILL_ATTR);
    });


  // Input types that should NOT be treated as normal form fields.
  //
  // hidden  -> invisible internal field
  // submit  -> submit button
  // button  -> regular button
  // image   -> image submit button
  // reset   -> reset button
  //
  const SKIP_TYPES = new Set([
    "hidden",
    "submit",
    "button",
    "image",
    "reset"
  ]);


  // Keywords used to recognize a resume/CV upload field.
  //
  // This is duplicated from matcher.js because scanFormFields()
  // runs inside the webpage and therefore cannot access variables
  // from the extension's outer JavaScript context.
  //
  // Example labels that can match:
  //
  // "Upload Resume"
  // "Resume"
  // "CV"
  // "Curriculum Vitae"
  //
  const RESUME_UPLOAD_KEYWORDS = [
    "resume",
    "cv",
    "curriculum vitae"
  ];


  // Placeholder texts a custom dropdown shows *as its own visible content*
  // before any choice has been made.
  //
  // Example:
  //
  // <button aria-haspopup="listbox">Select One</button>
  //
  // When we go looking for the question this control answers, a placeholder
  // like this is never the answer — it's noise, so it must not be mistaken
  // for a label. Same list popup.js re-scans on (GENERIC_DROPDOWN_LABELS),
  // duplicated here for the same reason RESUME_UPLOAD_KEYWORDS is.
  //
  const PLACEHOLDER_LABELS = new Set([
    "select one",
    "select",
    "select...",
    "choose one",
    "choose",
    "choose...",
    "please select",
    "-- select --",
    "search",
    "search...",
    // Validation markers some forms render as the only text inside a field's
    // label slot. They qualify the question, never replace it, so treating them
    // as placeholders lets the search keep looking for the question itself.
    "required",
    "optional"
  ]);


  // Is this candidate text just dropdown/validation noise, with no question in
  // it?
  //
  // A membership test against PLACEHOLDER_LABELS is not enough on its own,
  // because the noise is not always the *whole* string. Workday renders an
  // unanswered required question as one element containing the control's own
  // text plus the marker:
  //
  //   <div class="css-label">Select One Required</div>
  //
  // An exact-match test passes that straight through as a label, so every such
  // question ends up named "Select One Required" — identical to all the others,
  // matching nothing, and impossible to fill. Removing each known noise phrase
  // wherever it appears leaves only genuine question text, so a candidate that
  // reduces to nothing is rejected and the search keeps walking up.
  //
  function stripPlaceholderNoise(text) {

    let out = text;

    for (const phrase of PLACEHOLDER_LABELS) {

      // Escape the dots in "select..." / "choose..." so they stay literal.
      const pattern = new RegExp(
        phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi"
      );

      out = out.replace(pattern, " ");
    }

    // Punctuation left behind by the removals (" - ", " : ", stray dots).
    out = out
      .replace(/\s+/g, " ")
      .trim();


    // Required-field asterisk.
    //
    // Workday appends the marker as its own element inside the question:
    //
    //   <p>Do you have a non-compete?<abbr title="required">*</abbr></p>
    //
    // So the question's textContent ends in a bare "*". A trailing star is not
    // part of the question, and leaving it attached changes the last word
    // ("non-compete?*"), which is enough to stop a phrase match on it.
    //
    // Only a star at the very end is removed, and only where it directly abuts
    // the end of the sentence — a "*" in the middle of a question is content.
    //
    return out
      .replace(/\s*\*+\s*$/, "")
      .replace(/^[\s\-–—:,.()]+|[\s\-–—:,.()]+$/g, "")
      .trim();
  }


  // Extract the actual question sentence from long rich-text labels.
  //
  // Workday sometimes puts a long compliance preamble (paragraph + bullet list)
  // inside the same <legend> as the question itself. The full textContent can
  // run to hundreds of characters, but the field's question is almost always
  // the sentence ending with a question mark — and often the last question
  // mark in that block (the compliance text rarely ends with "?").
  //
  // Example:
  //
  //   "In line with U.S. export control laws... (bullets)... Do you now, or
  //    have you held citizenship in any of the countries listed above?"
  //
  // Returning just that final sentence lets the matcher work and also keeps the
  // label short enough that it isn't rejected by the length guard below.
  //
  function extractQuestionText(text) {

    if (!text) {
      return "";
    }

    // Split on sentence boundaries but keep the question mark attached.
    const sentences = text
      .split(/(?<=[.?!])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);


    // Prefer question sentences (those ending with ?). If there is more than
    // one, take the last one — the actual yes/no question tends to come after
    // any explanatory text on these compliance forms.
    const questions = sentences.filter((s) => s.endsWith("?"));


    if (questions.length) {
      return questions[questions.length - 1];
    }


    // No question mark found. Look for common interrogative starts instead.
    const starts = /^(do you|are you|will you|have you|did you|can you|could you|would you)/i;


    for (let i = sentences.length - 1; i >= 0; i--) {
      if (starts.test(sentences[i])) {
        return sentences[i];
      }
    }


    // Nothing obvious. Return the original trimmed text unchanged — the caller
    // will still enforce its length guard.
    return text.trim();
  }


  // ============================================================
  // CHECK WHETHER AN ELEMENT IS VISIBLE
  // ============================================================
  //
  // Returns true if the element appears to be visible on the page.
  //
  // offsetWidth/offsetHeight help detect elements that have no
  // rendered dimensions.
  //
  // getComputedStyle() catches elements explicitly hidden with:
  //
  // display: none
  // visibility: hidden
  //
  function isVisible(el) {
    if (visibleHere(el)) return true;

    // A control that fails the test but lives inside a shadow root is not
    // necessarily absent: custom elements routinely keep the real input at
    // display:none beneath a widget they render themselves — SmartRecruiters
    // does exactly this, and filtering the field out left the page reporting
    // "0 fields found". Judge the host the control sits in before giving up.
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    if (rootNode && rootNode !== document && rootNode.host) {
      return visibleHere(rootNode.host);
    }

    return false;
  }

  function visibleHere(el) {

    // If the element has no layout position and has zero dimensions,
    // treat it as hidden.
    if (
      !el.offsetParent &&
      el.offsetWidth === 0 &&
      el.offsetHeight === 0
    ) {
      return false;
    }


    // Get the element's actual computed CSS styles.
    const style = window.getComputedStyle(el);
    
//  example of above explanation    // Get the element
// const el = document.querySelector("#box");

// // Get its actual computed CSS styles
// const style = window.getComputedStyle(el);

// <!-- Example element -->
// <div id="box">Hello</div>

// <style>
//   #box {
//     color: red;
//     font-size: 20px;
//   }
// </style>
// // Read individual styles
// console.log(style.color);           // "rgb(255, 0, 0)"
// console.log(style.fontSize);        // "20px"
// console.log(style.display);         // "block"
// console.log(style.backgroundColor); // "rgb(255, 255, 255)"



    // Ignore elements hidden through CSS.
    return (
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
    //this staement just returns a boolean either true or false 
  }


  // ============================================================
  // EXTRACT AND NORMALIZE TEXT
  // ============================================================
  //
  // Gets all text inside an element and normalizes whitespace.
  //
  // Example:
  //
  // "\n   First   Name \n"
  //
  // becomes:
  //
  // "First Name"
  //
  function textOf(el) {
    return (
      el?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }


  // ============================================================
  // DETECT CUSTOM COMBOBOX / DROPDOWN
  // ============================================================
  //
  // Many modern websites do NOT use:
  //
  // <select>
  //
  // for dropdowns.
  //
  // Frameworks such as React may instead use:
  //
  // <input role="combobox">
  //
  // or another input with ARIA attributes.
  //
  // Without this detection, such an element would look like a
  // normal text input to the scanner.
  //
  // That is a problem because a dropdown should not be treated
  // like a free-text field.
  //drop down  is when you type fields name like i and in shows drop down 
  //options like India Indonesia and others 
  function isComboboxLike(el) {
    // Platform adapters may identify controls their UI kit does not expose
    // through standard ARIA combobox attributes (for example Workday's
    // selectinput). Selectors live in the adapter, not this shared engine.
    const platformSelectors = platformConfig.comboboxSelectors || [];
    if (platformSelectors.some((selector) => el.matches(selector) || el.closest(selector))) return true;

    // Direct ARIA role:
    //
    // <input role="combobox">
    //
    if (el.getAttribute("role") === "combobox") {
      return true;
    }


    // aria-autocomplete is commonly used by autocomplete/
    // combobox widgets.
    //
    // Example:
    //
    // <input aria-autocomplete="list">
    //
    if (el.getAttribute("aria-autocomplete")) {
      return true;
    }


    // Another common ARIA pattern:
    //
    // aria-haspopup="listbox"
    //
    if (el.getAttribute("aria-haspopup") === "listbox") {
      return true;
    }


    // Sometimes the input itself does not have role="combobox",
    // but a parent element does.
    //
    // Example:
    //
    // <div role="combobox">
    //   <input>
    // </div>
    //
    const comboboxAncestor = el.closest('[role="combobox"]');


    // Make sure the ancestor is actually different from the
    // element itself.
    return !!(
      comboboxAncestor &&
      comboboxAncestor !== el
    );

    //javascript nuiances
//     !!"hello"   // true
// !!123       // true
// !!{}        // true

// !!""        // false
// !!0         // false
// !!null      // false
// !!undefined // false

// !! in JavaScript is a common trick to convert any value into a real boolean (true or false).
// Your code:
// return !!(
//   comboboxAncestor &&
//   comboboxAncestor !== el
// );

// Break it down
// First:
// comboboxAncestor &&
// comboboxAncestor !== el

// This expression can return something that isn't necessarily true/false.
// Adding !! converts the result to a boolean.
// !value

// means NOT.
// !!value

// means NOT NOT, which effectively converts it to true or false.

  }


  // ============================================================
  // FIND THE LABEL ASSOCIATED WITH AN ELEMENT
  // ============================================================
  //
  // Websites can associate inputs with labels in many different
  // ways, so we try several methods in order.
  //
  // Priority:
  //
  // 1. <label for="id">
  // 2. aria-label
  // 3. aria-labelledby
  // 3b. <id>-label convention
  // 4. wrapping <label>
  // 5. placeholder
  // 6. nearby label-like element
  //
  // Strategies 1-7. Split out from labelForElement() so the generic-label
  // rescue there can inspect what this resolved without duplicating the walk.
  function resolveOwnLabel(el) {

    // Where this control's own tree ends: the document for light DOM, its
    // shadow root otherwise. Id references and label[for] resolve within that
    // tree first and fall back to the document, so a label on either side of
    // the shadow boundary is found — SmartRecruiters keeps the label in the
    // light DOM and the control inside the component.
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    const scope = rootNode || document;
    const byId = (id) =>
      (scope.getElementById && scope.getElementById(id)) ||
      document.getElementById(id) ||
      null;


    // ----------------------------------------------------------
    // 1. Explicit <label for="id">
    // ----------------------------------------------------------
    //
    // Example:
    //
    // <label for="email">Email Address</label>
    // <input id="email">
    //
    // The label's "for" attribute points to the input's "id".
    //
    if (el.id) {

      // CSS.escape() makes the ID safe to use inside a CSS selector.
      //
      // This matters if the ID contains CSS-special characters.
      //
      // Example:
      //
      // const id = "user:123";
      //
      // CSS.escape(id)
      //
      // produces something similar to:
      //
      // "user\\:123"
      //
      // So ":" is treated as part of the ID rather than CSS syntax.
      //
      const explicit = scope.querySelector(
        `label[for="${CSS.escape(el.id)}"]`
      );


      // If a matching label exists, use its text.
      if (explicit) {
        return textOf(explicit);
      }
    }


    // ----------------------------------------------------------
    // 2. aria-label
    // ----------------------------------------------------------
    //
    // Example:
    //
    // <input aria-label="Email Address">
    //
    // The element directly provides its accessible label.
    //
    if (el.getAttribute("aria-label")) {

      const ariaLabel =
        stripPlaceholderNoise(el.getAttribute("aria-label"));

      // Only trust it when it actually names the field.
      //
      // An unanswered dropdown's aria-label is frequently just its own
      // placeholder plus the validation marker, with a leading space:
      //
      //   <button aria-label=" Select One Required">Select One</button>
      //
      // Returning that verbatim named every Workday question "Select One
      // Required" — identical across the form, matching nothing. The real
      // question sits in the <legend> a step or two away, so fall through to
      // the later strategies instead of stopping on noise.
      //
      if (ariaLabel) {
        return ariaLabel;
      }
    }


    // ----------------------------------------------------------
    // 3. aria-labelledby
    // ----------------------------------------------------------
    //
    // Example:
    //
    // <div id="email-label">Email Address</div>
    // <input aria-labelledby="email-label">
    //
    // aria-labelledby contains the ID of another element whose
    // text should be used as the label.
    //
    const labelledBy = el.getAttribute("aria-labelledby");


    if (labelledBy) {

      // aria-labelledby can contain multiple IDs separated
      // by whitespace.
      //
      // Example:
      //
      // "first-name required"
      //
      // becomes:
      //
      // ["first-name", "required"]
      //
      const parts = labelledBy
        .split(/\s+/)

        // Find the DOM element for each ID.
        .map((id) => byId(id))

        // Remove IDs that did not match an element.
        .filter(Boolean)

        // Extract the text from each matched element.
        .map(textOf);


      // If at least one referenced element was found,
      // combine all their text into one label.
      //
      // Example:
      //
      // ["First Name", "Required"]
      //
      // becomes:
      //
      // "First Name Required"
      //
      if (parts.length) {
        return parts.join(" ");
      }
    }


    // ----------------------------------------------------------
    // 3b. "<id>-label" convention
    // ----------------------------------------------------------
    //
    // Some React/custom widgets use a predictable label ID.
    //
    // Example:
    //
    // <input id="country">
    // <div id="country-label">Country</div>
    //
    // This checks for that convention.
    //
    if (el.id) {

      // If el.id is "country", this searches for:
      //
      // "country-label"
      //
      const byConvention = byId(
        `${el.id}-label`
      );


      if (byConvention) {

        // Extract the label text.
        const t = textOf(byConvention);


        // Only use it if it actually contains text.
        if (t) {
          return t;
        }
      }
    }


    // ----------------------------------------------------------
    // 4. Wrapping <label>
    // ----------------------------------------------------------
    //
    // Example:
    //
    // <label>
    //   First Name
    //   <input>
    // </label>
    //
    // The input has no "id" or "for" relationship.
    // Instead, the input is physically inside the label.
    //
    const ancestorLabel = el.closest("label");


    if (ancestorLabel) {

      // Get the label's text.
      //
      // Remove the input's own text if necessary.
      //
      // trim() removes whitespace left after the replacement.
      //
      return textOf(ancestorLabel)
        .replace(textOf(el), "")
        .trim();
    }


    // ----------------------------------------------------------
    // 5. Placeholder
    // ----------------------------------------------------------
    //
    // Example:
    //
    // <input placeholder="Enter your email">
    //
    // If no real label exists, use the placeholder as a fallback.
    //
    if (el.placeholder) {
      return el.placeholder.trim();
    }


    // ----------------------------------------------------------
    // 6. Nearby label-like element
    // ----------------------------------------------------------
    //
    // Some websites do not use proper <label> elements.
    //
    // Example:
    //
    // <div class="field-container">
    //
    //   <div class="field-label">
    //     First Name
    //   </div>
    //
    //   <div>
    //     <input>
    //   </div>
    //
    // </div>
    //
    // Here "First Name" is just a <div>.
    //
    // So we search the input's parent containers for:
    //
    // <label>
    // elements whose class contains "label"
    // <legend>
    //
    // This control's own field container, when the site marks one up.
    //
    // ATS forms put each question in its own wrapper and then repeat that
    // wrapper for every question on the page:
    //
    //   <div data-automation-id="formField">…</div>   <- willing to relocate?
    //   <div data-automation-id="formField">…</div>   <- have a non-compete?
    //
    // Once the search climbs above a control's own container, any label-like
    // element it finds belongs to a *neighbouring* question, and since the walk
    // returns the first match, every question that lacks inline text would be
    // labelled with the same neighbour's wording. Recorded as the ceiling so the
    // walk below stops there instead of borrowing another field's question.
    //
    const fieldBoundary =
      el.closest('[data-automation-id*="formField" i]');


    let container = el.parentElement;


    // Search up to 4 levels of parent containers.
    for (
      let depth = 0;
      depth < 4 && container;
      depth++
    ) {

      // Above this control's own field container there is no label of ours to
      // find — only other fields' questions. Stop rather than mislabel.
      //
      if (
        fieldBoundary &&
        container !== fieldBoundary &&
        !fieldBoundary.contains(container)
      ) {
        break;
      }


      // Find elements that look like labels.
      //
      // [class*='label' i]
      //
      // means:
      //
      // Find an element whose class contains "label",
      // case-insensitively.
      //
      // Examples:
      //
      // field-label
      // InputLabel
      // FORM-LABEL
      //
      const candidates = Array.from(
        container.querySelectorAll(
          "label, [class*='label' i], legend," +
            // Workday renders the question itself as a div with a
            // data-automation-id rather than a <label>, e.g.
            // data-automation-id="questionTitle" / "formFieldPrompt".
            "[data-automation-id*='question' i]," +
            "[data-automation-id*='prompt' i]," +
            "[data-automation-id*='label' i]"
        )
      );


// Check every possible label.
      for (const c of candidates) {

        // Extract and normalize its text.
        const t = textOf(c);


        // Drop the noise a dropdown carries with it, so what is left is the
        // question alone — or nothing at all, if this candidate was only ever
        // the control's placeholder and a "Required" marker.
        //
        let question = stripPlaceholderNoise(t);


        // Pull out the actual question sentence if this is a long rich-text
        // block (common on Workday compliance forms that lead with paragraphs
        // and bullet lists before the yes/no question).
        //
        if (question) {
          question = extractQuestionText(question);
        }


        // Still looks like a block of prose rather than a question.
        //
        // This happens when the country list in an export-control block runs
        // into the question with nothing separating them, so the whole run is
        // one "sentence":
        //
        //   "…accordingly.AfghanistanArmenia…CentralAfricanRepublicDo you
        //    now, or have you held citizenship in any of the countries listed
        //    above?"
        //
        // Sentence splitting cannot separate those, and the result can still fit
        // under the length limit, so this is keyed on the run being long enough
        // to be prose — well past any single question — rather than on the 150
        // limit used for acceptance below.
        //
        if (question && question.length >= 90) {

          // Anchor on a full opener phrase, not the bare words "do you" /
          // "have you". The question often contains more than one of them
          // ("Do you now, or have you held citizenship…"), and cutting at the
          // last bare match would throw away the real opening.
          //
          // No leading \b: the country list runs straight into the question
          // with no separator ("Bosnia-HerzegovinaDo you now, or…"), so there
          // is no word boundary ahead of the real opening and requiring one
          // would skip it and match only the later "have you", losing "Do you
          // now, or". A trailing \b is kept so "young"/"yours" can't match.
          //
          // Instead try each occurrence as a starting point and keep the one
          // that leaves the longest question — the full sentence always beats a
          // fragment that begins mid-question.
          const openerPattern =
            /(?:do|are|will|have|did|can|could|would|is|was)\s+(?:you|your)\b/gi;

          let best = "";

          for (const match of question.matchAll(openerPattern)) {

            const tail = question.slice(match.index).trim();

            if (tail.length > best.length) {
              best = tail;
            }
          }

          if (best) {
            question = best;
          }
        }


        // Ignore empty labels and extremely long text.
        //
        // A real field label should normally be relatively short.
        //
        if (question && question.length < 150) {
          return question;
        }
      }


      // Move one level higher in the DOM tree.
      //
      // parent
      //   -> grandparent
      //       -> great-grandparent
      //
      container = container.parentElement;
    }


    // Nothing worked in this tree. A control inside a shadow root has run out
    // of ancestors at the shadow boundary — its parent chain ends at the shadow
    // root — while the site's <label> sits in the light DOM beside the custom
    // element hosting it. SmartRecruiters renders every question that way, so
    // start over from the host: a label the kit declared as an attribute, its
    // own id's label, its wrapping label, its nearby text. Nested shadow roots
    // recurse naturally, one host at a time. (rootNode is computed at the top
    // of this function, alongside `scope`.)
    if (rootNode && rootNode !== document && rootNode.host) {
      const host = rootNode.host;
      const declared = host.getAttribute && stripPlaceholderNoise(host.getAttribute("label") || "");
      if (declared) {
        return declared;
      }
      return resolveOwnLabel(host);
    }

    return "";
  }


  // ============================================================
  // RESCUE LABELS THAT ARE TOO GENERIC TO BE USEFUL
  // ============================================================
  //
  // Some kits label a field only by its role in the question, not by the
  // question itself: Google Forms' trailing free-text box on any "Other:"
  // choice is simply aria-label="Other response". That label matches no
  // dictionary entry and carries no information, so the row shows up as an
  // unmatched mystery called "Other response".
  //
  // When an adapter declares genericLabelRescue, a label this bare is treated
  // as a pointer upward rather than an answer: the real question is read off
  // the enclosing question wrapper. The generic label is kept as a suffix so a
  // human can still tell which box it is.
  //
  // Guarded by config, and only fires on a label that matched the declared
  // pattern — so no platform without the config is affected.
  //
  function labelForElement(el) {
    const own = resolveOwnLabel(el);

    const rescue = platformConfig.genericLabelRescue;
    if (!rescue || !rescue.genericPattern || !rescue.wrapperSelector || !rescue.labelSelector) {
      return own;
    }

    let generic;
    try {
      generic = new RegExp(rescue.genericPattern, "i");
    } catch {
      return own;
    }
    if (!own || !generic.test(own.trim())) {
      return own;
    }

    const wrapper = el.closest(rescue.wrapperSelector);
    if (!wrapper) {
      return own;
    }

    const heading = wrapper.querySelector(rescue.labelSelector);
    const question = stripPlaceholderNoise(textOf(heading)).trim();
    if (!question || question.length >= 150) {
      return own;
    }

    return `${extractQuestionText(question)} (${own})`;
  }


  // ============================================================
  // IDENTIFY THE UPLOAD WIDGET A FILE INPUT BELONGS TO
  // ============================================================
  //
  // Is this input just the hidden bookkeeping half of a custom dropdown?
  //
  // Workday renders its dropdown questions as a sibling pair inside one
  // wrapper: the <button aria-haspopup="listbox"> that the user actually
  // clicks, and a text <input> whose value holds the selected option's
  // internal ID.
  //
  //   <div class="css-12zup1l">
  //     <button aria-haspopup="listbox" name="degree" id="...">BS</button>
  //     <input type="text" value="281a47809d0e1000ee447dbff6e40000">
  //     <span class="menu-icon">...</span>
  //   </div>
  //
  // Only siblings sharing a parent with such a trigger count, so an ordinary
  // text field that merely sits somewhere near a dropdown is left alone.
  //
  function isDropdownStateMirror(el) {

    if (
      el.tagName.toLowerCase() !== "input" ||
      (el.getAttribute("type") || "text").toLowerCase() !== "text"
    ) {
      return false;
    }

    const parent = el.parentElement;

    if (!parent) return false;

    return !!parent.querySelector(
      "button[aria-haspopup='listbox'], button[aria-haspopup='menu']," +
        "[role='combobox'], [role='button'][aria-expanded]"
    );
  }


  // ============================================================
  //
  // Is this control part of the surrounding website rather than the form?
  //
  // An application page is a full site: masthead, language and account menus,
  // footer. Those carry `aria-haspopup` exactly like a real dropdown, so they
  // have to be recognised by where they sit, not by what they say.
  //
  function isSiteChrome(el) {

    // Built as a list and joined, so every entry is a complete selector. One
    // long quoted string would put the comma *inside* the quotes and leave a
    // stray `"` at the start of the next entry, which makes the whole group an
    // invalid selector — and closest()/matches() throw on an invalid group
    // rather than ignoring it, taking the scan down with them.
    const chromeAncestors = [
      "header",
      "nav",
      "footer",
      `[data-automation-id="header"]`,
      `[data-automation-id="navigationContainer"]`,
      `[data-automation-id="utilityButtonBar"]`,
      `[data-automation-id="footerContainer"]`
    ];


    if (el.closest(chromeAncestors.join(", "))) {
      return true;
    }


    // Marked directly rather than only by position: these live in portal
    // containers that are not inside a <header>, and their own ids are stable.
    const chromeControls = [
      `[data-automation-id="hammyMenuIcon"]`,
      `[data-automation-id="utilityMenuButton"]`,
      `[data-automation-id^="navigationItem-"]`
    ];


    return !!el.matches(chromeControls.join(", "));
  }


  // ============================================================
  //
  // Walks up from a file input looking for the widget that owns it, judged by
  // the data-automation-id marks ATS platforms put on the container.
  //
  // Returns { isResume, label }:
  //
  //   isResume - some ancestor is marked as the resume widget
  //   label     - that mark turned into readable text, for when the widget has
  //              no <label> to read ("resumeUpload" -> "Resume Upload")
  //
  // Deliberately matched on "resume" only, and not on the looser
  // RESUME_UPLOAD_KEYWORDS list, because these are opaque machine ids rather
  // than human text: substring-matching a two-letter keyword like "cv" against
  // arbitrary ids is how an unrelated upload gets mistaken for a resume.
  //
  function uploadWidgetOwner(el) {

    let node = el.parentElement;

    // Six levels covers the Workday nesting in practice
    // (input -> drop-zone wrapper -> resumeUpload -> column -> section ->
    // form); anything deeper than that is not this widget's own markup.
    //
    for (
      let depth = 0;
      depth < 6 && node;
      depth++
    ) {
      const raw = (
        node.getAttribute("data-automation-id") || ""
      );

      // Match case-insensitively, but hand humanizeAutomationId() the original
      // casing — lowercasing first would flatten the camelCase boundary it
      // splits on and turn "resumeUpload" into "Resumeupload".
      if (raw.toLowerCase().includes("resume")) {
        return {
          isResume: true,
          label: humanizeAutomationId(raw)
        };
      }

      node = node.parentElement;
    }

    return {
      isResume: false,
      label: ""
    };
  }


  // An adapter may designate one route as an unambiguous resume-first step.
  // This lets the scanner accept its otherwise unnamed file input without
  // making generic file uploads look like resumes.
  function isConfiguredResumeStep() {
    const rule = platformConfig.resumeStep;
    if (!rule) return false;
    return (
      location.hostname.toLowerCase().endsWith(rule.hostnameSuffix.toLowerCase()) &&
      location.pathname.toLowerCase().includes(rule.pathContains.toLowerCase())
    );
  }


  // "resumeUpload"     -> "Resume Upload"
  // "file_upload_ref"  -> "File Upload Ref"
  //
  // Split on camelCase and separators, then capitalize each word. Only ever
  // used to name a row the user can recognize — it never becomes a filled-in
  // value, so a clumsy translation costs nothing.
  //
  function humanizeAutomationId(id) {
    return id
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(
        /\b\w/g,
        (c) => c.toUpperCase()
      );
  }


  // ============================================================
  // RESULTS
  // ============================================================
  //
  // Every detected field will be pushed into this array.
  //
  const results = [];


  // Counter used to generate unique IDs:
  //
  // af-0
  // af-1
  // af-2
  //
  let counter = 0;


  // ============================================================
  // FIND ALL BASIC FORM ELEMENTS
  // ============================================================
  //
  // We scan:
  //
  // <input>
  // <textarea>
  // <select>
  //
  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  const simpleEls = querySelectorDeep(
    "input, textarea, select"
  );

//   This selects **all `<input>`, `<textarea>`, and `<select>` elements** on the current webpage.

// ```js
// const simpleEls = document.querySelectorAll(
//   "input, textarea, select"
// );
// ```

// ### Breakdown

// ```js
// document
// ```
// → The current HTML webpage.

// ```js
// .querySelectorAll(...)
// ```
// → Finds **all elements** matching the CSS selector.

// ```css
// "input, textarea, select"
// ```
// → Means **OR**:

// - `input` → `<input>`
// - `textarea` → `<textarea>`
// - `select` → `<select>`

// For example, given:

// ```html
// <input type="text">
// <input type="email">

// <textarea></textarea>

// <select>
//   <option>India</option>
// </select>

// <button>Submit</button>
// ```

// Then:

// ```js
// const simpleEls = document.querySelectorAll(
//   "input, textarea, select"
// );
// ```

// `simpleEls` contains the **4 form elements**:

// ```text
// <input type="text">
// <input type="email">
// <textarea>
// <select>
// ```

// The `<button>` is **not included** because it doesn't match the selector.

// ### Important

// `querySelectorAll()` returns a **NodeList**, which you can loop through:

// ```js
// simpleEls.forEach(el => {
//   console.log(el);
// });
// ```

// So in simple terms:

// > **"Find every input, textarea, and select element on this page and store them in `simpleEls`."**


  // Used to make sure radio/checkbox groups are only processed once.
  const seenRadioGroups = new Set();


  // Same job for adapter-configured ARIA groups, but keyed on the element
  // rather than a string: seenRadioGroups holds "<input name>" keys, and an
  // element interpolated into a key collapses to "[object HTMLDivElement]",
  // which would make every choice group on the page look like the first one.
  const seenChoiceContainers = new Set();


  // Process every discovered form element.
  simpleEls.forEach((el) => {

    // Convert:
    //
    // INPUT -> input
    // TEXTAREA -> textarea
    // SELECT -> select
    //
    const tag = el.tagName.toLowerCase();


    // Determine the input type.
    //
    // If <input> doesn't specify type,
    // HTML treats it as type="text".
    //
    const type = (
      el.getAttribute("type") || "text"
    ).toLowerCase();


    // ----------------------------------------------------------
    // Skip unwanted input types
    // ----------------------------------------------------------
    //
    if (
      tag === "input" &&
      SKIP_TYPES.has(type)
    ) {
      return;
    }


    // ==========================================================
    // CUSTOM DROPDOWN'S HIDDEN STATE MIRROR
    // ==========================================================
    //
    // A custom dropdown (Workday's Degree question, for example) is
    // really three elements:
    //
    // <button aria-haspopup="listbox" name="degree">BS</button>
    // <input type="text" value="281a47809d0e1000ee447dbff6e40000">
    // <span class="menu-icon">...</span>
    //
    // The button is the real control and already gets a data-autofill-uid
    // from the combobox scan. The <input> is not a field a human types into
    // — it mirrors the selected option's internal ID so the widget's
    // framework knows what is selected.
    //
    // It must never be listed or filled: typing an answer into it would
    // replace an option ID with "B.Tech" and leave the dropdown showing
    // garbage, and it would appear in the popup as a second copy of the
    // same question.
    //
    // Relying on visibility is not enough — some of these are only clipped
    // to 1px, not display:none, so they pass an isVisible() check.
    //
    if (isDropdownStateMirror(el)) {
      return;
    }


    // ==========================================================
    // FILE INPUTS
    // ==========================================================
    //
    // Resume upload inputs require special treatment.
    //
    // ATS websites such as Greenhouse, Lever, Workday and Ashby
    // commonly hide the native file input and display a custom
    // upload button/dropzone.
    //
    // Example:
    //
    // <input type="file" style="display:none">
    // <button>Upload Resume</button>
    //
    // Therefore we intentionally DO NOT call isVisible() here.
    //
    // fillResumeFile() directly assigns a File to input.files,
    // so the input does not need to be visible.
    //
    if (
      tag === "input" &&
      type === "file"
    ) {

      // Ignore detached/template elements.
      if (!el.isConnected) {
        return;
      }


      // Find the label associated with the file input.
      //
      // May come back empty — see the upload widget below.
      //
      let label = labelForElement(el);


      // ==========================================================
      // RESUME UPLOAD WIDGET OWNER
      // ==========================================================
      //
      // Workday names the widget around the input, not the input itself, and
      // puts no <label> anywhere near it:
      //
      // <div data-automation-id="resumeUpload">
      //   <div data-automation-id="file-upload-drop-zone">
      //     Drop file here
      //     <button data-automation-id="select-files">Select file</button>
      //   </div>
      //   <input data-automation-id="file-upload-input-ref" type="file">
      // </div>
      //
      // Nothing in that subtree is a <label>, a [class*='label'], a <legend>,
      // or carries a data-automation-id containing "question"/"prompt"/
      // "label", so labelForElement() returns "" and a label-only test
      // discards the field. On /apply/autofillWithResume this input is the
      // only control on the page, which is precisely how a scan there ends up
      // reporting zero fields.
      //
      // The widget's own data-automation-id is the only thing that names it, so
      // it counts as a second source — both for recognizing the field and for
      // the label shown in the popup ("resumeUpload" -> "Resume Upload").
      //
      const widget = uploadWidgetOwner(el);


      // Check whether this looks like a resume/CV upload, from either source.
      //
      // For example:
      //
      // "Upload Resume"
      // "CV"
      // "Curriculum Vitae"
      // data-automation-id="resumeUpload"
      //
      const isResumeField =
        widget.isResume ||
        isConfiguredResumeStep() ||
        RESUME_UPLOAD_KEYWORDS.some(
          (kw) =>
            label
              .toLowerCase()
              .includes(kw)
        );


      // Ignore unrelated uploads such as:
      //
      // Cover Letter
      // Portfolio
      // Transcript
      //
      if (!isResumeField) {
        return;
      }


      // No <label> to show, but the widget is recognizable — name the row after
      // it so the popup isn't a blank "Resume"-less entry the user can't
      // identify. Only ever a synthesized name, never guessed content.
      //
      if (!label) {
        label = widget.label || "Resume / CV upload";
      }


      // Give the file input a unique autofill ID.
      const uid = `af-${counter++}`;


      // Store the ID directly on the DOM element.
      el.setAttribute(
        AUTOFILL_ATTR,
        uid
      );


      // Add it to our result list.
      results.push({
        uid,
        label,
        tagName: tag,
        inputType: type,
        options: []
      });


      // File input is completely handled.
      return;
    }


    // ==========================================================
    // NORMAL VISIBILITY CHECK
    // ==========================================================
    //
    // All non-file fields must be visible.
    //
    if (!isVisible(el)) {
      return;
    }


    // ==========================================================
    // RADIO BUTTON GROUP
    // ==========================================================
    //
    // Example:
    //
    // <input type="radio" name="gender" value="male">
    // <input type="radio" name="gender" value="female">
    //
    // These are multiple options belonging to ONE question.
    //
    if (
      tag === "input" &&
      type === "radio" &&
      el.name
    ) {

      // Radio buttons with the same "name" belong to the same
      // mutually-exclusive group.
      const groupKey = `radio:${el.name}`;


      // If this group has already been processed,
      // don't process it again.
      if (seenRadioGroups.has(groupKey)) {
        return;
      }


      // Mark this radio group as processed.
      seenRadioGroups.add(groupKey);


      // Find all visible radio buttons having the same name.
      //
      // CSS.escape() protects the name if it contains characters
      // that have special meaning in CSS selectors.
      const group = Array.from(
        querySelectorDeep(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`
        )
      ).filter(isVisible);


      // Create ONE UID for the entire radio group.
      const uid = `af-${counter++}`;


      // Every radio option gets the same UID because they represent
      // one logical question.
      group.forEach((g) => {
        g.setAttribute(
          AUTOFILL_ATTR,
          uid
        );
      });


      // If the radio buttons are inside a fieldset,
      // its <legend> is usually the question.
      //
      // Example:
      //
      // <fieldset>
      //   <legend>Gender</legend>
      //   ...
      // </fieldset>
      //
      const fieldset = el.closest("fieldset");


      const groupLabel = fieldset
        ? textOf(
            fieldset.querySelector("legend")
          )
        : "";


      // Add the radio group to results.
      results.push({
        uid,

        // Label priority:
        //
        // 1. fieldset legend
        // 2. detected element label
        // 3. radio name
        //
        label:
          groupLabel ||
          labelForElement(el) ||
          el.name,

        // Treat the whole group as one logical field.
        tagName: "radiogroup",

        inputType: type,


        // Convert each radio button into an option.
        options: group.map((g) => ({
          // Actual value submitted by the radio button.
          value: g.value,

          // Human-readable label for that option.
          //
          // If no label is found, use its value.
          text:
            labelForElement(g) ||
            g.value
        }))
      });


      // Radio group is completely handled.
      return;
    }


    // ==========================================================
    // CHECKBOX GROUPS
    // ==========================================================
    //
    // Checkboxes need more careful handling than radio buttons.
    //
    // Multiple checkboxes with the same name MAY represent a
    // multi-select question:
    //
    // Skills:
    //
    // [x] JavaScript
    // [x] Python
    // [ ] Java
    //
    // But two completely unrelated checkboxes can also have
    // the same generic name.
    //
    // Example:
    //
    // [x] I agree to marketing emails
    // [x] I agree to background check authorization
    //
    // Both might use:
    //
    // name="agree"
    //
    // Therefore we only group checkboxes when they have distinct
    // explicit values.
    //
    if (
      tag === "input" &&
      type === "checkbox" &&
      el.name
    ) {

      // Find all visible checkboxes with the same name.
      const sameNameGroup = Array.from(
        querySelectorDeep(
          `input[type="checkbox"][name="${CSS.escape(el.name)}"]`
        )
      ).filter(isVisible);


      // Determine whether this looks like a real multi-select group.
      //
      // Requirements:
      //
      // 1. At least 2 checkboxes.
      //
      // 2. Every checkbox has an explicit "value".
      //
      // 3. Value isn't empty.
      //
      // 4. Value isn't the default "on".
      //
      const isRealOptionSet =
        sameNameGroup.length > 1 &&
        sameNameGroup.every(
          (g) =>
            g.hasAttribute("value") &&
            g.value !== "" &&
            g.value !== "on"
        );


      // --------------------------------------------------------
      // REAL CHECKBOX OPTION GROUP
      // --------------------------------------------------------
      //
      if (isRealOptionSet) {

        // Create a unique key for this checkbox group.
        const groupKey =
          `checkbox:${el.name}`;


        // Skip if already processed.
        if (
          seenRadioGroups.has(groupKey)
        ) {
          return;
        }


        // Mark the group as processed.
        seenRadioGroups.add(groupKey);


        // One UID for the whole checkbox group.
        const uid = `af-${counter++}`;


        // Give every checkbox in the group the same UID.
        sameNameGroup.forEach((g) => {
          g.setAttribute(
            AUTOFILL_ATTR,
            uid
          );
        });


        // Look for a fieldset legend.
        const fieldset =
          el.closest("fieldset");


        const groupLabel = fieldset
          ? textOf(
              fieldset.querySelector("legend")
            )
          : "";


        // Store the checkbox group as one field.
        results.push({
          uid,

          // Label priority:
          //
          // 1. fieldset legend
          // 2. detected label
          // 3. checkbox name
          //
          label:
            groupLabel ||
            labelForElement(el) ||
            el.name,

          // The existing logic represents grouped choices
          // using "radiogroup".
          tagName: "radiogroup",

          inputType: type,


          // Convert each checkbox into an option.
          options: sameNameGroup.map((g) => ({
            value: g.value,
            text:
              labelForElement(g) ||
              g.value
          }))
        });


        // Group completely handled.
        return;
      }


      // --------------------------------------------------------
      // STANDALONE CHECKBOX
      // --------------------------------------------------------
      //
      // If it isn't a genuine multi-select group,
      // we intentionally DON'T group it.
      //
      // It falls through to the normal-field logic below.
    }


    // ==========================================================
    // NORMAL FIELD
    // ==========================================================
    //
    // Everything that reaches here is treated as an individual
    // field.
    //
    // Examples:
    //
    // <input type="text">
    // <input type="email">
    // <textarea>
    // <select>
    // standalone checkbox
    //
    const uid = `af-${counter++}`;


    // Store our unique ID directly on the element.
    el.setAttribute(
      AUTOFILL_ATTR,
      uid
    );


    // Default options to an empty array.
    let options = [];


    // ----------------------------------------------------------
    // SELECT OPTIONS
    // ----------------------------------------------------------
    //
    // If this is a <select>, collect all of its <option>s.
    //
    if (tag === "select") {

      options = Array.from(
        el.options
      ).map((o) => ({
        // Value submitted by the option.
        value: o.value,

        // Human-readable option text.
        text: textOf(o)
      }));
    }


    // ----------------------------------------------------------
    // DETERMINE FINAL INPUT TYPE
    // ----------------------------------------------------------
    //
    // A <select> is represented as "select".
    //
    // Otherwise use the actual input type.
    //
    let resolvedInputType =
      tag === "select"
        ? "select"
        : type;


    // ----------------------------------------------------------
    // DETECT CUSTOM COMBOBOX
    // ----------------------------------------------------------
    //
    // A custom dropdown may technically be:
    //
    // <input type="text">
    //
    // but behave like a dropdown.
    //
    // Change its logical type to "combobox".
    //
    if (
      tag === "input" &&
      resolvedInputType === "text" &&
      isComboboxLike(el)
    ) {
      resolvedInputType = "combobox";
    }


    // ----------------------------------------------------------
    // STORE THE FIELD
    // ----------------------------------------------------------
    //
    results.push({
      uid,

      // Human-readable field label.
      label: labelForElement(el),

      // HTML tag:
      //
      // input
      // textarea
      // select
      //
      tagName: tag,

      // Logical input type:
      //
      // text
      // email
      // checkbox
      // select
      // combobox
      // etc.
      //
      inputType: resolvedInputType,

      // Options for select fields, otherwise [].
      options
    });
  });


  // ============================================================
  // FIND CUSTOM DROPDOWN / COMBOBOX CONTROLS
  // ============================================================
  //
  // The pass above can only find real form tags:
  //
  // <input>
  // <textarea>
  // <select>
  //
  // Workday/Zebra (and most React-based ATS front-ends) build their
  // dropdowns out of plain elements instead:
  //
  // <button aria-haspopup="listbox">Select One</button>
  //
  // or
  //
  // <div role="combobox">Select One</div>
  //
  // The options only exist in the DOM *after* the trigger is clicked:
  //
  // <ul role="listbox">
  //   <li role="option">Yes</li>
  //   <li role="option">No</li>
  // </ul>
  //
  // So they are found here by their ARIA/custom-control markers, given a
  // uid like any other field, and reported with inputType "combobox" so
  // fillFormFields() drives them with click-then-pick instead of a
  // value assignment.
  //
  const CUSTOM_CONTROL_SELECTOR = [
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="menu"]',
    '[aria-haspopup="tree"]',
    '[aria-haspopup="grid"]',
    '[aria-haspopup="true"]',
    '[data-automation-id="selectWidget"]',
    '[data-automation-id="dropdownWidget"]'
  ].join(", ");


  querySelectorDeep(CUSTOM_CONTROL_SELECTOR)
    .forEach((el) => {

      // Already emitted by the pass above.
      //
      // This is how an <input role="combobox"> (react-select and friends)
      // is avoided: it was already found as a normal text input and
      // retyped to "combobox" there.
      //
      if (el.hasAttribute(AUTOFILL_ATTR)) {
        return;
      }


      // Wraps a control the pass above already handled.
      //
      // Example:
      //
      // <div role="combobox">
      //   <input>
      // </div>
      //
      if (el.querySelector(`[${AUTOFILL_ATTR}]`)) {
        return;
      }


      // Nested custom controls: only the outermost one is the trigger.
      //
      // Example:
      //
      // <div data-automation-id="selectWidget">
      //   <button aria-haspopup="listbox">…</button>
      // </div>
      //
      if (
        el.parentElement &&
        el.parentElement.closest(CUSTOM_CONTROL_SELECTOR)
      ) {
        return;
      }


      // Already open. That is still a field waiting to be filled, and
      // fillCombobox() reads an open menu without re-clicking the trigger
      // (clicking an expanded trigger only closes it again).
      //
      // Skipping it here used to make a dropdown left open by a failed fill
      // vanish from the popup until the page was reloaded — the popup
      // claiming a field does not exist while it sits right there on screen.
      //


      // Hidden/collapsed widgets (tabs not yet opened, mobile menus off
      // screen) would fail the same visibility test as any other field.
      //
      if (!isVisible(el)) {
        return;
      }


      // Page furniture that merely looks like a dropdown. A job application
      // form is embedded in a full site shell, and Workday's shell is full of
      // `aria-haspopup` triggers:
      //
      //   <button data-automation-id="hammyMenuIcon" aria-label="main menu">
      //   <button id="languageSelectorButton" aria-haspopup="listbox">
      //   <button id="accountSettingsButton" aria-haspopup="true">
      //   <button data-automation-id="navigationItem-Home">
      //
      // None of them answer a question, so they only ever produced popup rows
      // with nothing to fill in — and a fill would have opened the site's own
      // menus. Judged by containment in the shell, not by the text of the
      // button, so a form field that happens to read "Settings" survives.
      //
      if (isSiteChrome(el)) {
        return;
      }


      // Find the question this control answers.
      //
      const label = labelForElement(el);


// No question text, or nothing but placeholder/marker noise ("Select One",
      // "Required") — the widget's real label wasn't wired up. Skipping beats
      // showing the user a row they can't act on. Tested the same way the
      // candidate search tests, so a label that survived the walk is not
      // rejected here for being noise.
      //
      const question = stripPlaceholderNoise(label);

      if (!question) {

        // Record what was dropped, and why, instead of discarding it. The
        // question text is in here somewhere under a selector this function
        // does not match yet, and reading the page's own markup is the only
        // reliable way to find it — guessing at the markup from outside has
        // already been wrong more than once. Only the owning field container,
        // not the whole page, and truncated because these can be large.
        if (debugDropped) {

          const owner =
            el.closest('[data-automation-id*="formField" i]') ||
            el.parentElement ||
            el;

          results.push({
            uid: `drop-${counter++}`,
            label: label || "(no label)",
            tagName: "combobox",
            inputType: "combobox",
            options: [],
            dropped: true,
            debugHtml: owner.outerHTML.slice(0, 1500)
          });
        }

        return;
      }


      const uid = `af-${counter++}`;


      // Store the uid on the trigger itself.
      el.setAttribute(AUTOFILL_ATTR, uid);


      // Options stay []: the <li role="option"> elements don't exist until
      // the popup is opened, and opening every dropdown during a scan
      // would fight the page for focus. fillCombobox() reads them live.
      results.push({
        uid,
        label,
        tagName: "combobox",
        inputType: "combobox",
        options: []
      });
    });


  // ============================================================
  // ADAPTER-CONFIGURED CHOICE GROUPS
  // ============================================================
  //
  // Some form kits render radio/checkbox questions as ARIA roles on <div>s
  // instead of native inputs. Those never appear in the "input, textarea,
  // select" sweep above, so on such a page every choice question is invisible
  // and only its trailing "Other response" input turns up.
  //
  // Adapters opt in by supplying choiceGroups{...}; without a config this pass
  // does nothing at all, so no existing platform changes behaviour.
  //
  const choiceConfig = platformConfig.choiceGroups;

  if (choiceConfig && choiceConfig.containerSelector && choiceConfig.optionSelector) {
    const valueAttributes = choiceConfig.valueAttributes || ["value", "aria-label"];

    // An option belongs to the NEAREST enclosing container, not to every
    // container that happens to contain it.
    //
    // Google Forms puts each question's role="radiogroup"/role="list" inside an
    // outer role="list" wrapper that matches containerSelector too. Collecting
    // plain descendants therefore hands every option on the page to the outer
    // wrapper — one row carrying all nine questions' options, with the label
    // read off the wrong ancestor. That row isn't degraded, it's wrong: the
    // question text no longer describes the options, so neither the dictionary
    // nor the model can answer it, and a multi-select matcher will cheerfully
    // tick every skill it recognises.
    //
    // Claiming by nearest container gives each question exactly its own options
    // and leaves the outer wrapper owning none, so it's dropped as empty.
    const ownedBy = (container) =>
      Array.from(container.querySelectorAll(choiceConfig.optionSelector)).filter(
        (option) => option.closest(choiceConfig.containerSelector) === container
      );

    const containers = Array.from(document.querySelectorAll(choiceConfig.containerSelector));

    // Whole-page fallback, not per-container. A per-container fallback
    // reintroduces the very merge this rule exists to prevent: the outer wrapper
    // owns nothing, so it would fall back to claiming all of them again. Instead
    // the strict pass is all-or-nothing — if it finds no groups anywhere, the
    // markup is shaped in a way this rule doesn't understand (a per-option
    // wrapper, say) and the old descendant behaviour is used page-wide.
    let claimed = containers.map(ownedBy);
    if (!claimed.some((options) => options.length)) {
      claimed = containers.map((container) =>
        Array.from(container.querySelectorAll(choiceConfig.optionSelector))
      );
    }

    // When a page yields one choice row out of nine, "the scanner didn't see
    // it" and "the scanner saw it and discarded it" need different fixes and
    // look identical from the popup. So every container reports its own verdict
    // — how many options it holds, how many it owns, and which gate rejected it
    // — instead of vanishing. Skipping a container is silent otherwise.
    // The question text hangs off the container's aria-labelledby, so reuse
    // the same multi-id resolution aria-labelledby fields already get.
    const resolveChoiceLabel = (container) => {
      let label = "";
      const labelledBy = container.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((id) => stripPlaceholderNoise(textOf(id)))
          .filter(Boolean);
        if (parts.length) label = extractQuestionText(parts.join(" "));
      }
      if (!label) {
        label = stripPlaceholderNoise(
          textOf(
            container.getAttribute("aria-label")
              ? container
              : container.querySelector("[role='heading']")
          )
        );
      }
      return label;
    };

    const describeChoiceContainer = (container, index, owned, visible, reason, label) => {
      if (!debugDropped) {
        return;
      }

      const descendants = Array.from(
        container.querySelectorAll(choiceConfig.optionSelector)
      );

      results.push({
        uid: `choice-skip-${index}`,
        // The resolved question text, not the container's bare aria-label:
        // Google Forms puts the question on aria-labelledby, so every row here
        // would otherwise read "(no aria-label)" and a dump of skipped
        // containers couldn't say which questions went missing.
        label: label || container.getAttribute("aria-label") || "(unlabelled)",
        tagName: "radiogroup",
        inputType: "choice-scan",
        options: [],
        dropped: true,
        debug: reason,
        // Ownership, not just counts: a container that owns none of its own
        // descendants is the nested-wrapper case, and one that owns fewer than
        // it holds means an option's nearest enclosing container sits somewhere
        // unexpected.
        choiceScan: {
          reason,
          question: label || "",
          role: container.getAttribute("role") || "",
          className: (container.className || "").toString().slice(0, 80),
          ariaLabelledBy: container.getAttribute("aria-labelledby") || "",
          descendantOptions: descendants.length,
          ownedOptions: owned.length,
          visibleOptions: visible.length,
          // Option texts are what the row would have displayed; empty ones
          // explain a row that never appeared.
          sample: descendants.slice(0, 6).map((o) => ({
            role: o.getAttribute("role") || "",
            text: stripPlaceholderNoise(textOf(o)).slice(0, 40),
            value: o.getAttribute("data-value") || o.getAttribute("data-answer-value") || "",
            visible: isVisible(o),
            stamped: o.hasAttribute(AUTOFILL_ATTR)
          }))
        },
        debugHtml: container.outerHTML.slice(0, 300)
      });
    };

    containers.forEach((container, index) => {
      const options = claimed[index].filter(isVisible);

      // Resolved ahead of the gates below, which only skip containers. Reading
      // it early costs nothing and lets a skipped container still name the
      // question it was holding.
      const questionLabel = resolveChoiceLabel(container);

      // One option is not a question, and an empty container is a template
      // Google Forms leaves in the DOM.
      if (!options.length) {
        describeChoiceContainer(
          container,
          index,
          claimed[index],
          options,
          claimed[index].length ? "all-options-invisible" : "no-owned-options",
          questionLabel
        );
        return;
      }

      // Options already claimed by the native radio/checkbox branches above.
      if (options.some((o) => o.hasAttribute(AUTOFILL_ATTR))) {
        describeChoiceContainer(
          container,
          index,
          claimed[index],
          options,
          "options-already-stamped",
          questionLabel
        );
        return;
      }

      // Dedupe on the container element itself.
      //
      // This cannot be a string key built from the container. Interpolating an
      // element into a template literal calls toString() on it, and every
      // HTMLDivElement stringifies to the same "[object HTMLDivElement]" — so
      // "choice:" + container is one key shared by every choice group on the
      // page, and the first group scanned silently discarded all the others as
      // duplicates. That is what left a nine-question form showing one question
      // with no error anywhere: ownership was correct, and each remaining
      // container was rejected as a repeat of the first.
      if (seenChoiceContainers.has(container)) {
        describeChoiceContainer(
          container,
          index,
          claimed[index],
          options,
          "container-already-seen",
          questionLabel
        );
        return;
      }
      seenChoiceContainers.add(container);

      const groupLabel = questionLabel || "Untitled question";

      const emitted = options
        .map((option) => {
          // Prefer the attribute the site actually submits; aria-label is the
          // last resort because it can be a rewritten string.
          let value = "";
          for (const attribute of valueAttributes) {
            const candidate = option.getAttribute(attribute);
            if (candidate && candidate.trim()) {
              value = candidate.trim();
              break;
            }
          }

          // Visible text wins over attributes for display, and Google Forms
          // nests it in a span.
          const visible = textOf(
            (choiceConfig.optionTextSelector && option.querySelector(choiceConfig.optionTextSelector)) || option
          );
          const text = stripPlaceholderNoise(visible) || value;

          return value && text ? { value, text } : null;
        })
        .filter(Boolean);

      if (!emitted.length) {
        describeChoiceContainer(
          container,
          index,
          claimed[index],
          options,
          "options-without-value-or-text",
          questionLabel
        );
        return;
      }

      const uid = `af-${counter++}`;
      options.forEach((option) => option.setAttribute(AUTOFILL_ATTR, uid));

      // A group is multi-select when any option is a checkbox. This has to be
      // recorded on the row: the filler has no other way to tell "tick these
      // three" from "pick exactly one", and defaulting to single would
      // silently drop every extra technology on a skills question.
      const multiple = emitted.length > 1 &&
        options.some((option) => option.getAttribute("role") === choiceConfig.multiSelectWhenRole);

      results.push({
        uid,
        label: groupLabel,
        tagName: "radiogroup",
        inputType: multiple ? "checkbox" : "radio",
        options: emitted,
        multiple,
        // Carried on the emitted row too, so a healthy group can be compared
        // against the skipped ones in the same dump.
        choiceScan: {
          reason: "emitted",
          question: groupLabel,
          role: container.getAttribute("role") || "",
          descendantOptions: container.querySelectorAll(choiceConfig.optionSelector).length,
          ownedOptions: claimed[index].length,
          visibleOptions: options.length
        }
      });
    });
  }


  // ============================================================
  // ADAPTER-CONFIGURED RESUME UPLOAD
  // ============================================================
  //
  // The file-input branch above only fires on a real <input type="file">, which
  // is why resume upload works on Workday and fails on Google Forms.
  //
  // Google Forms ships no file input at all until you click its "Add file"
  // button:
  //
  //   <div id="i21" jsname="EpCqVb">Upload 1 supported file…</div>
  //   <div jsname="kTlJSc" role="list" aria-label="Selected files"></div>
  //   <div role="button" jsname="mWZCyf" aria-label="Add file">
  //
  // The input is created on demand, inside a shadow root, behind a click that
  // also opens the OS file picker. So there is nothing to assign a File to
  // during a scan, and the extension reported no resume field on the form at
  // all — indistinguishable from having no resume saved.
  //
  // What can be detected is the trigger. Adapters name it, and the row is
  // emitted against that trigger so the popup can at least show the field and
  // say why it can't be filled automatically.
  //
  const resumeConfig = platformConfig.resumeUpload;

  if (
    resumeConfig &&
    resumeConfig.triggerSelector &&
    !results.some((field) => field.inputType === "file")
  ) {
    const triggers = Array.from(
      document.querySelectorAll(resumeConfig.triggerSelector)
    ).filter(isVisible);

    triggers.forEach((trigger) => {
      const uid = `af-${counter++}`;
      trigger.setAttribute(AUTOFILL_ATTR, uid);

      const question = trigger.closest("[role='listitem']");

      // Google keeps the question text on the listitem's heading, the same way
      // the choice pass reads it, so "Resume Link" is preferred over the
      // generic button name for the row's label.
      let label = "";
      const heading = question && question.querySelector("[role='heading']");
      if (heading) {
        label = extractQuestionText(stripPlaceholderNoise(textOf(heading)));
      }
      if (!label) {
        label =
          stripPlaceholderNoise(textOf(trigger)) ||
          trigger.getAttribute("aria-label") ||
          "Resume / CV upload";
      }

      results.push({
        uid,
        label,
        tagName: trigger.tagName.toLowerCase(),
        inputType: "file",
        options: [],
        // Not fillable by assignment: there is no input to assign to until the
        // user clicks through to the OS picker themselves.
        resumeRequiresClick: true,
        uploadTrigger: resumeConfig.triggerSelector
      });
    });
  }


  // Return every field discovered on the page.
  return results;
}


// ============================================================
// DESCRIBE FRAMES
// ============================================================
//
// Injected with allFrames, so this runs once per frame: the top document and
// every <iframe> inside it. It reports enough for the caller to answer the two
// questions a cross-origin form raises — which frames are ready to be read, and
// which ATS adapter each one belongs to.
//
// Both are needed because the form is frequently not in the page you are
// looking at. ChargePoint's /about/opportunities/job, for one, renders a shell
// whose entire content is a cross-origin <iframe> pointing at
// job-boards.greenhouse.io. The top document holds the site's own navigation
// and nothing else, so scanning it returns no application fields and no amount
// of waiting changes that — it reads as a page that is still rendering, and
// burned six rescans saying so. The frame holding the form has to be scanned in
// its own right, against the adapter matching its URL rather than the one
// matching the page that happens to host it.
//
// origin, not the full URL: the adapter matchers only look at the hostname,
// and a path or query here can carry a job id (see the privacy contract in
// lib/analytics.js — nothing read off the page is sent anywhere).
//
// IMPORTANT: self-contained, like every function in this file — it is
// serialized and injected on its own.
// ============================================================

function describeFrames() {

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  return {
    // Whether this is the top document rather than a frame inside it. The
    // caller's fallback path (a page it cannot enumerate frames on) is the top
    // document, so it needs to be able to tell which one it is looking at.
    top: window.top === window,

    // "loading" while the frame is still parsing. A frame that has not finished
    // parsing has not produced its controls yet, however settled its counts
    // look — so this is checked alongside the counts, never instead of them.
    readyState: document.readyState,

    // Form controls in THIS frame. Read as counts only, so a frame that is up
    // but still streaming its questions shows up as a rising number across
    // polls instead of a short but plausible scan.
    controls: querySelectorDeep("input, textarea, select").length,

    // Nested frames declared here. Summed over every reporting frame this gives
    // the size the frame tree should end up at, so a frame that has not loaded
    // yet — and so cannot report anything about itself — still gets counted.
    frames: querySelectorDeep("iframe").length,

    origin: (() => {
      try {
        return location.origin;
      } catch {
        // An opaque origin (a sandboxed frame) has none, which is a perfectly
        // ordinary answer: it falls back to the adapter for the host page.
        return null;
      }
    })()
  };
}


// ============================================================
// WAIT FOR FORM READY
// ============================================================
//
// Google Forms streams its questions into the DOM. Scanning a page that has
// only rendered the first few returns a perfectly valid-looking result: the
// fields that exist are read correctly, and everything below is simply absent,
// so the scan reports "1 of 9 choice questions found" with no error anywhere.
// There is nothing downstream that can recover from that — the matcher never
// sees a label it could not match, and the AI is only asked about fields the
// scan produced.
//
// So the scan has to wait for the DOM to settle before it reads it. Waiting on
// a fixed delay is worse than useless: it is either too short on a slow
// connection or wasted time on a fast one. Instead this watches the count of
// candidate controls and exits as soon as it stops changing.
//
// Only counts are used, never contents, so nothing about the page leaves here.
//
// IMPORTANT: self-contained, like every function in this file — it is
// serialized and injected on its own.
// ============================================================

async function waitForFormReady(platformConfig = {}, timeoutMs = 2500) {

  // Fast enough to feel instant on a settled page, slow enough that a burst of
  // questions landing in one tick isn't mistaken for the end of rendering.
  const POLL_MS = 150;

  // Consecutive identical samples required before the DOM counts as settled.
  // Three polls of one question at a time is the shape of progressive
  // rendering, so a single stable sample would exit during it.
  const STABLE_POLLS = 4;

  const choiceConfig = platformConfig.choiceGroups;

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  const count = () =>
    querySelectorDeep("input, textarea, select").length +
    (choiceConfig && choiceConfig.optionSelector
      ? document.querySelectorAll(choiceConfig.optionSelector).length
      : 0);

  const deadline = Date.now() + Math.max(0, timeoutMs || 0);

  let previous = count();
  let stable = 0;

  // document.readyState is checked as well as the counts: a page still
  // parsing has not finished producing its controls yet, however stable the
  // count looks in the meantime.
  while (document.readyState === "loading" || stable < STABLE_POLLS) {
    if (Date.now() >= deadline) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    const current = count();

    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }

  return {
    controls: previous,
    // Reported so the caller can say the page was still rendering rather than
    // letting a timeout pass as a completed scan.
    settled: stable >= STABLE_POLLS
  };
}


// ============================================================
// PROBE PAGE STATE
// ============================================================
//
// Answers "why did the scan come back empty?" for a page that has none of the
// expected form controls.
//
// scanFormFields() can't report this itself: it returns a flat array of
// fields, and a result that would need to carry diagnostics alongside them
// would change the shape popup.js and matchFields() consume.
//
// The distinction matters because the two causes need opposite fixes. A
// client-rendered ATS that hasn't finished rendering (Workday's
// /apply/autofillWithResume parses the uploaded resume before it shows the
// form) needs a wait; a form living inside an <iframe> can't be reached from
// the top document at all and needs a host permission instead. Without these
// numbers "0 fields found" is indistinguishable between the two.
//
// IMPORTANT: self-contained, like every function in this file — it is
// serialized and injected on its own. No URL is returned on purpose: the page
// address is never sent anywhere (see the privacy note in lib/analytics.js),
// and keeping it out of this payload removes any chance of it reaching the
// analytics event that consumes these numbers.
// ============================================================

function probePageState(platformConfig = {}) {

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  // Every form control in the top document, however rendered.
  //
  const all = querySelectorDeep(
    "input, textarea, select"
  );


  // How many of those a human could actually see and fill in. Repeats
  // scanFormFields()'s own isVisible() test rather than trusting the counts,
  // because "12 controls in the DOM, 0 visible" (a hidden wizard step, a
  // collapsed section) is the single most useful thing to be able to report.
  //
  const visibleHere = (el) => {
    if (
      !el.offsetParent &&
      el.offsetWidth === 0 &&
      el.offsetHeight === 0
    ) {
      return false;
    }

    const style = window.getComputedStyle(el);

    return (
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };

  // The host fallback mirrors scanFormFields()'s isVisible(): a shadow input
  // kept at display:none under the widget its component renders is visible
  // enough to count, through the host it sits in.
  const visible = all.filter((el) => {
    if (visibleHere(el)) return true;
    const rootNode = el.getRootNode ? el.getRootNode() : null;
    return !!(rootNode && rootNode !== document && rootNode.host && visibleHere(rootNode.host));
  });


  return {
    readyState: document.readyState,

    // Total form controls present in the DOM.
    total: all.length,

    // How many are visible right now.
    visible: visible.length,

    // Iframes present. A non-zero count on a page with no visible fields is
    // the signature of a form the top document simply cannot see.
    //
    iframes: document.querySelectorAll("iframe").length,

    // Rough size of the rendered page, used only to tell a still-empty SPA
    // shell apart from a page that has finished loading.
    //
    textLength: (document.body?.innerText || "").trim().length,


    // ARIA-built choice widgets, which the input/textarea/select sweep above
    // cannot see at all. On a Google Form these are the questions themselves,
    // so "0 inputs but 9 groups" is a fully-rendered form — and "9 inputs but
    // 1 group" is a form still streaming, which is the case that produced
    // scans missing eight questions with nothing to indicate why.
    //
    choiceGroups: platformConfig.choiceGroups?.containerSelector
      ? document.querySelectorAll(platformConfig.choiceGroups.containerSelector).length
      : 0,


    choiceOptions: platformConfig.choiceGroups?.optionSelector
      ? document.querySelectorAll(platformConfig.choiceGroups.optionSelector).length
      : 0
  };
}


// ============================================================
// FILL FORM FIELDS
// ============================================================
//
// Takes the structured output produced by scanFormFields()
// and fills the corresponding fields.
//
// payload format:
//
// [
//   {
//     uid: "af-0",
//     value: "Abhishek"
//   },
//   ...
// ]
//
// Returns a report telling the caller whether each field
// was successfully processed.
//
// Async because a custom dropdown/combobox can only be filled by
// clicking it open, waiting for the page to render its
// <li role="option"> list, then clicking the matching option — that
// wait has to happen between steps. chrome.scripting.executeScript
// awaits a returned promise, so the report still arrives intact at
// popup.js.
// ============================================================

async function fillFormFields(payload, platformConfig = {}) {

  // Same attribute used by scanFormFields().
  const AUTOFILL_ATTR = "data-autofill-uid";

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }


  // ==========================================================
  // SET INPUT/TEXTAREA VALUE
  // ==========================================================
  //
  // Instead of simply doing:
  //
  // el.value = value
  //
  // we use the native browser setter.
  //
  // This helps with React and other frameworks that override
  // input value handling.
  //
  function nativeSetValue(el, value) {

    // Textareas and inputs have different prototypes.
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;


    // Get the native "value" setter.
    const setter =
      Object.getOwnPropertyDescriptor(
        proto,
        "value"
      ).set;


    // Call the native setter with our value.
    setter.call(el, value);


    // Tell the webpage that the value changed.
    el.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );


    el.dispatchEvent(
      new Event("change", {
        bubbles: true
      })
    );
  }


  // ==========================================================
  // SET CHECKBOX/RADIO STATE
  // ==========================================================
  //
  // Used for:
  //
  // checkbox
  // radio
  //
  function setChecked(el, checked) {
    if (el.checked === checked) return;

    // Workday's radios are controlled components. `click()` runs the native
    // radio activation behaviour first, then emits the trusted sequence of
    // click/input/change events its React handler consumes. Assigning
    // `checked` and dispatching a synthetic event can leave the visual radio
    // selected while Workday's form state remains unchanged.
    if (checked) {
      el.click();
      return;
    }

    // This extension only asks setChecked() to select an answer today, but
    // retain a correct uncheck path for future callers.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    setter.call(el, false);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }


  // ============================================================
  // IS THIS CHECKBOX ASKING FOR CONSENT?
  // ============================================================
  //
  // setChecked() can only answer "tick", never "what should this
  // box say". For a standalone checkbox that is a real question,
  // because a box is not an answer — it is a permission: to be
  // contacted, to be emailed, to let something be shared.
  //
  // The control gives no way to tell "Are you 18 or older?" from
  // "Yes, email me product updates". Only the label does, so the
  // label is all we get to decide on. Ticking the second one on the
  // user's behalf is consent they never gave, and on some
  // jurisdictions it is also a compliance problem.
  //
  // matcher.js makes the same call earlier and drops the value
  // before a row ever reaches here. This is the second lock on the
  // same door, deliberately: a value that arrives from anywhere
  // else — a stale payload, a future caller, a learned rule that
  // slipped past a phrase — still cannot tick a consent box.
  //
  // Whole-phrase matching, not substring: "I agree" also appears
  // inside "I agree the information is accurate", which is a
  // declaration the candidate may genuinely mean to tick. Refusing
  // that one too would train the user to ignore the highlight and
  // defeat the point.
  //
  // A duplicate of the list in matcher.js rather than a shared
  // import, because every function in this file is serialized and
  // injected into the page on its own (see the file header) and has
  // no access to the popup's scope.
  //
  function isConsentCheckboxItem(item) {
    const label = String((item && item.label) || "")
      .toLowerCase()
      .replace(/[*:]/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // An unlabelled box is not permission to guess.
    if (!label) return true;

    const phrases = [
      "opt in",
      "optin",
      "opt out",
      "optout",
      "subscribe",
      "unsubscribe",
      "newsletter",
      "marketing",
      "promotional",
      "promotions",
      "email me",
      "email updates",
      "send me email",
      "send me updates",
      "text me",
      "sms me",
      "contact me by phone",
      "contact me by email",
      "call me",
      "contact me about",
      "agree to be contacted",
      "agree to receive",
      "agree to the privacy policy",
      "agree to the terms",
      "agree to the terms of service",
      "i agree to the terms",
      "i consent",
      "consent to",
      "permission to contact",
      "permission to email",
      "share my information",
      "share my data",
      "share my resume",
      "allow the employer",
      "allow employers",
      "may we",
      "can we contact",
      "do you agree",
      "would you like to receive",
      "would you like us to contact",
      "keep me posted",
      "follow up with me"
    ];

    for (const phrase of phrases) {
      if (label.includes(phrase)) return true;
    }

    return /^i agree$/.test(label) ||
      /^agree$/.test(label) ||
      /^accept$/.test(label);
  }


  // Select one option inside a choice group.
  //
  // setChecked() only understands native inputs: it reads `.checked` and calls
  // `.click()`. An ARIA option is a <div>, so `.checked` is undefined and its
  // selected state lives in aria-checked/aria-selected instead. Reading that
  // back after the click is also the only reliable confirmation that the
  // widget's own handler accepted the choice — a div can swallow a click
  // without warning.
  function selectChoice(el) {
    const role = el.getAttribute("role");
    const isAriaChoice =
      role === "radio" ||
      role === "checkbox" ||
      role === "menuitemradio" ||
      role === "menuitemcheckbox" ||
      role === "option";

    if (!isAriaChoice) {
      setChecked(el, true);
      return true;
    }

    const selected = () =>
      el.getAttribute("aria-checked") === "true" ||
      el.getAttribute("aria-selected") === "true";

    if (selected()) return true;

    // Widgets built on divs often ignore a bare .click() and listen for the
    // pointer sequence, so replay it as a human would.
    humanClick(el);
    if (selected()) return true;

    el.click();
    return selected();
  }


  // ==========================================================
  // AUTOFILL REPORT
  // ==========================================================
  //
  // Every payload item gets a report entry.
  //
  // Example:
  //
  // {
  //   uid: "af-0",
  //   ok: true
  // }
  //
  // or:
  //
  // {
  //   uid: "af-0",
  //   ok: false,
  //   reason: "element not found"
  // }
  //
  // ==========================================================
  // NORMALIZE TEXT
  // ==========================================================
  //
  // "\n   First   Name \n"
  //
  // becomes:
  //
  // "First Name"
  //
  // Duplicated from scanFormFields() because this function is
  // serialized and injected on its own — it cannot reach that
  // function's closure.
  //
  function textOf(el) {
    return (
      el?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }


  // ==========================================================
  // SIMULATE A REAL USER CLICK
  // ==========================================================
  //
  // Custom dropdowns are React components. They ignore a plain
  // el.value = "Yes" entirely, because their state only ever
  // changes through their own event handlers.
  //
  // So we replay the full pointer/mouse sequence a real click
  // produces, in the same order the browser would:
  //
  // pointerdown -> mousedown -> (focus) -> pointerup -> mouseup -> click
  //
  // React listens for mousedown on some widgets (to open a popup)
  // but click on others (to commit a choice), so all of them fire.
  //
  function humanClick(el) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1
    };

    [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup"
    ].forEach((type) => {
      el.dispatchEvent(
        new MouseEvent(type, base)
      );
    });

    el.click();
  }


  // ==========================================================
  // WAIT FOR THE OPTION LIST TO APPEAR
  // ==========================================================
  //
  // Clicking a dropdown trigger asks the framework to render its
  // popup. React renders asynchronously, so at the instant we look
  // for [role="option"] there usually isn't one yet.
  //
  // We poll for up to OPTION_WAIT_MS before giving up, because the
  // delay ranges from ~0ms (already-open popup) to a few hundred ms
  // for a slow ATS page. Polling beats a single fixed sleep: it
  // returns as soon as the list is really there.
  //
  const OPTION_WAIT_MS = 1500;
  const OPTION_POLL_MS = 50;


  // How long to wait for a click on an option to be reflected back in the
  // markup before concluding it did nothing.
  const OPTION_SETTLE_MS = 600;


  // Whether this option now reads as chosen.
  //
  // Both spellings turn up on real ATS option rows: Workday's menuItem carries
  // aria-selected and data-automation-selected, and the leaf node inside it
  // carries data-uxi-multiselectlistitem-isselected. Checking the subtree too
  // matters because the marker can land on either level depending on the
  // widget.
  function optionIsSelected(el) {
    return !!el.querySelector &&
      [el, ...el.querySelectorAll("*")].some((n) => {
        if (n.getAttribute("aria-selected") === "true") {
          return true;
        }
        if (n.getAttribute("data-automation-selected") === "true") {
          return true;
        }
        const uxi = n.getAttribute("data-uxi-multiselectlistitem-isselected");
        return uxi === "true" || uxi === "checked";
      });
  }


  // Whether a click on `row` was accepted: either the widget marked the row
  // selected, or it closed the menu over it.
  //
  // The second case is why this can't just poll for aria-selected. A plain
  // dropdown replaces the list once a choice is made, so the clicked node
  // leaves the DOM while the selection very much did happen — reading that as
  // failure would make a working fill report a broken one. Lists that are only
  // hidden (the row stays in the DOM, the menu collapses) read the same way, so
  // a row that stops being visible counts too.
  async function selectionTook(row, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (!row.isConnected || optionIsSelected(row) || !isVisibleOption(row)) {
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, OPTION_POLL_MS));
    }
  }


  // Collect the option elements currently on the page.
  //
  // After a trigger click, an open popup looks like:
  //
  // <ul role="listbox">
  //   <li role="option">Yes</li>
  //   <li role="option">No</li>
  // </ul>
  //
  // Some widgets (react-select) instead render
  // <div role="option">. Both are covered.
  //
  function openOptions() {
    const selectors = [
      '[role="option"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitem"]',
      ...(platformConfig.optionSelectors || [])
    ];
    return Array.from(
      document.querySelectorAll(selectors.join(", "))
    ).filter(
      // Not a choice on offer, just a readout of what is already selected.
      //
      // Workday renders the current answer as an option of its own:
      //
      // <li role="option" aria-selected="true"><div>BS</div></li>
      //
      // and a multiselect renders each chosen value as a dismissable pill
      // with role="option" too. Neither can be "picked" — clicking the pill
      // removes the answer, and clicking the selected row is a no-op that
      // leaves the dropdown showing its old value, which is exactly the
      // "it still says BS" outcome.
      (el) =>
        el.getAttribute("aria-selected") !== "true" &&
        el.getAttribute("data-automation-id") !== "selectedItem"
    );
  }


  // The options that belong to *this* trigger, when the widget says which.
  //
  // An open trigger points at its own menu via aria-controls, and Workday sets
  // it (`aria-controls="hcxk10"` -> the degree listbox). Matching inside that
  // one container is what keeps a fill from reaching into another widget's menu
  // — this page has a Field of Study multiselect with 323 options open at the
  // same time as the Degree dropdown, and both are `role="option"`.
  function triggerOptions(el) {

    const id = el.getAttribute("aria-controls");

    if (!id) return [];

    const listbox =
      document.getElementById(id) ||
      document.querySelector(`#${CSS.escape(id)}`);

    if (!listbox) return [];

    // The container may be the listbox itself or a wrapper around it.
    return Array.from(
      listbox.querySelectorAll('[role="option"], [role="menuitemradio"]')
    ).filter(
      (o) =>
        o.getAttribute("aria-selected") !== "true" &&
        o.getAttribute("data-automation-id") !== "selectedItem"
    );
  }


  // Many component libraries keep every option in the DOM while their menu is
  // closed, merely hiding it with CSS. Treating those hidden nodes as options
  // that were already open makes a freshly opened menu look empty after the
  // `before` filter in fillCombobox().
  function isVisibleOption(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }


  function waitForOptions(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;

      // Check once immediately — the popup may already have been open
      // (or render synchronously), and there is no reason to make the
      // user wait a full poll interval for nothing.
      const existing = openOptions().filter(isVisibleOption);

      if (existing.length) {
        resolve(existing);
        return;
      }

      const tick = () => {
        const found = openOptions().filter(isVisibleOption);

        if (found.length) {
          resolve(found);
          return;
        }

        if (Date.now() >= deadline) {
          resolve([]);
          return;
        }

        setTimeout(tick, OPTION_POLL_MS);
      };

      tick();
    });
  }


  // ==========================================================
  // FIND THE OPTION THAT MATCHES AN ANSWER
  // ==========================================================
  //
  // Matching is done on the option's *text*, because that is what the
  // user reads in the popup and what the answer in profile.json
  // spells out.
  //
  // Two rules, most precise first, tried per accepted text in the order
  // the answer and its aliases are listed:
  //
  //   1. exact match     "Yes"      vs "Yes"
  //   2. prefix          "Yes"      vs "Yes, I am willing"
  //   3. standalone      "authorized" vs "Yes — authorized to work"
  //
  // Exact must win over the looser rules, across ALL accepted texts, or
  // the first option that merely mentions "No" ("No, I do not require
  // sponsorship") could be picked for an answer of "Yes".
  //
  // standaloneMatch is what keeps "India" from claiming "British India"
  // or "British Indian Ocean Territory": a substring buried in a longer
  // name names something else. The prefix rule runs per-text before the
  // standalone one so that a shorter alias never claims a row while the
  // answer itself is still looking ("+91" must not grab
  // "+1 United States" before "United States" gets its turn).
  //

  // Whether `want` appears in `text` as a term in its own right. The
  // occurrence must end at a word boundary ("india" inside "indian" is a
  // fragment) and must not trail another word — punctuation in front is
  // fine ("(India)", "🇮🇳 India") and so is a dial code ("+91 India"),
  // but a word in front ("British", "of") means it is naming something
  // else and must not be selected.
  function standaloneMatch(text, want) {
    if (!want) return false;

    let from = 0;
    for (;;) {
      const at = text.indexOf(want, from);
      if (at === -1) return false;

      const before = text.slice(0, at);
      const after = text.slice(at + want.length);

      const endsRight = !/[a-z0-9]/.test(after[0] || "");

      const head = before.replace(/\s+$/, "");
      const startsRight =
        head === "" ||
        !/[a-z0-9]$/.test(head) ||
        (/\s$/.test(before) && /^\+?\d{1,4}$/.test(head));

      if (endsRight && startsRight) return true;

      from = at + 1;
    }
  }

  function matchOption(options, wantedTexts) {
    // Every text this answer is allowed to match: the displayed value
    // plus any aliases the profile listed alongside it (see `accepts` in
    // matcher.js — this is how one answer covers both a "Yes"/"No"
    // dropdown and a select whose option literally reads "Authorized to
    // work").
    const targets = (Array.isArray(wantedTexts) ? wantedTexts : [wantedTexts])
      .map((t) => String(t ?? "").trim().toLowerCase())
      .filter(Boolean);

    if (!targets.length) {
      return null;
    }

    const texts = options.map((o) => textOf(o).toLowerCase());

    // Pass 1: exact, across every accepted text. A full sweep of every
    // alias is done before falling back to a looser rule for any of
    // them, so an exact "No" is never beaten by a "No, not currently"
    // that happens to come earlier in the list.
    for (const target of targets) {
      const hit = texts.findIndex((t) => t === target);
      if (hit !== -1) return options[hit];
    }

    // Pass 2 and 3: per accepted text, prefix first, then any
    // occurrence standing on its own.
    for (const target of targets) {
      const prefix = texts.findIndex(
        (t) => t.startsWith(target) && !/[a-z0-9]/.test(t[target.length] || "")
      );
      if (prefix !== -1) return options[prefix];

      const loose = texts.findIndex((t) => standaloneMatch(t, target));
      if (loose !== -1) return options[loose];
    }

    return null;
  }


  // ==========================================================
  // FILL A CUSTOM DROPDOWN / COMBOBOX
  // ==========================================================
  //
  // Reproduces what a human does, in order:
  //
  //   1. click the trigger ("Select One")
  //   2. wait for the popup to render its [role="option"] list
  //   3. click the option whose text matches the answer
  //
  // The click in step 3 is what makes Workday update its internal
  // form state — there is no way to shortcut that from script.
  //
  // The text box that filters this widget's option list, when it has one.
  //
  // Some dropdowns are searched rather than scanned. Workday's Field of Study
  // is one: a "Search" box beside a magnifier icon, over a list of 323 entries
  // rendered through a virtual scroller, so only a window of them exists in the
  // DOM at any moment. An answer outside that window cannot be clicked, and no
  // amount of waiting will bring it in — the list has to be filtered first.
  //
  // Two shapes are covered: the control *is* the search box (react-select's
  // <input role="combobox">, Workday's selectinput), or the widget keeps one
  // beside a styled trigger.
  //
  function comboSearchBox(el) {

    if (el.tagName === "INPUT") {
      return el;
    }

    const container = el.closest(
      '[data-automation-id="multiSelectContainer"],' +
        '[data-uxi-widget-type="multiselect"],' +
        '[data-automation-id="multiselectInputContainer"],' +
        '[role="listbox"]'
    );

    if (!container) {
      return null;
    }


    // Workday renders a dropdown's current value in a sibling <input> that
    // holds an internal ID (see isDropdownStateMirror). Writing an answer into
    // that would replace the ID and break the widget without selecting
    // anything, so those inputs are stepped over rather than accepted — and
    // stepped over rather than treated as "no search box", because the real one
    // is usually the very next candidate. Returning null here is what made a
    // searchable widget silently fall back to opening a menu nobody could
    // select from.
    const candidates = container.querySelectorAll(
      '[data-automation-id="searchBox"], input[type="text"], input:not([type]), input[type="search"]'
    );

    for (const candidate of candidates) {
      if (!isDropdownStateMirror(candidate)) {
        return candidate;
      }
    }

    return null;
  }


  // The row to click for a matched option.
  //
  // Option text often sits in a nested element, and the click handler belongs
  // to the row above it:
  //
  // <div data-automation-id="menuItem" role="option">
  //   <div data-automation-label="Computer Engineering">Computer Engineering</div>
  // </div>
  //
  // Both are matched by the option selectors (role, and Workday's
  // data-automation-id), so the match can land on either. Clicking the row is
  // what actually commits the choice.
  //
  // Presses Enter on an element, the way a person finishes typing an answer.
  //
  // Searchable dropdowns commit on this key: typing "Computer Engineering" into
  // Workday's Field of Study and pressing Enter selects it, with no click on
  // the row involved. That is the path the widget actually implements, so it is
  // the one to drive — a synthesized click can land on the row and be ignored,
  // while the key sequence goes through the same handler a real keystroke does.
  //
  // All three event types are dispatched because widgets disagree about which
  // one they listen on, and Enter is harmless if handled twice.
  function pressEnter(el) {
    if (typeof el.focus === "function") {
      el.focus();
    }

    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          charCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }


  function clickableOption(el) {
    return (
      el.closest(
        '[role="option"], [role="menuitemradio"],' +
          ' [role="menuitemcheckbox"], [role="menuitem"]'
      ) || el
    );
  }


  // Types `text` into an input one character at a time, the way a person does.
  //
  // nativeSetValue is wrong for a search box. It sets the value in one go and
  // announces it with `input` and `change` only, which is right for filling a
  // text field but useless for a box that filters as you type: a widget
  // listening on keyup or keypress never hears a keystroke, so the list is
  // still unfiltered when the fill goes on to read it. On Workday's Field of
  // Study that meant the menu opened and then nothing could be selected from
  // it.
  //
  // The value is still advanced through the native setter, one character per
  // event, because a controlled React input only believes a change it was told
  // about — and each `input` event carries the value up to that character, so a
  // handler reading event.target.value sees the string grow as it types.
  function typeIntoBox(el, text) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Order matters and mirrors a real keystroke: the key goes down carrying
      // the value as it was *before* the character, the character lands, then
      // the key comes back up with the value updated. A widget that filters on
      // keyup therefore sees the new text, and one that filters on keydown sees
      // the old — both exactly as they would from a person typing.
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ch,
          bubbles: true,
          cancelable: true
        })
      );

      setter.call(el, text.slice(0, i + 1));

      el.dispatchEvent(
        new KeyboardEvent("keypress", {
          key: ch,
          bubbles: true,
          cancelable: true
        })
      );

      // InputEvent rather than Event so a handler reading `data` sees the
      // character, matching a real keystroke.
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: ch,
          inputType: "insertText"
        })
      );

      el.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: ch,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }


  async function fillCombobox(el, wantedTexts) {
    // Every text this answer is allowed to match: the displayed value
    // plus any aliases from the profile (see `accepts` in matcher.js).
    const wanted = (Array.isArray(wantedTexts) ? wantedTexts : [wantedTexts])
      .map((t) => String(t ?? "").trim())
      .filter(Boolean);

    // What the page actually did, step by step, folded into the failure
    // message.
    //
    // Dropdowns fail silently in several quite different ways — the keystrokes
    // are ignored, the list filters to something else, Enter commits the
    // highlighted row instead, the click lands on a row that cannot be chosen —
    // and they all look identical from the popup: "not selected". Reporting
    // what was observed at each step is the only thing that distinguishes them,
    // and guessing between them costs the user a reload per attempt.
    const trace = [];

    const note = (step) => trace.push(step);

    const fail = (reason) => ({
      ok: false,
      reason: reason + (trace.length ? ` [${trace.join("; ")}]` : "")
    });

    // Don't click the page around if we have nothing to select.
    if (!wanted.length) {
      return {
        ok: false,
        reason: "empty value"
      };
    }

    // Options that were already on the page before we clicked, so we
    // can tell "the popup opened" apart from "some other widget on
    // this page happens to have an open listbox".
    const before = new Set(openOptions().filter(isVisibleOption));


    // Whether this trigger's menu is already open — because the user opened
    // it, or because an earlier fill attempt failed and left it that way.
    const wasOpen = el.getAttribute("aria-expanded") === "true";


    // Reads this widget's options, preferring its own menu so two open
    // dropdowns can't answer for each other.
    const readWidgetOptions = () => {
      const scopedToWidget = widgetMenuOptions(el);

      return (scopedToWidget === null
        ? openOptions()
        : scopedToWidget
      ).filter(isVisibleOption);
    };


    // What the list looked like before we typed anything. A searchable menu is
    // shown in full when it opens — 323 rows on Workday — so this is what an
    // ignored keystroke looks like, and the only way to tell it apart from a
    // successful filter.
    const fingerprintBefore = optionFingerprint(readWidgetOptions());


    // Searchable dropdowns are narrowed by typing the answer, not by reading a
    // list that may not even contain it yet.
    //
    // Only for a single answer, though: a multi-value field (Skills is a list
    // of twenty) has to add its entries one at a time, and typing the whole
    // comma-joined string into the box would filter to nothing and leave junk
    // text behind for the user to clear.
    const searchBox =
      wanted.length === 1 && !wanted[0].includes(",")
        ? comboSearchBox(el)
        : null;

    // The single most useful fact about a search box: did the page keep what we
    // typed? React discards a value it does not accept, so an empty box
    // afterwards means the keystrokes were rejected outright.
    const reportTyped = () => {
      if (!searchBox) {
        return;
      }

      const held = searchBox.value;
      const label = searchBox.getAttribute("data-automation-id") || searchBox.id || "input";

      note(
        held === wanted[0]
          ? `box ${label} kept "${held}"`
          : `box ${label} holds "${held}" instead of "${wanted[0]}"`
      );
    };


    // 1. Put the widget in a state where its options can be read.
    if (searchBox) {

      // Focus first: some widgets mount their menu on focus rather than on
      // click, and the box must be focused for the typed value to register.
      if (typeof searchBox.focus === "function") {
        searchBox.focus();
      }

      // Workday hides the real input behind a magnifier icon and only mounts
      // the menu when that icon is used, so drive the icon when there is one.
      const icon = searchBox.parentElement &&
        searchBox.parentElement.querySelector(
          '[data-automation-id="promptSearchButton"],' +
            '[data-uxi-selectinputicon-type="promptSearchButton"]'
        );

      if (icon) {
        humanClick(icon);
      }

      typeIntoBox(searchBox, wanted[0]);
    } else if (!wasOpen) {

      // Plain trigger button: never click an already-expanded one, that would
      // close the menu we are about to read from.
      humanClick(el);
    }


    // 2. Wait for the option list to be rendered.
    const visible = (await waitForOptions(OPTION_WAIT_MS))
      .filter(isVisibleOption);


    // Prefer this trigger's own menu. Two dropdowns are open at once on a
    // Workday application form (Degree and Field of Study), and a document-wide
    // search would let one field's fill pick another field's option.
    const scoped = triggerOptions(el).filter(isVisibleOption);

    if (scoped.length || searchBox) {

      if (searchBox) {
        note(
          searchBox.getAttribute("data-automation-id") === "searchBox"
            ? "typed into searchBox"
            : "typed into a plain input"
        );
        reportTyped();

        const nowOpen = readWidgetOptions();
        note(`list ${nowOpen.length} rows before filter`);

        if (!nowOpen.length) {
          note("no rows rendered");
        }
      }

      const settled = searchBox
        ? await waitForFilter(
            readWidgetOptions,
            wanted,
            OPTION_WAIT_MS,
            fingerprintBefore
          )
        : null;

      if (settled) {
        reportTyped();
        note(`list ${settled.options.length} rows after filter`);
        note(settled.filtered ? "list changed" : "list did not change");

        const top = settled.options.slice(0, 3).map((o) => textOf(o).trim());

        if (top.length) {
          note(`top rows: ${top.join(" / ")}`);
        }
      }

      if (settled && !settled.filtered) {
        return fail(
          `typed "${wanted[0]}" but the list did not filter, so Enter was not pressed`
        );
      }

      return pickOption(
        el,
        settled ? settled.options : scoped,
        wanted,
        searchBox,
        null,
        note
      );
    }


    // Options that appeared *because of our click* are the ones that belong to
    // this trigger, which keeps a listbox some other widget left open on the
    // page from being mistaken for this field's menu.
    //
    // When the menu was already open nothing is new, so fall back to everything
    // visible rather than reporting a false "no options appeared" — that
    // fallback is the whole reason this field used to stay unfilled after a
    // single failed attempt.
    const opened =
      visible.filter((o) => !before.has(o));

    const options = opened.length ? opened : visible;


    // Nothing appeared — the trigger didn't open anything.
    if (!options.length) {
      return {
        ok: false,
        reason: wasOpen
          ? "trigger reported itself open but no options are visible"
          : "no options appeared after clicking"
      };
    }

    return pickOption(el, options, wanted, searchBox, null, note);
  }


  // A comparable snapshot of the options currently rendered.
//
// Used to tell "the widget filtered what we typed" from "the widget ignored it
// and is still showing everything". The distinction decides whether Enter is
// safe to press, so it has to be read off the list rather than assumed.
function optionFingerprint(options) {
    return options.map((o) => textOf(o).trim()).join("");
  }


  // The options belonging to one particular widget's menu.
  //
  // Workday renders this menu as a popper appended to <body>, not inside the
  // widget, and the search input carries no aria-controls for triggerOptions() to
  // follow. It does, however, name the widget it belongs to
  // (data-uxi-multiselect-id), and the popper names the widget it is showing
  // (data-associated-widget) — so the pairing is enough to keep two open menus
  // on the same form from answering for each other.
  //
  // Returns null when the page doesn't use this arrangement, so the caller can
  // fall back to the document-wide search.
  function widgetMenuOptions(el) {
    const widgetId =
      el.getAttribute("data-uxi-multiselect-id") ||
      (el.closest("[data-uxi-element-id]") || {}).getAttribute?.(
        "data-uxi-element-id"
      );

    if (!widgetId) {
      return null;
    }

    const menus = document.querySelectorAll(
      `[data-associated-widget="${CSS.escape(widgetId)}"]`
    );

    if (!menus.length) {
      return null;
    }

    return openOptions().filter((o) =>
      Array.from(menus).some(
        (menu) => menu === o || menu.contains(o)
      )
    );
  }


  // Waits until the list reflects what was typed, then matches against it.
  //
  // Requiring the list to have *changed* is the load-bearing part. An unfiltered
  // Workday menu already contains the answer somewhere among 323 rows, so
  // finding the text proves nothing — and pressing Enter there commits whatever
  // the widget has highlighted instead. On Workday that is the first row of the
  // list, which is what aria-activedescendant points at, so an unfiltered Enter
  // would silently fill "Accounting" into a Field of Study box.
  //
  // Returns `filtered: false` when the list never changed, and the caller must
  // not press Enter in that case.
  async function waitForFilter(readOptions, wanted, timeoutMs, fingerprintBefore) {
    const deadline = Date.now() + timeoutMs;

    let newest = [];

    for (;;) {
      const options = readOptions();

      if (options.length) {
        newest = options;
      }

      const fingerprint = optionFingerprint(options);

      if (
        options.length &&
        fingerprint !== fingerprintBefore &&
        matchOption(options, wanted)
      ) {
        return {
          options,
          filtered: true
        };
      }

      if (Date.now() >= deadline) {
        return {
          options: newest,
          filtered: fingerprint !== fingerprintBefore
        };
      }

      await new Promise((resolve) => setTimeout(resolve, OPTION_POLL_MS));
    }
  }


  // Choose one of `options` for `wanted` and commit it, closing the menu again
  // if nothing matched.
  //
  // `enterBox` is the widget's search box when it has one. Committing a
  // searchable dropdown the way a person does — Enter, no click — is tried
  // first, because that is the path the widget actually implements; a
  // synthesized click on the row can be ignored by the same widget.
  //
  // `target` is the row already matched against the settled list, when the
  // caller waited for the list to filter. Matching it again here could pick a
  // different row out of a list the caller has already moved past.
  async function pickOption(el, options, wanted, enterBox, target, trace) {

    const note = trace || (() => {});

    target = target || matchOption(options, wanted);

    if (!target) {
      // Close the popup we opened so we don't leave the page in a
      // half-interacted state.
      humanClick(el);

      return {
        ok: false,
        // Surfacing what *was* on offer is what makes this
        // debuggable — without it the popup would just report
        // "no matching option" and tell you nothing.
        reason: `no option matching "${wanted.join(" / ")}" (saw: ${
          options
            .map((o) => textOf(o))
            .slice(0, 8)
            .join(" | ") || "none"
        })`
      };
    }

    // Workday's list rows wrap the real control — a radio in the Degree
    // list, a checkbox in a multiselect — and the selection can be driven by
    // that input's change handler rather than the row's click handler.
    const row = clickableOption(target);

    // What the widget has highlighted right now is what Enter will commit, and
    // it is not necessarily the row we matched.
    if (enterBox) {
      const listbox = row.closest('[role="listbox"]');
      const activeId = listbox && listbox.getAttribute("aria-activedescendant");
      const active = activeId && document.getElementById(activeId);

      note(
        active
          ? `Enter would commit "${textOf(active).trim()}"`
          : "Enter has no aria-activedescendant to commit"
      );

      pressEnter(enterBox);

      const took = await selectionTook(row, OPTION_SETTLE_MS);

      note(took ? "Enter selected it" : "Enter changed nothing");

      if (took) {
        return {
          ok: true
        };
      }

      if (active && active !== row) {
        note(
          `widget instead highlighted "${textOf(active).trim()}" — clicking our row directly`
        );
      }
    }

    note(`clicking "${textOf(target).trim()}"`);

    humanClick(row);

    if (!(await selectionTook(row, OPTION_SETTLE_MS))) {
      const control = row.querySelector(
        'input[type="radio"], input[type="checkbox"]'
      );

      if (control) {
        note("clicking the row's own input");
        humanClick(control);
      } else {
        note("the row has no input to click");
      }
    }

    if (!(await selectionTook(row, OPTION_SETTLE_MS))) {
      return {
        ok: false,
        // Distinct from "no matching option" on purpose: the option was
        // there and was clicked, so the problem is in how the widget accepts a
        // selection, and saying otherwise would send the debugging in the wrong
        // direction.
        reason: `clicked "${textOf(target).trim()}" but the option was not marked selected`
      };
    }

    return {
      ok: true
    };
  }


  // Some platforms render hierarchical multiselects: choosing a parent opens
  // another menu containing its child. A normal combobox fill stops after the
  // first click, so use a `Parent > Child` profile value to walk each level.
  function isConfiguredHierarchicalMultiSelect(el, item) {
    const config = platformConfig.hierarchicalMultiSelect;
    return !!(
      config &&
      item.matchedPath === config.fieldPath &&
      el.matches(config.inputSelector) &&
      el.closest(config.containerSelector)
    );
  }


  function hierarchicalMenuItems(config) {
    return Array.from(
      document.querySelectorAll(config.menuItemSelectors.join(", "))
    ).filter((item) => {
      if (!isVisibleOption(item)) return false;
      // A selected pill also has role="option"/menuItem, but it is not a
      // navigable menu choice and must not be selected again.
      return !item.closest(config.selectedListSelector);
    });
  }


  function selectedHierarchicalValues(el, config) {
    const container = el.closest(config.containerSelector);
    if (!container) return [];
    return Array.from(container.querySelectorAll(config.selectedItemSelector))
      .map(textOf)
      .filter(Boolean);
  }


  function waitForHierarchicalOption(label, config, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;

      const tick = () => {
        const option = matchOption(hierarchicalMenuItems(config), [label]);
        if (option) {
          resolve(option);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(tick, OPTION_POLL_MS);
      };

      tick();
    });
  }


  async function fillHierarchicalMultiSelect(el, pathValue, config) {
    const path = String(pathValue ?? "")
      .split(/\s*>\s*/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (!path.length) return { ok: false, reason: "empty value" };

    const finalValue = path[path.length - 1].toLowerCase();
    if (selectedHierarchicalValues(el, config).some((value) => value.toLowerCase() === finalValue)) {
      return { ok: true };
    }

    humanClick(el);

    for (const segment of path) {
      const option = await waitForHierarchicalOption(segment, config, OPTION_WAIT_MS);
      if (!option) {
        return { ok: false, reason: `no menu option matching "${segment}"` };
      }
      humanClick(option);
    }

    // The last click schedules a React state update. Wait briefly for the
    // selected pill so the report reflects Workday's actual state, not only a
    // successful click dispatch.
    const deadline = Date.now() + OPTION_WAIT_MS;
    while (Date.now() < deadline) {
      if (selectedHierarchicalValues(el, config).some((value) => value.toLowerCase() === finalValue)) {
        return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, OPTION_POLL_MS));
    }

    return { ok: false, reason: `the menu did not select "${path[path.length - 1]}"` };
  }


  const report = [];


  // Process every requested field.
  //
  // Sequential and awaited, not forEach: a combobox needs its popup
  // opened, rendered and closed before the next field is touched,
  // otherwise two open popups can sit on top of each other and the
  // second fill clicks the wrong list.
  //
  for (const item of payload) {

    // Don't attempt to fill empty values.
    if (!item.value) {
      report.push({
        uid: item.uid,
        ok: false,
        reason: "empty value"
      });

      continue;
    }


    // ========================================================
    // RADIO/CHECKBOX GROUP
    // ========================================================
    //
    // Grouped choices have tagName "radiogroup".
    //
    if (item.tagName === "radiogroup") {

      // Find every element belonging to this group.
      const group = querySelectorDeep(
        `[${AUTOFILL_ATTR}="${item.uid}"]`
      );

      if (!group.length) {
        report.push({
          uid: item.uid,
          ok: false,
          reason: "group options not found"
        });
        continue;
      }


      // Every string this option could legitimately be matched by. Native
      // inputs expose `.value`; ARIA options are <div>s that only carry
      // data-value/aria-label, and their visible text may sit in a nested
      // span. Reading `.value` unguarded would throw on a div, so everything is
      // funnelled through the null check.
      const candidateTexts = (el) =>
        [
          el.value,
          el.getAttribute("value"),
          el.getAttribute("data-value"),
          el.getAttribute("data-answer-value"),
          el.getAttribute("aria-label"),
          textOf(el)
        ]
          .map((candidate) => (candidate == null ? "" : String(candidate)).trim().toLowerCase())
          .filter(Boolean);

      const optionTexts = group.map(candidateTexts);


      // A multi-select group carries values[]; a single-select one carries a
      // single value plus its aliases. Applies the same alias list that select
      // and combobox fields use — one ATS renders "Authorized to work" as a
      // label while another renders the equivalent answer as a Yes/No group.
      const wantsMultiple = item.multiple === true;
      const wanted = (
        wantsMultiple && Array.isArray(item.values) && item.values.length
          ? item.values
          : [item.value, ...(item.accepts || [])]
      )
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean);

      if (!wanted.length) {
        report.push({
          uid: item.uid,
          ok: false,
          reason: "empty value"
        });
        continue;
      }


      // Exact matches across every option win before any looser rule, and each
      // option is claimed at most once so two similar aliases can't both tick
      // the same box. The looser rules mirror matchOption: a prefix at a word
      // boundary first, then an occurrence standing on its own — so a country
      // answer claims "India" or "+91 India" but never "British India".
      const PREDICATES = [
        (text, want) => text === want,
        (text, want) =>
          text.startsWith(want) && !/[a-z0-9]/.test(text[want.length] || ""),
        (text, want) => standaloneMatch(text, want)
      ];

      const picked = [];
      const taken = new Set();

      for (const want of wanted) {
        let foundIndex = -1;

        for (const predicate of PREDICATES) {
          const index = optionTexts.findIndex(
            (texts, i) => !taken.has(i) && texts.some((text) => predicate(text, want))
          );
          if (index !== -1) {
            foundIndex = index;
            break;
          }
        }

        if (foundIndex === -1) continue;

        taken.add(foundIndex);
        picked.push(group[foundIndex]);

        // Radio options are mutually exclusive: the first match wins and the
        // remaining candidates are discarded rather than fighting over the
        // selection.
        if (!wantsMultiple) break;
      }


      if (!picked.length) {
        report.push({
          uid: item.uid,
          ok: false,
          reason: "no matching option"
        });
        continue;
      }


      picked.forEach((el) => selectChoice(el));

      report.push({
        uid: item.uid,
        ok: true,
        // Multi-selects report how many boxes were ticked, so the UI can say
        // "3 selected" instead of implying a single choice was made.
        ...(picked.length > 1 ? { selected: picked.length } : {})
      });


      // Group processing complete.
      continue;
    }


    // ========================================================
    // FIND NORMAL ELEMENT
    // ========================================================
    //
    // Search the page using the UID created by scanFormFields().
    //
    const el = querySelectorDeep(
      `[${AUTOFILL_ATTR}="${item.uid}"]`
    )[0] || null;


    // Element disappeared or could not be found.
    if (!el) {

      report.push({
        uid: item.uid,
        ok: false,
        reason: "element not found"
      });

      continue;
    }


    // ========================================================
    // CUSTOM DROPDOWN / COMBOBOX
    // ========================================================
    //
    // Covers both flavours scanFormFields() can emit as a combobox:
    //
    //   tagName "combobox" -> a <button>/<div role="combobox"> trigger
    //   tagName "input"    -> an <input role="combobox"> (react-select),
    //                        which isComboboxLike() retyped during scan
    //
    // Neither accepts el.value = "Yes": the answer only reaches
    // Workday's form state through a click on the chosen option.
    //
    if (item.inputType === "combobox") {
      const result =
        isConfiguredHierarchicalMultiSelect(el, item)
          ? await fillHierarchicalMultiSelect(el, item.value, platformConfig.hierarchicalMultiSelect)
          : await fillCombobox(el, [item.value, ...(item.accepts || [])]);

      report.push({
        uid: item.uid,
        ...result
      });

      continue;
    }


    // ========================================================
    // SELECT
    // ========================================================
    //
    // For <select>, we don't directly use the supplied value.
    // Instead, we try to find the matching option text.
    //
    if (el.tagName === "SELECT") {

      // Same option matching the combobox path uses, so one answer list
      // covers both control types (see matchOption above).
      const opt = matchOption(
        Array.from(el.options),
        [item.value, ...(item.accepts || [])]
      );


      // Matching option found.
      if (opt) {

        // Use the native select value setter.
        const setter =
          Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            "value"
          ).set;


        // Set the actual option value.
        setter.call(
          el,
          opt.value
        );


        // Notify the page/framework.
        el.dispatchEvent(
          new Event("change", {
            bubbles: true
          })
        );


        report.push({
          uid: item.uid,
          ok: true
        });

      } else {

        // No option matched the requested value.
        report.push({
          uid: item.uid,
          ok: false,
          reason: "no matching option"
        });
      }


      continue;
    }


    // ========================================================
    // CHECKBOX
    // ========================================================
    //
    // For a checkbox, the requested action is simply to check it.
    //
    if (
      el.tagName === "INPUT" &&
      el.type === "checkbox"
    ) {

      // Unless it is asking for consent, in which case the
      // extension has no answer to give and says so rather than
      // ticking a permission the user never chose to grant.
      //
      // Reported as ok:false, not ok:true, so it surfaces in the
      // popup's failure list and in the review highlight: this is
      // something the user is meant to handle, not something that
      // quietly went fine.
      //
      if (isConsentCheckboxItem(item)) {

        report.push({
          uid: item.uid,
          ok: false,
          reason: "Consent checkbox left for you to tick."
        });

        continue;
      }


      setChecked(
        el,
        true
      );


      report.push({
        uid: item.uid,
        ok: true
      });


      continue;
    }


    // ========================================================
    // NORMAL TEXT-LIKE FIELD
    // ========================================================
    //
    // Used for:
    //
    // text
    // email
    // number
    // textarea
    // etc.
    //
    nativeSetValue(
      el,
      item.value
    );


    report.push({
      uid: item.uid,
      ok: true
    });
  }


  // Return the complete fill report.
  return report;
}


// ============================================================
// HIGHLIGHT THE FIELDS LEFT FOR THE USER
// ============================================================
//
// The other half of a page-at-a-time pass: fillFormFields fills what it can and
// reports what it could not, and this makes the remainder visible on the page
// itself so the user knows where to look before deciding whether to continue.
//
// Without it the only signal is a count in the side panel, and the user has to
// hunt for which field the count refers to — on a long Workday step that is
// scrolling past a screen of correct values to find the one that needs a human.
//
// Two deliberate choices:
//
//   1. OUTLINE, NOT BORDER. An outline is painted outside the box and does not
//      participate in layout, so marking a field cannot move the text or inputs
//      around it. A border would reflow the form while the user is reading it,
//      which is how a "just a highlight" feature ends up clicking the wrong
//      button. It also survives sites that set their own borders with !important,
//      because our selector is equally specific but loaded later.
//
//   2. A CLASS TOGGLED ON THE EXISTING ELEMENT, NOT A WRAPPER DIV. Injecting
//      nodes around form controls is the classic way to break a framework that
//      walks up the tree from its own input (Workday resolves a field's container
//      by climbing ancestors), and it would leave the page dirty for the next
//      scan. This only ever sets and removes an attribute on elements the scanner
//      already stamped.
//
// Self-contained like every other function here: it is serialized and injected on
// its own, so it declares its own constant and shares nothing with
// fillFormFields or matcher.js.
//
function highlightReviewFields(request = {}) {
  const STYLE_ID = "autofill-review-style";
  const MARK_ATTR = "data-autofill-review";

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  // Required marker, not :focus or a class: the page owns every other attribute
  // on these elements and will overwrite anything it thinks is its own state.
  const STYLE_TEXT = `
    [${MARK_ATTR}="review"] {
      outline: 2px solid #d97706 !important;
      outline-offset: 2px !important;
      border-radius: 2px;
    }
  `;


  // --------------------------------------------------------
  // CLEAR ANY PREVIOUS PASS
  // --------------------------------------------------------
  //
  // Always runs first, including on the clear-only call, so a second fill on the
  // same step re-highlights from scratch instead of leaving yesterday's marks on
  // fields that have since been filled.
  //
  for (const stale of document.querySelectorAll(`[${MARK_ATTR}]`)) {
    stale.removeAttribute(MARK_ATTR);
  }

  const oldStyle = document.getElementById(STYLE_ID);
  if (oldStyle) oldStyle.remove();

  // A pass with nothing left to show should leave the page exactly as it was,
  // including not leaving a stylesheet behind.
  const uids = Array.isArray(request.uids) ? request.uids : [];
  if (!uids.length) {
    return { marked: 0, labels: [] };
  }


  // Injected once per pass rather than kept for the extension's lifetime: a
  // stylesheet that outlives the pass would keep applying to elements the
  // scanner has since re-stamped for a different question.
  //
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (document.head || document.documentElement).appendChild(style);


  const labels = [];

  // The scanner's own uids are "af-N", which needs no escaping, but this runs
  // against an attribute selector with a string that arrived over the messaging
  // boundary — one stray quote would throw inside the page and take the whole
  // highlight down with it.
  const escapeAttr = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  };


  for (const uid of uids) {
    if (!uid) continue;

    let el = null;
    try {
      el = querySelectorDeep(`[data-autofill-uid="${escapeAttr(String(uid))}"]`)[0] || null;
    } catch (_) {
      el = null;
    }
    if (!el) continue;

    // Nothing to point at on a hidden field — a collapsed accordion step or an
    // unopened tab. Marking it would show a mark the user cannot see and cannot
    // reach, which reads as a bug.
    const style_ = window.getComputedStyle(el);
    const hidden =
      style_.display === "none" ||
      style_.visibility === "hidden" ||
      style_.opacity === "0";
    if (hidden) continue;

    el.setAttribute(MARK_ATTR, "review");

    const label =
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.id ||
      "";
    if (label) labels.push(label);
  }

  const marked = document.querySelectorAll(`[${MARK_ATTR}="review"]`).length;


  // --------------------------------------------------------
  // BRING THE FIRST ONE INTO VIEW
  // --------------------------------------------------------
  //
  // Scrolling is the user's own decision to make — the extension must not move
  // the page under a cursor that is about to click something. So: only ever when
  // asked, and only to the first outstanding field, and with "auto" rather than
  // "smooth" so it lands immediately instead of animating while they are
  // already moving the mouse.
  //
  if (request.scroll && marked > 0) {
    const first = document.querySelector(`[${MARK_ATTR}="review"]`);
    if (first && typeof first.scrollIntoView === "function") {
      first.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }


  return { marked, labels };
}


// ============================================================
// FILL RESUME FILE
// ============================================================
//
// Attaches a stored PDF resume to an <input type="file">.
//
// The resume is supplied as base64 data.
//
// We:
//   1. Decode the base64
//   2. Convert it into bytes
//   3. Create a real File object
//   4. Put that File into a DataTransfer
//   5. Assign DataTransfer.files to input.files
//   6. Dispatch input/change events
//
// This avoids needing to interact with the visible upload button.
// ============================================================

function fillResumeFile(
  uid,
  base64,
  filename,
  mimeType
) {

  // Same attribute used everywhere else to identify fields.
  const AUTOFILL_ATTR =
    "data-autofill-uid";

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }


  // Find the file input by its generated UID.
  const el = querySelectorDeep(
    `[${AUTOFILL_ATTR}="${uid}"]`
  )[0] || null;


  // Input no longer exists.
  if (!el) {
    return {
      uid,
      ok: false,
      reason: "element not found"
    };
  }


  // File conversion can fail, so wrap it in try/catch.
  try {

    // Decode base64 into a binary string.
    const byteChars = atob(base64);


    // Create an array large enough to contain every byte.
    const byteNumbers =
      new Array(byteChars.length);


    // Convert every character into its numeric byte value.
    for (
      let i = 0;
      i < byteChars.length;
      i++
    ) {
      byteNumbers[i] =
        byteChars.charCodeAt(i);
    }


    // Create a real File object from the bytes.
    const file = new File(
      [
        new Uint8Array(
          byteNumbers
        )
      ],
      filename,
      {
        type: mimeType
      }
    );


    // DataTransfer provides a way to construct a FileList.
    const dt =
      new DataTransfer();


    // Add our File to the FileList.
    dt.items.add(file);


    // Assign the generated FileList to the file input.
    el.files = dt.files;


    // Notify the website that the file changed.
    el.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );


    el.dispatchEvent(
      new Event("change", {
        bubbles: true
      })
    );


    // Report success.
    return {
      uid,
      ok: true
    };

  } catch (err) {

    // Something went wrong while creating/attaching the file.
    return {
      uid,
      ok: false,
      reason: err.message
    };
  }
}


// ============================================================
// SCAN JOB DESCRIPTION
// ============================================================
//
// Attempts to extract the job description from the current page.
//
// Three strategies are tried in order:
//
// 1. JSON-LD structured data
// 2. Known ATS/platform selectors
// 3. Largest visible text block
//
// The function also reports which strategy was used.
//
// IMPORTANT:
// This is best-effort extraction. It is not guaranteed to identify
// the exact job description on every website.
// ============================================================

function scanJobDescription() {

  // Minimum amount of text expected from a normal JD.
  const MIN_LENGTH = 200;


  // Prevent an enormous page from producing an excessively large
  // result.
  const MAX_LENGTH = 20000;


  // ==========================================================
  // CLEAN TEXT
  // ==========================================================
  //
  // Normalizes whitespace and removes excessive blank lines.
  //
  function clean(text) {

    return (
      text || ""
    )

      // Replace non-breaking spaces with normal spaces.
      .replace(/ /g, " ")

      // Collapse multiple spaces/tabs into one space.
      .replace(/[ \t]+/g, " ")

      // Collapse 3+ newlines into 2 newlines.
      .replace(/\n{3,}/g, "\n\n")

      // Remove whitespace at the beginning/end.
      .trim();
  }


  // ==========================================================
  // STRIP HTML
  // ==========================================================
  //
  // Takes an HTML string and extracts only its text.
  //
  // Example:
  //
  // "<p>Hello <b>world</b></p>"
  //
  // becomes:
  //
  // "Hello world"
  //
  function stripHtml(html) {

    // Parse the HTML into a temporary document.
    const doc =
      new DOMParser()
        .parseFromString(
          html,
          "text/html"
        );


    // Return the text content of the temporary document body.
    //
    // This removes the HTML tags.
    return doc.body
      ? doc.body.textContent
      : "";
  }


  // ==========================================================
  // EXTRACT FROM JSON-LD
  // ==========================================================
  //
  // Many job websites embed structured data like:
  //
  // <script type="application/ld+json">
  //
  // containing a schema.org JobPosting object.
  //
  // This is generally more trustworthy than guessing based on
  // page layout.
  //
  function fromJsonLd() {

    // Find all JSON-LD script elements.
    const scripts =
      document.querySelectorAll(
        'script[type="application/ld+json"]'
      );


    // Check every JSON-LD block.
    for (const script of scripts) {

      let data;


      // JSON-LD should be JSON, but malformed JSON is possible.
      try {

        data = JSON.parse(
          script.textContent
        );

      } catch {

        // Ignore malformed JSON-LD and continue.
        continue;
      }


      // JSON-LD can have several possible structures.
      //
      // It may be:
      //
      // [item1, item2]
      //
      // or:
      //
      // { "@graph": [...] }
      //
      // or:
      //
      // { ...single object... }
      //
      const items =
        Array.isArray(data)
          ? data
          : Array.isArray(data["@graph"])
            ? data["@graph"]
            : [data];


      // Check every JSON-LD object.
      for (const item of items) {

        // Ignore null/non-object values.
        if (
          !item ||
          typeof item !== "object"
        ) {
          continue;
        }


        // @type may be:
        //
        // "JobPosting"
        //
        // or an array:
        //
        // ["JobPosting", "..."]
        //
        const types =
          Array.isArray(item["@type"])
            ? item["@type"]
            : [item["@type"]];


        // We only care about schema.org JobPosting objects
        // that contain a description.
        if (
          types.includes("JobPosting") &&
          typeof item.description === "string" &&
          item.description.trim()
        ) {

          // The description may contain HTML,
          // so strip the HTML before returning it.
          return stripHtml(
            item.description
          );
        }
      }
    }


    // No usable JobPosting description found.
    return "";
  }


  // ==========================================================
  // KNOWN ATS SELECTORS
  // ==========================================================
  //
  // Different job platforms use different CSS selectors for
  // their job description containers.
  //
  // They are ordered from more specific/common selectors toward
  // broader fallback selectors.
  //
  const ATS_SELECTORS = [

    // LinkedIn
    "#job-details",
    ".jobs-description__content",
    ".jobs-box__html-content",

    // Greenhouse
    ".job__description",
    "#content .job__description",

    // Workday
    "[data-automation-id='jobPostingDescription']",

    // Lever
    ".posting-requirements",
    "[data-qa='job-description']",

    // iCIMS
    ".iCIMS_JobContent",

    // SmartRecruiters
    ".job-sections",

    // Generic schema.org description
    "[itemprop='description']",

    // Broad HTML fallbacks
    "article",
    "main"
  ];


  // ==========================================================
  // EXTRACT USING KNOWN SELECTORS
  // ==========================================================
  //
  function fromKnownSelectors() {

    // Try each selector in order.
    for (const selector of ATS_SELECTORS) {

      let el;


      // querySelector can theoretically throw if a selector
      // is malformed, so protect it.
      try {

        el =
          document.querySelector(
            selector
          );

      } catch {

        continue;
      }


      // Selector didn't find anything.
      if (!el) {
        continue;
      }


      // Prefer innerText because it represents visible text.
      //
      // Fall back to textContent if innerText isn't available.
      const text = clean(
        el.innerText ||
        el.textContent ||
        ""
      );


      // Accept the first sufficiently large result.
      if (
        text.length >= MIN_LENGTH
      ) {
        return text;
      }
    }


    // None of the known selectors produced a valid JD.
    return "";
  }


  // ==========================================================
  // LARGEST VISIBLE TEXT BLOCK
  // ==========================================================
  //
  // Last-resort fallback.
  //
  // If we don't recognize the website, look for the largest
  // visible block of text.
  //
  function fromLargestBlock() {

    // Elements that are generally page chrome rather than JD content.
    const EXCLUDE_TAGS = new Set([
      "SCRIPT",
      "STYLE",
      "NAV",
      "HEADER",
      "FOOTER",
      "ASIDE",
      "SVG",
      "NOSCRIPT"
    ]);


    // Search common container elements.
    const candidates =
      document.querySelectorAll(
        "div, section, article, main"
      );


    // Keep track of the largest text block found.
    let best = "";


    // Examine every candidate.
    candidates.forEach((el) => {

      // Ignore obviously irrelevant tags.
      if (
        EXCLUDE_TAGS.has(
          el.tagName
        )
      ) {
        return;
      }


      // Also ignore elements located inside navigation,
      // headers, footers or sidebars.
      if (
        el.closest(
          "nav, header, footer, aside"
        )
      ) {
        return;
      }


      // Check CSS visibility.
      const style =
        window.getComputedStyle(el);


      if (
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        return;
      }


      // Extract visible text and normalize it.
      const text = clean(
        el.innerText || ""
      );


      // Keep the largest block encountered.
      if (
        text.length > best.length
      ) {
        best = text;
      }
    });


    return best;
  }


  // ==========================================================
  // FINALIZE RESULT
  // ==========================================================
  //
  // Makes sure the final JD doesn't exceed MAX_LENGTH.
  //
  // Also records:
  //
  // - which extraction method was used
  // - whether the result was truncated
  //
  function finalize(
    text,
    source
  ) {

    // Determine whether the text is too long.
    const truncated =
      text.length > MAX_LENGTH;


    return {

      // If too long, keep only the first MAX_LENGTH characters.
      text:
        truncated
          ? text.slice(
              0,
              MAX_LENGTH
            )
          : text,

      // Explain where the JD came from.
      source,

      // Tell the caller whether truncation occurred.
      truncated
    };
  }


  // ==========================================================
  // EXTRACTION ORDER
  // ==========================================================
  //
  // We deliberately try the methods in this order:
  //
  // 1. Structured JSON-LD
  // 2. Known ATS layout
  // 3. Largest visible text block
  //
  // The first successful method wins.
  // ==========================================================


  // JSON-LD has a lower minimum threshold because it is structured
  // JobPosting data rather than a page-layout guess.
  const JSON_LD_MIN_LENGTH = 40;


  // ----------------------------------------------------------
  // TIER 1: JSON-LD
  // ----------------------------------------------------------
  const jsonLdText =
    fromJsonLd();


  if (
    jsonLdText &&
    jsonLdText.length >=
      JSON_LD_MIN_LENGTH
  ) {

    return finalize(
      jsonLdText,
      "structured data (JobPosting)"
    );
  }


  // ----------------------------------------------------------
  // TIER 2: KNOWN ATS SELECTORS
  // ----------------------------------------------------------
  const selectorText =
    fromKnownSelectors();


  if (
    selectorText &&
    selectorText.length >=
      MIN_LENGTH
  ) {

    return finalize(
      selectorText,
      "known ATS layout"
    );
  }


  // ----------------------------------------------------------
  // TIER 3: LARGEST TEXT BLOCK
  // ----------------------------------------------------------
  const fallbackText =
    fromLargestBlock();


  if (fallbackText) {

    return finalize(
      fallbackText,
      "best-guess (largest text block on the page)"
    );
  }


  // ----------------------------------------------------------
  // NOTHING FOUND
  // ----------------------------------------------------------
  return {
    text: "",
    source: "not found",
    truncated: false
  };
}


// ============================================================
// SCAN JOB LISTINGS (discovery)
// ============================================================
//
// Reads the job cards off a search-results page — LinkedIn's jobs search,
// Indeed's results, or any board that ships schema.org JobPosting JSON-LD —
// and returns them as plain objects for the discover engine to score.
//
// Three strategies, in the same spirit as scanJobDescription():
// 1. LinkedIn's own card markup. The tab is opened with the user's logged-in
//    session, so what this reads is exactly what the person would see.
// 2. JSON-LD JobPosting blocks, which Greenhouse/Lever/Workday-powered career
//    sites and most aggregators embed on listing pages.
// 3. Generic job-shaped links, so an unrecognised board still yields titles
//    and URLs rather than nothing.
//
// These pages are SPAs: the function polls until cards appear or waitForMs
// elapses, because a tab that is still hydrating must not read as "no jobs".
// Returns [{ url, title, company, location, snippet }] — deduped by URL,
// capped at maxCards. Empty array means "nothing recognisable rendered",
// which on LinkedIn usually means the session was logged out (auth wall).
//
// IMPORTANT: self-contained, like every function in this file — it is
// serialized and injected on its own, with no access to the extension's
// other scripts.
// ============================================================

async function scanJobListings(options) {
  const opts = options || {};
  const MAX_CARDS = Math.min(Number(opts.maxCards) || 60, 120);
  const WAIT_MS = Math.max(Number(opts.waitForMs) || 9000, 0);
  const POLL_MS = 500;

  function textOf(el) {
    return el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function stripHtml(html) {
    return String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  // Tracking parameters off, fragment off: two cards for the same posting
  // through different links must dedupe to one, which is also the form the
  // tracker matches on.
  function cleanUrl(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.href);
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|ref|src|trk|tracking)/i.test(key)) url.searchParams.delete(key);
      }
      return url.toString();
    } catch {
      return "";
    }
  }

  function fromLinkedIn() {
    const cards = document.querySelectorAll(
      "li.jobs-search-results__list-item, .jobs-search-results__list-item, " +
      ".job-card-container, .job-card-list__container li, .jobs-search__results-list-item"
    );
    const out = [];
    for (const card of cards) {
      const link = card.querySelector(
        'a[href*="/jobs/view/"], a.job-card-list__link, a[href*="/jobs/"]'
      );
      const titleEl = card.querySelector(
        ".job-card-list__title, .artdeco-base-card__title, h3, h3.base-search-card__title"
      );
      const title = textOf(titleEl) || textOf(link);
      const url = cleanUrl(link && link.getAttribute("href"));
      if (!title || !url) continue;
      out.push({
        url,
        title,
        company: textOf(
          card.querySelector(
            ".job-card-container__company-name, .artdeco-base-card__subtitle, .job-card-container__primary-description"
          )
        ),
        location: textOf(
          card.querySelector(
            ".job-card-container__metadata-item, .artdeco-base-card__flak, .job-search-card__location"
          )
        ),
        snippet: ""
      });
    }
    return out;
  }

  function jsonLdItems() {
    const out = [];
    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (const block of blocks) {
      let parsed;
      try {
        parsed = JSON.parse(block.textContent || "");
      } catch {
        continue; // one malformed block must not sink the others
      }
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed["@graph"])
          ? parsed["@graph"]
          : [parsed];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const type = item["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (!types.some((t) => String(t).toLowerCase() === "jobposting")) continue;

        let location = "";
        const loc = item.jobLocation;
        const first = Array.isArray(loc) ? loc[0] : loc;
        const address = first && first.address;
        if (address) {
          location = [address.addressLocality, address.region, address.addressCountry]
            .filter(Boolean)
            .join(", ");
        }

        const org = item.hiringOrganization;
        out.push({
          url: cleanUrl(item.url),
          title: stripHtml(item.title),
          company: stripHtml((org && (org.name || org.legalName)) || ""),
          location,
          snippet: stripHtml(item.description).slice(0, 400)
        });
      }
    }
    return out;
  }

  function fromGenericLinks() {
    const anchors = document.querySelectorAll(
      'h2.jobTitle a[href], a[href*="/job/"], a[href*="/jobs/"], a[href*="career"], a[href*="position"], a.jtJNE'
    );
    const out = [];
    for (const anchor of anchors) {
      const title = textOf(anchor);
      const url = cleanUrl(anchor.getAttribute("href"));
      // Two words minimum: single-word anchors are "Apply", "Details", nav.
      if (!url || !title || title.split(" ").length < 2 || title.length > 160) continue;
      const card = anchor.closest("li, article, .card, .job-card, [data-job-id], div");
      out.push({
        url,
        title,
        company: "",
        location: "",
        snippet: card ? textOf(card).slice(0, 400) : ""
      });
    }
    return out;
  }

  function collect() {
    // Union of all three strategies, deduped by URL, LinkedIn first so its
    // better fields win over the generic link's guess.
    const seen = new Map();
    for (const listing of [...fromLinkedIn(), ...jsonLdItems(), ...fromGenericLinks()]) {
      if (!listing.url || !listing.title) continue;
      const existing = seen.get(listing.url);
      if (existing) {
        if (!existing.company && listing.company) existing.company = listing.company;
        if (!existing.location && listing.location) existing.location = listing.location;
        if (!existing.snippet && listing.snippet) existing.snippet = listing.snippet;
      } else {
        seen.set(listing.url, listing);
      }
    }
    return [...seen.values()].slice(0, MAX_CARDS);
  }

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = collect();
    if (found.length > 0 || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}


// ============================================================
// FILL RESUME BY DROP
// ============================================================
//
// Second route for resume upload, for sites that build their file input on
// demand instead of shipping one — Google Forms being the case that matters.
//
// Clicking its "Add file" button creates the <input type="file"> inside a
// shadow root and opens the OS picker, so fillResumeFile() has nothing to
// assign to and would report "element not found". But a Google Forms file
// question is also a drop target: it renders a "Drop file here" state when a
// file is dragged over it, and handles the file from the DataTransfer carried
// on the drop event.
//
// So this dispatches dragenter/dragover/drop with a DataTransfer holding the
// resume, rather than touching a file input. That needs no extra permission
// and reuses the same base64 -> File conversion fillResumeFile() already does.
//
// Whether the page accepts an untrusted (script-generated) drop is the site's
// decision, so success is never assumed: the result is verified against the
// DOM afterwards and reported honestly either way.
//
// IMPORTANT: self-contained, like every function in this file — it is
// serialized and injected on its own.
// ============================================================

async function fillResumeByDrop(
  uid,
  base64,
  filename,
  mimeType
) {

  const AUTOFILL_ATTR =
    "data-autofill-uid";

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  const trigger = querySelectorDeep(
    `[${AUTOFILL_ATTR}="${uid}"]`
  )[0] || null;

  if (!trigger) {
    return {
      uid,
      ok: false,
      reason: "upload button not found — reload the page and scan again"
    };
  }


  // --------------------------------------------------------
  // BUILD THE FILE
  // --------------------------------------------------------
  //
  let file = null;

  try {
    const byteChars =
      atob(base64);

    const byteNumbers =
      new Array(byteChars.length);

    for (
      let i = 0;
      i < byteChars.length;
      i++
    ) {
      byteNumbers[i] =
        byteChars.charCodeAt(i);
    }

    file = new File(
      [new Uint8Array(byteNumbers)],
      filename,
      { type: mimeType }
    );

  } catch (err) {
    return {
      uid,
      ok: false,
      reason: `could not build the file from the saved PDF (${err.message})`
    };
  }


  // --------------------------------------------------------
  // DID A FILE LAND?
  // --------------------------------------------------------
  //
  // Google shows accepted uploads as children of the question's
  // role="list" container, so its emptiness is the honest signal that the drop
  // was ignored. Checked before and after, because the file list may already
  // hold something from an earlier manual upload.
  //
  const acceptedFiles = () => {
    const question =
      trigger.closest("[role='listitem']") ||
      document;

    const list =
      question.querySelector(
        "[role='list'][aria-label*='elected file']"
      );

    return list
      ? list.children.length
      : 0;
  };

  const filesBefore =
    acceptedFiles();


  // --------------------------------------------------------
  // DISPATCH THE DRAG SEQUENCE
  // --------------------------------------------------------
  //
  // dragenter and dragover must fire before drop: a drop handler that toggles
  // its "Drop file here" state on dragover will otherwise ignore a drop event
  // it never saw it enable.
  //
// Dispatched once, from the innermost element inside the upload question. Drag
  // events bubble, so a drop on the button travels up through the card and the
  // question and reaches every drop handler in between exactly once.
  //
  // Dispatching to each wrapper in turn instead would re-deliver the same drop
  // to the same listeners, since each wrapper is an ancestor of the last — one
  // resume, several uploads.
  //
  // Each event also needs its own DataTransfer. Drag and drop keeps one
  // transfer per drag session, and that session ends at the drop, so sharing
  // the object across all three leaves dragover with an empty file list — which
  // is exactly what most handlers check before enabling the drop zone.
  //
  const makeTransfer = () => {
    const dt =
      new DataTransfer();

    dt.items.add(file);

    try {
      dt.dropEffect = "copy";
    } catch {
      // Read-only in some contexts; the default still delivers files.
    }

    return dt;
  };

  try {
    for (const type of ["dragenter", "dragover", "drop"]) {
      trigger.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: makeTransfer()
        })
      );
    }
  } catch (err) {
    return {
      uid,
      ok: false,
      reason: `could not dispatch the drop event (${err.message})`
    };
  }


  // --------------------------------------------------------
  // VERIFY
  // --------------------------------------------------------
  //
  // The upload is asynchronous — Google pushes the file to Drive before
  // listing it — so this polls rather than checking once. Reporting "attached"
  // without this is how the extension ends up claiming a resume it never
  // uploaded.
  //
  const DEADLINE_MS = 6000;
  const POLL_MS = 250;

  const deadline =
    Date.now() + DEADLINE_MS;

  while (Date.now() < deadline) {
    await new Promise(
      (resolve) =>
        setTimeout(resolve, POLL_MS)
    );

    if (acceptedFiles() > filesBefore) {
      return {
        uid,
        ok: true,
        method: "drop"
      };
    }
  }


  return {
    uid,
    ok: false,
    reason:
      "the page ignored the simulated drop — click \"Add file\" and choose the file yourself"
  };
}


// ============================================================
// ADVANCE TO THE NEXT STEP
// ============================================================
//
// Clicks the wizard's Next / Continue control, and only that control.
//
// Two rules make this safe enough to put on a button next to Fill:
//
//   1. IT REFUSES WHEN THE FORM IS NOT READY. Every visible control the page
//      itself marks required and still finds empty is reported back by name and
//      nothing is clicked. The user gets "3 required fields are still empty"
//      instead of a step that silently dropped their answers.
//
//   2. IT NEVER CLICKS SUBMIT. "Submit Application" is on the same page, is
//      usually the same shape, and is the one click that cannot be taken back.
//      Advance means "show me the next step"; submitting stays the user's own
//      deliberate act, which is what the panel footer promises. A form on its
//      final step therefore reports "no Next button — this looks like the last
//      step" and leaves the click alone.
//
// Self-contained like every other function here: serialized and injected on its
// own, so it declares its own helpers and reads its site-specific selectors from
// the adapter config it is handed.
//
// Async because the wait for the new step is a real wait, not a spin. A busy
// loop would hold the main thread and stop the render it is waiting for — the
// exact opposite of the intent. chrome.scripting.executeScript awaits a promise
// returned from an injected function, so this resolves to the panel unchanged;
// waitForOptions() inside fillFormFields already relies on that.
async function advanceStep(platformConfig = {}, options = {}) {
  const ADVANCE_WAIT_MS = 4000;
  const ADVANCE_POLL_MS = 150;

  // Every match for `selector` in the light DOM and inside open shadow roots,
  // recursively. SmartRecruiters keeps its form fields in multi-layered shadow
  // DOM — one custom element inside another — where document.querySelectorAll
  // sees nothing, and a plain "0 fields found" is the result. Self-contained,
  // like every function in this file: each injected entry point carries its
  // own copy (functions are serialized one at a time), and tests/verify-frames.js
  // asserts they stay byte-identical.
  function querySelectorDeep(selector) {
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll(selector)) found.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  // Labels that mean "go to the next step". Anchored so that "Next" matches but
  // "Next of kin" and "Continue shopping" do not, and matched against the whole
  // trimmed label because these buttons carry an arrow glyph or a count.
  const ADVANCE_PATTERN =
    /^(next|next step|next page|continue|continue to next step|proceed|save\s*(and|&)\s*continue|save and proceed|review|review and continue|review your application|step\s*\d+\s*of\s*\d+\s*next)$/i;

  // Labels that END the application. Clicked exactly like an advance control —
  // this function does not treat a submit as a different, more dangerous kind of
  // button.
  //
  // That is a deliberate reversal of an earlier version of this code, which
  // matched submit labels only in order to refuse them. The refusal was defensible
  // in isolation and wrong in practice: a wizard's last step has no Next button,
  // so refusing there meant the user still had to reach for the mouse on precisely
  // the one click that matters most, while every earlier step was automated. That
  // is the worst possible place to reintroduce a manual step.
  //
  // What actually keeps this safe is not the label of the button but the state of
  // the form: the required-field check below refuses while anything mandatory is
  // empty, and the page's own disabled state is trusted over anything derived
  // here. A user who can see a filled, valid, reviewed step has already done the
  // part that needs a human.
  //
  const SUBMIT_PATTERN =
    /^(submit|submit application|submit resume|submit my application|finish|finish application|complete( your)? application|send application|send my application|send resume|attest|attest and submit|submit application now)$/i;

  // Both kinds, tested together, so "is this a button that advances this
  // application" is one question with one answer at every call site.
  const isAdvanceish = (label) =>
    ADVANCE_PATTERN.test(label) || SUBMIT_PATTERN.test(label);

  // Everything the page is willing to treat as its primary action, in the shapes
  // that shape takes in practice.
  const CANDIDATE_SELECTOR = [
    "button",
    "input[type=submit]",
    "input[type=button]",
    "input[type=image]",
    "a[href]",
    "[role=button]"
  ].join(",");

  // Controls the page itself has declared mandatory. aria-required is included
  // because the ARIA-based widgets (Workday's, Google Forms') carry no `required`
  // attribute at all — on those a `[required]`-only check reports a fully valid
  // step as ready.
  const REQUIRED_SELECTOR = [
    "input[required]",
    "select[required]",
    "textarea[required]",
    "[aria-required=true]"
  ].join(",");


  function isVisible(el) {
    // Layout visibility ONLY. Whether the control is disabled is a separate
    // question, answered by isEnabled() below.
    //
    // Folding `disabled` in here is the mistake this shape invites: a wizard that
    // has disabled its own Next button is reporting its validation verdict, which
    // is the single most useful thing this function could learn. Treating a
    // disabled button as invisible throws that away and reports "no Next button
    // found", which on a half-filled step is both wrong and unactionable.
    if (!el) return false;
    if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }


  function isEnabled(el) {
    return !!(
      el &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true"
    );
  }


  function textOf(el) {
    const raw =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        ? el.value || ""
        : el.textContent || el.value || "";
    return String(raw).replace(/\s+/g, " ").trim();
  }


  // The question a control is answering, for reporting. Walks the same short list
  // the scanner does, without the adapter's rescue passes — a blocker that cannot
  // be named is reported by its name/id instead, which is still actionable.
  function describe(el) {
    const direct =
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      el.id ||
      "";

    if (direct) return direct;

    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) {
        const t = String(label.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
    }

    const wrapper = el.closest("label");
    if (wrapper) {
      const t = String(wrapper.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }

    const placeholder = el.getAttribute("placeholder");
    return placeholder || "(unlabelled)";
  }


  // --------------------------------------------------------
  // IS A CONTROL ACTUALLY UNANSWERED?
  // --------------------------------------------------------
  //
  // Presence of `required` is not the same as emptiness, and the two disagree in
  // ways that matter here:
  //
  //   - A required checkbox that is ticked is satisfied. Treating it as empty is
  //     what makes a wizard look permanently blocked once you tick the consent.
  //   - A required radio group is satisfied when ANY member is checked, and each
  //     member is individually marked required by several frameworks. Testing
  //     them one at a time therefore reports a group the user already answered as
  //     outstanding, forever.
  //   - A control the page hides is not something the user can act on, so it
  //     cannot be the thing that is stopping them.
  //
  function isUnanswered(el) {
    const role = el.getAttribute("role");

    if (role === "checkbox") {
      return el.getAttribute("aria-checked") !== "true";
    }

    const type = (el.type || "").toLowerCase();

    // A radio group — ARIA or native — is satisfied when ANY member is checked.
    //
    // Both shapes have to go through the group test, because every framework that
    // marks radio inputs required marks every member of the group, and testing
    // them one at a time then reports a question the user already answered as
    // permanently outstanding. For ARIA that check lives on aria-checked; for
    // native radios it is the `checked` property.
    if (role === "radio" || type === "radio") {
      const name = el.getAttribute("name");

      // No name means no group to consult, so the best evidence is this member.
      if (!name) {
        return role === "radio"
          ? el.getAttribute("aria-checked") !== "true"
          : !el.checked;
      }

      const group = document.querySelectorAll(
        `input[type=radio][name="${name}"], [role=radio][name="${name}"]`
      );

      for (const member of group) {
        const checked =
          member.tagName === "INPUT" && (member.type || "").toLowerCase() === "radio"
            ? member.checked
            : member.getAttribute("aria-checked") === "true";
        if (checked) return false;
      }

      // The group query found nothing (a control with a name but no siblings,
      // which a framework can produce for a single-option question): fall back to
      // this element rather than reporting a blocker nothing can clear.
      if (!group.length) {
        return role === "radio"
          ? el.getAttribute("aria-checked") !== "true"
          : !el.checked;
      }

      return true;
    }

    if (type === "checkbox") return !el.checked;

    if (type === "file") {
      // A required file input the extension attached is satisfied; one it could
      // not attach is not. Either way the value tells us.
      return !el.files || el.files.length === 0;
    }

    return String(el.value == null ? "" : el.value).trim() === "";
  }


  // --------------------------------------------------------
  // BLOCKERS
  // --------------------------------------------------------
  //
  const blockers = [];

  for (const el of document.querySelectorAll(REQUIRED_SELECTOR)) {
    if (!isVisible(el)) continue;

    // A hidden control that is nonetheless marked required is the page's own
    // bookkeeping (a collapsed section, a step behind us). It is not something
    // the user can see or fix, so it must not block the step they are on.
    if (isUnanswered(el)) {
      blockers.push(describe(el));
    }
  }


  // The buttons the panel knows are still outstanding — fields this extension
  // could not fill, and fields it deliberately left alone (consent checkboxes).
  // Passed in from the panel rather than re-derived here, because the page has no
  // idea which fields the panel tried and gave up on.
  //
  // Not a blocker on its own when the page considers the step complete, though:
  // a form is allowed to have optional questions it will not complain about. So
  // these are reported alongside the required ones and only stop the click when
  // the page itself also says the step is incomplete. See `buttonBlocked` below.
  const outstandingCount = Number(options.outstandingCount || 0);
  if (outstandingCount > 0) {
    for (const uid of Array.isArray(options.outstandingUids) ? options.outstandingUids : []) {
      const el = querySelectorDeep(
        `[data-autofill-uid="${String(uid).replace(/["\\]/g, "\\$&")}"]`
      )[0] || null;
      if (el && isVisible(el)) {
        blockers.push(`${describe(el)} (not filled)`);
      }
    }
  }


  // --------------------------------------------------------
  // FIND THE ADVANCE CONTROL
  // --------------------------------------------------------
  //
  // An adapter may name the control outright, and that wins over every heuristic
  // below — a per-site selector is the only thing reliable enough to beat text
  // matching, and this is the one behaviour a vendor's markup can break without
  // anyone noticing.
  //
  const explicit = platformConfig && platformConfig.advanceButton;

  // Disabled controls are returned, not skipped — see isVisible(). The reason is
  // that a disabled Next is the page telling us the step is incomplete, and that
  // is worth reporting rather than hiding behind "no button found".
  //
  // `usable` exists for the one case where it would be unsafe to act on what we
  // found: the click path must never click a control the page has disabled, so it
  // asks for the usable-only view and treats an empty result as "nothing to click".
  const findAdvanceButton = (usableOnly) => {
    if (typeof explicit === "string" && explicit.trim()) {
      const found = document.querySelectorAll(explicit);
      for (const candidate of found) {
        if (!isVisible(candidate)) continue;
        if (usableOnly && !isEnabled(candidate)) continue;
        return { candidate, label: textOf(candidate) || explicit };
      }
    }

    const candidates = [];

    for (const candidate of document.querySelectorAll(CANDIDATE_SELECTOR)) {
      if (!isVisible(candidate)) continue;

      const label = textOf(candidate);
      if (!label) continue;

      if (!isAdvanceish(label)) continue;

      // Prefer an enabled control when the page ships both — a stale hidden copy
      // of "Next" alongside the live one is common on wizard pages that cache
      // their footer.
      const enabled = isEnabled(candidate);
      if (usableOnly && !enabled) continue;

      candidates.push({ candidate, label, enabled });
    }

    if (!candidates.length) return null;

    const usable = candidates.filter((c) => c.enabled);
    const pool = usable.length ? usable : candidates;

    // Last match wins. On a wizard the primary action sits at the end of the
    // footer, and a "Back"-to-advance pair rendered as siblings puts the
    // forward control second. Taking the first would click Back often enough to
    // matter.
    return pool[pool.length - 1];
  };


  // --------------------------------------------------------
  // DRY RUN
  // --------------------------------------------------------
  //
  // Reports whether the step could be advanced without clicking anything, so the
  // panel can grey its Next button out while a required field is still empty.
  //
  // Asked on every row change and after every fill, so it has to cost nothing and
  // change nothing: no event dispatched, no attribute touched, no waiting. That
  // is also why the blockers are collected before this returns rather than only
  // when a click is coming — the panel needs the names to highlight, and doing it
  // twice would double the work on the path that matters.
  //
  if (options.dryRun) {
    const found = findAdvanceButton(false);

    if (!found) {
      return {
        ready: false,
        reason:
          "No Next, Continue or Submit button found on this page."
      };
    }

    if (!isEnabled(found.candidate)) {
      return {
        ready: false,
        blocked: true,
        label: found.label,
        isSubmit: SUBMIT_PATTERN.test(found.label),
        blockers,
        reason: blockers.length
          ? `The page has disabled "${found.label}" — ${blockers.length} required field${blockers.length === 1 ? " is" : "s are"} still empty.`
          : `The page has disabled "${found.label}", so the step is not complete yet.`
      };
    }

    if (blockers.length) {
      return {
        ready: false,
        blocked: true,
        label: found.label,
        isSubmit: SUBMIT_PATTERN.test(found.label),
        blockers,
        reason: `${blockers.length} required field${blockers.length === 1 ? "" : "s"} still empty.`
      };
    }

    return {
      ready: true,
      label: found.label,
      // Reported so the panel can warn before an irreversible click. See the
      // SUBMIT_PATTERN comment: submit is no longer refused, only announced.
      isSubmit: SUBMIT_PATTERN.test(found.label)
    };
  }


  const found = findAdvanceButton(true);
  const button = found ? found.candidate : null;
  const matchedLabel = found ? found.label : "";


  // A submit control was found but never an advance control: this is the last
  // step. Said plainly, because "no Next button found" on the final step of a
  // wizard reads like a bug in the extension rather than a job well done.
  //
  if (!button) {
    return {
      ok: false,
      advanced: false,
      reason:
        "Could not find a Next, Continue or Submit button on this page. Click it yourself."
    };
  }


  // --------------------------------------------------------
  // REFUSE WHILE THE PAGE SAYS IT IS NOT READY
  // --------------------------------------------------------
  //
  // The guard on an irreversible click is the state of the form, never the name
  // of the button. A form with a required field still empty does not advance and
  // does not submit, whatever its forward control happens to say — and that
  // includes the case where the page has disabled its own button, which is its
  // own validation verdict and better evidence than anything derived here.
  //
  // Consent checkboxes are deliberately NOT counted as blockers. They are never
  // filled on the user's behalf (see isConsentCheckboxItem in fillFormFields), so
  // counting them here would mean a form with a mandatory privacy checkbox could
  // never be advanced at all. The page's own disabled state is the honest signal
  // that one is still needed.
  //
  if (blockers.length && !options.force) {
    return {
      ok: false,
      advanced: false,
      blocked: true,
      label: matchedLabel,
      isSubmit: SUBMIT_PATTERN.test(matchedLabel),
      blockers,
      reason: `Not advancing — ${blockers.length} field${blockers.length === 1 ? "" : "s"} still need${blockers.length === 1 ? "s" : ""} an answer. They are highlighted on the page.`
    };
  }


  // --------------------------------------------------------
  // CLICK IT
  // --------------------------------------------------------
  //
  // The full trusted-looking pointer sequence rather than el.click(), because
  // these wizards frequently gate the transition on the event being a real one
  // and silently ignore a bare synthetic click — the button flashes and nothing
  // happens, which reads as "the extension didn't work". Same reasoning as
  // humanClick() inside fillFormFields.
  //
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1
  };

  ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {
    button.dispatchEvent(new MouseEvent(type, base));
  });

  button.click();


  // --------------------------------------------------------
  // WAIT FOR THE STEP TO ACTUALLY CHANGE
  // --------------------------------------------------------
  //
  // A click that lands on a wizard that then refuses still looks exactly like
  // success at the instant it happens. Polling a cheap signature of "this page
  // is different now" — the URL, the title, how many form controls the scanner
  // last stamped, and whether the button is still there saying the same thing —
  // is what lets the panel say "moved on" honestly instead of claiming progress
  // that did not happen.
  //
  // Polled rather than a fixed sleep: most steps swap in ~100ms, and the panel
  // re-scans the moment this returns.
  //
  const signature = () =>
    [
      location.href,
      document.title,
      querySelectorDeep("[data-autofill-uid]").length,
      isVisible(button) ? textOf(button) : ""
    ].join("|");

  const before = signature();

  let changed = false;

  if (options.waitForChange !== false) {
    // A submit gets a longer budget than a step change. Advancing swaps a form
    // section in place in ~100ms, but submitting uploads a file, runs the
    // employer's own validation and often redirects to a confirmation page —
    // seconds, not milliseconds. Cutting that short would report the application
    // as "did not move" at exactly the moment it succeeded.
    const budget = SUBMIT_PATTERN.test(matchedLabel)
      ? ADVANCE_WAIT_MS * 3
      : ADVANCE_WAIT_MS;

    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (signature() !== before) {
        changed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ADVANCE_POLL_MS));
    }
  }

  const wasSubmit = SUBMIT_PATTERN.test(matchedLabel);

  return {
    ok: true,
    advanced: true,
    label: matchedLabel,
    isSubmit: wasSubmit,
    // False means the click was delivered but the page did not move. Reported
    // rather than assumed, because the user's next action depends on it.
    changed,
    blockers,
    reason: changed
      ? undefined
      : wasSubmit
        ? `Clicked "${matchedLabel}", but the page did not change. It may still be uploading — give it a moment and check before clicking again.`
        : `Clicked "${matchedLabel}", but the page did not move. It may have rejected the step — check the highlighted fields.`
  };
}
