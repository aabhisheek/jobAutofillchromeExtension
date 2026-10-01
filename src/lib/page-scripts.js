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

function scanFormFields() {

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
      el.textContent || ""
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
  function labelForElement(el) {


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
      const explicit = document.querySelector(
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
      return el.getAttribute("aria-label").trim();
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
        .map((id) => document.getElementById(id))

        // Remove IDs that did not match an element.
        .filter(Boolean)

        // Extract the text from each matched element.
        .map(textOf);c


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
      const byConvention = document.getElementById(
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
    let container = el.parentElement;


    // Search up to 4 levels of parent containers.
    for (
      let depth = 0;
      depth < 4 && container;
      depth++
    ) {

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
          "label, [class*='label' i], legend"
        )
      );


      // Check every possible label.
      for (const c of candidates) {

        // Extract and normalize its text.
        const t = textOf(c);


        // Ignore empty labels and extremely long text.
        //
        // A real field label should normally be relatively short.
        //
        if (t && t.length < 150) {
          return t;
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


    // Nothing worked.
    return "";
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
  const simpleEls = document.querySelectorAll(
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
      const label = labelForElement(el);


      // Check whether the label looks like a resume/CV field.
      //
      // For example:
      //
      // "Upload Resume"
      // "CV"
      // "Curriculum Vitae"
      //
      const isResumeField =
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
        document.querySelectorAll(
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
        document.querySelectorAll(
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


  // Return every field discovered on the page.
  return results;
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
// ============================================================

function fillFormFields(payload) {

  // Same attribute used by scanFormFields().
  const AUTOFILL_ATTR = "data-autofill-uid";


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

    // Get the native "checked" setter.
    const setter =
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "checked"
      ).set;


    // Set checked state.
    setter.call(el, checked);


    // Fire events so the page/framework knows that the state changed.
    el.dispatchEvent(
      new Event("click", {
        bubbles: true
      })
    );


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
  const report = [];


  // Process every requested field.
  payload.forEach((item) => {

    // Don't attempt to fill empty values.
    if (!item.value) {
      report.push({
        uid: item.uid,
        ok: false,
        reason: "empty value"
      });

      return;
    }


    // ========================================================
    // RADIO/CHECKBOX GROUP
    // ========================================================
    //
    // Grouped choices have tagName "radiogroup".
    //
    if (item.tagName === "radiogroup") {

      // Find every element belonging to this group.
      const group = Array.from(
        document.querySelectorAll(
          `[${AUTOFILL_ATTR}="${item.uid}"]`
        )
      );


      // Find the option whose:
      //
      // 1. value exactly matches the requested value
      //
      // OR
      //
      // 2. text next to the element contains the requested value
      //
      const target = group.find(
        (g) =>
          g.value
            .toLowerCase() ===
            item.value
              .toLowerCase()
          ||
          (
            g.nextSibling?.textContent || ""
          )
            .toLowerCase()
            .includes(
              item.value.toLowerCase()
            )
      );


      // If a matching option was found...
      if (target) {

        // Check/select it.
        setChecked(
          target,
          true
        );


        // Report success.
        report.push({
          uid: item.uid,
          ok: true
        });

      } else {

        // No matching option.
        report.push({
          uid: item.uid,
          ok: false,
          reason: "no matching option"
        });
      }


      // Group processing complete.
      return;
    }


    // ========================================================
    // FIND NORMAL ELEMENT
    // ========================================================
    //
    // Search the page using the UID created by scanFormFields().
    //
    const el = document.querySelector(
      `[${AUTOFILL_ATTR}="${item.uid}"]`
    );


    // Element disappeared or could not be found.
    if (!el) {

      report.push({
        uid: item.uid,
        ok: false,
        reason: "element not found"
      });

      return;
    }


    // ========================================================
    // SELECT
    // ========================================================
    //
    // For <select>, we don't directly use the supplied value.
    // Instead, we try to find the matching option text.
    //
    if (el.tagName === "SELECT") {

      const opt = Array.from(
        el.options
      ).find(
        (o) =>
          o.textContent
            .trim()
            .toLowerCase() ===
            item.value.toLowerCase()
          ||
          o.textContent
            .trim()
            .toLowerCase()
            .includes(
              item.value.toLowerCase()
            )
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


      return;
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

      setChecked(
        el,
        true
      );


      report.push({
        uid: item.uid,
        ok: true
      });


      return;
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
  });


  // Return the complete fill report.
  return report;
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


  // Find the file input by its generated UID.
  const el = document.querySelector(
    `[${AUTOFILL_ATTR}="${uid}"]`
  );


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