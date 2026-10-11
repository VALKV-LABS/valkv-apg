// Raw HTTP helpers for talking to a node. Unlike fetch, these send the path
// and Host exactly as given, which the routing tests depend on (fetch would
// tidy up "/a/../b" before it ever left the client).

import http from "node:http";
import https from "node:https";
import http2 from "node:http2";

/** One request. `host` is the Host header (and the SNI name over TLS). */
export function send(base, { method = "GET", path = "/", host, headers = {}, body } = {}) {
  const url = new URL(base);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path,
        setHost: false,
        headers: { host: host ?? url.host, ...headers },
        ...(url.protocol === "https:" ? { rejectUnauthorized: false, servername: host ?? url.hostname } : {}),
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One request over HTTP/2 (TLS, ALPN). Resolves with status, headers and body text. */
export function sendH2(base, { path = "/", host } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const session = http2.connect(base, { rejectUnauthorized: false, servername: host ?? url.hostname });
    session.on("error", reject);
    const stream = session.request({ ":path": path, ":method": "GET", ":authority": host ?? url.host });
    let headers;
    const chunks = [];
    stream.on("response", (h) => (headers = h));
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      session.close();
      resolve({ status: headers?.[":status"], headers, text: Buffer.concat(chunks).toString("utf8"), alpn: session.alpnProtocol });
    });
    stream.on("error", reject);
    stream.end();
  });
}

/** Polls `fn` until it returns a truthy value or the time runs out. */
export async function until(fn, { timeoutMs = 15000, everyMs = 200, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
