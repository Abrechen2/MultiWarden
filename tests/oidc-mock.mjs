// Minimal OpenID Connect provider for SSO tests (authorization code flow, RS256 id tokens).
// The login page asks only for an e-mail address; every address is accepted and verified.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.OIDC_PORT ?? 9100);
const ISSUER = `http://localhost:${PORT}`;
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const codes = new Map();
const tokens = new Map();

const b64u = (b) => Buffer.from(b).toString("base64url");
function jwt(claims) {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(head + "." + body), privateKey);
  return head + "." + body + "." + b64u(sig);
}
const subOf = (email) => crypto.createHash("sha256").update(email).digest("hex").slice(0, 24);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function body(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, ISSUER);
    if (u.pathname === "/.well-known/openid-configuration")
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: ISSUER + "/authorize",
        token_endpoint: ISSUER + "/token",
        userinfo_endpoint: ISSUER + "/userinfo",
        jwks_uri: ISSUER + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile", "offline_access"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        claims_supported: ["sub", "email", "email_verified", "name", "preferred_username"],
      });
    if (u.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (u.pathname === "/authorize") {
      const q = u.searchParams;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Test-IdP</title>
<style>body{font:15px system-ui;background:#f3f5f9;display:flex;justify-content:center;padding-top:80px}form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 4px 20px #0002;width:320px}input,button{width:100%;box-sizing:border-box;padding:10px;margin-top:8px;font:inherit}button{background:#3d2fa8;color:#fff;border:0;border-radius:8px}</style></head>
<body><form method="get" action="/authorize/done"><h2>Test-Identity-Provider</h2><p>Anmeldung für <b>${esc(q.get("client_id"))}</b></p>
<label>E-Mail<input id="idp-email" name="email" type="email" required autofocus></label>
${["state", "redirect_uri", "nonce", "client_id", "code_challenge"].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? "")}">`).join("")}
<button id="idp-login" type="submit">Anmelden</button></form></body></html>`);
    }
    if (u.pathname === "/authorize/done") {
      const q = u.searchParams;
      const email = (q.get("email") ?? "").toLowerCase();
      const code = crypto.randomBytes(16).toString("hex");
      codes.set(code, { email, nonce: q.get("nonce"), client_id: q.get("client_id"), challenge: q.get("code_challenge") });
      const target = new URL(q.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const p = new URLSearchParams(await body(req));
      const c = codes.get(p.get("code"));
      if (!c) return json(res, 400, { error: "invalid_grant" });
      if (c.challenge) {
        const v = crypto
          .createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url");
        if (v !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "pkce" });
      }
      codes.delete(p.get("code"));
      const now = Math.floor(Date.now() / 1000);
      const at = "at-" + crypto.randomBytes(12).toString("hex");
      tokens.set(at, c.email);
      return json(res, 200, {
        access_token: at,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: jwt({
          iss: ISSUER,
          sub: subOf(c.email),
          aud: c.client_id,
          iat: now,
          exp: now + 3600,
          nonce: c.nonce,
          email: c.email,
          email_verified: true,
          name: c.email.split("@")[0],
        }),
      });
    }
    if (u.pathname === "/userinfo") {
      const email = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!email) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { sub: subOf(email), email, email_verified: true, preferred_username: email.split("@")[0] });
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log("oidc mock on", ISSUER));
