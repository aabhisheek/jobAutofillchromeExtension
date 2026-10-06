// Exercises the OAuth consent callback handling in gmail.js: the state check,
// the error passthrough, and the failure mode that made this bug undiagnosable.
//
// The interesting property under test is that `launchWebAuthFlow` only settles
// when Google actually redirects back. When the redirect_uri is wrong, Google
// renders an error page *inside* the flow window and never redirects, so the
// promise stays pending until the user closes the window. Everything here drives
// `connect()` with a stubbed launchWebAuthFlow.
//
// Run: node tests/verify-oauth-connect.js

const vm = require("vm");
const { ROOT, makeChrome, makeContext, makeStorage, load, take, expect } = require("./harness");

const { eq, ok, done } = expect("oauth-connect");

const CLIENT_ID = "123.apps.googleusercontent.com";
const REDIRECT = "https://testextensionid.chromiumapp.org/";

// Records what was sent to Google and replays a chosen redirect back.
function makeCtx(behaviour) {
  const sent = { url: null };
  const chromeMock = makeChrome({
    storage: makeStorage(),
    overrides: {
      runtime: { ...makeChrome().runtime, id: "testextensionid" },
      identity: {
        getRedirectURL: () => REDIRECT,
        launchWebAuthFlow: ({ url }) => {
          sent.url = url;
          return behaviour(url);
        }
      },
      // The code-for-token POST. Not the subject here, but the happy path
      // cannot reach "connected" without it. Only the token endpoint is
      // recorded: connect() also reads the profile afterwards, which is a GET
      // with no body and would otherwise overwrite what we captured.
      fetch: async (url, init) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          sent.tokenBody = init && init.body ? String(init.body) : "";
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "AT",
            refresh_token: "RT",
            expires_in: 3600
          })
        };
      }
    }
  });
  // The PKCE verifier is generated inside the module and never leaves the
  // browser in the authorize request, so it is observed the only way a test
  // honestly can: by watching what gets hashed into the code_challenge.
  // `crypto` is allow-listed in the harness, so overriding it here is the only
  // seam needed -- no test-only hook inside gmail.js itself.
  // Methods are copied by reference rather than spread: webcrypto's live
  // methods sit on the prototype, and spreading would drop getRandomValues --
  // which is exactly what newState() needs to build the CSRF token.
  const spyCrypto = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
    randomUUID: crypto.randomUUID.bind(crypto),
    subtle: {
      digest: async (algo, data) => {
        sent.verifier = new TextDecoder().decode(data);
        return crypto.subtle.digest(algo, data);
      }
    }
  };

  const ctx = makeContext({ chrome: chromeMock, globals: { crypto: spyCrypto } });
  load(ctx, "src/lib/schema.js");
  load(ctx, "src/lib/gmail.js");
  const { connect } = take(ctx, "({ connect: Gmail.connect })");
  return { connect, sent, chromeMock };
}

(async () => {
  const params = (url) => new URL(url).searchParams;

  // ---- 1. the happy path, and what went out on the wire -------------------
  {
    const { connect, sent } = makeCtx((url) => {
      const s = params(url).get("state");
      return Promise.resolve(`chrome-extension://testextensionid/?state=${s}&code=CODE123&scope=x`);
    });

    const auth = await connect({ settings: { gmailClientId: CLIENT_ID } });

    const q = params(sent.url);
    // PKCE. The verifier is never sent to the authorize endpoint; only its
    // SHA-256, which is what makes an intercepted code useless on its own.
    eq("challenge method is S256", q.get("code_challenge_method"), "S256");
    const challenge = q.get("code_challenge") || "";
    ok("challenge is present", challenge.length > 0);
    eq("challenge is base64url, not base64", /[+/=]/.test(challenge), false);
    eq(
      "challenge is the SHA-256 of the verifier",
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent.verifier)),
        "binary"
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      challenge
    );
    eq("client id sent", q.get("client_id"), CLIENT_ID);
    eq("response_type", q.get("response_type"), "code");
    // The bug: this used to be `.../oauth2`, which Google never registered.
    eq("redirect_uri is the bare origin", q.get("redirect_uri"), REDIRECT);
    eq("scope is gmail readonly", q.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
    eq("offline access for a refresh token", q.get("access_type"), "offline");
    eq("consent forced", q.get("prompt"), "consent");
    ok("a state token is sent", !!q.get("state"));
    eq("state is long enough to be unguessable", q.get("state").length >= 32, true);

    // The token exchange must use the same redirect_uri as the auth request, or
    // Google rejects the code. A classic and very quiet OAuth bug.
    const tokenBody = new URLSearchParams(sent.tokenBody);
    eq("token exchange reuses the same redirect_uri", tokenBody.get("redirect_uri"), REDIRECT);
    eq("token exchange sends the code", tokenBody.get("code"), "CODE123");
    // No client id, no secret: a Chrome Extension client type. Sending an empty
    // client_secret is not the same as omitting it -- Google reads the empty
    // string as a configured-but-wrong secret.
    eq("token exchange sends no secret", tokenBody.get("client_secret"), null);
    eq("token exchange proves the verifier", tokenBody.get("code_verifier"), sent.verifier);
    ok("token stored", !!(auth && auth.connected));
  }

  // ---- 1b. a Web client id sends its secret, verifier still included -----
  {
    const { connect, sent } = makeCtx((url) =>
      Promise.resolve(`chrome-extension://testextensionid/?state=${params(url).get("state")}&code=CODE123`)
    );

    await connect({
      settings: { gmailClientId: CLIENT_ID, gmailClientSecret: "GOCSPX-FAKE-TEST-ONLY-VALUE" }
    });

    const tokenBody = new URLSearchParams(sent.tokenBody);
    // The failure this fixes: Google's token endpoint answers
    // `client_secret is missing` for a Web client id when the secret is absent.
    eq(
      "web client sends its secret",
      tokenBody.get("client_secret"),
      "GOCSPX-FAKE-TEST-ONLY-VALUE"
    );
    eq("and still proves the verifier", tokenBody.get("code_verifier"), sent.verifier);
  }

  // ---- 1c. a whitespace-only secret is treated as no secret --------------
  {
    const { connect, sent } = makeCtx((url) =>
      Promise.resolve(`chrome-extension://testextensionid/?state=${params(url).get("state")}&code=C`)
    );

    await connect({ settings: { gmailClientId: CLIENT_ID, gmailClientSecret: "   " } });

    eq("blank secret is omitted, not sent empty", new URLSearchParams(sent.tokenBody).get("client_secret"), null);
  }

  // ---- 2. state must be single-use and unpredictable ----------------------
  {
    const { connect, sent } = makeCtx((url) =>
      Promise.resolve(`chrome-extension://testextensionid/?state=${params(url).get("state")}&code=C`)
    );
    await connect({ settings: { gmailClientId: CLIENT_ID } });
    const first = params(sent.url).get("state");
    await connect({ settings: { gmailClientId: CLIENT_ID } });
    const second = params(sent.url).get("state");
    ok("a second attempt gets a different state", first !== second);
  }

  // ---- 3. a replayed / forged callback is rejected ------------------------
  {
    const { connect } = makeCtx(() =>
      // A callback carrying someone else's state: the classic CSRF case.
      Promise.resolve("chrome-extension://testextensionid/?state=attacker&code=STOLEN")
    );
    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("mismatched state is refused", /state mismatch/i.test(message));
    ok("and it does not leak the code", !/STOLEN/.test(message));
  }

  // ---- 4. a missing state is also refused --------------------------------
  {
    const { connect } = makeCtx(() =>
      Promise.resolve("chrome-extension://testextensionid/?code=NO_STATE")
    );
    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("absent state is refused", /state mismatch/i.test(message));
  }

  // ---- 5. Google's own error is surfaced, not swallowed -------------------
  {
    const { connect } = makeCtx((url) =>
      Promise.resolve(
        `chrome-extension://testextensionid/?state=${params(url).get("state")}` +
          "&error=access_denied&error_description=The+user+denied+access"
      )
    );
    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("error code surfaced", /access_denied/.test(message));
    ok("description surfaced", /user denied access/i.test(message));
  }

  // ---- 5b. an error with no state still names the real reason ------------
  {
    const { connect } = makeCtx(() =>
      Promise.resolve("chrome-extension://testextensionid/?error=access_denied")
    );
    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("error beats the state complaint", /access_denied/.test(message));
    ok("and does not claim a state problem", !/state mismatch/i.test(message));
  }

  // ---- 6. the silent-failure path names the real cause -------------------
  {
    // What a bad Application ID actually looks like: Google paints an error page
    // in the flow window, never redirects, and the user closes it.
    const { connect } = makeCtx(() => Promise.reject(new Error("Authorization page could not be loaded.")));

    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("mentions redirect_uri_mismatch", /redirect_uri_mismatch/.test(message));
    ok("names the extension id to compare", /testextensionid/.test(message));
  }

  // ---- 7. nothing is requested before the client id is known --------------
  {
    let permissionRequested = false;
    const chromeMock = makeChrome({
      storage: makeStorage(),
      overrides: { permissions: { request: async () => { permissionRequested = true; return true; } } }
    });
    const ctx = makeContext({ chrome: chromeMock });
    load(ctx, "src/lib/schema.js");
    load(ctx, "src/lib/gmail.js");
    const { connect } = take(ctx, "({ connect: Gmail.connect })");

    let message = "";
    try {
      await connect({ settings: {} });
    } catch (err) {
      message = err.message;
    }
    ok("missing client id refused", /client id/i.test(message));
    eq("and no permission prompt was raised", permissionRequested, false);
  }

  // ---- 8. declining host permissions never opens the consent window -------
  {
    let flowStarted = false;
    const chromeMock = makeChrome({
      storage: makeStorage(),
      overrides: {
        permissions: { request: async () => false },
        identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow: () => { flowStarted = true; } }
      }
    });
    const ctx = makeContext({ chrome: chromeMock });
    load(ctx, "src/lib/schema.js");
    load(ctx, "src/lib/gmail.js");
    const { connect } = take(ctx, "({ connect: Gmail.connect })");

    let message = "";
    try {
      await connect({ settings: { gmailClientId: CLIENT_ID } });
    } catch (err) {
      message = err.message;
    }
    ok("declined permission explained", /declined/i.test(message));
    eq("consent window never opened", flowStarted, false);
  }

  process.exit(done() ? 1 : 0);
})();
