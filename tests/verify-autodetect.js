// Automatic form detection (src/content/autodetect.js).
//
// The content script runs in its own world on every http(s) page, so the
// shipped source is loaded into a vm with the bare browser surface it touches
// stubbed: a document that counts its controls, a location it can read, a
// fake MutationObserver that hands back its callback, and manual timers. The
// stubs let a test mutate the page's control count and then "flush" a pending
// debounce like a timer, without any real DOM or ticking.
//
// Behaviour under test: a page is only announced when it has a real form
// (3+ controls), only when the page actually changed (no spam on identical
// mutations), and change includes the URL — an SPA route change is a new form
// even when the control count happens to match.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, expect } = require("./harness");

const src = fs.readFileSync(path.join(ROOT, "src/content/autodetect.js"), "utf8");

function makePage({ controls = 0, shadowControls = 0, href = "https://jobs.example.com/apply", rejectMessages = false } = {}) {
  const state = { controls, shadowControls, href };
  const sent = [];
  let timerKey = 0;
  const timers = new Map();
  let observerCallback = null;

  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      // 0, 1, or many per call — a live count, so mutations are just writes to
      // state before the observer callback (or a flush) runs.
      const n = (name) => Array.from({ length: state[name] }, () => ({}));
      if (selector.includes("input")) return n("controls");
      if (state.shadowControls > 0) {
        return [{
          shadowRoot: {
            querySelectorAll: (sel) => (sel.includes("input") ? n("shadowControls") : [])
          }
        }];
      }
      return [];
    }
  };

  class MutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
  }

  const chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return rejectMessages ? Promise.reject(new Error("no receiver")) : Promise.resolve();
      }
    }
  };

  // A live location: the content script reads location.href at report time,
  // and a mutate({ href }) test case must be visible to later reports the way
  // an SPA pushState() would be.
  const location = {
    get href() { return state.href; }
  };

  vm.runInContext(src, vm.createContext({
    chrome,
    document,
    location,
    MutationObserver,
    setTimeout: (fn) => { timerKey += 1; timers.set(timerKey, fn); return timerKey; },
    clearTimeout: (id) => timers.delete(id),
    console
  }), { filename: "autodetect.js" });

  return {
    sent,
    pending: () => timers.size,
    mutate(next) {
      Object.assign(state, next);
      observerCallback([], {});
    },
    flush() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    }
  };
}

const { eq, ok, done } = expect("autodetect");

// Below the threshold a page is a search box, not an application, and must
// stay silent whether or not it mutates.
const quiet = makePage({ controls: 2 });
eq("a search box reports nothing on load", quiet.sent.length, 0);
quiet.mutate({ controls: 2 });
quiet.flush();
eq("…and stays silent when it mutates past nothing", quiet.sent.length, 0);

// Initial report: a form already in the DOM at document_idle announces
// itself immediately, no debounce wait.
const form = makePage({ controls: 5 });
eq("a form reports once on load", form.sent.length, 1);
eq("…with the expected message", form.sent[0], {
  type: "autofill:form-detected",
  controlCount: 5,
  href: "https://jobs.example.com/apply"
});

// Dedupe: an unchanged count is not a change. The extension's own injections
// (uids is a fill stamps) must not echo back into the panel.
form.mutate({ controls: 5 });
form.flush();
eq("an unchanged form stays quiet", form.sent.length, 1);

// Real change: controls appear or go away.
form.mutate({ controls: 7 });
form.flush();
eq("a changed count reports again", form.sent.length, 2);
eq("…with the new count", form.sent[1].controlCount, 7);

// SPA route change: same count, new URL — a new form to the user.
const spa = makePage({ controls: 6 });
spa.mutate({ href: "https://jobs.example.com/apply/step-2" });
spa.flush();
eq("an SPA route change reports despite the same count", spa.sent.length, 2);
eq("…with the new href", spa.sent[1].href, "https://jobs.example.com/apply/step-2");
eq("…and the same count", spa.sent[1].controlCount, 6);

// Debounce: ATS pages mutate in bursts while hydrating; several mutations in
// one window collapse into a single report carrying the final count.
const busy = makePage({ controls: 6 });
busy.mutate({ controls: 8 });
busy.mutate({ controls: 9 });
eq("a mutation burst leaves exactly one report pending", busy.pending(), 1);
busy.flush();
eq("one report per burst", busy.sent.length, 2);
eq("…with the final count", busy.sent[1].controlCount, 9);

// Shadow DOM: a widget that renders its controls inside an open shadow root
// still counts (same traversal describeFrames() uses).
const shadowed = makePage({ controls: 0, shadowControls: 4 });
eq("shadow-root controls count toward a report", shadowed.sent.length, 1);
eq("…including the shadow controls in the total", shadowed.sent[0].controlCount, 4);

// A page that grows a form later — the whole point of the observer.
const growing = makePage({ controls: 2 });
growing.mutate({ controls: 3 });
growing.flush();
eq("crossing the threshold from below reports", growing.sent.length, 1);
eq("…with the crossing count", growing.sent[0].controlCount, 3);

// The panel is closed most of the time; a report into an absent listener must
// not surface as an error from the content script.
const noReceiver = makePage({ controls: 5, rejectMessages: true });
noReceiver.flush();
ok("a report with no listener is not an error", noReceiver.sent.length === 1);

process.exit(done() ? 1 : 0);