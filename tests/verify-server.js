// The sign-in backend: the session JWT (sign/verify/tamper/expiry) and the four
// HTTP routes, exercised over a real socket with Google verification stubbed.
//
// No network: `createApp` takes the verifier as a dependency, so "Google said
// yes" and "Google said no" are both simulated, and the tokeninfo call is never
// made.
const http = require("node:http");
const { expect } = require("./harness");

const { loadConfig } = require("../server/config.js");
const { createApp } = require("../server/app.js");
const { signSession, verifySession } = require("../server/session.js");

const { eq, ok, done } = expect("server");

const SECRET = "test-secret-test-secret-test-secret-1234";
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  };
}

async function withServer(config, verifyGoogle, fn) {
  const server = http.createServer(createApp({ config, verifyGoogle }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  console.log("--- session ---");
  const token = signSession({ sub: "u1", email: "a@b.com", name: "A" }, SECRET, 3600);
  eq("round-trips the subject", verifySession(token, SECRET).sub, "u1");
  eq("round-trips the email", verifySession(token, SECRET).email, "a@b.com");
  eq("a different secret is rejected", verifySession(token, SECRET + "x"), null);
  eq("a tampered signature is rejected", verifySession(token.slice(0, -2) + "xy", SECRET), null);
  eq("a tampered payload is rejected", verifySession(`${token.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: "evil", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}.${token.split(".")[2]}`, SECRET), null);
  eq("garbage is rejected", verifySession("not.a.jwt", SECRET), null);
  eq("a non-string is rejected", verifySession(null, SECRET), null);
  eq("an expired token is rejected", verifySession(signSession({ sub: "u1" }, SECRET, -10), SECRET), null);
  eq("exp is added by signSession", typeof verifySession(token, SECRET).exp, "number");

  console.log("--- config guard ---");
  eq("a dev default secret is allowed outside production", loadConfig({ NODE_ENV: "test" }).sessionSecret, "dev-only-insecure-session-secret");
  ok("production refuses the default secret", (() => {
    try { loadConfig({ NODE_ENV: "production" }); return false; } catch { return true; }
  })());
  ok("production accepts a real secret", !!loadConfig({ NODE_ENV: "production", SESSION_SECRET: "a-real-secret-value" }));
  eq("the google client id defaults to the bundled one", loadConfig({}).googleClientId.startsWith("818119178127-"), true);

  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    SESSION_TTL_DAYS: "30"
  });

  const verifyGoogle = async (idToken, opts) => {
    if (idToken === "good" && opts.clientId === CLIENT_ID) {
      return { userId: "g-1", email: "me@example.com", name: "Me", picture: "https://pic" };
    }
    throw new Error("invalid token");
  };

  await withServer(config, verifyGoogle, async (base) => {
    console.log("--- routes ---");

    const health = await fetch(`${base}/health`);
    eq("GET /health is 200", health.status, 200);
    eq("GET /health says ok", (await health.json()).ok, true);

    const missing = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    eq("a missing id token is 401", missing.status, 401);
    eq("a missing id token names the cause", (await missing.json()).error, "invalid_google_token");

    const bad = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: "bad" })
    });
    eq("an invalid id token is 401", bad.status, 401);

    const badJson = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json"
    });
    eq("a malformed body is 400", badJson.status, 400);

    const good = await fetch(`${base}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: "good" })
    });
    eq("a valid id token is 200", good.status, 200);
    const session = await good.json();
    ok("returns a session token", typeof session.token === "string" && session.token.split(".").length === 3);
    eq("returns the user id", session.userId, "g-1");
    eq("returns the email", session.email, "me@example.com");
    eq("returns the name", session.name, "Me");
    ok("returns an expiry in the future", session.expiresAt > Date.now());
    eq("the session verifies under the secret", verifySession(session.token, SECRET).sub, "g-1");

    const meNoAuth = await fetch(`${base}/auth/me`);
    eq("GET /auth/me without a token is 401", meNoAuth.status, 401);

    const meBad = await fetch(`${base}/auth/me`, { headers: { authorization: "Bearer nonsense" } });
    eq("GET /auth/me with a bad token is 401", meBad.status, 401);

    const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
    eq("GET /auth/me with the token is 200", me.status, 200);
    const meBody = await me.json();
    eq("GET /auth/me returns the user id", meBody.userId, "g-1");
    eq("GET /auth/me returns the email", meBody.email, "me@example.com");

    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` }
    });
    eq("POST /auth/logout is 200", logout.status, 200);
    eq("POST /auth/logout says ok", (await logout.json()).ok, true);

    const notFound = await fetch(`${base}/nope`);
    eq("an unknown route is 404", notFound.status, 404);

    console.log("--- CORS ---");
    const preflight = await fetch(`${base}/auth/google`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdefghijklmnop", "Access-Control-Request-Method": "POST" }
    });
    eq("preflight is 204", preflight.status, 204);
    eq("a chrome-extension origin is echoed", preflight.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
    eq("allow-methods is advertised", preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    ok("allow-headers advertises authorization", /authorization/.test(preflight.headers.get("access-control-allow-headers")));

    const localhost = await fetch(`${base}/auth/google`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" }
    });
    eq("localhost is allowed in development", localhost.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const foreign = await fetch(`${base}/auth/google`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" }
    });
    eq("an unlisted origin is not echoed", foreign.headers.get("access-control-allow-origin"), null);
  });

  // A production config must NOT allow localhost, and must not echo a foreign
  // origin even for a real request.
  const prodConfig = { ...config, nodeEnv: "production", allowedOrigins: ["https://app.example"] };
  await withServer(prodConfig, verifyGoogle, async (base) => {
    const localhost = await fetch(`${base}/auth/google`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" }
    });
    eq("production refuses localhost", localhost.headers.get("access-control-allow-origin"), null);

    const allowed = await fetch(`${base}/auth/google`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" }
    });
    eq("production allows an ALLOWED_ORIGINS entry", allowed.headers.get("access-control-allow-origin"), "https://app.example");
  });

  process.exitCode = done() ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
