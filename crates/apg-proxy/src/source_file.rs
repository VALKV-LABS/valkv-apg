//! The `file` config source (spec §5.5): `apg.yaml`, or a directory of them.
//!
//! The documents are compiled into the same events a control plane would
//! send and applied through the same path. A reload is all-or-nothing: an
//! invalid file leaves the running configuration untouched.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use apg_core::config;
use apg_core::resources::Resources;
use apg_core::schema::{Fault, Schemas};

use crate::gateway::Gateway;
use crate::metrics;
use crate::tls::TlsStore;

/// The YAML files a config path names: the file itself, or every `.yaml` /
/// `.yml` file directly inside a directory, in name order.
pub fn config_files(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    if !path.is_dir() {
        return Ok(vec![path.to_path_buf()]);
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(path)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")))
        .collect();
    files.sort();
    Ok(files)
}

/// Reads, substitutes, validates and compiles the configuration at `path`.
/// Returns every fault found. Certificates named by file are read and checked too.
pub fn load(path: &Path, schemas: &Schemas, env: &dyn Fn(&str) -> Option<String>) -> Result<Resources, Vec<Fault>> {
    let files = config_files(path).map_err(|e| vec![Fault::new("/", format!("cannot read {}: {e}", path.display()))])?;
    if files.is_empty() {
        return Err(vec![Fault::new("/", format!("{} contains no .yaml or .yml file", path.display()))]);
    }
    let mut sources = Vec::new();
    let mut faults = Vec::new();
    for file in &files {
        let name = file.display().to_string();
        match std::fs::read_to_string(file) {
            Err(e) => faults.push(Fault::new("/", format!("cannot read {name}: {e}"))),
            Ok(text) => match config::substitute_env(&text, env) {
                Ok(text) => sources.push((name, text)),
                Err(fs) => faults.extend(fs.into_iter().map(|f| Fault::new(f.pointer, format!("{name}: {}", f.message)))),
            },
        }
    }
    if !faults.is_empty() {
        return Err(faults);
    }
    let doc = config::parse_and_merge(&sources)?;
    let events = config::compile(&doc, schemas)?;

    let mut resources = Resources::new();
    for event in &events {
        resources.apply(event);
    }
    let cert_faults = TlsStore::check(&resources, &|p| std::fs::read(p));
    if cert_faults.is_empty() { Ok(resources) } else { Err(cert_faults) }
}

/// Something that changes whenever any config file changes.
fn fingerprint(path: &Path) -> Vec<(PathBuf, Option<SystemTime>, u64)> {
    config_files(path)
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let meta = std::fs::metadata(&p).ok();
            (p, meta.as_ref().and_then(|m| m.modified().ok()), meta.map_or(0, |m| m.len()))
        })
        .collect()
}

pub struct FileSource {
    pub path: PathBuf,
    pub schemas: Arc<Schemas>,
    pub gateway: Arc<Gateway>,
    pub tls: Arc<TlsStore>,
}

impl FileSource {
    /// Loads and installs the configuration. On failure nothing is installed
    /// and the faults are returned.
    pub fn reload(&self, generation: u64) -> Result<(), Vec<Fault>> {
        let resources = load(&self.path, &self.schemas, &|k| std::env::var(k).ok())?;
        let names = self.tls.install(&resources, &|p| std::fs::read(p));
        self.gateway.install(&resources, generation);
        self.gateway.health.mark_alive();
        self.gateway.health.mark_converged();
        let snap = self.gateway.snapshot();
        tracing::info!(routes = snap.route_count(), services = snap.service_count(), certificate_names = names, generation, "configuration loaded");
        Ok(())
    }

    /// Reloads on file change (checked twice a second, which also debounces a
    /// half-written file: it is picked up once its size and time settle) and
    /// on `SIGHUP`. An invalid file is rejected whole; the node keeps serving
    /// what it has (spec CFG-18).
    pub async fn watch(self) {
        let mut seen = fingerprint(&self.path);
        let mut pending: Option<Vec<(PathBuf, Option<SystemTime>, u64)>> = None;
        let mut generation = 1u64;
        #[cfg(unix)]
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()).ok();
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            #[cfg(unix)]
            let forced = match hangup.as_mut() {
                Some(sig) => tokio::select! {
                    _ = tick.tick() => false,
                    _ = sig.recv() => true,
                },
                None => {
                    tick.tick().await;
                    false
                }
            };
            #[cfg(not(unix))]
            let forced = {
                tick.tick().await;
                false
            };

            // The file exists and is readable: the source is alive, changed or not.
            self.gateway.health.mark_alive();
            let now = fingerprint(&self.path);
            let changed = now != seen;
            // Wait for one quiet interval after a change before reading.
            let settled = pending.as_ref() == Some(&now);
            if changed && !settled && !forced {
                pending = Some(now);
                continue;
            }
            if !(forced || (changed && settled)) {
                continue;
            }
            pending = None;
            seen = now;
            generation += 1;
            match self.reload(generation) {
                Ok(()) => {}
                Err(faults) => {
                    metrics::CONFIG_RELOAD_FAILURES.inc();
                    for f in &faults {
                        tracing::error!(pointer = %f.pointer, message = %f.message, "configuration rejected; still serving the previous one");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const GOOD: &str = "version: 1\nservices:\n  - { name: s, backends: [{ target: '${UPSTREAM:-echo:8080}' }] }\nroutes:\n  - { name: r, service: s, paths: [/a] }\n";

    fn schemas() -> Arc<Schemas> {
        Arc::new(Schemas::load().unwrap())
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn loads_one_file_with_env_defaults() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("apg.yaml");
        std::fs::write(&file, GOOD).unwrap();
        let r = load(&file, &schemas(), &no_env).unwrap();
        assert_eq!((r.count("service"), r.count("route"), r.count("workspace")), (1, 1, 1));
        let svc = r.kind("service").next().unwrap().1;
        assert_eq!(svc.data["backends"][0]["target"], "echo:8080");
        let with_env = load(&file, &schemas(), &|k| (k == "UPSTREAM").then(|| "10.0.0.1:9000".to_string())).unwrap();
        assert_eq!(with_env.kind("service").next().unwrap().1.data["backends"][0]["target"], "10.0.0.1:9000");
    }

    #[test]
    fn loads_a_directory_in_name_order_and_ignores_other_files() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("10-services.yaml"), "version: 1\nservices:\n  - { name: s, backends: [{ target: 'a:1' }] }\n").unwrap();
        std::fs::write(dir.path().join("20-routes.yml"), "version: 1\nroutes:\n  - { name: r, service: s }\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "not config").unwrap();
        let r = load(dir.path(), &schemas(), &no_env).unwrap();
        assert_eq!((r.count("service"), r.count("route")), (1, 1));
        assert_eq!(config_files(dir.path()).unwrap().len(), 2);
    }

    #[test]
    fn reports_every_problem_with_where_it_is() {
        let dir = TempDir::new().unwrap();
        let missing = load(&dir.path().join("nope.yaml"), &schemas(), &no_env).unwrap_err();
        assert!(missing[0].message.contains("cannot read"));
        assert!(load(dir.path(), &schemas(), &no_env).unwrap_err()[0].message.contains("no .yaml"));

        let file = dir.path().join("apg.yaml");
        std::fs::write(&file, "version: 1\nservices:\n  - { name: s, backends: [{ target: '${UPSTREAM}' }] }\n").unwrap();
        assert!(load(&file, &schemas(), &no_env).unwrap_err()[0].message.contains("UPSTREAM is not set"));

        std::fs::write(&file, "version: 1\nroutes:\n  - { name: r, service: gone }\n").unwrap();
        assert_eq!(load(&file, &schemas(), &no_env).unwrap_err()[0].pointer, "/routes/0/service");

        std::fs::write(&file, "version: 1\ncertificates:\n  - { name: c, cert_file: /nope.crt, key_file: /nope.key }\n").unwrap();
        assert!(load(&file, &schemas(), &no_env).unwrap_err()[0].message.contains("cannot read certificate"));
    }

    // spec CFG-18: a bad edit must never take down a working gateway.
    #[test]
    fn an_invalid_reload_keeps_the_previous_configuration() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("apg.yaml");
        std::fs::write(&file, GOOD).unwrap();
        let gateway = Gateway::new("n".into(), "file", 30);
        let source = FileSource { path: file.clone(), schemas: schemas(), gateway: gateway.clone(), tls: Arc::new(TlsStore::new(None).unwrap()) };

        source.reload(1).unwrap();
        assert_eq!(gateway.snapshot().route_count(), 1);
        assert!(gateway.health.readiness().ready);

        std::fs::write(&file, "version: 1\nroutes:\n  - { name: r, service: does-not-exist }\n").unwrap();
        let faults = source.reload(2).unwrap_err();
        assert_eq!(faults[0].pointer, "/routes/0/service");
        assert_eq!(gateway.snapshot().route_count(), 1, "still serving the configuration from before the bad edit");
        assert_eq!(gateway.applied_seq(), 1);

        std::fs::write(&file, GOOD.replace("paths: [/a]", "paths: [/a, /b]")).unwrap();
        source.reload(3).unwrap();
        assert_eq!(gateway.applied_seq(), 3);
    }

    #[test]
    fn the_fingerprint_changes_when_a_file_changes() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("apg.yaml");
        std::fs::write(&file, GOOD).unwrap();
        let a = fingerprint(&file);
        assert_eq!(a, fingerprint(&file));
        std::fs::write(&file, format!("{GOOD}# more\n")).unwrap();
        assert_ne!(a, fingerprint(&file));
    }
}
