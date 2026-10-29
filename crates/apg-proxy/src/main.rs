//! The `valkv-apg` binary.
//!
//!   valkv-apg                       run the node (configuration from the environment)
//!   valkv-apg validate --config P   check a config file or directory and exit
//!   valkv-apg --upgrade               take over the listeners of a running node (file mode)
//!   valkv-apg --version

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use apg_core::schema::Schemas;
use apg_proxy::acme;
use apg_proxy::applier::Applier;
use apg_proxy::config::{Config, ConfigSource};
use apg_proxy::source_api::{ApiSource, ApiSourceConfig};
use apg_proxy::gateway::Gateway;
use apg_proxy::proxy::{ApgProxy, ProxySettings};
use apg_proxy::source_file::{self, FileSource};
use apg_proxy::tls::{SniAcceptor, TlsStore};
use apg_proxy::{metrics, mgmt};
use pingora_core::listeners::tls::TlsSettings;
use pingora_core::server::Server;
use pingora_core::tls::ssl::SslVersion;
use pingora_core::server::configuration::ServerConf;
use pingora_proxy::http_proxy_service;

const USAGE: &str = "usage:\n  valkv-apg                         run the node\n  valkv-apg --upgrade               start, taking over the listeners of the running node\n  valkv-apg validate --config PATH  check a config file or directory\n  valkv-apg --version";

/// Validates configuration without starting anything (spec CFG-19). Exit code 0 means valid.
fn validate(args: &[String]) -> i32 {
    let path = match args {
        [flag, path] if flag == "--config" || flag == "-c" => PathBuf::from(path),
        [] => PathBuf::from(std::env::var("APG_CONFIG_FILE").unwrap_or_else(|_| "/etc/apg/apg.yaml".into())),
        _ => {
            eprintln!("{USAGE}");
            return 2;
        }
    };
    let schemas = match Schemas::load() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("internal error: {e}");
            return 1;
        }
    };
    match source_file::load(&path, &schemas, &|k| std::env::var(k).ok()) {
        Ok(resources) => {
            println!(
                "{}: valid ({} workspaces, {} services, {} routes, {} plugins, {} domains, {} certificates)",
                path.display(),
                resources.count("workspace"),
                resources.count("service"),
                resources.count("route"),
                resources.count("plugin"),
                resources.count("domain"),
                resources.count("certificate"),
            );
            0
        }
        Err(faults) => {
            eprintln!("{}: {} problem(s)", path.display(), faults.len());
            for f in &faults {
                eprintln!("  {f}");
            }
            1
        }
    }
}

fn init_logging(config: &Config) {
    let filter = tracing_subscriber::EnvFilter::new(&config.log_level);
    if config.log_json {
        tracing_subscriber::fmt().event_format(apg_proxy::logfmt::JsonLines).with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}

fn run(upgrade: bool) -> anyhow::Result<()> {
    let config = Config::from_env()?;
    if upgrade && config.source != ConfigSource::File {
        // Two processes cannot hold the local configuration cache at once.
        anyhow::bail!("--upgrade is available with APG_CONFIG_SOURCE=file only; restart the node instead (it serves from its cache at once)");
    }
    init_logging(&config);
    metrics::init();

    let schemas = Arc::new(Schemas::load()?);
    let tls = Arc::new(TlsStore::new(config.tls_fallback.as_ref())?.with_secrets(config.secrets.clone()));
    let source_name = match config.source {
        ConfigSource::File => "file",
        ConfigSource::ApiPoll => "api_poll",
    };
    let gateway = Gateway::with_upstreams(config.node_id.clone(), source_name, config.stale_after_secs(), config.upstream.clone());

    // Each source is prepared here, on the main thread, so a configuration
    // problem stops the node before it listens; its long-running part is then
    // handed to the background runtime.
    enum Source {
        File(FileSource),
        Api(Arc<ApiSource>, String),
    }
    let source = match config.source {
        ConfigSource::File => {
            // First load. An invalid file here is fatal: there is nothing older to serve (spec CFG-18).
            let source = FileSource { path: PathBuf::from(&config.config_file), schemas, gateway: gateway.clone(), tls: tls.clone() };
            if let Err(faults) = source.reload(1) {
                for f in &faults {
                    tracing::error!(pointer = %f.pointer, message = %f.message, "invalid configuration");
                    eprintln!("{}: {f}", config.config_file);
                }
                anyhow::bail!("{} is not valid; refusing to start", config.config_file);
            }
            Source::File(source)
        }
        ConfigSource::ApiPoll => {
            let poll = config.api_poll.clone().expect("present for api_poll");
            // Opening the cache installs the last known configuration, so the
            // node serves before (and whether or not) the control plane answers.
            let applier = Arc::new(Applier::open(&config.data_dir, gateway.clone(), tls.clone())?);
            let api = ApiSource::new(
                ApiSourceConfig {
                    url: poll.url,
                    token: poll.token,
                    poll_interval: Duration::from_millis(poll.interval_ms),
                    poll_limit: poll.limit,
                    wait: Duration::from_millis(poll.wait_ms),
                    node_id: config.node_id.clone(),
                    region: config.region.clone(),
                    client_identity: poll.client_identity,
                    ca_file: poll.ca_file,
                },
                applier,
                gateway.clone(),
            )?;
            Source::Api(Arc::new(api), poll.admin_url)
        }
    };

    // Plugin state that outlives a restart: quota counters.
    gateway.plugins.allow_env(config.template_env_allow.clone());
    gateway.plugins.cache.set_budget(config.cache_bytes);
    let quota_file = PathBuf::from(&config.data_dir).join("quota.json");
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    gateway.plugins.quotas.load(&quota_file, now());

    // Usage: counted into windows, queued on disk, delivered by a background task (spec §11).
    apg_proxy::metrics::set_max_series(config.metrics_max_series);
    let usage = Arc::new(apg_proxy::usage::Usage::new(config.usage_interval_secs, config.usage_by_consumer, Some(PathBuf::from(&config.data_dir).join("usage-queue.json"))));
    let _ = gateway.usage.set(usage.clone());
    let usage_sink = match &source {
        Source::File(_) => match &config.usage_file {
            Some(path) => apg_proxy::usage::UsageSink::File(PathBuf::from(path)),
            None => apg_proxy::usage::UsageSink::Discard,
        },
        Source::Api(api, admin_url) => apg_proxy::usage::UsageSink::ControlPlane {
            http: api.client(),
            url: admin_url.clone(),
            token: api.config.token.clone(),
            node_id: config.node_id.clone(),
            region: config.region.clone(),
        },
    };

    // Certificate issuance. With a control plane the fleet is coordinated
    // through it; from a file this node is on its own (spec TLS-12).
    let coordination = match &source {
        Source::File(_) => acme::Coordination::Local { data_dir: PathBuf::from(&config.data_dir) },
        Source::Api(api, admin_url) => acme::Coordination::Fleet(acme::Fleet {
            base: admin_url.trim_end_matches('/').to_string(),
            token: api.config.token.clone(),
            http: api.client(),
            node_id: config.node_id.clone(),
        }),
    };
    let certificates = acme::Manager::new(config.acme.clone(), gateway.clone(), tls.clone(), config.secrets.clone(), coordination)?;

    // Background runtime: the config source and the management listener.
    {
        let gateway = gateway.clone();
        let mgmt_addr = config.listen_mgmt.clone();
        std::thread::Builder::new().name("apg-background".into()).spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("background runtime");
            rt.block_on(async move {
                // Backend name resolution and active health checks.
                tokio::spawn(gateway.upstreams.clone().run());
                // Upgraded connections to a drained or removed backend are let go (spec UP-11).
                tokio::spawn(gateway.long_lived.clone().run(gateway.clone()));
                tokio::spawn(gateway.clone().report_status());
                tokio::spawn(certificates.run());
                tokio::spawn(apg_proxy::usage::run(usage, gateway.clone(), usage_sink));
                {
                    // Quota counters are written out every ten seconds (spec §9.4).
                    let plugins = gateway.plugins.clone();
                    tokio::spawn(async move {
                        let mut tick = tokio::time::interval(Duration::from_secs(10));
                        loop {
                            tick.tick().await;
                            if !plugins.quotas.is_empty()
                                && let Err(e) = plugins.quotas.save(&quota_file, now())
                            {
                                tracing::warn!(error = %e, "quota counters could not be written");
                            }
                        }
                    });
                }
                match source {
                    Source::File(file) => {
                        tokio::spawn(file.watch());
                    }
                    Source::Api(api, admin_url) => {
                        tokio::spawn(api.clone().run());
                        tokio::spawn(api.heartbeat(admin_url));
                    }
                }
                match mgmt_addr {
                    Some(addr) => {
                        // While taking over from a running node its management port is
                        // still held by that node; wait for it to let go.
                        let mut attempts = if upgrade { 120 } else { 1 };
                        loop {
                            let Err(e) = mgmt::serve(addr.clone(), gateway.clone()).await else { break };
                            attempts -= 1;
                            if attempts == 0 {
                                // Without it nothing can probe the node; do not limp on.
                                tracing::error!(error = %e, "management listener failed");
                                std::process::exit(1);
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                    None => std::future::pending::<()>().await,
                }
            });
        })?;
    }

    let https_port = config.listen_https.as_deref().and_then(|a| a.rsplit_once(':')).and_then(|(_, p)| p.parse::<u16>().ok()).filter(|p| *p != 443);
    let tcp_proxy = match &config.listen_tcp {
        Some(_) => Some(apg_proxy::tcp::TcpProxy::new(gateway.clone(), tls.clone(), config.tls13_only).map_err(|e| anyhow::anyhow!("TCP listener setup failed: {e}"))?),
        None => None,
    };
    let proxy = ApgProxy::new(
        gateway,
        ProxySettings {
            http_mode: config.http_mode,
            traffic_health_path: config.traffic_health_path.clone(),
            trusted_proxies: config.trusted_proxies.clone(),
            stub_upstream: config.stub_upstream,
            https_port,
        },
    );

    // On SIGTERM: stop accepting, let requests in flight finish, then exit (spec DP-4).
    // A new binary started with --upgrade asks this process for its listening
    // sockets through `upgrade_sock`; this process then gets SIGQUIT and drains (spec PKG-7).
    let conf = ServerConf {
        grace_period_seconds: Some(0),
        graceful_shutdown_timeout_seconds: Some(config.shutdown_grace_secs),
        upgrade_sock: format!("{}/upgrade.sock", config.data_dir.trim_end_matches('/')),
        // The framework's default is one worker thread per service, which leaves
        // every other core idle. Use what the machine (or the container's CPU limit) offers.
        threads: std::thread::available_parallelism().map_or(2, std::num::NonZero::get),
        ..ServerConf::default()
    };
    let opt = pingora_core::server::configuration::Opt { upgrade, ..Default::default() };
    let mut server = Server::new_with_opt_and_conf(Some(opt), conf);
    server.bootstrap();

    let mut service = http_proxy_service(&server.configuration, proxy);
    if let Some(addr) = &config.listen_https {
        let mut settings = TlsSettings::with_callbacks(Box::new(SniAcceptor { store: tls })).map_err(|e| anyhow::anyhow!("TLS setup failed: {e}"))?;
        settings.enable_h2();
        if config.tls13_only {
            settings.set_min_proto_version(Some(SslVersion::TLS1_3)).map_err(|e| anyhow::anyhow!("APG_TLS_MIN_VERSION: {e}"))?;
        }
        service.add_tls_with_settings(addr, None, settings);
    }
    if let Some(addr) = &config.listen_http {
        service.add_tcp(addr);
    }
    tracing::info!(
        node_id = %config.node_id,
        https = config.listen_https.as_deref().unwrap_or("disabled"),
        http = config.listen_http.as_deref().unwrap_or("disabled"),
        mgmt = config.listen_mgmt.as_deref().unwrap_or("disabled"),
        tcp = config.listen_tcp.as_deref().unwrap_or("disabled"),
        source = source_name,
        "valkv-apg starting"
    );
    server.add_service(service);
    if let (Some(addr), Some(app)) = (&config.listen_tcp, tcp_proxy) {
        let mut tcp = pingora_core::services::listening::Service::new("tcp routes".to_string(), app);
        tcp.add_tcp(addr);
        server.add_service(tcp);
    }
    server.run_forever();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        None | Some("--upgrade") => match run(!args.is_empty()) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("valkv-apg: {e}");
                2
            }
        },
        Some("validate") => validate(&args[1..]),
        Some("--version" | "-V") => {
            println!("valkv-apg {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help" | "-h") => {
            println!("{USAGE}");
            0
        }
        Some(_) => {
            eprintln!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}
