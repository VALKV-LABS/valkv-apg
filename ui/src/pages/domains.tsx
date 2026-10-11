/** Domains, certificates and CA certificates. */

import { useQueryClient } from "@tanstack/react-query";
import { BadgeCheck } from "lucide-react";
import { useState } from "react";
import { type Json, api, formatTime, relativeTime, ws } from "../api";
import { ResourcePage, type ResourceSpec } from "../components/resource";
import { CopyButton, Dialog, ErrorNotice, PageHead, Tabs, Tag, Tags } from "../components/ui";
import { useNames } from "../hooks";
import { useSession } from "../session";

const DAY = 24 * 3600_000;

function expiry(notAfter: string) {
  const left = new Date(notAfter).getTime() - Date.now();
  const tone = left < 0 ? "danger" : left < 30 * DAY ? "warn" : "ok";
  return <span title={formatTime(notAfter)}><Tag tone={tone}>{left < 0 ? `expired ${relativeTime(notAfter)}` : relativeTime(notAfter)}</Tag></span>;
}

/** The DNS record that proves a domain is yours, and a button to check it. */
function Verify({ domain, onClose }: { domain: Json; onClose: () => void }) {
  const { workspace } = useSession();
  const client = useQueryClient();
  const [current, setCurrent] = useState(domain);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const v = current["verification"] as Json;
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setCurrent(await api("POST", `${ws(workspace, "domains")}/${domain["id"]}/verify`));
      await client.invalidateQueries({ queryKey: ["ws", workspace] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Verify ${domain["hostname"]}`} onClose={onClose} foot={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      {current["status"] !== "active" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check now"}</button>}
    </>}>
      <div className="form">
        {current["status"] === "active"
          ? <div className="notice notice-ok" role="status">The domain is verified and active.</div>
          : <>
            <p>Create this DNS record, wait for it to be visible, then check. Routes can use the domain once it is active.</p>
            <div className="table-scroll"><table className="t">
              <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Value</th><th scope="col"><span className="sr-only">Copy</span></th></tr></thead>
              <tbody><tr><td>TXT</td><td className="mono wrap">{v["record"]}</td><td className="mono wrap">{v["token"]}</td><td className="actions"><CopyButton text={String(v["token"])} label="Copy value" /></td></tr></tbody>
            </table></div>
            {current["status_reason"] && <div className="notice notice-warn" role="status">{current["status_reason"]}</div>}
          </>}
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}

export function Domains() {
  const { canWrite } = useSession();
  const [tab, setTab] = useState<"domains" | "certificates" | "ca">("domains");
  const [verifying, setVerifying] = useState<Json | null>(null);
  const certNames = useNames("certificates");

  const domains: ResourceSpec = {
    title: "Domains", singular: "domain", segment: "domains", schemaPath: "resources/domain.json",
    hide: ["verification", "status", "status_reason"],
    choices: { certificate: [...certNames].map(([value, label]) => ({ value, label })) },
    emptyHint: "A domain is a host name this workspace owns. Routes outside the system workspace may only use hosts covered by one.",
    columns: [
      { head: "Host name", cell: (r) => <span className="row-link">{r["hostname"]}</span> },
      { head: "Certificate", cell: (r) => r["tls"]?.["mode"] === "manual" ? `uploaded: ${certNames.get(r["tls"]["certificate"]) ?? r["tls"]["certificate"]}` : r["tls"]?.["mode"] === "acme" ? `automatic (${r["tls"]["challenge"] === "dns01" ? "DNS challenge" : "HTTP challenge"})` : "none" },
      { head: "Status", cell: (r) => r["status"] === "active" ? <Tag tone="ok" dot>active</Tag> : <Tag tone="warn" dot>{r["status"]}</Tag> },
      { head: "Reason", cell: (r) => r["status_reason"] ?? "" },
    ],
  };
  const certificates: ResourceSpec = {
    title: "Certificates", singular: "certificate", segment: "certificates", schemaPath: "resources/certificate.json",
    hide: ["cert_file", "key_file", "hosts", "not_before", "not_after", "issuer", "fingerprint_sha256", "source"],
    emptyHint: "Upload a certificate and its key for domains whose certificate you manage yourself. Automatic certificates appear here once issued.",
    columns: [
      { head: "Name", cell: (r) => <span className="row-link">{r["name"]}</span> },
      { head: "Hosts", cell: (r) => <Tags items={r["hosts"]} /> },
      { head: "Source", cell: (r) => (r["source"] === "acme" ? "automatic" : "uploaded") },
      { head: "Issuer", cell: (r) => r["issuer"] },
      { head: "Expires", cell: (r) => expiry(r["not_after"]) },
    ],
  };
  const cas: ResourceSpec = {
    title: "CA certificates", singular: "CA certificate", segment: "ca-certificates", schemaPath: "resources/ca-certificate.json",
    hide: ["cert_file"],
    emptyHint: "A CA certificate lets the gateway trust a private authority: for upstream TLS, or for client certificates.",
    columns: [
      { head: "Name", cell: (r) => <span className="row-link">{r["name"]}</span> },
      { head: "Added", cell: (r) => formatTime(r["created_at"]) },
    ],
  };

  return (
    <div className="page">
      <PageHead title="Domains & certificates">Host names this workspace serves, and the certificates presented for them.</PageHead>
      <Tabs label="Kind" value={tab} onChange={setTab} tabs={[["domains", "Domains"], ["certificates", "Certificates"], ["ca", "CA certificates"]]} />
      {tab === "domains" && (
        <ResourcePage spec={domains} rowActions={(row) => row["status"] !== "active" && row["verification"]?.["method"] === "dns_txt" && canWrite && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVerifying(row)}><BadgeCheck size={12} aria-hidden="true" /> Verify</button>
        )} />
      )}
      {tab === "certificates" && <ResourcePage spec={certificates} />}
      {tab === "ca" && <ResourcePage spec={cas} />}
      {verifying && <Verify domain={verifying} onClose={() => setVerifying(null)} />}
    </div>
  );
}
