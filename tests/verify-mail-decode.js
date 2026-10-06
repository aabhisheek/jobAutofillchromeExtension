// Decodes a real Gmail message payload the way the service worker does.
//
// The bug this exists for: gmail.js reduced text/html to text with
// `document.createElement("template")`. That code path runs in the background
// service worker (src/background.js importScripts gmail.js), where `document` does
// not exist. Every message threw ReferenceError, so every sync reported every
// email as "unreadable" and imported nothing while still reporting ok: true.
//
// The context below deliberately has NO `document` -- see the note in
// tests/harness.js. A DOM stub here would have hidden the exact bug.
//
// Run: node tests/verify-mail-decode.js
const { makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("mail-decode");

// Gmail's base64url, as the API sends it.
function b64url(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const SETTINGS = { gmailClientId: "123.apps.googleusercontent.com" };

// Serves one message and records the Authorization header, so the token path is
// covered too.
function makeCtx(message) {
  let authHeader = null;

  // The connection the user has already made, which is what the dashboard and the
  // daily alarm both find on disk.
  const storage = makeStorage({
    gmailAuth: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000, email: "me@gmail.com" }
  });

  const chromeMock = makeChrome({
    storage,
    overrides: {
      fetch: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "AT2", expires_in: 3600 })
          };
        }
        // Lower-cased on purpose: gmailFetch sends `authorization`, and a lookup
        // for `Authorization` would silently record nothing and pass vacuously.
        const headers = (init && init.headers) || {};
        authHeader = headers.authorization || headers.Authorization || null;
        return { ok: true, status: 200, json: async () => message };
      }
    }
  });

  const ctx = makeContext({ chrome: chromeMock });
  load(ctx, "src/lib/schema.js");
  load(ctx, "src/lib/gmail.js");
  const { getMessage } = take(ctx, "({ getMessage: Gmail.getMessage })");
  return { getMessage, sentAuth: () => authHeader };
}

function headers(subject, from) {
  return [
    { name: "Subject", value: subject },
    { name: "From", value: from },
    { name: "Date", value: "Tue, 6 Oct 2026 01:16:00 +0000" }
  ];
}

// ---- the bug, stated as an assertion rather than left to a crash ---------
//
// Reproducing the original failure explicitly matters because with the bug
// present every case below dies on its first line and the harness reports
// CRASHED, losing the other six suites. This asserts the cause directly.
async function workerHasNoDocument() {
  const chromeMock = makeChrome({
    storage: makeStorage({ gmailAuth: { accessToken: "AT", expiresAt: Date.now() + 3600_000 } }),
    overrides: {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "m0",
          payload: {
            mimeType: "text/html",
            headers: headers("Subject", "a@b.com"),
            body: { data: b64url('<p>Applied</p><a href="https://x.com/j">Job</a>') }
          }
        })
      })
    }
  });

  const ctx = makeContext({ chrome: chromeMock });
  load(ctx, "src/lib/schema.js");
  load(ctx, "src/lib/gmail.js");

  eq("gmail.js runs with no document, as in the service worker", typeof ctx.document, "undefined");

  const { getMessage } = take(ctx, "({ getMessage: Gmail.getMessage })");

  // Trapped, because an untrapped ReferenceError here kills the whole harness
  // file and the runner loses this suite's other 34 assertions along with it.
  let message = null;
  let error = "";
  try {
    message = await getMessage(SETTINGS, "m0");
  } catch (err) {
    error = err.message;
  }

  eq("html mail decodes without a DOM", error, "");
  ok("a message object came back", !!message);
  // Anchor text stays in the body: a job title is often only in the link label.
  eq("body text extracted", message && message.body, "Applied\nJob");
  eq("anchor decoded without a DOM", message && message.links[0] && message.links[0].href, "https://x.com/j");
}

async function run() {
  console.log("--- service worker has no document, and mail still decodes ---");
  await workerHasNoDocument();

  console.log("--- html-only mail, the common ATS shape ---");
  {
    const html = [
      "<html><head><style>.btn{color:red}</style></head><body>",
      "<p>We have received your application for the <b>Backend Engineer</b> role.</p>",
      "<p>Job posting: <a href=\"https://boards.greenhouse.io/acme/jobs/42?utm_source=mail\">View the role</a></p>",
      "<div>Acme Corp Talent Team</div>",
      "</body></html>"
    ].join("");

    const { getMessage } = makeCtx({
      id: "m1",
      threadId: "t1",
      snippet: "We have received your application",
      payload: {
        mimeType: "multipart/alternative",
        headers: headers("Application received: Backend Engineer at Acme Corp", "Acme Careers <careers@acme.com>"),
        parts: [{ mimeType: "text/html", body: { data: b64url(html) } }]
      }
    });

    const message = await getMessage(SETTINGS, "m1");

    eq("id captured", message.id, "m1");
    eq("subject captured", message.subject, "Application received: Backend Engineer at Acme Corp");
    eq("sender name parsed", message.from.name, "Acme Careers");
    eq("sender address parsed", message.from.address, "careers@acme.com");
    ok("body is non-empty", message.body.length > 0);
    ok("body contains the role", message.body.includes("Backend Engineer"));
    ok("body contains the company", message.body.includes("Acme Corp"));
    ok("body does not leak css", !message.body.includes("color:red"));
    ok("body has no leftover tags", !/<[a-z]/i.test(message.body));

    // The link is the single most useful fact in a confirmation mail and it only
    // exists in the markup.
    eq("one anchor captured", message.links.length, 1);
    eq("anchor href captured", message.links[0].href, "https://boards.greenhouse.io/acme/jobs/42?utm_source=mail");
    eq("anchor text captured", message.links[0].text, "View the role");
  }

  console.log("--- multipart: plain text wins, links still mined from the html ---");
  {
    const html = '<p>Thanks!</p><a href="https://acme.com/status">Track your application</a>';
    const { getMessage } = makeCtx({
      id: "m2",
      payload: {
        mimeType: "multipart/alternative",
        headers: headers("Your application", "no-reply@acme.com"),
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Thanks!\nBackend Engineer\nAcme Corp") } },
          { mimeType: "text/html", body: { data: b64url(html) } }
        ]
      }
    });

    const message = await getMessage(SETTINGS, "m2");
    eq("plain text preferred", message.body, "Thanks!\nBackend Engineer\nAcme Corp");
    eq("anchor still found in the html part", message.links.length, 1);
    eq("anchor href", message.links[0].href, "https://acme.com/status");
  }

  console.log("--- nested multipart/related with an inline image ---");
  {
    const { getMessage } = makeCtx({
      id: "m3",
      payload: {
        mimeType: "multipart/related",
        headers: headers("Interview invitation", "Acme <careers@acme.com>"),
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("We would like to invite you to a phone screen.") } },
              {
                mimeType: "text/html",
                body: { data: b64url('<p>Phone screen</p><a href="https://acme.com/sched">Pick a time</a><img src="cid:logo">') }
              }
            ]
          },
          { mimeType: "image/png", filename: "logo.png", body: { data: b64url("PNGnottext") } }
        ]
      }
    });

    const message = await getMessage(SETTINGS, "m3");
    ok("walked into the nested alternative part", message.body.includes("phone screen"));
    eq("anchor found at depth", message.links.length, 1);
    eq("anchor href at depth", message.links[0].href, "https://acme.com/sched");
  }

  console.log("--- html entities and script/style stripping ---");
  {
    const html =
      "<style>p{color:#333}</style><script>alert('x')</script>" +
      "<p>Role: Frontend &amp; Platform Engineer &#8211; Acme &lt;Corp&gt;</p>" +
      '<a href="https://acme.com/j?a=1&amp;b=2">Apply &amp; view</a>';
    const { getMessage } = makeCtx({
      id: "m4",
      payload: {
        mimeType: "text/html",
        headers: headers("Applied", "talent@acme.com"),
        body: { data: b64url(html) }
      }
    });

    const message = await getMessage(SETTINGS, "m4");
    ok("named entity decoded", message.body.includes("Frontend & Platform Engineer"));
    ok("numeric entity decoded", message.body.includes("–"));
    ok("lt/gt decoded", message.body.includes("Acme <Corp>"));
    ok("style dropped", !message.body.includes("color:#333"));
    ok("script body dropped", !message.body.includes("alert"));
    eq("href entities decoded", message.links[0].href, "https://acme.com/j?a=1&b=2");
    eq("anchor text entities decoded", message.links[0].text, "Apply & view");
  }

  console.log("--- anchors without an href, and block tags becoming line breaks ---");
  {
    const html = '<a name="top"></a><p>Line one</p><p>Line two</p><table><tr><td>Cell</td></tr></table>';
    const { getMessage } = makeCtx({
      id: "m5",
      payload: { mimeType: "text/html", headers: headers("X", "a@b.com"), body: { data: b64url(html) } }
    });

    const message = await getMessage(SETTINGS, "m5");
    eq("hrefless anchor dropped", message.links.length, 0);
    ok("paragraph break kept as a newline", /Line one\nLine two/.test(message.body));
    ok("table cell text kept", message.body.includes("Cell"));
  }

  console.log("--- malformed input degrades instead of throwing ---");
  {
    // Every message in a real inbox, so one bad tree cannot end a run.
    const { getMessage } = makeCtx({
      id: "m6",
      payload: {
        mimeType: "text/html",
        headers: headers("Subject", "From"),
        body: { data: "!!!not-base64!!!" }
      }
    });

    const message = await getMessage(SETTINGS, "m6");
    eq("still returned", message.id, "m6");
    eq("body empty rather than throwing", message.body, "");
    eq("no links rather than throwing", message.links.length, 0);
  }

  console.log("--- the access token is attached ---");
  {
    const { getMessage, sentAuth } = makeCtx({
      id: "m7",
      payload: { mimeType: "text/plain", headers: headers("S", "f@e.com"), body: { data: b64url("hi") } }
    });
    await getMessage(SETTINGS, "m7");
    eq("bearer token sent", sentAuth(), "Bearer AT");
  }
}

// A throw anywhere above is reported as a failed assertion rather than a crashed
// process. With the original DOM-based decoder present, every case here throws a
// ReferenceError; uncaught that aborts the file, and the runner prints
// CRASHED -- which loses this suite's passing assertions and reads as an
// infrastructure problem rather than the product bug it is.
run()
  .then(done)
  .catch((err) => {
    console.log(`  FAIL suite threw: ${err && err.message}`);
    ok("every decode case ran to completion", false);
    process.exitCode = done();
  });
