// The HTTP surface: four routes and the CORS the extension needs.
//
// Kept as a plain (req, res) handler with no framework so the whole server is
// standard-library only and can be dropped on any host that runs Node. The
// handler is created through a factory — dependencies are injected — so tests
// can swap Google verification for a stub and never touch the network.

const { verifyGoogleIdToken } = require("./google.js");
const { signSession, verifySession } = require("./session.js");

// Generous enough for an ID token, small enough that a body cannot be used to
// exhaust memory. An ID token is a few kilobytes.
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

// Any extension origin (chrome-extension://<id>) is accepted: the caller is a
// browser extension whose id is not known in advance, and the pairing that
// matters is the ID token, not the origin. localhost is allowed outside
// production for local development and the test suite. Everything else has to
// be named explicitly in ALLOWED_ORIGINS.
function isAllowedOrigin(origin, config) {
  if (!origin) return true; // non-browser client (curl, a server-to-server call)
  if (origin.startsWith("chrome-extension://")) return true;
  if (config.nodeEnv !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  return config.allowedOrigins.includes(origin);
}

function applyCors(req, res, config) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, config)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-max-age", "600");
}

// Reads and parses a JSON body, capped. Resolves to {} for an empty body so a
// POST with nothing in it is a validation error at the route, not a parse
// error here.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  return match ? match[1].trim() : "";
}

function createApp({ config, verifyGoogle = verifyGoogleIdToken, fetchImpl = fetch } = {}) {
  return async function handle(req, res) {
    applyCors(req, res, config);

    // The browser sends this before any cross-origin POST; answering it with
    // the CORS headers already set above and no body is all that is required.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/auth/google") {
        const body = await readJsonBody(req);
        const idToken = body && body.idToken;

        let identity;
        try {
          identity = await verifyGoogle(idToken, {
            clientId: config.googleClientId,
            tokeninfoUrl: config.googleTokeninfoUrl,
            fetchImpl
          });
        } catch (err) {
          sendJson(res, 401, { error: "invalid_google_token", detail: String(err && err.message || err) });
          return;
        }

        const expiresAt = Date.now() + config.sessionTtlSeconds * 1000;
        const token = signSession(
          { sub: identity.userId, email: identity.email, name: identity.name, picture: identity.picture },
          config.sessionSecret,
          config.sessionTtlSeconds
        );

        sendJson(res, 200, {
          token,
          userId: identity.userId,
          email: identity.email,
          name: identity.name,
          picture: identity.picture,
          expiresAt
        });
        return;
      }

      if (req.method === "GET" && path === "/auth/me") {
        const claims = verifySession(bearerToken(req), config.sessionSecret);
        if (!claims) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, {
          userId: claims.sub,
          email: claims.email,
          name: claims.name || "",
          picture: claims.picture || ""
        });
        return;
      }

      // Stateless tokens cannot be revoked server-side, so logout is the
      // client dropping its copy. The route still exists to give the extension
      // one place to call, and to be the obvious hook when sessions gain a
      // revocation list.
      if (req.method === "POST" && path === "/auth/logout") {
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      sendJson(res, 400, { error: "bad_request", detail: String(err && err.message || err) });
    }
  };
}

module.exports = { createApp, isAllowedOrigin, MAX_BODY_BYTES };
