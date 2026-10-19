// Verifies a Google ID token and returns the identity behind it.
//
// Uses Google's tokeninfo endpoint rather than verifying the RS256 signature
// locally. tokeninfo is a single GET with no key management, no JWKS caching
// and no crypto dependency of our own, which is the right trade for a sign-in
// endpoint: Google is the authority on its own tokens, and the endpoint already
// checks signature and expiry. It does add one network hop to sign-in, which
// happens once per session, not per request.
//
// `clientId` is checked here rather than trusted from the token: a tokeninfo
// response is valid for ANY client that asks, so without this check a token
// minted for some other app would be accepted as a login to ours.

async function verifyGoogleIdToken(idToken, { clientId, tokeninfoUrl, fetchImpl = fetch } = {}) {
  if (!idToken || typeof idToken !== "string") {
    throw new Error("missing id token");
  }

  const url = `${tokeninfoUrl}?id_token=${encodeURIComponent(idToken)}`;

  let res;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new Error("could not reach Google to verify the token");
  }

  if (!res.ok) {
    // 400 is Google's answer to a malformed, expired or unverifiable token.
    throw new Error(`Google rejected the token (${res.status})`);
  }

  const data = await res.json();

  if (clientId && data.aud !== clientId) {
    throw new Error("token was issued for a different client");
  }

  // Google returns email_verified as the string "true"/"false" from tokeninfo.
  // An unverified address is not an identity we can key an account on.
  if (data.email_verified === "false" || data.email_verified === false) {
    throw new Error("email is not verified");
  }

  if (!data.sub || !data.email) {
    throw new Error("token is missing the subject or email");
  }

  const exp = Number(data.exp) * 1000;
  if (Number.isFinite(exp) && exp > 0 && exp < Date.now()) {
    throw new Error("token has expired");
  }

  return {
    userId: String(data.sub),
    email: String(data.email),
    name: String(data.name || ""),
    picture: String(data.picture || "")
  };
}

module.exports = { verifyGoogleIdToken };
