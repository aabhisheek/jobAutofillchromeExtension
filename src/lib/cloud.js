// Cloud sign-in for the extension.
//
// This is the client half of server/: it runs the same Google consent flow the
// Gmail importer already uses (chrome.identity.launchWebAuthFlow, authorization
// code + PKCE), but asks for identity scopes instead of mailbox access, then
// hands the resulting ID token to our backend. The backend verifies the token
// with Google and returns a session token; the extension stores that and shows
// the signed-in state.
//
// Why go through a backend at all, when the ID token is already proof of
// identity? Because the extension must not be the authority on who is signed
// in. An ID token proves identity to *whoever verifies it*; the backend is
// where that verification (and, later, the user's own data) lives. The session
// token it returns is the extension's key to those future calls.
//
// Scope of this pass: sign in, sign out, and know the signed-in identity. No
// application data is sent or fetched yet.

const CLOUD_SESSION_KEY = "cloudSession";

// Where the sign-in backend lives until the user points it somewhere else. The
// bundled value is the local server; a deployment sets its own URL in the
// Account panel (settings.cloudApiUrl).
const DEFAULT_CLOUD_API_URL = "http://localhost:8787";

// Prefixed `CLOUD_` on purpose: these are classic scripts sharing one global
// scope with gmail.js, which already declares its own TOKEN_URL and
// OAUTH_AUTH_URL. Two top-level `const`s of the same name in one global scope
// is a redeclaration error that would take the whole dashboard down.
const CLOUD_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CLOUD_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Identity only. No Gmail scope here: signing in must not drag mailbox access
// along with it, so an account that only wants the board is asked for nothing
// more than who it is.
const SIGNIN_SCOPE = "openid email profile";

// ---- PKCE (RFC 7636) ---------------------------------------------------
//
// The client is public (no secret that can be kept), so the code is bound to
// this one request with a verifier only this page knows. Same mechanism as
// gmail.js; the helpers are name-spaced rather than imported because the two
// flows are independent — a change to the mail importer must not be able to
// break sign-in, and two same-named top-level consts in one global scope would.

function cloudBase64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cloudRandomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return cloudBase64UrlEncode(bytes);
}

async function cloudChallengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return cloudBase64UrlEncode(new Uint8Array(digest));
}

function cloudNewState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- settings ----------------------------------------------------------

// The base URL of the sign-in backend, with any trailing slash removed so
// `${base}/auth/google` can never become a double slash.
function apiUrl(settings) {
  const configured = settings && settings.cloudApiUrl;
  const value = typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_CLOUD_API_URL;
  return value.replace(/\/+$/, "");
}

// ---- stored session ----------------------------------------------------

// The stored session, or null when there is none or the one on file has
// expired. An expired token is cleared on read rather than returned, so no
// caller has to remember to check expiresAt — "no session" is the only thing
// that ever comes back without a valid token.
async function getSession() {
  const { [CLOUD_SESSION_KEY]: session } = await chrome.storage.local.get(CLOUD_SESSION_KEY);
  if (!session || typeof session !== "object" || !session.token) return null;

  if (session.expiresAt && session.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(CLOUD_SESSION_KEY);
    return null;
  }

  return session;
}

async function isSignedIn() {
  return !!(await getSession());
}

async function clearSession() {
  await chrome.storage.local.remove(CLOUD_SESSION_KEY);
}

// ---- the flow ----------------------------------------------------------

// Opens Google's consent screen and returns the ID token for the account the
// user chose. Must be called from an extension page, since it needs a live
// document for the consent window.
async function obtainIdToken(settings) {
  if (typeof Gmail === "undefined" || typeof Gmail.resolveCredentials !== "function") {
    throw new Error("Sign-in needs the extension's Google client, which was not loaded on this page.");
  }

  const { clientId, clientSecret } = await Gmail.resolveCredentials(settings);
  if (!clientId) {
    throw new Error("The Google client id is missing — reinstall the extension or add src/data/google-oauth.json.");
  }

  const codeVerifier = cloudRandomVerifier();
  const codeChallenge = await cloudChallengeFor(codeVerifier);
  const state = cloudNewState();

  // prompt=select_account every time: a machine with two Google accounts must
  // not silently sign into whichever Chrome last used, and an account picker is
  // exactly what "Sign in with Google" is expected to show.
  const url =
    `${CLOUD_AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(Gmail.redirectUrl())}` +
    `&scope=${encodeURIComponent(SIGNIN_SCOPE)}` +
    `&access_type=online` +
    `&prompt=select_account` +
    `&state=${state}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    throw new Error(
      `Google closed the sign-in window without completing (${err && err.message ? err.message : "no detail"}). ` +
      `If the window showed "Error 400: redirect_uri_mismatch", the client id is not registered for this extension (${chrome.runtime.id}).`
    );
  }

  if (!responseUrl) throw new Error("Sign-in was cancelled.");

  const returned = new URL(responseUrl);

  // Google's own error is reported before the state check — an error response
  // mints nothing, and "access denied" beats a misleading "state mismatch".
  const error = returned.searchParams.get("error");
  if (error) {
    const description = returned.searchParams.get("error_description") || "";
    throw new Error(`Google returned ${error}${description ? `: ${description}` : ""}.`);
  }

  if (returned.searchParams.get("state") !== state) {
    throw new Error("Google's reply did not match this sign-in attempt (state mismatch). Try again.");
  }

  const code = returned.searchParams.get("code");
  if (!code) throw new Error("Google's response had no authorization code.");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    grant_type: "authorization_code",
    redirect_uri: Gmail.redirectUrl(),
    code_verifier: codeVerifier
  });
  // Only Web-client ids need this; treated as public, same as gmail.js.
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(CLOUD_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google rejected the sign-in (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.id_token) throw new Error("Google did not return an ID token for sign-in.");
  return data.id_token;
}

// Signs in and stores the session. `settings` is required so the caller passes
// the same merged settings the rest of the page uses; it carries both the OAuth
// client and the backend URL.
async function signIn(settings) {
  const idToken = await obtainIdToken(settings);
  const base = apiUrl(settings);

  let res;
  try {
    res = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken })
    });
  } catch {
    throw new Error(`Could not reach the sign-in server at ${base}. Check the server URL and that it is running.`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`The sign-in server rejected the account (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
  }

  const data = await res.json();
  const session = {
    token: data.token,
    userId: data.userId || "",
    email: data.email || "",
    name: data.name || "",
    picture: data.picture || "",
    expiresAt: Number(data.expiresAt) || 0
  };

  await chrome.storage.local.set({ [CLOUD_SESSION_KEY]: session });
  return session;
}

// Drops the local session, telling the server first (best effort). A server
// that is unreachable must not trap the user in a signed-in state, so the clear
// happens either way.
async function signOut(settings) {
  const session = await getSession();
  if (session) {
    try {
      await fetch(`${apiUrl(settings)}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` }
      });
    } catch {
      // Offline logout is still a logout.
    }
  }
  await clearSession();
}

const Cloud = {
  SESSION_KEY: CLOUD_SESSION_KEY,
  DEFAULT_API_URL: DEFAULT_CLOUD_API_URL,
  SIGNIN_SCOPE,
  apiUrl,
  getSession,
  isSignedIn,
  signIn,
  signOut,
  clearSession
};
