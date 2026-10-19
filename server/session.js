// Session tokens: a minimal HS256 JWT, signed and verified with node:crypto.
//
// A JWT rather than a random opaque token in a database because there is no
// database yet: the whole point of this pass is a deployable sign-in that
// issues the extension a session it can later present, and a self-contained
// signed token does that with no server-side storage. When accounts grow real
// state, this is the piece to move behind a store — the token shape stays.

const crypto = require("node:crypto");

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  const text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function signatureFor(data, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(data).digest());
}

// Claims are kept to the minimum the extension needs to show a signed-in
// state: who the account is and when the session dies. `iat`/`exp` are added
// here so a caller only supplies identity.
function signSession(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + Math.floor(Number(ttlSeconds) || 0) };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;

  return `${data}.${signatureFor(data, secret)}`;
}

// Returns the verified payload, or null for anything malformed, mis-signed,
// tampered with or expired. A null is the single failure signal so callers
// cannot accidentally treat a partially-valid token as trustworthy.
function verifySession(token, secret) {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = signatureFor(`${header}.${body}`, secret);

  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so that is checked first; the
  // constant-time compare then stops a signature being forged byte by byte.
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;

  return payload;
}

module.exports = { signSession, verifySession };
