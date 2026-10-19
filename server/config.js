// Server configuration, read from the environment with sane development
// defaults so `node server/index.js` works out of the box.
//
// The one value that must match the client is GOOGLE_CLIENT_ID: it is the
// audience stamped into every Google ID token, and verifyGoogleIdToken refuses
// a token minted for any other client. Every other value has a safe default.

// The extension's own OAuth client, the same one in src/data/google-oauth.json.
// Duplicated here as a default so a local server verifies tokens from the
// shipped client with no .env file at all. Override via GOOGLE_CLIENT_ID when
// deploying, and keep the two in step.
const DEFAULT_GOOGLE_CLIENT_ID =
  "818119178127-m1eibpeh0lqm4jpqe0rea40f720ollcb.apps.googleusercontent.com";

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";

  const rawOrigins = String(env.ALLOWED_ORIGINS || "");
  const allowedOrigins = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const config = {
    nodeEnv,
    port: Number(env.PORT || 8787),
    host: env.HOST || "0.0.0.0",
    googleClientId: env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID,
    // Overridable so tests can point at a stub instead of Google.
    googleTokeninfoUrl:
      env.GOOGLE_TOKENINFO_URL || "https://oauth2.googleapis.com/tokeninfo",
    sessionSecret: env.SESSION_SECRET || "dev-only-insecure-session-secret",
    sessionTtlSeconds: Number(env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60,
    allowedOrigins
  };

  // A development secret is fine locally and catastrophic in production: it
  // would let anyone mint a session for any account. Refuse to start rather
  // than serve with it.
  if (nodeEnv === "production" && (!env.SESSION_SECRET || env.SESSION_SECRET === "dev-only-insecure-session-secret")) {
    throw new Error("SESSION_SECRET must be set to a strong value when NODE_ENV=production.");
  }

  return config;
}

module.exports = { loadConfig, DEFAULT_GOOGLE_CLIENT_ID };
