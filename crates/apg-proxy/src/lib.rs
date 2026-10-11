//! The valkv-apg node.
//!
//! Decisions (matching, plugin resolution, config loading) live in `apg-core`.
//! This crate does the I/O around them: listeners, the proxy pipeline, TLS,
//! the config sources, the local cache, and the management endpoints.

pub mod acme;
pub mod applier;
pub mod cache;
pub mod config;
pub mod gateway;
pub mod limits;
pub mod metrics;
pub mod mgmt;
pub mod net;
pub mod proxy;
pub mod secrets;
pub mod source_api;
pub mod source_file;
pub mod tls;
pub mod upstream;
