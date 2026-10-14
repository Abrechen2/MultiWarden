// HTTPS → HTTP proxy for the official CLI (it refuses plain-http servers).
// Usage: node tests/tls-proxy.mjs <listenPort> <targetPort> <key> <cert>
import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";
const [port, target, key, cert] = process.argv.slice(2);
https
  .createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const p = http.request({ host: "127.0.0.1", port: Number(target), path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(p);
  })
  .listen(Number(port), "127.0.0.1");
