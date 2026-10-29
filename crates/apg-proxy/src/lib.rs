//! The valkv-apg node.
//!
//! Decisions (matching, plugin resolution, config loading) live in `apg-core`.
//! This crate does the I/O around them: listeners, the proxy pipeline, TLS,
//! the config sources, the local cache, and the management endpoints.

pub mod accesslog;
pub mod acme;
pub mod applier;
pub mod auth;
pub mod cache;
pub mod callout;
pub mod config;
pub mod gateway;
pub mod limits;
pub mod logfmt;
pub mod long_lived;
pub mod metrics;
pub mod mgmt;
pub mod mtls;
pub mod net;
pub mod plugins;
pub mod proxy;
pub mod response_cache;
pub mod secrets;
pub mod source_api;
pub mod source_file;
pub mod tcp;
pub mod tls;
pub mod transform;
pub mod upstream;
pub mod usage;
