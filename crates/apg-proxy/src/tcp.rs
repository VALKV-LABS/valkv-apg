//! The TCP listener: TLS connections routed by SNI name to `tcp` routes.
//!
//! The node reads the client's ClientHello without consuming it, takes the
//! SNI name, and matches it against `tcp` routes exactly as HTTP hosts are
//! matched (system routes first, then the routes of the workspace that owns
//! the name). Then, by the route's `tls_passthrough`:
//!
//! - `false`: the node completes the handshake with the certificate it holds
//!   for the name and forwards the decrypted stream (TLS again when the
//!   service's scheme is `https`).
//! - `true`: the node forwards the client's bytes untouched, ClientHello
//!   included, and the backend completes the handshake.
//!
//! Backend choice, connect timeouts, retries on connect failure, the circuit
//! breaker, egress restriction and draining are the ones HTTP traffic uses.
//! Plugins do not apply: the node never sees requests here, only bytes.

use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use apg_core::snapshot::{ServiceEntry, Snapshot, TcpMatched};
use async_trait::async_trait;
use pingora_core::apps::ServerApp;
use pingora_core::connectors::TransportConnector;
use pingora_core::protocols::Stream;
use pingora_core::server::ShutdownWatch;
use pingora_core::tls::ssl::{Ssl, SslAcceptor, SslMethod, SslVersion};
use pingora_core::tls::tokio_ssl::SslStream;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use crate::gateway::Gateway;
use crate::metrics;
use crate::tls::TlsStore;
use crate::upstream::{self, Picked};

/// How long a client has to send its ClientHello.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the TLS handshake may take once the ClientHello is in.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The most the node buffers while looking for the SNI name. A ClientHello
/// is normally well under 2 KiB; post-quantum key shares make it larger.
const HELLO_MAX: usize = 32 * 1024;

/// What the bytes read so far say about the ClientHello.
#[derive(Debug, PartialEq, Eq)]
pub enum Hello {
    /// Not enough bytes yet.
    Incomplete,
    /// A complete ClientHello, with its SNI name if it has one.
    Complete(Option<String>),
    /// The client is not speaking TLS, or not sensibly.
    NotTls,
}

/// Reads the SNI name out of the ClientHello at the start of `buf`. The
/// handshake message may be spread over several TLS records.
pub fn client_hello(buf: &[u8]) -> Hello {
    // Collect the handshake bytes from consecutive handshake records.
    let mut handshake = Vec::new();
    let mut at = 0;
    loop {
        if handshake.len() >= 4 {
            let want = 4 + u32::from_be_bytes([0, handshake[1], handshake[2], handshake[3]]) as usize;
            if handshake[0] != 1 || want > HELLO_MAX {
                return Hello::NotTls;
            }
            if handshake.len() >= want {
                return parse_client_hello(&handshake[4..want]).map_or(Hello::NotTls, Hello::Complete);
            }
        }
        let Some(header) = buf.get(at..at + 5) else { return Hello::Incomplete };
        // A handshake record, TLS 1.0 to 1.2 on the record layer (1.3 keeps saying 1.2 there).
        if header[0] != 22 || header[1] != 3 || header[2] > 3 {
            return Hello::NotTls;
        }
        let len = u16::from_be_bytes([header[3], header[4]]) as usize;
        if len == 0 {
            return Hello::NotTls;
        }
        let Some(fragment) = buf.get(at + 5..at + 5 + len) else { return Hello::Incomplete };
        handshake.extend_from_slice(fragment);
        at += 5 + len;
    }
}

/// The body of a ClientHello: `None` when malformed, `Some(None)` when it has no SNI name.
fn parse_client_hello(body: &[u8]) -> Option<Option<String>> {
    let mut r = Reader(body);
    r.take(2 + 32)?; // version, random
    let session = r.u8()? as usize;
    r.take(session)?;
    let suites = r.u16()? as usize;
    r.take(suites)?;
    let compression = r.u8()? as usize;
    r.take(compression)?;
    if r.0.is_empty() {
        return Some(None); // no extensions at all
    }
    let len = r.u16()? as usize;
    let mut ext = Reader(r.take(len)?);
    while !ext.0.is_empty() {
        let kind = ext.u16()?;
        let len = ext.u16()? as usize;
        let data = ext.take(len)?;
        if kind != 0 {
            continue;
        }
        // server_name: a list of (type, name); type 0 is a host name.
        let mut list = Reader(data);
        let len = list.u16()? as usize;
        let mut names = Reader(list.take(len)?);
        while !names.0.is_empty() {
            let kind = names.u8()?;
            let len = names.u16()? as usize;
            let name = names.take(len)?;
            if kind == 0 {
                let name = std::str::from_utf8(name).ok()?;
                let valid = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_');
                return valid.then(|| Some(name.trim_end_matches('.').to_ascii_lowercase()));
            }
        }
        return Some(None);
    }
    Some(None)
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Some(head)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
}

/// A stream that first gives back bytes already read from it.
struct Replay<S> {
    head: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Replay<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.at < self.head.len() {
            let n = buf.remaining().min(self.head.len() - self.at);
            let at = self.at;
            buf.put_slice(&self.head[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Replay<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Copies both ways until both sides have closed, either side fails, or
/// nothing has moved in either direction for `idle`. Returns the bytes sent
/// from `a` to `b` and from `b` to `a`.
pub async fn pipe<A, B>(a: A, b: B, idle: Duration) -> (u64, u64)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let started = Instant::now();
    let last = AtomicU64::new(0);
    let touch = || last.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
    let (mut a_read, mut a_write) = tokio::io::split(a);
    let (mut b_read, mut b_write) = tokio::io::split(b);
    let (a_to_b, b_to_a) = (AtomicU64::new(0), AtomicU64::new(0));

    async fn copy(from: &mut (impl AsyncRead + Unpin), to: &mut (impl AsyncWrite + Unpin), count: &AtomicU64, touch: &(dyn Fn() + Sync)) -> io::Result<()> {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = from.read(&mut buf).await?;
            if n == 0 {
                // Half-close: the other side may still have something to say.
                return to.shutdown().await;
            }
            to.write_all(&buf[..n]).await?;
            // The node's streams buffer writes; nothing reaches the other side until flushed.
            to.flush().await?;
            count.fetch_add(n as u64, Ordering::Relaxed);
            touch();
        }
    }
    let both = async {
        let (up, down) = tokio::join!(copy(&mut a_read, &mut b_write, &a_to_b, &touch), copy(&mut b_read, &mut a_write, &b_to_a, &touch));
        // An error on one side ends both: there is no one to finish talking to.
        let _ = (up, down);
    };
    let watchdog = async {
        loop {
            let quiet = started.elapsed().saturating_sub(Duration::from_millis(last.load(Ordering::Relaxed)));
            if quiet >= idle {
                return;
            }
            tokio::time::sleep(idle - quiet).await;
        }
    };
    tokio::select! {
        () = both => {}
        () = watchdog => {}
    }
    (a_to_b.load(Ordering::Relaxed), b_to_a.load(Ordering::Relaxed))
}

/// The TCP listener's application.
pub struct TcpProxy {
    gateway: Arc<Gateway>,
    tls: Arc<TlsStore>,
    acceptor: SslAcceptor,
    connector: TransportConnector,
}

/// Why a connection was not proxied, as the `outcome` metric label.
type Outcome = &'static str;

impl TcpProxy {
    pub fn new(gateway: Arc<Gateway>, tls: Arc<TlsStore>, tls13_only: bool) -> anyhow::Result<Self> {
        let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls())?;
        if tls13_only {
            builder.set_min_proto_version(Some(SslVersion::TLS1_3))?;
        }
        Ok(Self { gateway, tls, acceptor: builder.build(), connector: TransportConnector::new(None) })
    }

    /// Reads until the ClientHello is complete. Returns the bytes read and the SNI name.
    async fn read_hello(client: &mut Stream) -> Result<(Vec<u8>, String), Outcome> {
        let mut buf = Vec::with_capacity(2048);
        let read = async {
            loop {
                match client_hello(&buf) {
                    Hello::Complete(Some(name)) => return Ok(name),
                    Hello::Complete(None) => return Err("no_sni"),
                    Hello::NotTls => return Err("not_tls"),
                    Hello::Incomplete if buf.len() >= HELLO_MAX => return Err("not_tls"),
                    Hello::Incomplete => {}
                }
                let mut chunk = [0u8; 4096];
                match client.read(&mut chunk).await {
                    Ok(0) | Err(_) => return Err("client_closed"),
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
        };
        let name = tokio::time::timeout(HELLO_TIMEOUT, read).await.map_err(|_| "client_timeout")??;
        Ok((buf, name))
    }

    /// Opens a connection to a backend of the service, retrying on another
    /// backend as the service's `retries` allow (spec UP-9).
    async fn connect(&self, snapshot: &Snapshot, service: &ServiceEntry, client_ip: Option<IpAddr>) -> Option<(Stream, Picked)> {
        let ups = &self.gateway.upstreams;
        let key = client_ip.map(|ip| ip.to_string()).filter(|_| service.spec.load_balancing.hash_key == "client_ip");
        let retries = &service.spec.retries;
        let attempts = 1 + if retries.on("connect_failure") { retries.attempts } else { 0 };
        let mut tried: Vec<String> = Vec::new();
        for attempt in 0..attempts {
            if attempt > 0 {
                metrics::UPSTREAM_RETRIES.with_label_values(&[&service.workspace_id, &service.spec.name]).inc();
            }
            let picked = ups.select(snapshot, service, key.as_deref(), &tried)?;
            tried.push(picked.backend.target.clone());
            let addr = match ups.address(service, &picked.backend, key.as_deref()).await {
                Ok(addr) => addr,
                Err(reason) => {
                    picked.failed_because(reason);
                    ups.record(snapshot, service, &picked, false);
                    continue;
                }
            };
            let peer = match ups.peer(service, &picked.backend, addr, None) {
                Ok(peer) => peer,
                Err(reason) => {
                    // Broken trust material: every backend of the service would fail the same way.
                    tracing::error!(service = %service.spec.name, %reason, "tcp connection refused: the service's TLS settings are unusable");
                    return None;
                }
            };
            match self.connector.new_stream(&peer).await {
                Ok(stream) => {
                    ups.record(snapshot, service, &picked, true);
                    return Some((stream, picked));
                }
                Err(e) => {
                    ups.connect_failed(addr);
                    picked.failed_because(&upstream::failure_reason(&e));
                    ups.record(snapshot, service, &picked, false);
                }
            }
        }
        None
    }

    async fn handle(&self, mut client: Stream) -> (Outcome, Option<TcpMatched>, Option<Arc<ServiceEntry>>) {
        let client_ip = client.get_socket_digest().and_then(|d| d.peer_addr().and_then(|a| a.as_inet()).map(|a| a.ip()));
        let (hello, sni) = match Self::read_hello(&mut client).await {
            Ok(found) => found,
            Err(outcome) => return (outcome, None, None),
        };
        let snapshot = self.gateway.snapshot();
        let Some(matched) = snapshot.match_tcp(&sni) else {
            tracing::debug!(%sni, "tcp connection with no route");
            return ("no_route", None, None);
        };
        if snapshot.is_suspended(&matched.workspace_id) {
            return ("suspended", Some(matched), None);
        }
        let route = matched.route.clone();
        let index = if route.targets.len() == 1 {
            0
        } else {
            let weights: Vec<u32> = route.targets.iter().map(|(_, w)| *w).collect();
            upstream::weighted_pick(&weights, upstream::random() as usize).unwrap_or(0)
        };
        let Some(service) = snapshot.service(&route.targets[index].0).cloned() else { return ("no_backend", Some(matched), None) };

        // Terminate first, so a client that cannot complete a handshake never costs a backend connection.
        let client: Box<dyn Duplex> = if route.passthrough {
            Box::new(Replay { head: hello, at: 0, inner: client })
        } else {
            let mut ssl = match Ssl::new(self.acceptor.context()) {
                Ok(ssl) => ssl,
                Err(_) => return ("handshake_failed", Some(matched), Some(service)),
            };
            if let Err(message) = crate::tls::install(&mut ssl, &self.tls.select(Some(&sni))) {
                tracing::error!(%sni, %message, "certificate could not be installed for a tcp handshake");
                return ("handshake_failed", Some(matched), Some(service));
            }
            let Ok(mut tls) = SslStream::new(ssl, Replay { head: hello, at: 0, inner: client }) else {
                return ("handshake_failed", Some(matched), Some(service));
            };
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, Pin::new(&mut tls).accept()).await {
                Ok(Ok(())) => Box::new(tls),
                _ => return ("handshake_failed", Some(matched), Some(service)),
            }
        };

        let Some((upstream, picked)) = self.connect(&snapshot, &service, client_ip).await else {
            return ("upstream_failed", Some(matched), Some(service));
        };
        // A second descriptor of the upstream socket, so the connection can be
        // closed when its backend drains or leaves (spec UP-11).
        let _watch = {
            #[cfg(unix)]
            {
                // SAFETY: `upstream` owns the descriptor and outlives this borrow; it is only duplicated here.
                let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(upstream.id()) };
                borrowed.try_clone_to_owned().ok().map(|fd| {
                    let drain = Duration::from_millis(service.spec.drain_timeout_ms);
                    self.gateway.long_lived.register(&service.id, &picked.backend.target, drain, std::net::TcpStream::from(fd))
                })
            }
            #[cfg(not(unix))]
            None::<crate::long_lived::Registration>
        };

        let (route_label, service_label) = metrics::series(&route.name, &service.spec.name);
        metrics::TCP_ACTIVE.inc();
        let (up, down) = pipe(client, upstream, Duration::from_millis(route.idle_timeout_ms)).await;
        metrics::TCP_ACTIVE.dec();
        metrics::TCP_BYTES.with_label_values(&[route_label, service_label, "upstream"]).inc_by(up);
        metrics::TCP_BYTES.with_label_values(&[route_label, service_label, "downstream"]).inc_by(down);
        drop(picked);
        ("proxied", Some(matched), Some(service))
    }
}

/// A client side the proxy can copy to and from, TLS or not.
trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

#[async_trait]
impl ServerApp for TcpProxy {
    async fn process_new(self: &Arc<Self>, client: Stream, _shutdown: &ShutdownWatch) -> Option<Stream> {
        let (outcome, matched, service) = self.handle(client).await;
        let route = matched.as_ref().map_or("", |m| m.route.name.as_str());
        let service = service.as_ref().map_or("", |s| s.spec.name.as_str());
        let (route_label, service_label) = metrics::series(route, service);
        metrics::TCP_CONNECTIONS.with_label_values(&[route_label, service_label, outcome]).inc();
        if outcome != "proxied" && outcome != "client_closed" {
            tracing::debug!(route, service, outcome, "tcp connection not proxied");
        }
        // A tcp connection is never handed back for reuse.
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ClientHello as a client library would send it, from OpenSSL itself.
    fn hello_from_openssl(sni: Option<&str>) -> Vec<u8> {
        use pingora_core::tls::ssl::SslConnector;
        let connector = SslConnector::builder(SslMethod::tls()).unwrap().build();
        let mut config = connector.configure().unwrap();
        if sni.is_none() {
            config.set_use_server_name_indication(false);
        }
        // A socket pair whose other end never answers: the handshake writes the ClientHello and stalls.
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().unwrap();
        theirs.set_nonblocking(true).unwrap();
        let _ = config.connect(sni.unwrap_or("ignored.invalid"), theirs);
        let mut out = vec![0u8; HELLO_MAX];
        ours.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let n = std::io::Read::read(&mut &ours, &mut out).unwrap();
        out.truncate(n);
        out
    }

    #[test]
    fn the_sni_name_comes_out_of_a_real_client_hello() {
        let hello = hello_from_openssl(Some("Cache.Redis.Example.com"));
        assert_eq!(client_hello(&hello), Hello::Complete(Some("cache.redis.example.com".into())));
        assert_eq!(client_hello(&hello_from_openssl(None)), Hello::Complete(None));
        // Every prefix is only incomplete, never wrong.
        for cut in [0, 1, 4, 5, 9, 40, hello.len() - 1] {
            assert_eq!(client_hello(&hello[..cut]), Hello::Incomplete, "cut at {cut}");
        }
    }

    #[test]
    fn a_client_hello_split_over_records_is_put_back_together() {
        let hello = hello_from_openssl(Some("db.example.com"));
        let body = &hello[5..];
        let (first, second) = body.split_at(30);
        let mut split = Vec::new();
        for part in [first, second] {
            split.extend_from_slice(&[22, 3, 1]);
            split.extend_from_slice(&(part.len() as u16).to_be_bytes());
            split.extend_from_slice(part);
        }
        assert_eq!(client_hello(&split), Hello::Complete(Some("db.example.com".into())));
        assert_eq!(client_hello(&split[..split.len() - 1]), Hello::Incomplete);
    }

    #[test]
    fn what_is_not_tls_is_said_to_be_so() {
        assert_eq!(client_hello(b"*1\r\n$4\r\nPING\r\n"), Hello::NotTls, "a plain Redis command");
        assert_eq!(client_hello(b"GET / HTTP/1.1\r\n"), Hello::NotTls);
        assert_eq!(client_hello(&[22, 3, 1, 0, 0]), Hello::NotTls, "an empty record");
        assert_eq!(client_hello(&[22, 3, 1, 0, 4, 2, 0, 0, 0]), Hello::NotTls, "a handshake that is not a ClientHello");
        assert_eq!(client_hello(&[22, 3, 1, 0, 4, 1, 0, 0, 0]), Hello::NotTls, "a ClientHello with no body");
    }

    #[tokio::test]
    async fn pipe_copies_both_ways_and_replays_what_was_read_first() {
        let (client, mut client_far) = tokio::io::duplex(1024);
        let (backend, mut backend_far) = tokio::io::duplex(1024);
        let replayed = Replay { head: b"HELLO ".to_vec(), at: 0, inner: client };
        let task = tokio::spawn(pipe(replayed, backend, Duration::from_secs(5)));

        client_far.write_all(b"PING\r\n").await.unwrap();
        let mut got = vec![0u8; 12];
        backend_far.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"HELLO PING\r\n");
        backend_far.write_all(b"+PONG\r\n").await.unwrap();
        let mut got = vec![0u8; 7];
        client_far.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"+PONG\r\n");

        // The client closes; the backend sees the end, closes too, and the pipe finishes.
        drop(client_far);
        let mut rest = Vec::new();
        backend_far.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        drop(backend_far);
        assert_eq!(task.await.unwrap(), (12, 7));
    }

    // The node's own streams buffer writes, like this one: without a flush the
    // backend would never see a short command such as `SET k v`.
    #[tokio::test]
    async fn pipe_flushes_streams_that_buffer_writes() {
        let (client, mut client_far) = tokio::io::duplex(1024);
        let (backend, mut backend_far) = tokio::io::duplex(1024);
        let _task = tokio::spawn(pipe(client, tokio::io::BufStream::new(backend), Duration::from_secs(5)));
        client_far.write_all(b"SET k v\r\n").await.unwrap();
        let mut got = vec![0u8; 9];
        tokio::time::timeout(Duration::from_secs(2), backend_far.read_exact(&mut got)).await.expect("the write was flushed").unwrap();
        assert_eq!(&got, b"SET k v\r\n");
    }

    #[tokio::test]
    async fn pipe_closes_a_connection_that_has_gone_quiet() {
        let (client, _client_far) = tokio::io::duplex(64);
        let (backend, _backend_far) = tokio::io::duplex(64);
        let started = Instant::now();
        assert_eq!(pipe(client, backend, Duration::from_millis(100)).await, (0, 0));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
