/** Declarative configuration: the workspace as YAML, a document to apply, and the revision history. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import yaml from "js-yaml";
import { History, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { type Json, api, formatTime } from "../api";
import { ChangeList, summaryText } from "../components/changes";
import { Card, Confirm, CopyButton, Empty, ErrorNotice, ErrorState, Field, Loading, PageHead, SecretOnce, Tabs, Tag } from "../components/ui";
import { useSession } from "../session";

type Mode = "apply" | "sync";

function Editor() {
  const { workspace, canWrite } = useSession();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<Mode>("apply");
  const [preview, setPreview] = useState<Json | null>(null);
  const [done, setDone] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const parse = (): Json => {
    let doc: unknown;
    try {
      doc = yaml.load(text);
    } catch (err) {
      throw new Error(`The document is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("The document must be a mapping that starts with version: 1.");
    return doc as Json;
  };
  const run = async (what: "diff" | Mode) => {
    setBusy(true);
    setError(null);
    try {
      const body = { document: parse(), ...(message ? { message } : {}) };
      const query = { workspace, ...(what === "diff" && mode === "sync" ? { prune: true } : {}) };
      const result = await api<Json>("POST", `/v1/config/${what}`, { body, query });
      if (what === "diff") {
        setPreview(result);
        setDone(null);
      } else {
        setDone(result);
        setPreview(null);
        await client.invalidateQueries();
      }
    } catch (err) {
      setError(err);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const deletes = ((preview?.["changes"] ?? []) as Json[]).filter((c) => c["op"] === "delete").length;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="stack">
      <Card title="Apply a document" subtitle="Paste or upload apg.yaml. Nothing changes until you apply.">
        <div className="card-body form">
          <Field label="Document" hint={`Applied to ${workspace} unless the document names another workspace.`}>
            {(id, d) => <textarea id={id} className="textarea code" rows={14} spellCheck={false} aria-describedby={d} placeholder={"version: 1\nservices:\n  - name: orders\n    backends:\n      - target: \"10.0.0.1:8080\""} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); setDone(null); }} />}
          </Field>
          <div className="form-grid">
            <Field label="What to do with resources the document leaves out">
              {(id) => (
                <select id={id} className="select" value={mode} onChange={(e) => { setMode(e.target.value as Mode); setPreview(null); }}>
                  <option value="apply">Keep them (apply)</option>
                  <option value="sync">Delete them (sync)</option>
                </select>
              )}
            </Field>
            <Field label="Message" hint="Recorded with the revision.">{(id, d) => <input id={id} className="input" aria-describedby={d} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
          </div>
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <input ref={file} type="file" accept=".yaml,.yml,.json" className="sr-only" aria-label="Upload a document" tabIndex={-1}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setText(t); setPreview(null); setDone(null); }); e.target.value = ""; }} />
            <button type="button" className="btn btn-ghost" onClick={() => file.current?.click()}><Upload size={13} aria-hidden="true" /> Upload file</button>
            <button type="button" className="btn btn-ghost" disabled={busy || text.trim() === "" || !canWrite} onClick={() => void run("diff")}>{busy ? "Working…" : "Show changes"}</button>
            {!canWrite && <span className="muted">Your role can read the configuration but not change it.</span>}
          </div>
          <ErrorNotice error={error} />
          {done && (
            <div className="form" aria-live="polite">
              <div className="notice notice-ok" role="status">
                Done: {summaryText(done["summary"])}.
                {((done["revisions"] ?? []) as Json[]).map((r) => ` Recorded revision ${r["number"]} of ${r["workspace"]}.`).join("")}
              </div>
              {((done["generated"] ?? []) as Json[]).map((g) => <SecretOnce key={`${g["consumer"]}/${g["credential"]}`} label={`Generated key for ${g["consumer"]}/${g["credential"]}`} value={g["key"]} />)}
            </div>
          )}
        </div>
      </Card>

      {preview && (
        <Card title="Changes" subtitle={summaryText(preview["summary"])}
          actions={preview["changes"].length > 0 && <button type="button" className={`btn ${deletes > 0 ? "btn-danger" : "btn-primary"} btn-sm`} disabled={busy} onClick={() => (deletes > 0 ? setConfirming(true) : void run(mode))}>{mode === "sync" ? "Sync" : "Apply"} {preview["changes"].length} change{preview["changes"].length === 1 ? "" : "s"}</button>}>
          <ChangeList changes={preview["changes"]} />
        </Card>
      )}
      {confirming && (
        <Confirm title={`Delete ${deletes} resource${deletes === 1 ? "" : "s"}?`} confirmLabel="Sync" danger busy={busy} onClose={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void run("sync"); }}>
          <p>Sync removes what the document leaves out. Nodes stop serving those within a second or two. The revision history can bring them back.</p>
        </Confirm>
      )}
    </div>
  );
}

function Current() {
  const { workspace } = useSession();
  const dump = useQuery({ queryKey: ["ws", workspace, "dump"], queryFn: () => api<Json>("GET", "/v1/config/dump", { query: { workspace } }) });
  const text = dump.data ? yaml.dump(dump.data, { lineWidth: 120, noRefs: true }) : "";
  return (
    <Card title={`${workspace} as a document`} subtitle="Secrets are placeholders; sync reads a placeholder as “keep what is stored”." actions={dump.data && <CopyButton text={text} />}>
      {dump.isLoading && <Loading />}
      {dump.error && <ErrorState error={dump.error} retry={() => void dump.refetch()} />}
      {dump.data && <div className="card-body"><pre className="code-block" tabIndex={0} aria-label="Current configuration as YAML">{text}</pre></div>}
    </Card>
  );
}

function Revisions() {
  const { workspace, canWrite } = useSession();
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["ws", workspace, "revisions"], queryFn: () => api<{ data: Json[]; drift: Json }>("GET", "/v1/config/revisions", { query: { workspace } }) });
  const [target, setTarget] = useState<{ revision: Json; preview: Json } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const preview = async (revision: Json) => {
    setError(null);
    try {
      setTarget({ revision, preview: await api("POST", `/v1/config/revisions/${revision["id"]}/rollback`, { body: {}, query: { dry_run: true } }) });
    } catch (err) {
      setError(err);
    }
  };
  const rollback = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api("POST", `/v1/config/revisions/${target.revision["id"]}/rollback`, { body: {} });
      setTarget(null);
      await client.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {list.data?.drift["drifted"] && (
        <div className="notice notice-warn" role="status">
          Drifted from revision {list.data.drift["since_revision"]}: this workspace was changed outside apply and sync since then. The current document shows what is live now.
        </div>
      )}
      <ErrorNotice error={error} />
      <Card title="Revisions" subtitle="Every apply, sync and rollback of this workspace">
        {list.isLoading && <Loading />}
        {list.error && <ErrorState error={list.error} retry={() => void list.refetch()} />}
        {list.data && (list.data.data.length === 0 ? <Empty title="No revisions yet">A revision is recorded each time a document is applied.</Empty> : (
          <div className="table-scroll"><table className="t">
            <thead><tr><th scope="col">Revision</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">When</th><th scope="col">Changes</th><th scope="col">Message</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.data.data.map((r, i) => (
                <tr key={r["id"]}>
                  <td className="num">{r["number"]} {i === 0 && <Tag tone="info">latest</Tag>}</td>
                  <td>{r["action"]}</td>
                  <td>{r["actor"]["name"]}</td>
                  <td>{formatTime(r["created_at"])}</td>
                  <td className="num">+{r["summary"]["create"]} ~{r["summary"]["update"]} -{r["summary"]["delete"]}</td>
                  <td className="wrap">{r["message"]}</td>
                  <td className="actions">{canWrite && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void preview(r)}><History size={12} aria-hidden="true" /> Roll back to this</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </Card>
      {target && (
        <Confirm title={`Roll back to revision ${target.revision["number"]}?`} confirmLabel="Roll back" danger={((target.preview["changes"] ?? []) as Json[]).some((c) => c["op"] === "delete")} busy={busy} error={error} onClose={() => setTarget(null)} onConfirm={() => void rollback()}>
          <p style={{ marginBottom: 12 }}>The revision's document is applied again and recorded as a new revision. {summaryText(target.preview["summary"])}.</p>
          <div className="card"><ChangeList changes={target.preview["changes"]} /></div>
        </Confirm>
      )}
    </div>
  );
}

export function Config() {
  const [tab, setTab] = useState<"current" | "apply" | "revisions">("current");
  return (
    <div className="page">
      <PageHead title="Config">Keep the gateway's configuration in files: export it, review a change, apply it, and go back.</PageHead>
      <Tabs label="View" value={tab} onChange={setTab} tabs={[["current", "Current"], ["apply", "Apply a document"], ["revisions", "Revisions"]]} />
      {tab === "current" && <Current />}
      {tab === "apply" && <Editor />}
      {tab === "revisions" && <Revisions />}
    </div>
  );
}
