//! The part of valkv-apg that decides, without doing any I/O.
//!
//! * [`model`]: the resources a node receives and the changelog event that carries them.
//! * [`resources`]: the idempotent apply path every config source feeds (spec ARC-1, CFG-4, CFG-5).
//! * [`snapshot`]: an immutable, indexed view built from the resources; what a request is matched against.
//! * [`path`]: request path normalisation (spec RT-3).
//! * [`plugins`]: which plugin instance applies to a request (spec PL-1).
//! * [`template`]: the `{{ variable }}` templates of spec §9.5.
//! * [`schema`]: the JSON Schemas in `schemas/`, compiled in.
//! * [`config`]: `apg.yaml` to events (spec §14.1), for file mode and `validate`.
//!
//! The node links this crate; so will the admin's route tester, so both run the
//! same matching code (spec RT-6).

pub mod config;
pub mod model;
pub mod path;
pub mod plugins;
pub mod resources;
pub mod schema;
pub mod snapshot;
pub mod template;
