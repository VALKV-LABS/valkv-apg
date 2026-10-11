//! Which plugin instance applies to a request (spec PL-1).
//!
//! For each plugin type exactly one instance is chosen, the most specific one.
//! If the chosen instance is disabled, the type does not run: that is how a
//! narrower scope switches off a broader default.

use std::collections::HashMap;

use crate::model::Plugin;

/// One plugin instance with its id.
#[derive(Debug, Clone)]
pub struct Instance {
    pub id: String,
    pub plugin: Plugin,
}

/// Where a request sits, for the purpose of choosing instances.
#[derive(Debug, Clone, Copy)]
pub struct Site<'a> {
    pub route_id: &'a str,
    pub service_id: &'a str,
    /// The workspace the request is attributed to.
    pub workspace_id: &'a str,
    pub consumer_id: Option<&'a str>,
}

#[derive(Debug, Default)]
struct PerType {
    by_route: HashMap<String, Vec<Instance>>,
    by_service: HashMap<String, Vec<Instance>>,
    /// Workspace-scoped instances, keyed by the workspace that owns them.
    by_workspace: HashMap<String, Vec<Instance>>,
    global: Vec<Instance>,
}

/// Every plugin instance, indexed for lookup on the request path.
#[derive(Debug, Default)]
pub struct PluginIndex {
    by_type: HashMap<String, PerType>,
}

impl PluginIndex {
    /// Adds an instance. `owner_workspace` is the workspace the instance belongs to.
    pub fn insert(&mut self, id: String, owner_workspace: &str, plugin: Plugin) {
        let per = self.by_type.entry(plugin.kind.clone()).or_default();
        let inst = Instance { id, plugin };
        match inst.plugin.scope.as_str() {
            "route" => {
                if let Some(route) = inst.plugin.route_id.clone() {
                    per.by_route.entry(route).or_default().push(inst);
                }
            }
            "service" => {
                if let Some(service) = inst.plugin.service_id.clone() {
                    per.by_service.entry(service).or_default().push(inst);
                }
            }
            "workspace" => per.by_workspace.entry(owner_workspace.to_string()).or_default().push(inst),
            "global" => per.global.push(inst),
            _ => {}
        }
    }

    /// The instance of `kind` that applies at `site`, or `None` when no
    /// instance applies or the one that applies is disabled.
    pub fn effective(&self, kind: &str, site: &Site<'_>) -> Option<&Instance> {
        let per = self.by_type.get(kind)?;
        let chosen = pick(per.by_route.get(site.route_id), site)
            .or_else(|| pick(per.by_service.get(site.service_id), site))
            .or_else(|| pick(per.by_workspace.get(site.workspace_id), site))
            .or_else(|| pick(Some(&per.global), site))?;
        chosen.plugin.enabled.then_some(chosen)
    }

    /// Plugin types that have at least one instance.
    pub fn types(&self) -> impl Iterator<Item = &str> {
        self.by_type.keys().map(String::as_str)
    }
}

/// Within one scope: the consumer's instance, then the target workspace's, then the unqualified one.
fn pick<'a>(candidates: Option<&'a Vec<Instance>>, site: &Site<'_>) -> Option<&'a Instance> {
    let list = candidates?;
    if let Some(consumer) = site.consumer_id
        && let Some(hit) = list.iter().find(|i| i.plugin.consumer_id.as_deref() == Some(consumer))
    {
        return Some(hit);
    }
    if let Some(hit) = list.iter().find(|i| i.plugin.consumer_id.is_none() && i.plugin.target_workspace.as_deref() == Some(site.workspace_id)) {
        return Some(hit);
    }
    list.iter().find(|i| i.plugin.consumer_id.is_none() && i.plugin.target_workspace.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plugin(scope: &str, route: Option<&str>, service: Option<&str>, consumer: Option<&str>, target: Option<&str>, enabled: bool) -> Plugin {
        serde_json::from_value(json!({
            "type": "rate_limit", "scope": scope, "route_id": route, "service_id": service,
            "consumer_id": consumer, "target_workspace": target, "enabled": enabled, "config": {}
        }))
        .unwrap()
    }

    fn site<'a>(consumer: Option<&'a str>, workspace: &'a str) -> Site<'a> {
        Site { route_id: "r1", service_id: "s1", workspace_id: workspace, consumer_id: consumer }
    }

    fn index() -> PluginIndex {
        let mut ix = PluginIndex::default();
        ix.insert("global".into(), "sys", plugin("global", None, None, None, None, true));
        ix.insert("ws".into(), "acme", plugin("workspace", None, None, None, None, true));
        ix.insert("svc".into(), "sys", plugin("service", None, Some("s1"), None, None, true));
        ix.insert("route".into(), "sys", plugin("route", Some("r1"), None, None, None, true));
        ix.insert("route-ws".into(), "sys", plugin("route", Some("r1"), None, None, Some("acme"), true));
        ix.insert("route-consumer".into(), "sys", plugin("route", Some("r1"), None, Some("c1"), None, true));
        ix
    }

    fn id(ix: &PluginIndex, s: &Site<'_>) -> Option<String> {
        ix.effective("rate_limit", s).map(|i| i.id.clone())
    }

    #[test]
    fn most_specific_instance_wins() {
        let ix = index();
        assert_eq!(id(&ix, &site(Some("c1"), "acme")).as_deref(), Some("route-consumer"));
        assert_eq!(id(&ix, &site(None, "acme")).as_deref(), Some("route-ws"));
        assert_eq!(id(&ix, &site(Some("other"), "acme")).as_deref(), Some("route-ws"));
        assert_eq!(id(&ix, &site(None, "rival")).as_deref(), Some("route"));
    }

    #[test]
    fn falls_back_scope_by_scope() {
        let ix = index();
        let other_route = Site { route_id: "r2", service_id: "s1", workspace_id: "acme", consumer_id: None };
        assert_eq!(id(&ix, &other_route).as_deref(), Some("svc"));
        let other_service = Site { route_id: "r2", service_id: "s2", workspace_id: "acme", consumer_id: None };
        assert_eq!(id(&ix, &other_service).as_deref(), Some("ws"));
        let other_ws = Site { route_id: "r2", service_id: "s2", workspace_id: "rival", consumer_id: None };
        assert_eq!(id(&ix, &other_ws).as_deref(), Some("global"));
        assert_eq!(ix.effective("cors", &other_ws).map(|i| i.id.as_str()), None);
    }

    // The override that matters: a narrower disabled instance turns the type off,
    // it does not fall through to the broader one.
    #[test]
    fn a_disabled_winner_switches_the_type_off() {
        let mut ix = PluginIndex::default();
        ix.insert("global".into(), "sys", plugin("global", None, None, None, None, true));
        ix.insert("off-for-acme".into(), "sys", plugin("route", Some("r1"), None, None, Some("acme"), false));
        assert_eq!(id(&ix, &site(None, "acme")), None);
        assert_eq!(id(&ix, &site(None, "rival")).as_deref(), Some("global"));
    }

    #[test]
    fn a_consumer_instance_never_applies_to_another_consumer_or_to_anonymous() {
        let mut ix = PluginIndex::default();
        ix.insert("only-c1".into(), "sys", plugin("route", Some("r1"), None, Some("c1"), None, true));
        assert_eq!(id(&ix, &site(Some("c1"), "acme")).as_deref(), Some("only-c1"));
        assert_eq!(id(&ix, &site(Some("c2"), "acme")), None);
        assert_eq!(id(&ix, &site(None, "acme")), None);
    }
}
