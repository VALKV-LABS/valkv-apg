/**
 * `{{ variable }}` templates (spec §9.5), checked on write.
 *
 * Nodes compile templates when configuration is applied
 * (`crates/apg-core/src/template.rs`). The same rules are applied here, so a
 * template that would not compile is refused by the Admin API instead of
 * breaking a plugin on every node (spec TPL-1). A fixture shared with the
 * node's tests keeps the two in step.
 */

/** Variable roots a template may use. */
export const ROOTS = ["request", "client", "workspace", "consumer", "route", "service", "backend", "jwt", "env", "error"];

/** Why a template does not compile, or `null` when it does. */
export function templateFault(source: string): string | null {
  let rest = source;
  let offset = 0;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) return null;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) return `unclosed '{{' at offset ${offset + start}`;
    const inner = after.slice(0, end).trim();
    if (inner === "") return `empty placeholder at offset ${offset + start}`;
    const bar = inner.indexOf("|");
    const path = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (bar >= 0 && !/^default\(\s*("[^"]*"|'[^']*')\s*\)$/.test(inner.slice(bar + 1).trim())) {
      return `unsupported filter in '${inner}'; only default("…") is available`;
    }
    const root = path.split(".")[0] ?? "";
    const wellFormed = path.includes(".") && path.split(".").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
    if (!ROOTS.includes(root) || !wellFormed) return `unknown variable '${path}'`;
    offset += start + 2 + end + 2;
    rest = after.slice(end + 2);
  }
}

/** Where templates sit in a plugin's configuration: single values, and maps whose string values are templates. */
function templateFields(type: string): { single: string[]; maps: string[] } {
  switch (type) {
    case "redirect": return { single: ["/path"], maps: [] };
    case "static_response": return { single: ["/body"], maps: [] };
    case "request_transformer": return { single: [], maps: ["/headers/set", "/headers/add", "/query/set", "/query/add", "/body/set"] };
    case "response_transformer": return { single: [], maps: ["/headers/set", "/headers/add", "/body/set"] };
    case "access_log": return { single: [], maps: ["/custom_fields"] };
    default: return { single: [], maps: [] };
  }
}

function at(doc: unknown, pointer: string): unknown {
  let node = doc;
  for (const token of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

/** Every template in a plugin configuration that does not compile. */
export function pluginTemplateFaults(type: string, config: unknown): Array<{ pointer: string; message: string }> {
  const { single, maps } = templateFields(type);
  const found: Array<[string, string]> = [];
  for (const pointer of single) {
    const value = at(config, pointer);
    if (typeof value === "string") found.push([pointer, value]);
  }
  for (const pointer of maps) {
    const map = at(config, pointer);
    if (map === null || typeof map !== "object") continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string") found.push([`${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, value]);
    }
  }
  const faults: Array<{ pointer: string; message: string }> = [];
  for (const [pointer, text] of found) {
    const message = templateFault(text);
    if (message) faults.push({ pointer, message });
  }
  return faults;
}
