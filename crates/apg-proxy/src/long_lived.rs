//! Upgraded connections (WebSocket and the like), which outlive the request
//! that opened them (spec UP-11, UP-12).
//!
//! A backend that stops being `active`, or leaves its service, gets no new
//! requests at once. A connection already upgraded to it is closed once the
//! service's `drain_timeout_ms` has passed, so its client reconnects and lands
//! on a backend that stays. The node keeps a second descriptor of each such
//! upstream socket and shuts the socket down: the proxy then sees the upstream
//! end and finishes both sides as it does for any close.

use std::net::{Shutdown, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use apg_core::snapshot::Snapshot;
use dashmap::DashMap;

use crate::gateway::Gateway;
use crate::metrics;

/// Where a connection's backend stands in the configuration now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// `active`: the connection stays. Carries the service's `drain_timeout_ms`.
    Active(Duration),
    /// `draining` or `down`: the connection is closed after the drain timeout.
    Leaving(Duration),
    /// The backend or its whole service was removed: closed after the drain
    /// timeout the service last had.
    Gone,
}

impl Standing {
    pub fn of(snapshot: &Snapshot, service_id: &str, target: &str) -> Self {
        let Some(service) = snapshot.service(service_id) else { return Standing::Gone };
        let drain = Duration::from_millis(service.spec.drain_timeout_ms);
        match service.spec.backends.iter().find(|b| b.target == target) {
            Some(b) if b.status == "active" => Standing::Active(drain),
            Some(_) => Standing::Leaving(drain),
            None => Standing::Gone,
        }
    }
}

struct Conn {
    service_id: String,
    target: String,
    socket: TcpStream,
    drain: Duration,
    /// When the backend was first seen leaving; cleared if it comes back.
    leaving_since: Option<Instant>,
    closed: bool,
}

/// Every upgraded connection this node holds open.
#[derive(Default)]
pub struct LongLived {
    conns: DashMap<u64, Conn>,
    next: AtomicU64,
}

/// Held by a request for as long as its connection is upgraded.
pub struct Registration {
    owner: Arc<LongLived>,
    id: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        if self.owner.conns.remove(&self.id).is_some() {
            metrics::UPGRADED.dec();
        }
    }
}

impl LongLived {
    /// Starts watching an upgraded connection to `target` of a service.
    /// `socket` is a second descriptor of the upstream socket.
    pub fn register(self: &Arc<Self>, service_id: &str, target: &str, drain: Duration, socket: TcpStream) -> Registration {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.conns.insert(id, Conn { service_id: service_id.to_string(), target: target.to_string(), socket, drain, leaving_since: None, closed: false });
        metrics::UPGRADED.inc();
        Registration { owner: self.clone(), id }
    }

    pub fn len(&self) -> usize {
        self.conns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.conns.is_empty()
    }

    /// One pass over the open connections: closes those whose backend has
    /// been leaving for its drain timeout. Returns how many it closed.
    pub fn sweep(&self, now: Instant, standing: impl Fn(&str, &str) -> Standing) -> usize {
        let mut closed = 0;
        for mut conn in self.conns.iter_mut() {
            if conn.closed {
                continue;
            }
            match standing(&conn.service_id, &conn.target) {
                Standing::Active(drain) => {
                    conn.drain = drain;
                    conn.leaving_since = None;
                    continue;
                }
                Standing::Leaving(drain) => conn.drain = drain,
                Standing::Gone => {}
            }
            let since = *conn.leaving_since.get_or_insert(now);
            if now.saturating_duration_since(since) >= conn.drain {
                // An error only means the socket is already closed.
                let _ = conn.socket.shutdown(Shutdown::Both);
                conn.closed = true;
                closed += 1;
            }
        }
        closed
    }

    /// Runs for the life of the node.
    pub async fn run(self: Arc<Self>, gateway: Arc<Gateway>) {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tick.tick().await;
            if self.is_empty() {
                continue;
            }
            let snapshot = gateway.snapshot();
            let closed = self.sweep(Instant::now(), |service_id, target| Standing::of(&snapshot, service_id, target));
            if closed > 0 {
                metrics::DRAINED.inc_by(closed as u64);
                tracing::info!(closed, "closed upgraded connections to a backend that was drained or removed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A connected pair of real sockets: what the node holds, and the backend's end.
    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let near = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (far, _) = listener.accept().unwrap();
        (near, far)
    }

    fn is_closed(far: &mut TcpStream) -> bool {
        far.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        matches!(far.read(&mut [0u8; 1]), Ok(0))
    }

    #[test]
    fn a_leaving_backend_is_let_go_after_the_drain_timeout() {
        let long_lived = Arc::new(LongLived::default());
        let (near, mut far) = pair();
        let _held = long_lived.register("s1", "a:80", Duration::from_secs(5), near.try_clone().unwrap());
        let t0 = Instant::now();

        assert_eq!(long_lived.sweep(t0, |_, _| Standing::Active(Duration::from_secs(5))), 0);
        assert_eq!(long_lived.sweep(t0, |_, _| Standing::Leaving(Duration::from_secs(5))), 0, "the clock starts now");
        assert_eq!(long_lived.sweep(t0 + Duration::from_secs(4), |_, _| Standing::Leaving(Duration::from_secs(5))), 0);
        assert!(!is_closed(&mut far));
        assert_eq!(long_lived.sweep(t0 + Duration::from_secs(5), |_, _| Standing::Leaving(Duration::from_secs(5))), 1);
        assert!(is_closed(&mut far), "the backend sees the connection end");
        assert_eq!(long_lived.sweep(t0 + Duration::from_secs(6), |_, _| Standing::Gone), 0, "closed once");
    }

    #[test]
    fn a_backend_that_comes_back_keeps_its_connections() {
        let long_lived = Arc::new(LongLived::default());
        let (near, mut far) = pair();
        let _held = long_lived.register("s1", "a:80", Duration::from_secs(5), near);
        let t0 = Instant::now();
        long_lived.sweep(t0, |_, _| Standing::Leaving(Duration::from_secs(5)));
        long_lived.sweep(t0 + Duration::from_secs(3), |_, _| Standing::Active(Duration::from_secs(5)));
        assert_eq!(long_lived.sweep(t0 + Duration::from_secs(6), |_, _| Standing::Leaving(Duration::from_secs(5))), 0, "the clock started again");
        assert!(!is_closed(&mut far));
        far.write_all(b"x").unwrap();
    }

    #[test]
    fn a_removed_backend_uses_the_drain_timeout_its_service_last_had() {
        let long_lived = Arc::new(LongLived::default());
        let (near, mut far) = pair();
        let _held = long_lived.register("s1", "a:80", Duration::from_secs(30), near);
        let t0 = Instant::now();
        long_lived.sweep(t0, |_, _| Standing::Active(Duration::ZERO));
        assert_eq!(long_lived.sweep(t0, |_, _| Standing::Gone), 1, "a drain timeout of zero closes at once");
        assert!(is_closed(&mut far));
    }

    #[test]
    fn a_finished_connection_is_forgotten() {
        let long_lived = Arc::new(LongLived::default());
        let (near, _far) = pair();
        let held = long_lived.register("s1", "a:80", Duration::ZERO, near);
        assert_eq!(long_lived.len(), 1);
        drop(held);
        assert!(long_lived.is_empty());
    }

    #[test]
    fn standing_follows_the_configuration() {
        use apg_core::model::ChangeEvent;
        use apg_core::resources::Resources;
        use serde_json::json;
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s1", Some("w".into()), json!({ "name": "svc", "drain_timeout_ms": 1500, "backends": [
            { "target": "a:80" }, { "target": "b:80", "status": "draining" }, { "target": "c:80", "status": "down" }
        ] })));
        let snapshot = Snapshot::build(&r);
        let drain = Duration::from_millis(1500);
        assert_eq!(Standing::of(&snapshot, "s1", "a:80"), Standing::Active(drain));
        assert_eq!(Standing::of(&snapshot, "s1", "b:80"), Standing::Leaving(drain));
        assert_eq!(Standing::of(&snapshot, "s1", "c:80"), Standing::Leaving(drain));
        assert_eq!(Standing::of(&snapshot, "s1", "d:80"), Standing::Gone);
        assert_eq!(Standing::of(&snapshot, "s2", "a:80"), Standing::Gone);
    }
}
