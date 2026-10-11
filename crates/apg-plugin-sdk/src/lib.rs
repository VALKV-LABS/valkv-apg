//! Plugin phases and default ordering.
//!
//! The `Plugin` trait itself lands in build phase 2e. What is here is the part
//! the schemas and the admin already depend on: the list of plugin types, the
//! phases each runs in, and the default priority that orders them.

#![deny(missing_docs)]

use serde::{Deserialize, Serialize};

/// A point in the request lifecycle at which a plugin can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Before a backend is chosen. A plugin may answer the request here.
    Request,
    /// While the upstream request is being built.
    UpstreamRequest,
    /// When response headers are available.
    ResponseHeaders,
    /// For each response body chunk.
    ResponseBody,
    /// After the response has been sent. Always runs.
    Log,
}

/// Static description of one built-in plugin type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PluginTypeInfo {
    /// The `type` value used in configuration.
    pub name: &'static str,
    /// Default priority. Higher runs first within a phase.
    pub default_priority: i32,
    /// Phases the type runs in.
    pub phases: &'static [Phase],
}

use Phase::{Log, Request, ResponseBody, ResponseHeaders, UpstreamRequest};

/// Every built-in plugin type, in default execution order.
pub const PLUGIN_TYPES: &[PluginTypeInfo] = &[
    PluginTypeInfo { name: "ip_restriction",       default_priority: 3000, phases: &[Request] },
    PluginTypeInfo { name: "cors",                 default_priority: 2900, phases: &[Request, ResponseHeaders] },
    PluginTypeInfo { name: "request_size_limit",   default_priority: 2800, phases: &[Request] },
    PluginTypeInfo { name: "mtls_auth",            default_priority: 2500, phases: &[Request] },
    PluginTypeInfo { name: "jwt_auth",             default_priority: 2400, phases: &[Request] },
    PluginTypeInfo { name: "key_auth",             default_priority: 2300, phases: &[Request] },
    PluginTypeInfo { name: "basic_auth",           default_priority: 2200, phases: &[Request] },
    PluginTypeInfo { name: "forward_auth",         default_priority: 2100, phases: &[Request] },
    PluginTypeInfo { name: "acl",                  default_priority: 2000, phases: &[Request] },
    PluginTypeInfo { name: "rate_limit",           default_priority: 1900, phases: &[Request, ResponseHeaders] },
    PluginTypeInfo { name: "quota",                default_priority: 1800, phases: &[Request, ResponseHeaders] },
    PluginTypeInfo { name: "bandwidth_limit",      default_priority: 1700, phases: &[Request, Log] },
    PluginTypeInfo { name: "http_callout",         default_priority: 1500, phases: &[Request, ResponseHeaders] },
    PluginTypeInfo { name: "wasm",                 default_priority: 1400, phases: &[Request, ResponseHeaders] },
    PluginTypeInfo { name: "redirect",             default_priority: 1300, phases: &[Request] },
    PluginTypeInfo { name: "static_response",      default_priority: 1200, phases: &[Request] },
    PluginTypeInfo { name: "request_transformer",  default_priority: 1100, phases: &[Request, UpstreamRequest] },
    PluginTypeInfo { name: "response_cache",       default_priority: 1000, phases: &[Request, ResponseHeaders, ResponseBody] },
    PluginTypeInfo { name: "response_transformer", default_priority: 900,  phases: &[ResponseHeaders, ResponseBody] },
    PluginTypeInfo { name: "compression",          default_priority: 800,  phases: &[ResponseHeaders, ResponseBody] },
    PluginTypeInfo { name: "access_log",           default_priority: 100,  phases: &[Log] },
];

/// Looks up a built-in plugin type by its configuration name.
pub fn plugin_type(name: &str) -> Option<&'static PluginTypeInfo> {
    PLUGIN_TYPES.iter().find(|t| t.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn there_are_21_types_with_unique_names_and_priorities() {
        assert_eq!(PLUGIN_TYPES.len(), 21);
        let names: HashSet<_> = PLUGIN_TYPES.iter().map(|t| t.name).collect();
        let prios: HashSet<_> = PLUGIN_TYPES.iter().map(|t| t.default_priority).collect();
        assert_eq!(names.len(), 21);
        assert_eq!(prios.len(), 21, "equal priorities would make order ambiguous");
    }

    #[test]
    fn table_is_sorted_by_descending_priority() {
        assert!(PLUGIN_TYPES.windows(2).all(|w| w[0].default_priority > w[1].default_priority));
    }

    #[test]
    fn restriction_runs_before_authentication_and_auth_before_limits() {
        let p = |n| plugin_type(n).unwrap().default_priority;
        assert!(p("ip_restriction") > p("jwt_auth"));
        assert!(p("key_auth") > p("acl"));
        assert!(p("acl") > p("rate_limit"));
    }

    #[test]
    fn unknown_type_is_none() {
        assert!(plugin_type("nope").is_none());
    }
}
