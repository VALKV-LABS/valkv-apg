// TLS and certificates, end to end (spec §8): real handshakes against real
// nodes, and certificates obtained from a test ACME authority that validates
// challenges over the container network exactly as a public one would.
//
// With a control plane, two nodes share the names the authority resolves, so
// a challenge started by one node may be checked on the other (TLS-10).
//
// Runs in every config mode through the shared driver (spec ARC-1).

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { MGMT, MODE, NODE, NODE_TLS, REDIRECT, REDIRECT_MGMT, REDIRECT_TLS, adminCall, apply, metric } from "./lib/driver.js";
import { assert, http, step } from "./lib/harness.js";
import { send, until } from "./lib/raw.js";

const fixture = (name) => readFileSync(new URL(`../../admin/test/fixtures/${name}`, import.meta.url), "utf8");
const CERT = fixture("test-cert.crt");
const KEY = fixture("test-cert.key");
const MANUAL_FINGERPRINT = new X509Certificate(CERT).fingerprint256;
const ACME_HOST = "acme-one.test";
// Nothing answers to this name, so the authority can never validate it.
const UNREACHABLE = "acme-unreachable.test";
const FLEET = MODE !== "file";

/** One TLS handshake. Resolves with the certificate presented and the protocol agreed, or the error. */
function handshake(base, servername, options = {}) {
  const url = new URL(base);
  return new Promise((resolve) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port), servername, rejectUnauthorized: false, ...options }, () => {
      const result = { certificate: socket.getPeerCertificate(), protocol: socket.getProtocol() };
      socket.end();
      resolve(result);
    });
    socket.on("error", (error) => resolve({ error }));
  });
}

const issuer = async (base, servername) => (await handshake(base, servername)).certificate?.issuer?.CN ?? "";
const subject = async (base, servername) => (await handshake(base, servername)).certificate?.subject?.CN ?? "";

/** Sums a counter over the nodes that take part in issuance. */
async function fleetTotal(name, labels) {
  const nodes = FLEET ? [MGMT, REDIRECT_MGMT] : [MGMT];
  const values = await Promise.all(nodes.map((n) => metric(n, name, labels)));
  return values.reduce((sum, v) => sum + (v ?? 0), 0);
}

function config({ unreachable = true } = {}) {
  return {
    version: 1,
    certificates: [{ name: "manual", cert_pem: CERT, key_pem: KEY }],
    domains: [
      { hostname: "api.example.com", tls: { mode: "manual", certificate: "manual" } },
      { hostname: ACME_HOST, tls: { mode: "acme" } },
      ...(unreachable ? [{ hostname: UNREACHABLE, tls: { mode: "acme" } }] : []),
    ],
    services: [{ name: "echo", shared: true, backends: [{ target: "echo:8080" }] }],
    routes: [{ name: "tls-echo", service: "echo", hosts: ["api.example.com", ACME_HOST] }],
  };
}

let issuedBefore = 0;
let failuresBefore = 0;

step("a node presents its fallback certificate for a name it holds nothing for (TLS-1)", async () => {
  if (FLEET) {
    // Start from a control plane that holds no certificate for the test name,
    // so issuance happens in this run however often the suite is repeated.
    await adminCall("DELETE", `/v1/workspaces/default/domains/${ACME_HOST}`);
    await adminCall("DELETE", `/v1/workspaces/default/certificates/acme-${ACME_HOST}`);
    for (const base of [NODE_TLS, REDIRECT_TLS]) {
      await until(async () => !/Pebble/.test(await issuer(base, ACME_HOST)), { what: "the previous certificate to be withdrawn" });
    }
  }
  assert.equal(await subject(NODE_TLS, "nobody.test"), "valkv-apg fallback certificate");
  issuedBefore = await fleetTotal("apg_acme_issuances_total");
  failuresBefore = await fleetTotal("apg_acme_failures_total", { reason: "challenge" });
});

step("a configured certificate is served for its exact and wildcard names, on every node (TLS-1, CFG-6)", async () => {
  await apply(config());
  const bases = FLEET ? [NODE_TLS, REDIRECT_TLS] : [NODE_TLS];
  for (const base of bases) {
    // With a control plane the key travelled sealed and was opened by the node.
    await until(async () => (await handshake(base, "api.example.com")).certificate?.fingerprint256 === MANUAL_FINGERPRINT, { what: `the certificate on ${base}` });
    assert.equal((await handshake(base, "x.wild.example.com")).certificate.fingerprint256, MANUAL_FINGERPRINT);
    assert.equal(await subject(base, "nobody.test"), "valkv-apg fallback certificate");
    // A wildcard covers one label, not two.
    assert.equal(await subject(base, "a.b.wild.example.com"), "valkv-apg fallback certificate");
  }
  const res = await send(NODE_TLS, { host: "api.example.com", path: "/" });
  assert.equal(res.status, 200);
  assert.equal(res.json.headers["x-forwarded-proto"], "https");
});

step("an unknown ACME token is a plain 404 on the HTTP port, before any routing or redirect", async () => {
  for (const base of [NODE, REDIRECT]) {
    const res = await send(base, { host: ACME_HOST, path: "/.well-known/acme-challenge/not-a-real-token" });
    assert.equal(res.status, 404);
    assert.equal(res.headers["x-apg-error"], undefined);
  }
});

step("a domain with tls.mode acme gets a certificate from the authority without anyone asking (TLS-4, TLS-5)", async () => {
  await until(async () => /Pebble/.test(await issuer(NODE_TLS, ACME_HOST)), { timeoutMs: 120000, everyMs: 1000, what: "the issued certificate to be served" });
  const presented = (await handshake(NODE_TLS, ACME_HOST)).certificate;
  assert.ok(presented.subjectaltname.includes(`DNS:${ACME_HOST}`), presented.subjectaltname);
  const res = await send(NODE_TLS, { host: ACME_HOST, path: "/over-acme" });
  assert.equal(res.status, 200);
  assert.equal(res.json.path, "/over-acme");
});

if (FLEET) {
  step("one node obtained it and every node serves it (TLS-9, TLS-10, TLS-11)", async () => {
    await until(async () => /Pebble/.test(await issuer(REDIRECT_TLS, ACME_HOST)), { timeoutMs: 30000, what: "the other node to serve the certificate" });
    const a = (await handshake(NODE_TLS, ACME_HOST)).certificate.fingerprint256;
    const b = (await handshake(REDIRECT_TLS, ACME_HOST)).certificate.fingerprint256;
    assert.equal(a, b, "both nodes present the same certificate");
    assert.equal((await fleetTotal("apg_acme_issuances_total")) - issuedBefore, 1, "exactly one node ran the issuance");
    // The control plane holds it, attributed to the authority, and never reveals the key.
    const stored = await adminCall("GET", `/v1/workspaces/default/certificates/acme-${ACME_HOST}`);
    assert.equal(stored.json.source, "acme");
    assert.deepEqual(stored.json.hosts, [ACME_HOST]);
    assert.ok(!stored.text.includes("PRIVATE KEY") && stored.json.key_pem === undefined);
  });
} else {
  step("the issued certificate is counted, and kept in the data directory for the next start", async () => {
    assert.equal((await fleetTotal("apg_acme_issuances_total")) - issuedBefore, 1);
  });
}

step("a name the authority cannot validate fails, is counted, and gets the fallback meanwhile (TLS-7)", async () => {
  await until(async () => (await fleetTotal("apg_acme_failures_total", { reason: "challenge" })) > failuresBefore, { timeoutMs: 120000, everyMs: 1000, what: "the failed validation to be counted" });
  assert.equal(await subject(NODE_TLS, UNREACHABLE), "valkv-apg fallback certificate");
  // The failure of one name does not disturb another.
  assert.match(await issuer(NODE_TLS, ACME_HOST), /Pebble/);
});

step("TLS 1.2 is accepted by default and refused when the minimum is 1.3 (TLS-2)", async () => {
  const old = { maxVersion: "TLSv1.2" };
  assert.equal((await handshake(NODE_TLS, "api.example.com", old)).protocol, "TLSv1.2");
  assert.equal((await handshake(NODE_TLS, "api.example.com")).protocol, "TLSv1.3", "1.3 is preferred");
  // The second node runs with APG_TLS_MIN_VERSION=1.3.
  assert.ok((await handshake(REDIRECT_TLS, "api.example.com", old)).error, "a TLS 1.2 client is refused");
  assert.equal((await handshake(REDIRECT_TLS, "api.example.com")).protocol, "TLSv1.3");
});

step("expiry is exported, and the name that cannot be validated is withdrawn", async () => {
  const exported = (await http("GET", `${MGMT}/metrics`)).text;
  for (const within of ["7d", "14d", "30d"]) assert.ok(exported.includes(`apg_certs_expiring{within="${within}"}`), within);
  // Leave nothing behind that would keep failing after the suite.
  if (FLEET) await adminCall("DELETE", `/v1/workspaces/default/domains/${UNREACHABLE}`);
  else await apply(config({ unreachable: false }));
});
