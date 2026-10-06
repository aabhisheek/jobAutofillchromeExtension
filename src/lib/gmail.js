// Gmail access for the email importer, over the REST API with the extension's
// own OAuth client.
//
// Why the API and not the Gmail web page: a DOM scraper breaks the week Google
// renames a class, and it would have to steal a live tab. The API is a contract.
// It does need the user to paste a Google Cloud OAuth client id once, which is
// the price of never having this extension ask for a password.
//
// What it asks for is gmail.readonly and nothing else — no send, no delete, no
// label writes. The token lives in chrome.storage.local next to the rest of the
// user's data and is only ever sent back to googleapis.com.
//
// Split of responsibility with the service worker:
//   - launchWebAuthFlow() opens a real consent window, so it is only called
//     from an extension page (the dashboard's Gmail panel). It is not called
//     from background.js.
//   - everything else — refresh, API reads — is plain fetch and works in both,
//     which is what lets the daily chrome.alarms run unattended.

const GMAIL_AUTH_KEY = "gmailAuth";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// Read-only, full stop. Gmail has no narrower scope that still lists messages.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Google's own OAuth guide calls this the "TVs and Limited Input devices" type.
// It is a public client: there is no client secret to ship or protect, which is
// the only reason this can be dependency-free and buildless.
//
// A client secret is still *accepted* when one is configured, because Google's
// token endpoint asks for one on some client types. It is treated as a public
// value, which is Google's own position for installed apps: "…which you embed in
// the source code of your application. (In this context, the client secret is
// obviously not treated as a secret.)" It is stored in chrome.storage.local and
// never written into this repository, which is public.
const TOKEN_TYPE = "urn:ietf:params:oauth:token-type:oauth2";
const ACCESS_TYPE = "offline";
const PROMPT = "consent";

// PKCE (RFC 7636), S256. Binds the authorization code to this one request, so an
// code intercepted in the redirect cannot be redeemed by anyone else. This is
// what allows the flow to work without relying on the client secret at all.
function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

// Refresh this far out rather than at expiry, so a sync that starts at 08:59
// does not discover at 09:00 that the token died mid-request.
const EXPIRY_MARGIN_MS = 60_000;

const DEFAULT_MAX_RESULTS = 25;

// Hard ceiling per sync. A query the user has fat-fingered into matching their
// whole inbox should not turn into thousands of API calls and a correspondingly
// large AI bill.
const MAX_RESULTS_CEILING = 100;

// ---- stored auth -------------------------------------------------------

async function readAuth() {
  const { [GMAIL_AUTH_KEY]: auth } = await chrome.storage.local.get(GMAIL_AUTH_KEY);
  return auth && typeof auth === "object" ? auth : null;
}

async function writeAuth(auth) {
  if (!auth) await chrome.storage.local.remove(GMAIL_AUTH_KEY);
  else await chrome.storage.local.set({ [GMAIL_AUTH_KEY]: auth });
  return auth;
}

function isConnected(auth) {
  return !!(auth && auth.refreshToken);
}

// Redirect URL for chrome.identity.launchWebAuthFlow.
//
// Must be the BARE origin, no path. A Google Cloud OAuth client of type
// "Chrome Extension" is configured with nothing but the extension id, and
// Google then registers exactly `https://<id>.chromiumapp.org/` for it. Passing
// a path argument here — `getRedirectURL("oauth2")` — appends a segment that
// was never registered, and every consent attempt dies with
// `Error 400: redirect_uri_mismatch` before the user ever sees a consent
// screen. So: no argument.
function redirectUrl() {
  return chrome.identity.getRedirectURL();
}

// The two Google origins, which live in the manifest's optional permissions so
// an extension that never connects to Gmail never holds them.
function requiredOrigins() {
  return ["https://gmail.googleapis.com/*", "https://oauth2.googleapis.com/*"];
}

// ---- token lifecycle ---------------------------------------------------

async function exchangeCodeForTokens(code, clientId, clientSecret, codeVerifier) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    grant_type: "authorization_code",
    redirect_uri: redirectUrl()
  });
  // PKCE: proves this exchange belongs to the authorize request we started, so
  // a code grabbed from the redirect cannot be redeemed by someone else.
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  // Google's token endpoint answers `invalid_request: client_secret is missing`
  // on Web-client ids, so it is sent when configured. See the note at the top
  // of this file: for an installed app Google does not treat it as a secret.
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google rejected the authorization code (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token || "",
    // A granted-but-not-issued refresh token means the account was already
    // connected; the access token still works, but the daily sync would die
    // within the hour. Worth surfacing rather than pretending all is well.
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    email: ""
  };
}

async function refreshAccessToken(auth, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token"
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    // invalid_grant is Google's way of saying the grant was revoked or the
    // password changed. No amount of retrying fixes it, so the stored token is
    // dropped and the user is asked to reconnect instead of being told to try
    // again later.
    if (res.status === 400 || res.status === 401) await writeAuth(null);
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail token refresh failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const next = {
    ...auth,
    accessToken: data.access_token || "",
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
  await writeAuth(next);
  return next;
}

// Returns a usable access token, refreshing first when the current one is at or
// near expiry. Safe to call from the service worker with no user gesture.
async function ensureAccessToken(settings) {
  const auth = await readAuth();
  if (!auth || !auth.accessToken) throw new Error("Gmail is not connected yet.");

  if (auth.expiresAt && auth.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return auth;

  const clientId = String((settings && settings.gmailClientId) || "").trim();
  if (!clientId) throw new Error("Add your Google OAuth client id before syncing.");
  if (!auth.refreshToken) throw new Error("Gmail needs reconnecting to get a refresh token.");

  return refreshAccessToken(auth, clientId, String((settings && settings.gmailClientSecret) || "").trim());
}

// Single-use CSRF token for one consent attempt. Held in memory rather than
// storage: `connect()` only ever runs from a live extension page, so the token
// does not need to outlive the page, and keeping it out of storage means it
// cannot be replayed from a stale value later.
let pendingState = null;

function newState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Opens Google's consent screen. Must be called from an extension page, and
// needs the optional host permissions granted first — a user who declines the
// permission prompt should get an explanation, not an opaque OAuth failure.
async function connect({ settings, interactive = true } = {}) {
  const clientId = String((settings && settings.gmailClientId) || "").trim();
  if (!clientId) throw new Error("Paste your Google OAuth client id first.");

  const granted = await chrome.permissions.request({ origins: requiredOrigins() });
  if (!granted) throw new Error("Network access to Google was declined, so Gmail stays disconnected.");

  const state = newState();
  pendingState = state;

  const clientSecret = String((settings && settings.gmailClientSecret) || "").trim();
  const codeVerifier = randomVerifier();
  const codeChallenge = await challengeFor(codeVerifier);

  // prompt=consent is what makes Google issue a refresh token the first time.
  // Without it a user who has already granted the scope silently gets no
  // refresh_token and the connection dies an hour later.
  const url =
    `${OAUTH_AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUrl())}` +
    `&scope=${encodeURIComponent(GMAIL_SCOPE)}` +
    `&access_type=${ACCESS_TYPE}` +
    `&prompt=${PROMPT}` +
    `&state=${state}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256` +
    `&include_granted_scopes=true`;

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url,
      interactive: interactive !== false
    });
  } catch (err) {
    // A rejected redirect_uri never comes back to us: Google renders an error
    // page inside the flow window instead of redirecting, so this promise only
    // settles when the user closes that window. That is why the failure looks
    // mute in the panel. Name the one cause worth checking.
    throw new Error(
      `Google closed the sign-in window without completing (${err && err.message ? err.message : "no detail"}). ` +
      `If the window showed "Error 400: redirect_uri_mismatch", the client's Application ID in Google Cloud ` +
      `is not this extension's ID (${chrome.runtime.id}).`
    );
  } finally {
    pendingState = null;
  }

  if (!responseUrl) throw new Error("Google sign-in was cancelled.");

  // Google redirects back to chrome-extension://<id>/?state=…&code=…, which
  // chrome.identity hands to us instead of navigating to.
  const returned = new URL(responseUrl);

  // Google's own error is surfaced before the state check. The state check is
  // there to stop a forged or replayed `code` being redeemed, so it guards the
  // code path only; an `error` response mints nothing and its text comes from
  // Google, not from an attacker. Reporting it first means a declined consent
  // screen says "access denied" instead of the useless "state mismatch".
  const error = returned.searchParams.get("error");
  if (error) {
    const description = returned.searchParams.get("error_description") || "";
    throw new Error(`Google returned ${error}${description ? `: ${description}` : ""}.`);
  }

  const returnedState = returned.searchParams.get("state");
  if (!state || returnedState !== state) {
    throw new Error("Google's reply did not match this sign-in attempt (state mismatch). Try connecting again.");
  }

  const code = returned.searchParams.get("code");
  if (!code) throw new Error("Google's response had no authorization code.");

  const auth = await exchangeCodeForTokens(code, clientId, clientSecret, codeVerifier);
  await writeAuth(auth);
  return getConnection(settings, auth);
}

async function disconnect() {
  await writeAuth(null);
}

// ---- API reads ---------------------------------------------------------

async function gmailFetch(settings, path) {
  const auth = await ensureAccessToken(settings);
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  // A 401 here means the token was revoked mid-session rather than being
  // expired, so the same drop-and-reconnect treatment applies.
  if (res.status === 401) {
    await writeAuth(null);
    throw new Error("Gmail rejected the saved authorization. Reconnect to continue.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail request failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  return res.json();
}

// The address the token is bound to. Cached on the auth record so the panel has
// something to show without spending a request on every render.
//
// `settings` is threaded through every API helper rather than read from storage
// here, because refreshing a token needs the OAuth client id and a helper that
// had to fetch settings itself would be doing a second, redundant read on every
// single message.
async function getConnection(settings, authOverride) {
  const auth = authOverride || (await readAuth());
  if (!isConnected(auth)) return { connected: false, email: "" };

  if (auth.email) return { connected: true, email: auth.email };

  try {
    const data = await gmailFetch(settings, "/profile");
    const email = data.emailAddress || "";
    if (email) await writeAuth({ ...auth, email });
    return { connected: true, email };
  } catch {
    // Not being able to read the address does not mean the mail cannot be read,
    // so this is reported as connected with an unknown address rather than as
    // a failure the user has to act on.
    return { connected: true, email: "" };
  }
}

// Message ids only — Gmail's list endpoint can carry full payloads, and the
// importer needs each body exactly once.
async function listMessageIds(settings, { query, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const capped = Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_RESULTS), MAX_RESULTS_CEILING);
  const params = new URLSearchParams({ maxResults: String(capped) });
  if (query) params.set("q", query);

  const data = await gmailFetch(settings, `/messages?${params}`);
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return messages.map((message) => message.id).filter(Boolean);
}

// ---- message decoding --------------------------------------------------

// Gmail's base64url: standard base64 with + and / swapped for - and _ and the
// padding dropped. atob() wants the padding back and the original alphabet.
function decodeBase64Url(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!text) return "";
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);

  try {
    const binary = atob(padded);
    // Byte-wise, not code-unit-wise: a UTF-8 subject arrives as one code point
    // per byte and collapsing that into a string directly mangles every
    // non-ASCII character into mojibake.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function headerValue(headers, name) {
  const match = (headers || []).find((header) => String(header.name || "").toLowerCase() === name);
  return match ? String(match.value || "") : "";
}

// Anchors out of raw html, and html down to readable text.
//
// Deliberately NOT the DOMParser/<template> trick used for job descriptions in
// page-scripts.js. That runs in a content script, which has a DOM. This runs in
// the service worker, which does not: there is no `document` to create a
// <template> from, and `document.createElement` there throws a ReferenceError for
// *every* message. That made each sync report every email as unreadable and
// import nothing, while the run still reported ok.
//
// These are regex passes over text that is never executed, which is the right
// trade for a worker anyway: no parsing cost, no nodes, no risk of a mail
// template's markup being interpreted as anything.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"' };

function decodeEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const key = String(name).toLowerCase();
    if (HTML_ENTITIES[key] != null) return HTML_ENTITIES[key];
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

// Walks the MIME tree for the best body available.
//
// text/plain is preferred because it is already readable text. text/html is the
// fallback for the many ATS mail templates that send nothing else.
//
// The html is also mined for anchors. A confirmation email's single most useful
// fact is its link to the posting or to an application-status page, and that
// link exists only in the markup — flattening to text throws it away. Anchors
// with no href are dropped here rather than filtered by every caller.
function collectBody(payload) {
  const plain = [];
  const html = [];
  const links = [];

  const walk = (part) => {
    if (!part || typeof part !== "object") return;
    const mime = String(part.mimeType || "").toLowerCase();

    if (mime === "text/plain" && part.body && part.body.data) {
      plain.push(decodeBase64Url(part.body.data));
    } else if (mime === "text/html" && part.body && part.body.data) {
      html.push(decodeBase64Url(part.body.data));
    }
    // multipart/alternative holds both formats; multipart/related holds the
    // html plus inline images. Either way the children are the real content.
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };

  walk(payload);

  const htmlText = html.join("\n");

  // href first, then the anchor's text: the href attribute itself often carries
  // tracking parameters that would otherwise dominate the captured text.
  for (const match of htmlText.matchAll(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^"'>\s]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!href) continue;
    links.push({ href, text: htmlToText(match[5] || "").trim() });
  }

  const text = plain.length ? plain.join("\n") : htmlToText(htmlText);

  return { text, links };
}

// Markup down to text. Script and style bodies are dropped outright rather than
// inlined, so a template's CSS does not end up in the body the parser reads for
// a job title. Block-level tags become newlines to keep the line-oriented
// heuristics downstream working on something resembling the original layout.
function htmlToText(html) {
  const stripped = String(html || "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function parseFromHeader(raw) {
  const value = String(raw || "");
  const bracket = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const name = (bracket ? bracket[1] : value).replace(/^["']|["']$/g, "").trim();
  const address = bracket ? bracket[2].trim() : "";
  return { name, address, domain: address.split("@")[1] || "" };
}

// One message as the importer wants it. Decoding lives here rather than in the
// importer so this file is the only place that knows Gmail's wire format.
async function getMessage(settings, id) {
  const data = await gmailFetch(settings, `/messages/${encodeURIComponent(id)}?format=full`);
  const headers = (data.payload && data.payload.headers) || [];
  const body = collectBody(data.payload);
  const dateHeader = headerValue(headers, "date");

  return {
    id: data.id || "",
    threadId: data.threadId || "",
    subject: headerValue(headers, "subject"),
    from: parseFromHeader(headerValue(headers, "from")),
    date: dateHeader || "",
    // When the mail actually arrived, in epoch milliseconds. internalDate is
    // Gmail's own clock and beats the Date header, which is the sending
    // client's clock and is occasionally nonsense. The importer stamps the
    // applied / rejected dates from this, so a sync records when the event
    // happened rather than the day the sync happened to run.
    receivedAt: Number(data.internalDate) || Date.parse(dateHeader) || 0,
    snippet: String(data.snippet || ""),
    body: body.text,
    links: body.links
  };
}

const Gmail = {
  SCOPE: GMAIL_SCOPE,
  DEFAULT_MAX_RESULTS,
  readAuth,
  isConnected,
  redirectUrl,
  requiredOrigins,
  connect,
  disconnect,
  ensureAccessToken,
  getConnection,
  listMessageIds,
  getMessage
};