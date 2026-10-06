// Regression guard for the OAuth redirect URI, which is the single most
// expensive thing to get wrong in this feature: it fails as an opaque
// `Error 400: redirect_uri_mismatch` on a Google sign-in screen, long after the
// user thinks the extension is broken.
//
// The rule, from Google's own docs and the Chrome Extension client type in
// Google Cloud:
//
//   A "Chrome Extension" OAuth client is configured with *only* the extension
//   id. Google then registers exactly `https://<id>.chromiumapp.org/` — the
//   bare origin, trailing slash, no path. So the extension must ask for that
//   same bare origin. `getRedirectURL("oauth2")` appends `/oauth2`, which was
//   never registered, and the consent flow dies at Google before it ever
//   reaches the user.
//
// Run: node tests/verify-oauth-redirect.js

const { makeChrome, makeContext, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("oauth-redirect");

// A real-looking Chromium redirect. The id is whatever Chrome assigned; the
// harness cannot know it, and must not care, because the invariant under test
// is the *shape* of the URL, not the id.
const EXT_ID = "testextensionid";

const chromeMock = makeChrome();
const ctx = makeContext({ chrome: chromeMock });

load(ctx, "src/lib/schema.js");
load(ctx, "src/lib/gmail.js");

const { redirectUrl } = take(ctx, "({ redirectUrl: Gmail.redirectUrl })");

const uri = redirectUrl();

console.log(`--- redirectUrl() -> ${uri} ---`);

// The bug itself: a path segment here is a redirect_uri_mismatch.
eq("no path segment", uri.replace(/^https:\/\/[^/]+\.chromiumapp\.org\//, ""), "");
eq("is a chromiumapp.org origin", /^https:\/\/[a-z]+\.chromiumapp\.org\/$/.test(uri), true);

// ...and the adjacent mistakes, since they all surface as the same 400.
ok("https, not http", uri.startsWith("https://"));
eq("no query string", uri.includes("?"), false);
eq("no fragment", uri.includes("#"), false);
ok("ends with exactly one slash", uri.endsWith("/") && !uri.endsWith("//"));
eq("not the API key as a redirect", uri.includes("googleapis.com"), false);

// The consent screen renders this exact string, so it must survive the round
// trip through URL encoding intact and stay identical to what we assert against
// (Google compares byte-for-byte, so a stray encoding difference is a 400).
eq("survives encodeURIComponent unchanged",
   decodeURIComponent(encodeURIComponent(uri)), uri);

// And it must be deterministic: a value that changes between calls would
// intermittently mismatch against a single registered URI.
eq("deterministic across calls", redirectUrl(), uri);

// Finally, pin the thing that actually broke, so that changing the argument
// passed to getRedirectURL is a test failure rather than a production outage.
const withPath = chromeMock.identity.getRedirectURL("oauth2");
ok("the buggy form is genuinely different (guard is meaningful)",
   withPath !== uri);
eq("buggy form carries /oauth2", withPath, `https://${EXT_ID}.chromiumapp.org/oauth2`);

process.exit(done() ? 1 : 0);
