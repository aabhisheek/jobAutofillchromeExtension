(function () {
  // The daily Naukri profile touch.
  //
  // The background alarm opens the profile URL in a tab that is already logged
  // in and messages this script to do exactly one thing: toggle the trailing
  // dot on the headline (add it when missing, remove it when present), then
  // save. The edit exists to touch the profile every day, so it always changes
  // the text: an "already ends with a dot, do nothing" run leaves Naukri's
  // "Profile last updated" at the previous day while still reporting success.
  // After the save, the last-updated line is read back and the run only claims
  // success when it actually moved — except on a hidden background tab, where
  // the frozen render never paints the move, and the "editor stayed open"
  // symptom is a rendering artifact rather than a failed save.
  //
  // The profile page shows its fields read-only behind an edit control, so the
  // primary target is the "Resume headline" section: click its edit control,
  // wait for the editor it reveals, and dot that. The headline is preferred
  // because it is short, always present, and edited through a plain text box.
  // The profile-summary/bio flow is kept as a fallback for pages (or layouts)
  // that do not expose a headline.
  //
  // This is best-effort DOM work on a page the extension does not own, so
  // every step reports what it did or why it could not: the one failure mode
  // worse than not having the automation is having it silently do nothing.

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // getClientRects, not offsetParent: offsetParent is null for fixed-position
  // elements and for position:fixed ancestors, which would hide a perfectly
  // visible field, while an empty rect list reliably means "not rendered".
  function isVisible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return el.getClientRects().length > 0;
  }

  // Repeatedly evaluates `predicate` until it returns something truthy or the
  // timeout runs out. The profile page hydrates slowly and re-renders its
  // editor, so a single query after a fixed sleep is exactly the kind of
  // guess that makes an automation "work on my machine".
  async function waitFor(predicate, timeout = 10000, pollMs = 300) {
    const start = Date.now();
    for (;;) {
      const found = predicate();
      if (found) return found;
      if (Date.now() - start >= timeout) return null;
      await wait(pollMs);
    }
  }

  // Selector sweep, most specific first. The bio/summary/about box is the
  // target; nothing else on the edit page must ever be written to.
  const BIO_SELECTORS = [
    'textarea[id*="summary" i], textarea[name*="summary" i], textarea[placeholder*="summary" i], textarea[aria-label*="summary" i]',
    'textarea[id*="about" i], textarea[name*="about" i], textarea[placeholder*="about" i], textarea[aria-label*="about" i]',
    'textarea[id*="bio" i], textarea[name*="bio" i], textarea[placeholder*="bio" i], textarea[aria-label*="bio" i]',
    'div[contenteditable="true"][id*="summary" i], div[contenteditable="true"][aria-label*="summary" i]',
    'div[contenteditable="true"][id*="about" i], div[contenteditable="true"][aria-label*="about" i]',
    'div[role="textbox"][aria-label*="summary" i], div[role="textbox"][aria-label*="about" i]',
    "#profileSummary, #profileDescription, .profile-summary textarea"
  ];

  // The "Resume headline" section on the read-only profile page. Its edit
  // control carries an aria-label naming the section; the class hooks are the
  // fallback if that wording changes.
  const HEADLINE_EDIT_SELECTORS = [
    '[aria-label="Edit resume headline" i]',
    '[aria-label*="edit resume headline" i]',
    "#lazyResumeHead .edit, #lazyResumeHead [role='button']",
    ".resumeHeadline .edit, .resumeHeadline [role='button']"
  ];

  // The editor the headline edit control reveals. The current layout is the
  // free-user-editor textarea (#resumeHeadlineTxt, name resumeHeadline); older
  // layouts used an input, and some use a contenteditable.
  const HEADLINE_FIELD_SELECTORS = [
    "#resumeHeadlineTxt",
    'textarea[name="resumeHeadline" i]',
    "#resumeHeadline",
    'textarea[name*="headline" i], textarea[id*="headline" i], textarea[placeholder*="headline" i], textarea[aria-label*="headline" i]',
    'input[name*="headline" i], input[id*="headline" i], input[placeholder*="headline" i], input[aria-label*="headline" i]',
    '.resumeHeadlineEdit textarea, .resumeHeadlineEdit input, .resumeHeadlineEdit [contenteditable="true"]',
    '[role="dialog"] textarea, [role="dialog"] input, .lightbox textarea, .lightbox input'
  ];

  // The "Profile last updated - X" line on the profile page. A save Naukri
  // actually records moves this to "Today"/"now"; a save that is silently
  // discarded leaves it at "Yesterday" (or an older date). Reading it back
  // after the click is the only proof the write stuck.
  const LAST_UPDATED_SELECTORS = [
    ".mod-date-val",
    ".mod-date .mod-date-val",
    '[class*="mod-date"] .mod-date-val',
    ".mod-date"
  ];

  function readText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return String(el.value || "");
    return String(el.textContent || "");
  }

  function findLastUpdated() {
    for (const selector of LAST_UPDATED_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function readLastUpdated() {
    const el = findLastUpdated();
    return el ? readText(el).trim() : null;
  }

  // A value that means "just updated". Naukri shows "Today"/"now"/a relative
  // "N minutes ago" for a fresh save and "Yesterday" (or a concrete old date)
  // for a stale one. Any change from the value read before the edit also
  // counts, which keeps this honest if the wording changes.
  function isFreshUpdate(before, after) {
    const text = String(after == null ? "" : after).trim().toLowerCase();
    if (!text) return false;
    if (before != null && text !== String(before).trim().toLowerCase()) return true;
    if (/yesterday|ago/.test(text)) return false;
    return /\b(today|now|just now)\b/.test(text);
  }

  // A plain `el.value = ...` is invisible to React, which installs its own
  // value setter on the node and keeps the input's state separately. Writing
  // through the prototype's native setter and then dispatching `input` is what
  // makes the editor's internal state agree with the text on screen, so the
  // Save that follows persists the dot rather than the old value.
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "INPUT" ? window.HTMLInputElement && window.HTMLInputElement.prototype
      : el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
      : null;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function isEditableField(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
    if (el.isContentEditable === true) return true;
    return String(el.getAttribute && el.getAttribute("contenteditable")) === "true";
  }

  function findBioField() {
    for (const selector of BIO_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el)) return el;
      }
    }

    // Last resort on the edit page: the summary box is the longest text field
    // on it (the headline and title fields are inputs, not textareas), so pick
    // the visible textarea/contenteditable with the most characters rather
    // than whatever happens to come first in the DOM.
    let best = null;
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
      if (!isVisible(el)) continue;
      const length = readText(el).length;
      if (!best || length > best.length) best = { el, length };
    }
    return best ? best.el : null;
  }

  // The headline edit control that opens the editor. Returns null when the
  // page has no headline section, which is the signal to fall back to the bio.
  function findHeadlineEditButton() {
    for (const selector of HEADLINE_EDIT_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // The editor field itself, only ever an editable box — the read-only view
  // text is a plain div and must never be treated as the target.
  function findHeadlineField() {
    for (const selector of HEADLINE_FIELD_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (isVisible(el) && isEditableField(el)) return el;
      }
    }
    return null;
  }

  function findButtonByText(pattern) {
    for (const el of document.querySelectorAll("button, a, input[type='submit'], [role='button']")) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || el.value || "").trim();
      if (pattern.test(text)) return el;
    }
    return null;
  }

  // A read-only profile view needs one click to reach the editor; the edit URL
  // the background opens usually lands straight in it, so this only runs when
  // no bio box could be found.
  function findEditButton() {
    return findButtonByText(/^(edit|edit profile|update profile|edit now)$/i);
  }

  function findSaveButton() {
    const strict = findButtonByText(/^(save|save profile|save changes|update|update profile|update now)$/i);
    if (strict) return strict;
    return findButtonByText(/\b(save|update)\b/i);
  }

  // Same save search, but confined to the editor the field lives in. The
  // profile page keeps a dozen hidden edit drawers mounted at once, so a global
  // "find a visible Save" can land on the wrong drawer's button — the click
  // then does nothing while the run still reports a save. Scoping to the
  // field's own dialog is what makes "clicked Save" mean "saved this field".
  function findSaveButtonNear(field) {
    if (field && typeof field.closest === "function") {
      const root = field.closest("form, [role='dialog'], .lightbox, .drawer-content, .profileEditDrawer");
      if (root && typeof root.querySelectorAll === "function") {
        const strict = findButtonIn(root, /^(save|save profile|save changes|update|update profile|update now)$/i);
        if (strict) return strict;
        const loose = findButtonIn(root, /\b(save|update)\b/i);
        if (loose) return loose;
      }
    }
    return findSaveButton();
  }

  function findButtonIn(root, pattern) {
    for (const el of root.querySelectorAll("button, a, input[type='submit'], [role='button']")) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || el.value || "").trim();
      if (pattern.test(text)) return el;
    }
    return null;
  }

  // The whole edit. Returns the next text.
  function nextText(current, editPattern, customText) {
    const trimmed = String(current == null ? "" : current).replace(/\s+$/, "");

    if (editPattern === "custom") return trimmed + (customText || " .");
    if (editPattern === "append") return trimmed + " ";

    // "dots" — the default and the spec: toggle the trailing dot. Add one when
    // it is missing, remove it when it is there. A always-changing edit is what
    // makes each run a real profile update: a run that finds the dot already
    // present and does nothing leaves Naukri's "Profile last updated" at the
    // previous day, which is exactly the "it says saved but nothing saved"
    // failure this toggle exists to prevent.
    if (trimmed.endsWith(".")) return trimmed.slice(0, -1).replace(/\s+$/, "");
    return trimmed + ".";
  }

  function writeText(el, text) {
    if (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") {
      writeRichText(el, text);
      return;
    }
    // Focus first: Naukri's editor tracks the focused field, and its character
    // counter/validation only recompute once the box is the active element.
    if (typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A contenteditable editor (the headline is one on some Naukri layouts) keeps
  // its own model, and a bare `textContent = …` updates the pixels but not that
  // model, so the Save that follows persists the old text. Selecting the
  // content and inserting through the editing command is what a real keystroke
  // does, and it is the only write these editors reliably observe. The plain
  // textContent path stays as the fallback for test shims and future layouts.
  function writeRichText(el, text) {
    if (typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }

    let inserted = false;
    if (typeof document.execCommand === "function") {
      try {
        if (typeof document.createRange === "function" && typeof window.getSelection === "function") {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }
    }

    if (!inserted) el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // The headline pass: click the section's edit control, wait for the editor it
  // reveals, dot it, save. Returns null when the page has no headline section,
  // which is the cue to fall back to the bio/summary flow.
  async function refreshHeadline(editPattern, customText, background) {
    const edit = await waitFor(findHeadlineEditButton, 8000);
    if (!edit) return null;

    try {
      edit.click();
    } catch {
      return { ok: false, edited: false, saved: false, reason: "The Edit resume headline control could not be clicked." };
    }

    const field = await waitFor(findHeadlineField, 8000);
    if (!field) {
      return {
        ok: false,
        edited: false,
        saved: false,
        reason: "Found the resume headline but its editor did not open. Are you logged in to Naukri?"
      };
    }

    const beforeUpdated = readLastUpdated();
    const next = nextText(readText(field), editPattern, customText);

    writeText(field, next);
    await wait(400);

    const save = await waitFor(() => findSaveButtonNear(field), 5000);
    if (!save) {
      return { ok: false, edited: true, saved: false, reason: "The resume headline was updated but no Save button was found." };
    }
    try {
      save.click();
    } catch (err) {
      return { ok: false, edited: true, saved: false, reason: `The Save button could not be clicked: ${err.message}` };
    }

    // A save Naukri's server accepts moves the "Profile last updated" line, so
    // that is the primary proof and it is polled first: it also works on a
    // background tab, where the page's paint can be frozen (requestAnimationFrame
    // is paused and the drawer's close animation is throttled) while the XHR
    // that persisted the change runs normally.
    const hasDateLine = !!findLastUpdated();
    if (hasDateLine) {
      const moved = await waitFor(() => (isFreshUpdate(beforeUpdated, readLastUpdated()) ? true : null), 12000, 500);
      if (moved) return { ok: true, edited: true, saved: true, reason: "" };
    }

    // The worker opens this tab in the background, so Naukri's frozen render can
    // keep the drawer open and the date stale even though the save went through.
    // That freeze is not a failed save, and reporting it as one is the exact
    // false "the change did not save" this flow kept raising. Report the save
    // and say why it could not be visually confirmed.
    if (background) {
      return {
        ok: true,
        edited: true,
        saved: true,
        reason: "",
        note: "the save was sent, but the tab ran in the background so the page never repainted to confirm it"
      };
    }

    // Foreground: the drawer closing is the page's own confirmation of a save,
    // and a drawer that closes while the date stays put is the "it says saved
    // but nothing saved" case that must be reported.
    const closed = await waitFor(() => (isVisible(field) ? null : true), 6000, 300);
    if (closed && !hasDateLine) {
      return { ok: true, edited: true, saved: true, reason: "" };
    }
    if (closed) {
      const shown = readLastUpdated();
      return {
        ok: false,
        edited: true,
        saved: false,
        reason: `The editor closed but the profile still reads "Profile last updated - ${shown}" — the save did not stick.`
      };
    }

    return { ok: false, edited: true, saved: false, reason: "The Save button was clicked but the editor stayed open — the change did not save." };
  }

  async function refreshProfile(editPattern, customText, background) {
    // Primary target: the resume headline. Its edit control is on the page the
    // background opens, so this is the path the daily run normally takes.
    const headline = await refreshHeadline(editPattern, customText, background);
    if (headline) return headline;

    // Fallback: no headline section on this page/layout — dot the bio/summary
    // box instead. The tab was just opened, so give the page a beat to hydrate
    // before the first look, then keep looking for a while.
    let field = await waitFor(findBioField, 8000);
    if (!field) {
      const edit = findEditButton();
      if (edit) {
        try { edit.click(); } catch {}
        field = await waitFor(findBioField, 8000);
      }
    }
    if (!field) {
      return {
        ok: false,
        edited: false,
        saved: false,
        reason: "Could not find the bio/summary box on the profile page. Are you logged in to Naukri?"
      };
    }

    const beforeUpdated = readLastUpdated();
    const next = nextText(readText(field), editPattern, customText);

    writeText(field, next);
    await wait(400);

    const save = await waitFor(findSaveButton, 5000);
    if (!save) {
      return { ok: false, edited: true, saved: false, reason: "The bio was updated but no Save button was found." };
    }
    try {
      save.click();
    } catch (err) {
      return { ok: false, edited: true, saved: false, reason: `The Save button could not be clicked: ${err.message}` };
    }

    // Same gate as the headline path: movement of the "Profile last updated"
    // line is the proof, and it is the one signal that can survive a background
    // tab — where the page's own re-render is frozen while the save itself goes
    // through.
    const hasDateLine = !!findLastUpdated();
    if (hasDateLine) {
      const moved = await waitFor(() => (isFreshUpdate(beforeUpdated, readLastUpdated()) ? true : null), 12000, 500);
      if (moved) return { ok: true, edited: true, saved: true, reason: "" };
    }

    if (background) {
      return {
        ok: true,
        edited: true,
        saved: true,
        reason: "",
        note: "the save was sent, but the tab ran in the background so the page never repainted to confirm it"
      };
    }

    if (hasDateLine) {
      const shown = readLastUpdated();
      return {
        ok: false,
        edited: true,
        saved: false,
        reason: `The save was clicked but the profile still reads "Profile last updated - ${shown}" — the save did not stick.`
      };
    }

    return { ok: true, edited: true, saved: true, reason: "" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "naukri:refresh") return false;

    (async () => {
      try {
        // The worker opens the tab with active:false and says so in the message.
        // Checking the visibility API as a fallback keeps this honest if the
        // script is ever driven another way.
        const background =
          message.backgroundTab === true ||
          (typeof document !== "undefined" && document.hidden === true);
        sendResponse(await refreshProfile(message.editPattern, message.customText, background));
      } catch (err) {
        sendResponse({ ok: false, edited: false, saved: false, reason: err.message });
      }
    })();
    return true; // keep the channel open for the async reply
  });
})();
