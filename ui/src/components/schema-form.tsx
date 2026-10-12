/**
 * A form drawn from a JSON Schema (spec UI-2).
 *
 * The schemas are the ones the server validates with, fetched from
 * `/v1/schemas/*`, so a field the server knows always has a control and the
 * console needs no change when a schema gains a field. Shapes with no natural
 * control (free-form objects, lists of mixed types) are edited as JSON.
 *
 * Faults the server reports are placed on fields by JSON pointer.
 */

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Fault, Json } from "../api";
import { Field } from "./ui";

const BASE = "https://valkv-apg.dev/schemas/";

/** Every schema the server publishes, addressed by path (`resources/route.json`). */
export class Schemas {
  private readonly byPath = new Map<string, Json>();

  constructor(entries: Array<{ path: string; schema: Json }>) {
    for (const e of entries) this.byPath.set(e.path, e.schema);
  }

  get(path: string): Json | undefined {
    return this.byPath.get(path);
  }

  /** Follows `$ref` until a schema with content is reached. `base` is the file the reference is written in. */
  resolve(schema: Json, base: string): { schema: Json; base: string } {
    let current = schema;
    let file = base;
    for (let hops = 0; hops < 12 && typeof current?.["$ref"] === "string"; hops++) {
      const { $ref, ...siblings } = current;
      const url = new URL($ref as string, BASE + file);
      const target = url.href.slice(BASE.length).split("#")[0]!;
      let found: any = this.byPath.get(target);
      for (const part of url.hash.replace(/^#\/?/, "").split("/").filter(Boolean)) found = found?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (!found) return { schema: siblings, base: file };
      current = { ...found, ...siblings };
      file = target;
    }
    return { schema: current, base: file };
  }
}

/** Schema descriptions carry references to the requirements document that mean nothing to the reader. */
export const plain = (text: unknown): string | undefined =>
  typeof text === "string" ? text.replace(/\s*\((?:spec )?§[^)]*\)/g, "").replace(/\s*\(spec [^)]*\)/g, "").replace(/\s*\([A-Z]{2,4}-\d+[a-z]?(?:, [A-Z]{2,4}-\d+[a-z]?)*\)/g, "") : undefined;

const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const title = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const isScalar = (s: Json) => s["enum"] !== undefined || ["string", "integer", "number", "boolean"].includes(s["type"]);

/** Properties of an object schema, including those of the `oneOf` branch the value's `type` selects. */
function propertiesOf(schema: Json, value: Json): { properties: Json; required: string[] } {
  const properties: Json = { ...(schema["properties"] ?? {}) };
  const required: string[] = [...(schema["required"] ?? [])];
  for (const branch of (schema["oneOf"] ?? schema["anyOf"] ?? []) as Json[]) {
    const tag = branch["properties"]?.["type"]?.["const"];
    if (tag !== undefined && tag === value?.["type"]) {
      for (const [k, v] of Object.entries(branch["properties"] as Json)) if (k !== "type") properties[k] = v;
      required.push(...((branch["required"] ?? []) as string[]));
    }
  }
  return { properties, required };
}

/** For a field that names another resource: what can be chosen. Keyed by field name. */
export type Choices = Record<string, Array<{ value: string; label: string }>>;

interface Common {
  schemas: Schemas;
  faults: Map<string, string>;
  disabled?: boolean | undefined;
  choices: Choices;
}

/** Keys the form leaves out: server-managed fields, and whatever the page handles itself. */
const ENVELOPE = ["id", "workspace_id", "revision", "created_at", "updated_at"];

export function SchemaForm({ schemas, schemaPath, schema, value, onChange, faults = [], pointer = "", hide = [], disabled, choices = {} }: {
  schemas: Schemas;
  /** File the schema lives in; `$ref`s resolve against it. */
  schemaPath: string;
  /** The schema itself; defaults to the file's root. */
  schema?: Json;
  value: Json;
  onChange: (next: Json) => void;
  faults?: Fault[];
  /** Pointer of `value` in what the server validated (for example `/config`). */
  pointer?: string;
  hide?: string[];
  disabled?: boolean;
  choices?: Choices;
}) {
  const root = schema ?? schemas.get(schemaPath);
  if (!root) return <div className="notice notice-danger">The schema {schemaPath} is not available.</div>;
  const map = new Map(faults.map((f) => [f.pointer, f.message]));
  return (
    <ObjectFields
      common={{ schemas, faults: map, disabled, choices }}
      schema={root}
      base={schemaPath}
      value={value}
      onChange={onChange}
      pointer={pointer}
      hide={[...ENVELOPE, ...hide]}
      depth={0}
    />
  );
}

/** Pointers a form drawn from this schema can show a fault on; the rest belong in a summary. */
export function shownPointers(faults: Fault[], value: Json, pointer = ""): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    out.push(at || "/");
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}/${i}`));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, `${at}/${escape(k)}`);
  };
  walk(value, pointer);
  const known = new Set(out);
  return faults.map((f) => f.pointer).filter((p) => known.has(p));
}

function ObjectFields({ common, schema, base, value, onChange, pointer, hide, depth }: {
  common: Common; schema: Json; base: string; value: Json; onChange: (next: Json) => void; pointer: string; hide: string[]; depth: number;
}) {
  const { properties, required } = propertiesOf(schema, value);
  const set = (key: string, next: unknown) => {
    const copy = { ...value };
    if (next === undefined || next === "" || (Array.isArray(next) && next.length === 0 && !required.includes(key))) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  const keys = Object.keys(properties).filter((k) => !hide.includes(k));
  const simple: string[] = [];
  const complex: string[] = [];
  for (const key of keys) {
    const { schema: s } = common.schemas.resolve(properties[key], base);
    if (s["readOnly"] === true || s["const"] !== undefined) continue;
    (isScalar(s) && !(s["type"] === "string" && isLong(key, s)) ? simple : complex).push(key);
  }
  const field = (key: string) => (
    <SchemaField
      key={key}
      common={common}
      name={key}
      schema={properties[key]}
      base={base}
      value={value?.[key]}
      onChange={(next) => set(key, next)}
      pointer={`${pointer}/${escape(key)}`}
      required={required.includes(key)}
      depth={depth}
    />
  );
  return (
    <div className="form">
      {simple.length > 0 && <div className="form-grid">{simple.map(field)}</div>}
      {complex.map(field)}
    </div>
  );
}

const isLong = (name: string, s: Json) => /_pem$|^body$|^template$/.test(name) || (typeof s["maxLength"] === "number" && s["maxLength"] > 1024);

function SchemaField({ common, name, schema: raw, base: rawBase, value, onChange, pointer, required, depth }: {
  common: Common; name: string; schema: Json; base: string; value: unknown; onChange: (next: unknown) => void; pointer: string; required: boolean; depth: number;
}) {
  const { schema, base } = common.schemas.resolve(raw, rawBase);
  const label = title(name);
  const hint = plain(schema["description"]);
  const error = common.faults.get(pointer);
  const invalid = error ? { "aria-invalid": true as const } : {};
  const disabled = common.disabled;

  if (schema["enum"] !== undefined) {
    const options = schema["enum"] as unknown[];
    return (
      <Field label={label} hint={hint} error={error} required={required}>
        {(id, describedBy) => (
          <select id={id} className="select" aria-describedby={describedBy} {...invalid} disabled={disabled}
            value={value === undefined ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : options.find((o) => String(o) === e.target.value))}>
            {(!required || value === undefined) && <option value="">{schema["default"] !== undefined ? `Default (${String(schema["default"])})` : "Not set"}</option>}
            {options.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
          </select>
        )}
      </Field>
    );
  }

  if (schema["type"] === "boolean") {
    const checked = value === undefined ? schema["default"] === true : value === true;
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
        {hint && <span className="field-hint">{hint}</span>}
        {error && <span className="field-error">{error}</span>}
      </div>
    );
  }

  if (schema["type"] === "integer" || schema["type"] === "number") {
    return (
      <Field label={label} hint={hint} error={error} required={required}>
        {(id, describedBy) => (
          <input id={id} className="input" type="number" inputMode="decimal" aria-describedby={describedBy} {...invalid} disabled={disabled}
            step={schema["type"] === "integer" ? 1 : "any"} min={schema["minimum"]} max={schema["maximum"]}
            placeholder={schema["default"] !== undefined ? String(schema["default"]) : ""}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
        )}
      </Field>
    );
  }

  const options = schema["type"] === "string" ? common.choices[name] : undefined;
  if (options) {
    // References are stored as ids and written by name; offer both, and keep a value that is neither.
    const known = options.some((o) => o.value === value || o.label === value);
    return (
      <Field label={label} hint={hint} error={error} required={required}>
        {(id, describedBy) => (
          <select id={id} className="select" aria-describedby={describedBy} {...invalid} disabled={disabled}
            value={typeof value === "string" ? (options.find((o) => o.label === value)?.value ?? value) : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
            <option value="">{required ? "Choose" : "None"}</option>
            {typeof value === "string" && value !== "" && !known && <option value={value}>{value}</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </Field>
    );
  }

  if (schema["type"] === "string") {
    const long = isLong(name, schema);
    return (
      <Field label={label} hint={hint} error={error} required={required}>
        {(id, describedBy) => long ? (
          <textarea id={id} className="textarea code" rows={6} aria-describedby={describedBy} {...invalid} disabled={disabled} spellCheck={false}
            value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input id={id} className="input" type="text" aria-describedby={describedBy} {...invalid} disabled={disabled} autoComplete="off" spellCheck={false}
            placeholder={schema["default"] !== undefined ? String(schema["default"]) : ""}
            value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
    );
  }

  if (schema["type"] === "array" && schema["items"] !== undefined) {
    const { schema: item, base: itemBase } = common.schemas.resolve(schema["items"], base);
    const list = Array.isArray(value) ? value : [];
    const structured = item["type"] === "object" && item["properties"] !== undefined && depth < 3;
    if (isScalar(item) || structured) {
      const replace = (i: number, next: unknown) => onChange(list.map((x, j) => (j === i ? next : x)));
      return (
        <fieldset className="fieldset">
          <legend className={required ? "field-required" : ""}>{label}</legend>
          {hint && <span className="field-hint">{hint}</span>}
          {error && <span className="field-error">{error}</span>}
          {list.map((entry, i) => (
            <div className="list-row" key={i}>
              {structured ? (
                <ObjectFields common={common} schema={item} base={itemBase} value={(entry ?? {}) as Json} onChange={(next) => replace(i, next)} pointer={`${pointer}/${i}`} hide={["id"]} depth={depth + 1} />
              ) : (
                <ListItem common={common} label={`${label} ${i + 1}`} schema={item} value={entry} onChange={(next) => replace(i, next)} error={common.faults.get(`${pointer}/${i}`)} />
              )}
              {!disabled && (
                <button type="button" className="icon-btn" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
          {!disabled && (
            <div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...list, structured ? {} : item["type"] === "string" || item["enum"] ? "" : 0])}>
                <Plus size={12} aria-hidden="true" /> Add {label.toLowerCase().replace(/s$/, "")}
              </button>
            </div>
          )}
        </fieldset>
      );
    }
  }

  if (schema["type"] === "object" && schema["properties"] !== undefined && schema["additionalProperties"] === false && depth < 3) {
    return (
      <fieldset className="fieldset">
        <legend className={required ? "field-required" : ""}>{label}</legend>
        {hint && <span className="field-hint">{hint}</span>}
        {error && <span className="field-error">{error}</span>}
        <ObjectFields common={common} schema={schema} base={base} value={(value ?? {}) as Json}
          onChange={(next) => onChange(Object.keys(next).length === 0 && !required ? undefined : next)} pointer={pointer} hide={[]} depth={depth + 1} />
      </fieldset>
    );
  }

  return <JsonField label={label} hint={hint} error={error ?? firstBelow(common.faults, pointer)} required={required} value={value} onChange={onChange} disabled={disabled} />;
}

/** A fault somewhere inside a value that is edited as one JSON text. */
function firstBelow(faults: Map<string, string>, pointer: string): string | undefined {
  for (const [p, message] of faults) if (p.startsWith(`${pointer}/`)) return `${p.slice(pointer.length)}: ${message}`;
  return undefined;
}

function ListItem({ common, label, schema, value, onChange, error }: { common: Common; label: string; schema: Json; value: unknown; onChange: (next: unknown) => void; error: string | undefined }) {
  const invalid = error ? { "aria-invalid": true as const } : {};
  return (
    <div className="field">
      {schema["enum"] !== undefined ? (
        <select className="select" aria-label={label} {...invalid} disabled={common.disabled} value={String(value ?? "")} onChange={(e) => onChange((schema["enum"] as unknown[]).find((o) => String(o) === e.target.value) ?? "")}>
          <option value="">Choose</option>
          {(schema["enum"] as unknown[]).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      ) : schema["type"] === "string" ? (
        <input className="input" type="text" aria-label={label} {...invalid} disabled={common.disabled} autoComplete="off" spellCheck={false} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" type="number" aria-label={label} {...invalid} disabled={common.disabled} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/** Edits any value as JSON text. The value changes only while the text parses. */
export function JsonField({ label, hint, error, required, value, onChange, disabled, rows = 5 }: {
  label: string; hint?: string | undefined; error?: string | undefined; required?: boolean | undefined; value: unknown; onChange: (next: unknown) => void; disabled?: boolean | undefined; rows?: number;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState<string | undefined>();
  // Follow a value replaced from outside (a reset, a loaded resource), not our own edits.
  useEffect(() => {
    setText((current) => {
      try {
        if (current.trim() !== "" && JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
      } catch {
        return current;
      }
      return value === undefined ? "" : JSON.stringify(value, null, 2);
    });
  }, [value]);
  return (
    <Field label={label} hint={hint ? `${hint} Written as JSON.` : "Written as JSON."} error={bad ?? error} required={required}>
      {(id, describedBy) => (
        <textarea id={id} className="textarea code" rows={rows} aria-describedby={describedBy} disabled={disabled} spellCheck={false}
          {...(bad ?? error ? { "aria-invalid": true as const } : {})}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === "") {
              setBad(undefined);
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(e.target.value));
              setBad(undefined);
            } catch {
              setBad("This is not valid JSON yet.");
            }
          }} />
      )}
    </Field>
  );
}
