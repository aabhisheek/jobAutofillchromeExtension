// Functions injected into the target page via chrome.scripting.executeScript.
// They must be fully self-contained (no references to outer closures) because
// their source is serialized and re-run inside the page's own JS context.

function scanFormFields() {
  const AUTOFILL_ATTR = "data-autofill-uid";
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset"]);
  // Duplicated from matcher.js's RESUME_UPLOAD_KEYWORDS rather than shared —
  // this function is serialized and re-run in the page's own JS context, so
  // it can't reference anything outside itself (see file header comment).
  const RESUME_UPLOAD_KEYWORDS = ["resume", "cv", "curriculum vitae"];

  function isVisible(el) {
    if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function textOf(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Custom dropdown widgets (react-select and similar — very common on
  // Greenhouse, Workday, Ashby, etc.) are usually a plain text-like <input>
  // under the hood, not a real <select>, so they'd otherwise be
  // indistinguishable from a genuine free-text field: same tag, same type
  // ("text"), same everything. That matters because a constrained-choice
  // dropdown can't be answered with typed free text (there is no "type your
  // own answer" option), so it must never be treated as a draft candidate
  // the way a real free-text field is. Detect it via the ARIA combobox
  // pattern these widgets use for accessibility regardless of framework.
  function isComboboxLike(el) {
    if (el.getAttribute("role") === "combobox") return true;
    if (el.getAttribute("aria-autocomplete")) return true;
    if (el.getAttribute("aria-haspopup") === "listbox") return true;
    const comboboxAncestor = el.closest('[role="combobox"]');
    return !!(comboboxAncestor && comboboxAncestor !== el);
  }

  function labelForElement(el) {
    // 1. <label for="id">
    if (el.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit) return textOf(explicit);
    }
    // 2. aria-label
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    // 3. aria-labelledby
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map(textOf);
      if (parts.length) return parts.join(" ");
    }
    // 3b. "<id>-label" convention (react-select and similar widgets set this
    // before wiring up aria-labelledby; catches the label during the gap).
    if (el.id) {
      const byConvention = document.getElementById(`${el.id}-label`);
      if (byConvention) {
        const t = textOf(byConvention);
        if (t) return t;
      }
    }
    // 4. wrapping <label>
    const ancestorLabel = el.closest("label");
    if (ancestorLabel) return textOf(ancestorLabel).replace(textOf(el), "").trim();
    // 5. placeholder
    if (el.placeholder) return el.placeholder.trim();
    // 6. heuristic: nearest preceding text within a shared container (Workday-style
    // div-wrapped fields where the "label" is just a sibling div, not a <label>).
    let container = el.parentElement;
    for (let depth = 0; depth < 4 && container; depth++) {
      const candidates = Array.from(container.querySelectorAll("label, [class*='label' i], legend"));
      for (const c of candidates) {
        const t = textOf(c);
        if (t && t.length < 150) return t;
      }
      container = container.parentElement;
    }
    return "";
  }

  const results = [];
  let counter = 0;

  // Text-like inputs, textareas, selects.
  const simpleEls = document.querySelectorAll("input, textarea, select");
  const seenRadioGroups = new Set();

  simpleEls.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();

    if (tag === "input" && SKIP_TYPES.has(type)) return;

    // File inputs: only surface ones that look like a resume/CV upload —
    // there's exactly one PDF stored for autofill, so unrelated uploads
    // (cover letter, transcript, portfolio) would just be dead rows.
    // Deliberately skips the isVisible() check that applies to every other
    // field type below: real ATS platforms (Greenhouse, Lever, Workday,
    // Ashby) almost always hide the native file input (display:none or
    // 0x0) behind a styled dropzone/button that calls .click() on it.
    // fillResumeFile sets .files directly via DataTransfer instead of
    // clicking through that UI, so the input being hidden doesn't stop us
    // from using it — but it would stop us from ever finding it here.
    // el.isConnected still filters out genuinely detached/template nodes.
    if (tag === "input" && type === "file") {
      if (!el.isConnected) return;
      const label = labelForElement(el);
      const isResumeField = RESUME_UPLOAD_KEYWORDS.some((kw) => label.toLowerCase().includes(kw));
      if (!isResumeField) return;

      const uid = `af-${counter++}`;
      el.setAttribute(AUTOFILL_ATTR, uid);
      results.push({ uid, label, tagName: tag, inputType: type, options: [] });
      return;
    }

    if (!isVisible(el)) return;

    if (tag === "input" && type === "radio" && el.name) {
      // Radios sharing a name are always one question with mutually
      // exclusive choices — always group them.
      const groupKey = `radio:${el.name}`;
      if (seenRadioGroups.has(groupKey)) return;
      seenRadioGroups.add(groupKey);

      const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)).filter(isVisible);
      const uid = `af-${counter++}`;
      group.forEach((g) => g.setAttribute(AUTOFILL_ATTR, uid));

      const fieldset = el.closest("fieldset");
      const groupLabel = fieldset ? textOf(fieldset.querySelector("legend")) : "";

      results.push({
        uid,
        label: groupLabel || labelForElement(el) || el.name,
        tagName: "radiogroup",
        inputType: type,
        options: group.map((g) => ({
          value: g.value,
          text: labelForElement(g) || g.value
        }))
      });
      return;
    }

    // Checkboxes sharing a name are only grouped when they look like a real
    // multi-select option set (2+ checkboxes, each with its own explicit
    // value). Checkboxes that share a generic name but were never given
    // distinct values (the unset default is "on" for all of them) are
    // typically unrelated standalone consent/agreement boxes — e.g. two
    // different checkboxes both named "agree" ("I agree to marketing
    // emails" / "I agree to the background check authorization"). Grouping
    // those by name would silently merge them into one row and bury the
    // second checkbox's text inside another row's options list instead of
    // surfacing it as its own item.
    if (tag === "input" && type === "checkbox" && el.name) {
      const sameNameGroup = Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`)).filter(isVisible);
      const isRealOptionSet = sameNameGroup.length > 1 && sameNameGroup.every((g) => g.hasAttribute("value") && g.value !== "" && g.value !== "on");

      if (isRealOptionSet) {
        const groupKey = `checkbox:${el.name}`;
        if (seenRadioGroups.has(groupKey)) return;
        seenRadioGroups.add(groupKey);

        const uid = `af-${counter++}`;
        sameNameGroup.forEach((g) => g.setAttribute(AUTOFILL_ATTR, uid));

        const fieldset = el.closest("fieldset");
        const groupLabel = fieldset ? textOf(fieldset.querySelector("legend")) : "";

        results.push({
          uid,
          label: groupLabel || labelForElement(el) || el.name,
          tagName: "radiogroup",
          inputType: type,
          options: sameNameGroup.map((g) => ({
            value: g.value,
            text: labelForElement(g) || g.value
          }))
        });
        return;
      }
      // Not a real option set — fall through and treat this checkbox as its
      // own standalone row, same as a checkbox with no name at all.
    }

    const uid = `af-${counter++}`;
    el.setAttribute(AUTOFILL_ATTR, uid);

    let options = [];
    if (tag === "select") {
      options = Array.from(el.options).map((o) => ({ value: o.value, text: textOf(o) }));
    }

    let resolvedInputType = tag === "select" ? "select" : type;
    if (tag === "input" && resolvedInputType === "text" && isComboboxLike(el)) {
      resolvedInputType = "combobox";
    }

    results.push({
      uid,
      label: labelForElement(el),
      tagName: tag,
      inputType: resolvedInputType,
      options
    });
  });

  return results;
}

// payload: array of { uid, value, tagName, inputType }
function fillFormFields(payload) {
  const AUTOFILL_ATTR = "data-autofill-uid";

  function nativeSetValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setChecked(el, checked) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    setter.call(el, checked);
    el.dispatchEvent(new Event("click", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const report = [];

  payload.forEach((item) => {
    if (!item.value) {
      report.push({ uid: item.uid, ok: false, reason: "empty value" });
      return;
    }

    if (item.tagName === "radiogroup") {
      const group = Array.from(document.querySelectorAll(`[${AUTOFILL_ATTR}="${item.uid}"]`));
      const target = group.find(
        (g) => g.value.toLowerCase() === item.value.toLowerCase() || (g.nextSibling?.textContent || "").toLowerCase().includes(item.value.toLowerCase())
      );
      if (target) {
        setChecked(target, true);
        report.push({ uid: item.uid, ok: true });
      } else {
        report.push({ uid: item.uid, ok: false, reason: "no matching option" });
      }
      return;
    }

    const el = document.querySelector(`[${AUTOFILL_ATTR}="${item.uid}"]`);
    if (!el) {
      report.push({ uid: item.uid, ok: false, reason: "element not found" });
      return;
    }

    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(
        (o) => o.textContent.trim().toLowerCase() === item.value.toLowerCase() || o.textContent.trim().toLowerCase().includes(item.value.toLowerCase())
      );
      if (opt) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
        setter.call(el, opt.value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        report.push({ uid: item.uid, ok: true });
      } else {
        report.push({ uid: item.uid, ok: false, reason: "no matching option" });
      }
      return;
    }

    if (el.tagName === "INPUT" && (el.type === "checkbox")) {
      setChecked(el, true);
      report.push({ uid: item.uid, ok: true });
      return;
    }

    nativeSetValue(el, item.value);
    report.push({ uid: item.uid, ok: true });
  });

  return report;
}

// Attaches a stored PDF (base64) to a resume-upload <input type="file">
// field found by scanFormFields. Constructs a real File from bytes we
// already have and assigns it via DataTransfer — the standard way to set
// input.files programmatically (browsers only block reading arbitrary local
// paths, not injecting File data the caller already possesses). May not
// work on upload widgets that hide the native input behind drag-and-drop-only
// JS — in that case the field won't visibly update and this reports ok:false
// isn't guaranteed, so always re-check the page before submitting.
function fillResumeFile(uid, base64, filename, mimeType) {
  const AUTOFILL_ATTR = "data-autofill-uid";
  const el = document.querySelector(`[${AUTOFILL_ATTR}="${uid}"]`);
  if (!el) return { uid, ok: false, reason: "element not found" };

  try {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const file = new File([new Uint8Array(byteNumbers)], filename, { type: mimeType });

    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { uid, ok: true };
  } catch (err) {
    return { uid, ok: false, reason: err.message };
  }
}

// Best-effort extraction of the job description text from the current page,
// so "Tailor Resume" doesn't require copy-pasting the JD by hand. Tries three
// tiers, most trustworthy first, and reports which one it used so the user
// can judge how much to double-check:
//   1. JSON-LD structured data (schema.org JobPosting) — many ATS/job boards
//      embed this for SEO even when the visible page is a JS-rendered SPA,
//      so it's often available and correct even before/without hydration.
//   2. A curated list of container selectors from common ATS platforms
//      (Greenhouse, Lever, Workday, LinkedIn, iCIMS, SmartRecruiters, etc).
//   3. Generic fallback: the largest visible text block on the page, after
//      excluding obvious chrome (nav/header/footer/aside/script/style).
// Never guaranteed correct — this only feeds the JD textarea, which the user
// can review/edit before analyzing, same as if they'd pasted it themselves.
function scanJobDescription() {
  const MIN_LENGTH = 200;
  const MAX_LENGTH = 20000;

  function clean(text) {
    return (text || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body ? doc.body.textContent : "";
  }

  function fromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const items = Array.isArray(data) ? data : Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (types.includes("JobPosting") && typeof item.description === "string" && item.description.trim()) {
          return stripHtml(item.description);
        }
      }
    }
    return "";
  }

  // Ordered by how common/reliable the platform's markup is. Generic
  // itemprop="description" (schema.org microdata, older-style boards) and
  // <article>/<main> land last as broad catch-alls.
  const ATS_SELECTORS = [
    "#job-details", // LinkedIn
    ".jobs-description__content", // LinkedIn
    ".jobs-box__html-content", // LinkedIn
    ".job__description", // Greenhouse
    "#content .job__description", // Greenhouse
    "[data-automation-id='jobPostingDescription']", // Workday
    ".posting-requirements", // Lever
    "[data-qa='job-description']", // Lever (some boards)
    ".iCIMS_JobContent", // iCIMS
    ".job-sections", // SmartRecruiters
    "[itemprop='description']",
    "article",
    "main"
  ];

  function fromKnownSelectors() {
    for (const selector of ATS_SELECTORS) {
      let el;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el) continue;
      const text = clean(el.innerText || el.textContent || "");
      if (text.length >= MIN_LENGTH) return text;
    }
    return "";
  }

  function fromLargestBlock() {
    const EXCLUDE_TAGS = new Set(["SCRIPT", "STYLE", "NAV", "HEADER", "FOOTER", "ASIDE", "SVG", "NOSCRIPT"]);
    const candidates = document.querySelectorAll("div, section, article, main");
    let best = "";
    candidates.forEach((el) => {
      if (EXCLUDE_TAGS.has(el.tagName)) return;
      if (el.closest("nav, header, footer, aside")) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      // Skip containers whose text is mostly duplicated from a bigger child
      // (avoids picking html/body/a top-level wrapper instead of the real
      // content block) by requiring this element's OWN direct text to be a
      // meaningful share of its total text.
      const text = clean(el.innerText || "");
      if (text.length > best.length) best = text;
    });
    return best;
  }

  function finalize(text, source) {
    const truncated = text.length > MAX_LENGTH;
    return { text: truncated ? text.slice(0, MAX_LENGTH) : text, source, truncated };
  }

  // Each tier gets exactly one shot, in order of trustworthiness, and an
  // early return the moment one clears its own bar — a tier's result is
  // never re-checked against a later (stricter) tier's threshold. JSON-LD is
  // structured, purpose-built data, not a heuristic guess, so it's held to a
  // much lower bar (just enough to rule out an empty/placeholder
  // description) than the tiers that are actually guessing at page
  // structure — otherwise a short-but-genuine JD would get thrown away in
  // favor of a worse guess.
  const JSON_LD_MIN_LENGTH = 40;

  const jsonLdText = fromJsonLd();
  if (jsonLdText && jsonLdText.length >= JSON_LD_MIN_LENGTH) {
    return finalize(jsonLdText, "structured data (JobPosting)");
  }

  const selectorText = fromKnownSelectors();
  if (selectorText && selectorText.length >= MIN_LENGTH) {
    return finalize(selectorText, "known ATS layout");
  }

  const fallbackText = fromLargestBlock();
  if (fallbackText) {
    return finalize(fallbackText, "best-guess (largest text block on the page)");
  }

  return { text: "", source: "not found", truncated: false };
}
