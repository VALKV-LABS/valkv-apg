/** Small building blocks every page uses. Their look comes from styles.css. */

import { AlertTriangle, Check, Copy, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError, type Fault } from "../api";

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, foot }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <div className="card-subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="row gap-8">{actions}</div>}
        </div>
      )}
      {children}
      {foot && <div className="card-foot">{foot}</div>}
    </section>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <Loader2 size={18} className="spin" aria-hidden="true" />
      <div>{label}…</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

/** Shows the server's own message and offers a retry (spec UI-1). */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state" role="alert">
      <AlertTriangle size={18} aria-hidden="true" style={{ color: "var(--danger)" }} />
      <h3>Something went wrong</h3>
      <div>{messageOf(error)}</div>
      {retry && <button type="button" className="btn btn-ghost" onClick={retry}>Try again</button>}
    </div>
  );
}

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** An error from a write, with the faults no field could show. */
export function ErrorNotice({ error, shown = [] }: { error: unknown; shown?: string[] }) {
  if (!error) return null;
  const faults: Fault[] = error instanceof ApiError ? error.details.filter((d) => !shown.includes(d.pointer)) : [];
  return (
    <div className="notice notice-danger" role="alert">
      {messageOf(error)}
      {faults.length > 0 && (
        <ul>
          {faults.map((f, i) => <li key={i}><span className="mono">{f.pointer}</span> {f.message}</li>)}
        </ul>
      )}
    </div>
  );
}

type Tone = "ok" | "info" | "warn" | "danger" | undefined;

export function Tag({ tone, dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`tag${tone ? ` tag-${tone}` : ""}`}>
      {dot && <span className="tag-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Tags({ items }: { items: unknown }) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return <span className="dim">none</span>;
  return <span className="tags">{list.map((x, i) => <Tag key={i}>{String(x)}</Tag>)}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, text]) => (
        <button key={id} type="button" role="tab" className="tab" aria-selected={value === id} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}

/** A modal on the native dialog element: focus is trapped and Escape closes it without extra code. */
export function Dialog({ title, onClose, children, foot, narrow }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; narrow?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", "");
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${narrow ? " narrow" : ""}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <h2 id={id} className="grow">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </dialog>
  );
}

export function Confirm({ title, children, confirmLabel, danger, busy, error, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; error?: unknown; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog
      narrow
      title={title}
      onClose={onClose}
      foot={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
      </>}
    >
      <div className="form">
        <div>{children}</div>
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A secret the server will never show again (spec UI-8). */
export function SecretOnce({ label, value }: { label: string; value: string }) {
  return (
    <div className="notice notice-warn" role="status">
      <strong>{label}</strong>
      <div className="muted" style={{ margin: "4px 0 8px" }}>Copy it now. It is shown this once and cannot be read back later.</div>
      <div className="row gap-8">
        <code className="code-block wrap grow" data-testid="secret-once">{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

export function Field({ label, hint, error, required, children }: { label: string; hint?: string | undefined; error?: string | undefined; required?: boolean | undefined; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id} className={`field-label${required ? " field-required" : ""}`}>{label}</label>
      {children(id, describedBy)}
      {hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}
      {error && <span id={`${id}-error`} className="field-error">{error}</span>}
    </div>
  );
}
