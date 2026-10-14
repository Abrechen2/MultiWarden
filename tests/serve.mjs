import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "site");
http
  .createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/mock-sl/api/alias/random/new" && req.method === "POST") {
      // SimpleLogin-compatible mock for the username generator (self-hosted base URL)
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers.authentication !== "sl-test-token") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "Wrong api key" }));
        }
        const host = new URL(req.url, "http://x").searchParams.get("hostname") ?? "";
        const note = JSON.parse(body || "{}").note ?? "";
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ alias: `mock.${host || "none"}@simplelogin.test`, note }));
      });
      return;
    }
    if (p.startsWith("/basic")) {
      // HTTP Basic authentication test page (user "basic-user", password "basic-pw")
      const ok = req.headers.authorization === "Basic " + Buffer.from("basic-user:basic-pw").toString("base64");
      if (!ok) {
        // one realm per first path segment, so the browser's auth cache does not answer other test cases
        const realm = "MultiWarden-" + p.split("/")[1];
        res.writeHead(401, { "www-authenticate": `Basic realm="${realm}"`, "content-type": "text/html; charset=utf-8" });
        return res.end("<h1>401 – Anmeldung erforderlich</h1>");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<h1 id='ok'>Willkommen im geschützten Bereich</h1>");
    }
    const f = join(root, p === "/" ? "login.html" : p);
    if (!existsSync(f)) {
      res.writeHead(404);
      return res.end("nope");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(f));
  })
  .listen(Number(process.env.PORT ?? 9000), "127.0.0.1", () => console.log("site on", process.env.PORT ?? 9000));
