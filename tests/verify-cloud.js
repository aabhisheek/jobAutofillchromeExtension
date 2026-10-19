// The extension's cloud sign-in lib, run for real inside the harness vm with
// chrome.identity and fetch stubbed.
//
// gmail.js is loaded first because cloud.js reuses its OAuth client resolution
// and redirect URL — the same client the Gmail importer already ships — so the
// test proves the two actually share that setup rather than assuming it.
const { makeChrome, makeStorage, makeContext, loadAll, take, expect } = require("./harness");

const { eq, ok, done } = expect("cloud");

// One isolated world: fresh storage, fresh chrome and a fresh vm context.
// gmail.js caches the bundled OAuth client for the life of a context, so the
// "no client id" case needs its own world rather than a mutated fixture.
function makeWorld({ bundledCredentials }) {
  const state = {
    mode: "ok",
    lastAuthUrl: "",
    lastSessionUrl: "",
    lastSessionBody: null,
    lastExchangeBody: null,
    lastLogoutUrl: ""
  };

  function jsonRes(status, obj) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
      text: async () => JSON.stringify(obj)
    };
  }

  async function fetchStub(url, init) {
    const u = String(url);

    if (u.includes("google-oauth.json")) return jsonRes(200, bundledCredentials);

    if (u === "https://oauth2.googleapis.com/token") {
      state.lastExchangeBody = init && init.body;
      return jsonRes(200, { id_token: "IDTOKEN", access_token: "at", expires_in: 3600 });
    }

    if (u.endsWith("/auth/google")) {
      state.lastSessionUrl = u;
      if (state.mode === "unreachable") throw new Error("network down");
      if (state.mode === "server-reject") return jsonRes(401, { error: "invalid_google_token" });
      state.lastSessionBody = JSON.parse(init.body);
      return jsonRes(200, {
        token: "SESS.TOKEN.sig",
        userId: "u9",
        email: "user@example.com",
        name: "User Example",
        picture: "https://pic",
        expiresAt: Date.now() + 100000
      });
    }

    if (u.endsWith("/auth/logout")) {
      state.lastLogoutUrl = u;
      return jsonRes(200, { ok: true });
    }

    return jsonRes(404, { error: "not_found" });
  }

  const storage = makeStorage();
  const chromeMock = makeChrome({
    storage,
    overrides: {
      identity: {
        getRedirectURL: (p) => `https://testextensionid.chromiumapp.org/${p || ""}`,
        launchWebAuthFlow: async ({ url }) => {
          state.lastAuthUrl = url;
          const st = new URL(url).searchParams.get("state");
          if (state.mode === "cancel") return undefined;
          if (state.mode === "error") {
            return `https://testextensionid.chromiumapp.org/?error=access_denied&error_description=Denied&state=${st}`;
          }
          if (state.mode === "badstate") return "https://testextensionid.chromiumapp.org/?code=X&state=WRONG";
          return `https://testextensionid.chromiumapp.org/?code=AUTHCODE&state=${st}`;
        }
      },
      fetch: fetchStub
    }
  });

  const ctx = makeContext({ chrome: chromeMock });
  loadAll(ctx, ["src/lib/gmail.js", "src/lib/cloud.js"]);

  return { Cloud: take(ctx, "Cloud"), store: storage.store, state };
}

const settings = { cloudApiUrl: "https://api.example.test/", gmailClientId: "", gmailClientSecret: "" };

(async () => {
  const { Cloud, store, state } = makeWorld({ bundledCredentials: { web: { client_id: "cid-123", client_secret: "" } } });

  console.log("--- apiUrl ---");
  eq("defaults when unset", Cloud.apiUrl({}), "http://localhost:8787");
  eq("strips trailing slashes", Cloud.apiUrl({ cloudApiUrl: "https://api.example.test///" }), "https://api.example.test");
  eq("blank falls back to the default", Cloud.apiUrl({ cloudApiUrl: "   " }), "http://localhost:8787");

  console.log("--- initial state ---");
  eq("no session initially", await Cloud.getSession(), null);
  eq("isSignedIn is false", await Cloud.isSignedIn(), false);

  console.log("--- signIn ---");
  const session = await Cloud.signIn(settings);
  eq("returns the email", session.email, "user@example.com");
  eq("returns the name", session.name, "User Example");
  eq("returns the session token", session.token, "SESS.TOKEN.sig");
  ok("persists the session to storage", !!store.cloudSession);
  eq("getSession reads it back", (await Cloud.getSession()).email, "user@example.com");
  eq("isSignedIn is true", await Cloud.isSignedIn(), true);
  eq("talks to the configured server", state.lastSessionUrl, "https://api.example.test/auth/google");
  eq("forwards the Google id token", state.lastSessionBody.idToken, "IDTOKEN");

  console.log("--- the consent request ---");
  ok("asks only for openid/email/profile", /scope=openid(%20|\+)email(%20|\+)profile/.test(state.lastAuthUrl));
  ok("never asks for a Gmail scope", !/gmail/.test(state.lastAuthUrl));
  ok("asks for an account picker", /prompt=select_account/.test(state.lastAuthUrl));
  ok("uses PKCE S256", /code_challenge_method=S256/.test(state.lastAuthUrl));
  ok("redirects back to the extension origin", state.lastAuthUrl.includes(encodeURIComponent("https://testextensionid.chromiumapp.org/")));
  ok("sends the PKCE verifier on exchange", /code_verifier=/.test(String(state.lastExchangeBody)));
  ok("sends the auth code on exchange", /code=AUTHCODE/.test(String(state.lastExchangeBody)));

  console.log("--- signOut ---");
  await Cloud.signOut(settings);
  eq("clears the session", await Cloud.getSession(), null);
  eq("isSignedIn is false again", await Cloud.isSignedIn(), false);
  eq("tells the server", state.lastLogoutUrl, "https://api.example.test/auth/logout");

  console.log("--- expiry ---");
  store.cloudSession = { token: "t", email: "old@example.com", expiresAt: Date.now() - 1000 };
  eq("an expired session reads as null", await Cloud.getSession(), null);
  ok("an expired session is removed", store.cloudSession === undefined);

  console.log("--- failure paths ---");
  async function signInError() {
    try { await Cloud.signIn(settings); return null; } catch (err) { return err; }
  }

  state.mode = "cancel";
  let err = await signInError();
  ok("a cancelled flow rejects", err && /cancelled/i.test(err.message));

  state.mode = "error";
  err = await signInError();
  ok("Google's own error is surfaced", err && /access_denied/.test(err.message));

  state.mode = "badstate";
  err = await signInError();
  ok("a state mismatch is refused", err && /state mismatch/i.test(err.message));

  state.mode = "server-reject";
  err = await signInError();
  ok("a backend rejection is surfaced", err && /rejected the account/i.test(err.message));

  state.mode = "unreachable";
  err = await signInError();
  ok("an unreachable backend is surfaced", err && /could not reach/i.test(err.message));

  eq("no session was stored by any failure", await Cloud.getSession(), null);

  console.log("--- a missing OAuth client ---");
  const noClient = makeWorld({ bundledCredentials: {} });
  const missingErr = await noClient.Cloud.signIn({ cloudApiUrl: "https://api.example.test" }).then(() => null, (e) => e);
  ok("a missing client id is reported", missingErr && /client id is missing/i.test(missingErr.message));

  process.exitCode = done() ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
