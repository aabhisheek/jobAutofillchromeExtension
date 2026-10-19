// The daily Naukri profile refresh, both halves, against the shipped files:
//
//   1. src/content/naukri-profile.js — opens on a mocked profile page with a
//      virtual clock (its waitFor loops are seconds of real time otherwise)
//      and does exactly one thing: toggle the trailing dot (add it when
//      missing, remove it when present), save, and only claim success once the
//      page's "Profile last updated" line has actually moved. The primary
//      target is the read-only page's "Resume headline" edit control (click
//      it, toggle the editor it reveals); the bio/summary box is the fallback.
//
//   2. src/background.js — sliced the way verify-alarm.js slices it (the whole
//      worker needs chrome.* at import time): the scheduling helpers, then the
//      onMessage wiring, then the alarm/storage listeners, so the tests drive
//      the real message handlers the dashboard and the alarm actually call.
//
//   3. The defaults and the manifest entry, so the feature cannot ship
//      silently disabled or without its content script registered.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, makeContext, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("naukri");

// ---- content script harness ----------------------------------------------

function makeNode(spec) {
  const node = {
    kind: spec.kind, // "bio" | "field" | "button"
    tagName: String(spec.tag || "TEXTAREA").toUpperCase(),
    value: spec.value || "",
    textContent: spec.text || "",
    disabled: !!spec.disabled,
    readOnly: !!spec.readOnly,
    hidden: !!spec.hidden,
    visible: spec.visible !== false,
    events: [],
    clicks: 0,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    dispatchEvent(evt) {
      this.events.push(evt.type);
      return true;
    },
    click() {
      this.clicks += 1;
      if (this.onClick) this.onClick();
    }
  };
  return node;
}

// Enough of querySelectorAll for this script's query shapes: the resume
// headline edit control and its editor (matched first, so the [role="button"]
// candidate in the edit selector does not fall through to the button sweep),
// the bio selector sweep (every selector mentions summary/about/bio), the
// button sweep, and the last-resort "any text field" sweep.
function makeDocument(elements) {
  return {
    querySelectorAll(selector) {
      const s = String(selector).toLowerCase();
      if (/headline|resumehead/.test(s)) {
        return /\bedit\b|role=/.test(s)
          ? elements.filter((n) => n.kind === "headlineEdit")
          : elements.filter((n) => n.kind === "headlineField");
      }
      if (/button/i.test(selector)) return elements.filter((n) => n.kind === "button");
      if (/mod-date|last.?updated/.test(s)) return elements.filter((n) => n.kind === "date");
      if (/summary|about|bio/i.test(selector)) return elements.filter((n) => n.kind === "bio");
      if (/textarea|contenteditable/i.test(selector)) return elements.filter((n) => n.kind !== "button");
      return [];
    }
  };
}

function bootContent(elements, opts) {
  const clock = { now: 0 };
  let listener = null;
  const document = makeDocument(elements);
  if (opts && opts.hidden) {
    // A tab the extension opened with active:false is a hidden document: the
    // page still lays out (getClientRects keeps working) but its render loop
    // is frozen, exactly the state the "editor stayed open" false alarm lived
    // in.
    document.hidden = true;
    document.visibilityState = "hidden";
  }
  const ctx = makeContext({
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    document,
    globals: {
      window: {
        getComputedStyle: (n) => ({
          display: n.hidden ? "none" : "block",
          visibility: "visible",
          opacity: "1"
        })
      },
      Event: function FakeEvent(type, init) {
        this.type = type;
        this.bubbles = !!(init && init.bubbles);
      },
      // Virtual clock: every wait() advances it by exactly the requested
      // delay before resolving, so an 8-second waitForGiveUp costs no real
      // time and the timeout arithmetic still works.
      Date: { now: () => clock.now },
      setTimeout: (fn, ms) => {
        clock.now += Number(ms) || 0;
        fn();
        return 0;
      }
    }
  });
  load(ctx, "src/content/naukri-profile.js");
  return { listener };
}

// Sends one refresh message. Resolves with { keep, value }: `keep` is what the
// listener returned synchronously (true = channel held open for the async
// reply), `value` is the content script's report.
function askContent(listener, message) {
  return new Promise((resolve) => {
    const keep = listener(message, {}, (value) => resolve({ keep, value }));
    if (keep !== true) resolve({ keep, value: undefined });
  });
}

const REFRESH = { type: "naukri:refresh", editPattern: "dots" };

async function contentTests() {
  // 1. A bio without a dot gets exactly one, with the input/change events a
  //    React-ish editor needs to notice, and a save.
  {
    const bio = makeNode({ kind: "bio", value: "Senior engineer building pipelines" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    const { keep, value } = await askContent(listener, REFRESH);
    eq("holds the message channel open", keep, true);
    eq("reports success", value, { ok: true, edited: true, saved: true, reason: "" });
    eq("dot appended", bio.value, "Senior engineer building pipelines.");
    eq("notified the editor", bio.events, ["input", "change"]);
    eq("save clicked once", save.clicks, 1);
  }

  // 2. The normal case after the first run: a dotted bio has its dot removed
  //    and is saved — the toggle is what makes every run a real update.
  {
    const bio = makeNode({ kind: "bio", value: "Done." });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("dot removed and saved", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("value toggled", bio.value, "Done");
    eq("notified the editor", bio.events, ["input", "change"]);
    eq("save clicked once", save.clicks, 1);
  }

  // 3. Whitespace after the dot still toggles cleanly: removing the dot also
  //    drops the trailing whitespace so no stray spaces are saved.
  {
    const bio = makeNode({ kind: "bio", value: "Done.   " });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("toggled cleanly", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("dot and trailing space gone", bio.value, "Done");
    eq("save clicked once", save.clicks, 1);
  }

  // 4. Trailing whitespace without a dot: the dot lands on the trimmed end.
  {
    const bio = makeNode({ kind: "bio", value: "Build things\n" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("edited and saved", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("dot on the trimmed text", bio.value, "Build things.");
  }

  // 5. A contenteditable bio is read and written through textContent, not
  //    .value — the field this page actually ships.
  {
    const bio = makeNode({ kind: "bio", tag: "DIV", text: "I ship things" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("edited and saved", [value.ok, value.saved], [true, true]);
    eq("textContent got the dot", bio.textContent, "I ship things.");
    eq("notified the editor", bio.events, ["input", "change"]);
  }

  // 6. isVisible covers every branch: display:none, an empty rect list, and a
  //    read-only field are all skipped in favour of the one real bio box.
  {
    const displayNone = makeNode({ kind: "bio", value: "Hidden", hidden: true });
    const notRendered = makeNode({ kind: "bio", value: "Unrendered", visible: false });
    const readOnly = makeNode({ kind: "bio", value: "Locked", readOnly: true });
    const real = makeNode({ kind: "bio", value: "Real bio" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([displayNone, notRendered, readOnly, real, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("found the visible field", value.ok, true);
    eq("real bio dotted", real.value, "Real bio.");
    eq("display:none untouched", displayNone.value, "Hidden");
    eq("unrendered untouched", notRendered.value, "Unrendered");
    eq("read-only untouched", readOnly.value, "Locked");
  }

  // 7. No bio anywhere: a loud, specific failure — never a silent no-op.
  {
    const edit = makeNode({ kind: "button", text: "Edit profile" });
    const { listener } = bootContent([edit]);
    const { value } = await askContent(listener, REFRESH);
    eq("fails honestly", value.ok, false);
    ok("names the missing box", /bio\/summary box/.test(value.reason));
    ok("asks about the login", /logged in to Naukri/.test(value.reason));
    eq("edit clicked once", edit.clicks, 1);
    eq("nothing edited", value.edited, false);
  }

  // 8. Read-only view: the Edit button is clicked once and the bio it
  //    reveals gets the treatment.
  {
    const elements = [];
    const edit = makeNode({ kind: "button", text: "Edit profile" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => {
      elements.push(makeNode({ kind: "bio", value: "Revealed bio" }));
    };
    elements.push(edit, save);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("edit path succeeds", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("edit clicked once", edit.clicks, 1);
    eq("revealed bio dotted", elements[2].value, "Revealed bio.");
    eq("save clicked", save.clicks, 1);
  }

  // 9. Edited but no Save button: half-done must be reported as a failure so
  //    the daily log never claims a save that did not happen.
  {
    const bio = makeNode({ kind: "bio", value: "No button here" });
    const { listener } = bootContent([bio]);
    const { value } = await askContent(listener, REFRESH);
    eq("fails", value.ok, false);
    eq("but the edit happened", value.edited, true);
    eq("nothing saved", value.saved, false);
    ok("says so", /Save button/.test(value.reason));
    eq("value written", bio.value, "No button here.");
  }

  // 10. Last resort: with no summary/about/bio selector matching, the longest
  //     visible text field wins (the headline is a short input, the summary
  //     is the long textarea).
  {
    const short = makeNode({ kind: "field", value: "Hi" });
    const long = makeNode({ kind: "field", value: "The longest text on the page" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([short, long, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("picks the longest field", value.ok, true);
    eq("long field dotted", long.value, "The longest text on the page.");
    eq("short field untouched", short.value, "Hi");
  }

  // 11. Save falls back from the strict label to any save/update word, so a
  //     button reading "Update details" still gets clicked.
  {
    const bio = makeNode({ kind: "bio", value: "Needs saving" });
    const save = makeNode({ kind: "button", text: "Update details" });
    const { listener } = bootContent([bio, save]);
    const { value } = await askContent(listener, REFRESH);
    eq("fallback label clicked", [value.ok, value.saved], [true, true]);
    eq("save clicked once", save.clicks, 1);
  }

  // 12. The other edit patterns the settings expose keep working.
  {
    const bio = makeNode({ kind: "bio", value: "Hi" });
    const save = makeNode({ kind: "button", text: "Save" });
    const { listener } = bootContent([bio, save]);
    await askContent(listener, { type: "naukri:refresh", editPattern: "append" });
    eq("append adds a space", bio.value, "Hi ");

    const bio2 = makeNode({ kind: "bio", value: "Hi" });
    const save2 = makeNode({ kind: "button", text: "Save" });
    const { listener: l2 } = bootContent([bio2, save2]);
    await askContent(l2, { type: "naukri:refresh", editPattern: "custom", customText: " ." });
    eq("custom appends the configured text", bio2.value, "Hi .");
  }

  // 12b. The bio fallback behaves the same on a hidden background tab: the
  //      write and Save click happen, the frozen page keeps the stale date,
  //      and the run still reports the save with a note.
  {
    const bio = makeNode({ kind: "bio", value: "Bio note" });
    const save = makeNode({ kind: "button", text: "Save" });
    const date = makeNode({ kind: "date", tag: "SPAN", text: "Yesterday" });
    const { listener } = bootContent([bio, save, date], { hidden: true });
    const { value } = await askContent(listener, REFRESH);
    eq("hidden bio run claims the save", [value.ok, value.edited, value.saved], [true, true, true]);
    ok("explains the stale page", /background/.test(value.note || ""));
    eq("bio toggled anyway", bio.value, "Bio note.");
    eq("save clicked once", save.clicks, 1);
  }

  // 13. Messages meant for other listeners are declined synchronously so the
  //     channel is not held open for a reply that will never come.
  {
    const { listener } = bootContent([]);
    const { keep, value } = await askContent(listener, { type: "naukri:run" });
    eq("declines a foreign message", keep, false);
    eq("no reply sent", value, undefined);
  }

  // 14. Resume headline: the read-only page's edit control is clicked, the
  //     editor it reveals gets the dot, and Save persists it. This is the
  //     primary path on the real profile page (no bio textarea exists there).
  {
    const elements = [];
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => {
      elements.push(makeNode({ kind: "headlineField", value: "I am a FULL Stack Developer" }));
    };
    // A successful save closes the editor, which is the signal the run must
    // wait for before it may claim a save.
    save.onClick = () => {
      if (elements[2]) elements[2].visible = false;
    };
    elements.push(edit, save);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("headline edited and saved", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("edit control clicked once", edit.clicks, 1);
    eq("headline field dotted", elements[2].value, "I am a FULL Stack Developer.");
    eq("notified the headline editor", elements[2].events, ["input", "change"]);
    eq("save clicked once", save.clicks, 1);
  }

  // 14b. Clicking Save that does not close the editor is a rejected save, not a
  //      success — the exact false "Done" the first version reported.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Still open" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => elements.push(field);
    elements.push(edit, save);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("not claimed as saved", value.ok, false);
    eq("but the write happened", value.edited, true);
    eq("saved is false", value.saved, false);
    ok("says the editor stayed open", /editor stayed open/.test(value.reason));
    eq("save was still clicked", save.clicks, 1);
  }

  // 14c. Save is scoped to the editor's own form: a decoy "Save" elsewhere on
  //      the page must not be the one clicked. The real editor is a
  //      <form name="resumeHeadlineForm"> with a type=submit Save, so the click
  //      has to come from inside that form.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Scoped headline" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const decoySave = makeNode({ kind: "button", text: "Save" });
    const realSave = makeNode({ kind: "button", text: "Save" });
    const formRoot = makeNode({ kind: "form" });
    formRoot.querySelectorAll = (sel) => (/button/i.test(sel) ? [realSave] : []);
    field.closest = () => formRoot;
    edit.onClick = () => elements.push(field);
    realSave.onClick = () => { field.visible = false; };
    elements.push(edit, decoySave, realSave);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("scoped save succeeded", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("the editor's own Save was clicked", realSave.clicks, 1);
    eq("the decoy Save was left alone", decoySave.clicks, 0);
    eq("headline field dotted", field.value, "Scoped headline.");
  }

  // 14e. The reported bug: the save is accepted on the server but the tab was
  //      opened in the background, so Naukri's frozen UI keeps the editor open
  //      and the date stale. The run must report the save, not scream that the
  //      change did not save — while still saying why it cannot fully verify.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Hidden tab" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    const date = makeNode({ kind: "date", tag: "SPAN", text: "Yesterday" });
    edit.onClick = () => elements.push(field);
    // The write and the Save click both happen; only the page's render is
    // frozen, so the drawer never closes and the date never visibly moves.
    elements.push(edit, save, date);
    const { listener } = bootContent(elements, { hidden: true });
    const { value } = await askContent(listener, REFRESH);
    eq("hidden background run claims the save", [value.ok, value.edited, value.saved], [true, true, true]);
    ok("explains the frozen tab", /background/.test(value.note || ""));
    eq("save was still clicked", save.clicks, 1);
    eq("headline still toggled", field.value, "Hidden tab.");
  }

  // 14f. Same frozen background tab but no last-updated line on the page: the
  //      save is still reported as saved.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Hidden" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => elements.push(field);
    elements.push(edit, save);
    const { listener } = bootContent(elements, { hidden: true });
    const { value } = await askContent(listener, REFRESH);
    eq("hidden run without a date line still saves", [value.ok, value.edited, value.saved], [true, true, true]);
  }

  // 14g. The worker marks the message as a background run. Even if the page's
  //      own visibility API says "visible" (the flag this flow used to trust,
  //      and the one that let the false error through), the frozen repaint is
  //      not read as a failed save.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Flagged background" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    const date = makeNode({ kind: "date", tag: "SPAN", text: "Yesterday" });
    edit.onClick = () => elements.push(field);
    elements.push(edit, save, date);
    const { listener } = bootContent(elements); // document is NOT hidden
    const { value } = await askContent(listener, { ...REFRESH, backgroundTab: true });
    eq("flagged background run claims the save", [value.ok, value.edited, value.saved], [true, true, true]);
    ok("explains the frozen tab", /background/.test(value.note || ""));
    ok("does not raise the editor error", !/editor stayed open/.test(value.reason || ""));
    eq("headline still toggled", field.value, "Flagged background.");
  }

  // 15. A headline that already ends with a dot has its dot removed and is
  //     saved — the second-and-later run still produces a real edit.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Built pipelines." });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => elements.push(field);
    save.onClick = () => { field.visible = false; };
    elements.push(edit, save);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("headline toggled and saved", [value.ok, value.edited, value.saved], [true, true, true]);
    eq("dot removed", field.value, "Built pipelines");
    eq("save clicked once", save.clicks, 1);
  }

  // 15b. The editor closes but the profile's "last updated" line never moves:
  //      the exact false "Done" this check exists to catch — reported as a
  //      failure, not a save.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Fresh text" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    const date = makeNode({ kind: "date", tag: "SPAN", text: "Yesterday" });
    edit.onClick = () => elements.push(field);
    save.onClick = () => { field.visible = false; };
    elements.push(edit, save, date);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("stale date is not a save", [value.ok, value.edited, value.saved], [false, true, false]);
    ok("names the stuck date", /still reads "Profile last updated - Yesterday"/.test(value.reason));
    ok("says it did not stick", /did not stick/.test(value.reason));
  }

  // 15c. The save sticks and the last-updated line moves to "Today": the run
  //      may claim success.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "Fresh text" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    const date = makeNode({ kind: "date", tag: "SPAN", text: "Yesterday" });
    edit.onClick = () => elements.push(field);
    save.onClick = () => { field.visible = false; date.textContent = "Today"; };
    elements.push(edit, save, date);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("moving date confirms the save", [value.ok, value.edited, value.saved], [true, true, true]);
  }

  // 15d. Some layouts do not expose the last-updated line: when it is absent,
  //      the editor closing remains the confirmation rather than a hard fail.
  {
    const elements = [];
    const field = makeNode({ kind: "headlineField", value: "No date here" });
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const save = makeNode({ kind: "button", text: "Save" });
    edit.onClick = () => elements.push(field);
    save.onClick = () => { field.visible = false; };
    elements.push(edit, save);
    const { listener } = bootContent(elements);
    const { value } = await askContent(listener, REFRESH);
    eq("missing date line is not a blocker", [value.ok, value.edited, value.saved], [true, true, true]);
  }

  // 16. The edit control is found but its editor never appears: a loud failure,
  //     never a silent no-op or a write somewhere else.
  {
    const edit = makeNode({ kind: "headlineEdit", tag: "SPAN", text: "editOneTheme" });
    const { listener } = bootContent([edit]);
    const { value } = await askContent(listener, REFRESH);
    eq("headline failure reported", value.ok, false);
    ok("says the editor did not open", /editor did not open/.test(value.reason));
    eq("edit clicked once", edit.clicks, 1);
    eq("nothing edited", value.edited, false);
  }
}

// ---- worker harness -------------------------------------------------------

// background.js as three slices: the helpers (from MINIMIZED_KEY, so the
// panel and email helpers the wiring references are defined), then the
// onMessage listener, then the alarm/action/storage listeners. Registration
// is all the last two do at load time, which is what keeps the whole service
// worker from needing chrome.* everywhere.
const bgSrc = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const sliceA = bgSrc.slice(bgSrc.indexOf("const MINIMIZED_KEY"), bgSrc.indexOf("// ---- wiring ----"));
const sliceB = bgSrc.slice(bgSrc.indexOf("// ---- wiring ----"), bgSrc.indexOf("chrome.alarms.onAlarm.addListener"));
const sliceC = bgSrc.slice(
  bgSrc.indexOf("chrome.alarms.onAlarm.addListener"),
  bgSrc.indexOf("chrome.runtime.onInstalled.addListener")
);

const alarmsCreated = [];
const alarmsCleared = [];
const tabsCreated = [];
const tabsRemoved = [];
const messagesSent = [];
const defaultSend = () => ({ ok: true, edited: true, saved: true });
let sendBehavior = defaultSend;
let currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
let onMessage = null;
let onAlarm = null;
let onStorageChanged = null;

const workerChrome = {
  alarms: {
    async create(name, opts) { alarmsCreated.push({ name, opts }); },
    async clear(name) { alarmsCleared.push(name); return true; },
    onAlarm: { addListener(fn) { onAlarm = fn; } }
  },
  action: {
    onClicked: { addListener() {} },
    async setBadgeText() {},
    async setTitle() {}
  },
  commands: { onCommand: { addListener() {} } },
  runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener(fn) { onStorageChanged = fn; } }
  },
  tabs: {
    async create(opts) {
      const tab = { id: 1000 + tabsCreated.length, ...opts };
      tabsCreated.push(tab);
      return tab;
    },
    async remove(id) { tabsRemoved.push(id); },
    async sendMessage(tabId, message) {
      messagesSent.push({ tabId, message });
      const out = sendBehavior(messagesSent.length, message);
      if (out instanceof Error) throw out;
      return out;
    }
  }
};

const workerCtx = makeContext({
  chrome: workerChrome,
  globals: {
    // The retry loop's one-second beat becomes free; the logic under test is
    // "tries again", not "waits a real second".
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    loadSettings: async () => ({ ...currentSettings }),
    MailImport: {
      readSyncState: async () => null,
      loadSettings: async () => ({ ...currentSettings })
    }
  }
});
// The worker records every run and arms its "next run" through this lib, so it
// has to be present for the sliced handlers — the same way the real worker gets
// it from importScripts. Its writes are harmless here (the chrome mock's
// storage is a no-op) and its own behaviour is covered by verify-scheduler-state.
load(workerCtx, "src/lib/scheduler-state.js");
vm.runInContext(sliceA, workerCtx, { filename: "background.js#slices" });
vm.runInContext(sliceB, workerCtx, { filename: "background.js#wiring" });
vm.runInContext(sliceC, workerCtx, { filename: "background.js#listeners" });

// What the dashboard's buttons and the alarm handler call. Resolves with the
// worker's reply; { responded: false } for a message it declined.
function sendToWorker(message) {
  return new Promise((resolve) => {
    const keep = onMessage(message, {}, (value) => resolve({ responded: true, value }));
    if (keep !== true) resolve({ responded: false, keep });
  });
}

async function ask(message) {
  const { value } = await sendToWorker(message);
  return value;
}

// Lets a fire-and-forget run (the alarm path) finish. Everything inside is
// microtasks plus the instant setTimeout, so a tick is plenty.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function resetTabs() {
  tabsCreated.length = 0;
  tabsRemoved.length = 0;
  messagesSent.length = 0;
  sendBehavior = defaultSend;
}
function resetAlarms() {
  alarmsCreated.length = 0;
  alarmsCleared.length = 0;
}
function lastAlarm() {
  return alarmsCreated[alarmsCreated.length - 1];
}

async function workerTests() {
  ok("all three wiring slices registered their listeners",
     typeof onMessage === "function" && typeof onAlarm === "function" && typeof onStorageChanged === "function");

  // 1. Default schedule: a daily alarm at 08:00 local, seconds zeroed, in
  //    the future — the "roughly 8 a.m. every day" the panel promises.
  {
    resetAlarms();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
    const res = await ask({ type: "naukri:reschedule" });
    eq("reschedule answered", res.ok, true);
    const alarm = lastAlarm();
    eq("alarm name", alarm.name, "naukri-profile-refresh");
    eq("daily period", alarm.opts.periodInMinutes, 1440);
    const at = new Date(alarm.opts.when);
    eq("fires at 08:00 local", [at.getHours(), at.getMinutes()], [8, 0]);
    eq("seconds zeroed", at.getSeconds(), 0);
    ok("when is in the future", alarm.opts.when > Date.now());
    eq("reply carries the time", res.when, alarm.opts.when);
  }

  // 2. A configured time is honoured verbatim.
  {
    resetAlarms();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "09:15" };
    await ask({ type: "naukri:reschedule" });
    const at = new Date(lastAlarm().opts.when);
    eq("configured time used", [at.getHours(), at.getMinutes()], [9, 15]);
  }

  // 3. Switched off: the alarm is cleared, not rescheduled.
  {
    resetAlarms();
    currentSettings = { naukriRefreshEnabled: false, naukriRefreshTime: "08:00" };
    const res = await ask({ type: "naukri:reschedule" });
    eq("still answers", res.ok, true);
    eq("no next run", res.when, null);
    eq("no new alarm", alarmsCreated.length, 0);
    ok("old alarm cleared", alarmsCleared.includes("naukri-profile-refresh"));
  }

  // 4. "Refresh now": opens the profile in a background tab, messages the
  //    content script, hands back its report verbatim, and closes the tab.
  {
    resetAlarms();
    resetTabs();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
    const res = await ask({ type: "naukri:run" });
    eq("run reports the content script's result", [res.ok, res.edited, res.saved], [true, true, true]);
    eq("one tab opened", tabsCreated.length, 1);
    eq("the profile url", tabsCreated[0].url, "https://www.naukri.com/mnjuser/profile");
    eq("background tab", tabsCreated[0].active, false);
    eq("result carries the url", res.url, tabsCreated[0].url);
    eq("message type", messagesSent[0].message.type, "naukri:refresh");
    eq("dots pattern by default", messagesSent[0].message.editPattern, "dots");
    eq("custom text default", messagesSent[0].message.customText, " .");
    eq("told the tab it runs in the background", messagesSent[0].message.backgroundTab, true);
    eq("sent to the opened tab", messagesSent[0].tabId, tabsCreated[0].id);
    ok("tab closed after the run", tabsRemoved.includes(tabsCreated[0].id));
  }

  // 5. The disabled gate: the alarm's run (no force) does nothing at all —
  //    no tab, no message — while an unknown alarm name is ignored too.
  {
    resetTabs();
    currentSettings = { naukriRefreshEnabled: false };
    onAlarm({ name: "naukri-profile-refresh" });
    await settle();
    eq("disabled: no tab opened", tabsCreated.length, 0);

    onAlarm({ name: "some-other-alarm" });
    await settle();
    eq("unknown alarm ignored", tabsCreated.length, 0);
  }

  // 6. ...but the same alarm runs when enabled, and the dashboard's forced
  //    run works even with the schedule switched off.
  {
    resetTabs();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
    onAlarm({ name: "naukri-profile-refresh" });
    await settle();
    eq("alarm run opened a tab", tabsCreated.length, 1);
    ok("alarm run closed it", tabsRemoved.includes(tabsCreated[0].id));

    resetTabs();
    currentSettings = { naukriRefreshEnabled: false };
    const res = await ask({ type: "naukri:run" });
    eq("force bypasses the switch", [res.ok, tabsCreated.length], [true, 1]);
  }

  // 7. The content script only exists once its document has loaded, so the
  //    message is retried: two rejections then an answer still succeeds.
  {
    resetTabs();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
    let calls = 0;
    sendBehavior = () => {
      calls += 1;
      if (calls <= 2) return new Error("Could not establish connection.");
      return { ok: true, edited: false, saved: false, reason: "The bio already ends with a dot — nothing to change." };
    };
    const res = await ask({ type: "naukri:run" });
    eq("succeeds after retries", res.ok, true);
    eq("exactly three attempts", messagesSent.length, 3);
    eq("the no-op is reported", [res.edited, res.saved], [false, false]);
  }

  // 8. If the tab never answers, the failure says so instead of hanging or
  //    pretending the profile was touched.
  {
    resetTabs();
    sendBehavior = () => new Error("Could not establish connection.");
    const res = await ask({ type: "naukri:run" });
    eq("gives up", res.ok, false);
    ok("says the tab never answered", /never answered/.test(res.reason));
    ok("includes the last error", /Could not establish connection/.test(res.reason));
    ok("still closes the tab", tabsRemoved.includes(tabsCreated[0].id));
  }

  // 9. Two triggers at once (alarm + a click) share one run: one tab, one
  //    message, both callers answered with the same report.
  {
    resetTabs();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "08:00" };
    const [a, b] = await Promise.all([
      ask({ type: "naukri:run" }),
      ask({ type: "naukri:run" })
    ]);
    eq("single tab for two triggers", tabsCreated.length, 1);
    eq("single message", messagesSent.length, 1);
    eq("both callers answered", [a.ok, b.ok], [true, true]);
  }

  // 10. A settings change re-arms the alarm from storage without a worker
  //     restart; unrelated keys and other storage areas do not touch it.
  {
    resetAlarms();
    currentSettings = { naukriRefreshEnabled: true, naukriRefreshTime: "07:30" };
    onStorageChanged({ naukriRefreshTime: { newValue: "07:30" } }, "local");
    await settle();
    const at = new Date(lastAlarm().opts.when);
    eq("re-armed at the new time", [at.getHours(), at.getMinutes()], [7, 30]);

    resetAlarms();
    onStorageChanged({ groqApiKey: { newValue: "x" } }, "local");
    await settle();
    eq("unrelated key ignored", alarmsCreated.length, 0);

    onStorageChanged({ naukriRefreshEnabled: { newValue: false } }, "sync");
    await settle();
    eq("other storage area ignored", alarmsCreated.length, 0);
  }

  // 11. The dashboard's decline paths: non-naukri messages are not answered,
  //     so their real handlers (in the un-sliced worker) own the reply.
  {
    const foreign = await sendToWorker({ type: "not-a-real-type" });
    eq("foreign type declined", foreign, { responded: false, keep: false });
    const nothing = await sendToWorker(null);
    eq("null declined", nothing, { responded: false, keep: false });
  }
}

// ---- defaults and manifest ------------------------------------------------

function contractTests() {
  const schemaCtx = makeContext();
  load(schemaCtx, "src/lib/schema.js");
  const defaults = take(schemaCtx, "DEFAULT_SETTINGS");

  eq("refresh ships enabled", defaults.naukriRefreshEnabled, true);
  eq("default time is 8 a.m.", defaults.naukriRefreshTime, "08:00");
  eq("default pattern is dots", defaults.naukriRefreshEditPattern, "dots");
  eq("default profile url", defaults.naukriRefreshUrl, "https://www.naukri.com/mnjuser/profile");

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const entry = (manifest.content_scripts || []).find((s) => (s.js || []).includes("src/content/naukri-profile.js"));
  ok("content script registered in the manifest", !!entry);
  ok("matches Naukri pages", !!entry && (entry.matches || []).some((m) => m.includes("naukri.com")));
  ok("alarms permission present", (manifest.permissions || []).includes("alarms"));
}

(async () => {
  await contentTests();
  await workerTests();
  contractTests();
  process.exit(done() ? 1 : 0);
})();
