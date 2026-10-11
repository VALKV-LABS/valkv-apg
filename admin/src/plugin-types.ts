/**
 * Built-in plugin types, their default priorities and phases (spec §9.2).
 *
 * This table is duplicated from `crates/apg-plugin-sdk/src/lib.rs`, which the
 * node uses. A test (`plugin-types.test.ts`) parses the Rust source and fails
 * if the two drift.
 */

export interface PluginTypeInfo {
  name: string;
  default_priority: number;
  phases: string[];
}

export const PLUGIN_TYPES: PluginTypeInfo[] = [
  { name: "ip_restriction", default_priority: 3000, phases: ["request"] },
  { name: "cors", default_priority: 2900, phases: ["request", "response_headers"] },
  { name: "request_size_limit", default_priority: 2800, phases: ["request"] },
  { name: "mtls_auth", default_priority: 2500, phases: ["request"] },
  { name: "jwt_auth", default_priority: 2400, phases: ["request"] },
  { name: "key_auth", default_priority: 2300, phases: ["request"] },
  { name: "basic_auth", default_priority: 2200, phases: ["request"] },
  { name: "forward_auth", default_priority: 2100, phases: ["request"] },
  { name: "acl", default_priority: 2000, phases: ["request"] },
  { name: "rate_limit", default_priority: 1900, phases: ["request", "response_headers"] },
  { name: "quota", default_priority: 1800, phases: ["request", "response_headers"] },
  { name: "bandwidth_limit", default_priority: 1700, phases: ["request", "log"] },
  { name: "http_callout", default_priority: 1500, phases: ["request", "response_headers"] },
  { name: "wasm", default_priority: 1400, phases: ["request", "response_headers"] },
  { name: "redirect", default_priority: 1300, phases: ["request"] },
  { name: "static_response", default_priority: 1200, phases: ["request"] },
  { name: "request_transformer", default_priority: 1100, phases: ["request", "upstream_request"] },
  { name: "response_cache", default_priority: 1000, phases: ["request", "response_headers", "response_body"] },
  { name: "response_transformer", default_priority: 900, phases: ["response_headers", "response_body"] },
  { name: "compression", default_priority: 800, phases: ["response_headers", "response_body"] },
  { name: "access_log", default_priority: 100, phases: ["log"] },
];
