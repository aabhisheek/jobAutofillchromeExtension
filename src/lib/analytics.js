// Mixpanel instrumentation shared by every extension page (popup, options,
// resume). Loaded as a plain script alongside schema.js/matcher.js — no
// modules, no bundler, same as the rest of this project.
//
// Nothing is sent from here directly: track() hands the event to the
// background service worker (src/background.js), which owns the queue, the
// token and the network call. That indirection is load-bearing for the popup,
// which Chrome destroys the moment it loses focus — a fetch started in this
// context would be aborted mid-flight, whereas a message keeps the service
// worker alive until it has taken the event.
//
// Privacy contract: this extension holds a full job-application profile, so
// analytics only ever carries counts, enums, durations and booleans. Never a
// field value, a profile field, job-description text, a resume, an API key, or
// a page URL. Only the ATS vendor is derived from the tab (see atsVendor
// below) — the hostname itself is deliberately not sent, since that would
// amount to shipping the user's browsing history. background.js re-checks this
// on the way out by truncating every string property.

const ANALYTICS_MESSAGE_TYPE = "analytics:track";

// Known ATS platforms, matched against a job page's hostname. The point of
// this list is to answer "which ATS does autofill actually get used on / break
// on" without transmitting the hostname; anything unrecognized collapses to
// "other" and pages that can't be inspected to "unknown".
const ATS_PATTERNS = [
  [/myworkdayjobs\.com|myworkdaysite\.com|workday/i, "workday"],
  [/greenhouse\.io|grnh\.se/i, "greenhouse"],
  [/lever\.co/i, "lever"],
  [/ashbyhq\.com/i, "ashby"],
  [/smartrecruiters\.com/i, "smartrecruiters"],
  [/icims\.com/i, "icims"],
  [/taleo\.net/i, "taleo"],
  [/successfactors\.|sapsf\./i, "successfactors"],
  [/jobvite\.com/i, "jobvite"],
  [/bamboohr\.com/i, "bamboohr"],
  [/workable\.com/i, "workable"],
  [/recruitee\.com/i, "recruitee"],
  [/linkedin\.com/i, "linkedin"],
  [/naukri\.com/i, "naukri"],
  [/indeed\.com/i, "indeed"]
];

function atsVendor(url) {
  if (!url) return "unknown";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  // Anything that isn't a real web page — chrome://, about:, file://, the PDF
  // viewer — is "unknown", not "other". Those are pages the popup can't scan
  // at all, and folding them into "other" would understate how often autofill
  // works on unrecognized ATS platforms.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "unknown";
  if (!parsed.hostname) return "unknown";

  for (const [pattern, vendor] of ATS_PATTERNS) {
    if (pattern.test(parsed.hostname)) return vendor;
  }
  return "other";
}

const Analytics = {
  // Which extension page is reporting — set once per page via init(), then
  // attached to every event as `surface` so popup/options/resume funnels can
  // be separated in Mixpanel.
  surface: "unknown",

  init(surface) {
    this.surface = surface;
  },

  // Fire-and-forget by design. Analytics must never be able to break, block or
  // slow down the feature it is measuring, so every failure path here is
  // swallowed: no listener (service worker torn down mid-navigation), an
  // extension context invalidated by a reload, messaging disabled — all of it
  // is a no-op rather than an exception in a click handler.
  track(event, props = {}) {
    try {
      const result = chrome.runtime.sendMessage({
        type: ANALYTICS_MESSAGE_TYPE,
        event,
        props: { ...props, surface: this.surface }
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // ignored — see above
    }
  },

  // Convenience for the timed flows (scan, fill, tailor). `startedAt` is a
  // performance.now() reading taken when the work began.
  trackTimed(event, startedAt, props = {}) {
    this.track(event, { ...props, duration_ms: Math.round(performance.now() - startedAt) });
  }
};
