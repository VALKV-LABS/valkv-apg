//! The management listener (spec §6.1): health, readiness, metrics, status.
//!
//! A real HTTP server, bound to loopback by default and never to a traffic
//! listener. It is what load balancers, orchestrators and Prometheus talk to.

use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::gateway::Gateway;
use crate::metrics;

fn reply(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder().status(status).header("content-type", content_type).body(Full::new(body.into())).expect("static response")
}

/// Answers one management request. Separate from the listener so it can be tested without a socket.
pub fn handle(method: &Method, path: &str, gateway: &Gateway) -> Response<Full<Bytes>> {
    match (method, path) {
        // Liveness: the process is running.
        (&Method::GET, "/healthz") => reply(StatusCode::OK, "text/plain", "ok\n"),
        // Readiness: the node holds a complete configuration. See SourceHealth::readiness.
        (&Method::GET, "/readyz") => {
            let r = gateway.health.readiness();
            let body = serde_json::json!({
                "ready": r.ready,
                "stale": r.stale,
                "source": gateway.source,
                "source_age_seconds": r.source_age_seconds,
                "applied_seq": gateway.applied_seq(),
            });
            let status = if r.ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
            reply(status, "application/json", body.to_string())
        }
        (&Method::GET, "/metrics") => {
            gateway.health.readiness(); // refreshes the source-age gauge
            reply(StatusCode::OK, "text/plain; version=0.0.4", metrics::gather())
        }
        (&Method::GET, "/status") => reply(StatusCode::OK, "application/json", gateway.status().to_string()),
        (_, "/healthz" | "/readyz" | "/metrics" | "/status") => reply(StatusCode::METHOD_NOT_ALLOWED, "text/plain", "method not allowed\n"),
        _ => reply(StatusCode::NOT_FOUND, "text/plain", "not found\n"),
    }
}

/// Serves the management endpoints until the process exits.
pub async fn serve(addr: String, gateway: Arc<Gateway>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&addr).await.map_err(|e| anyhow::anyhow!("management listener cannot bind {addr}: {e}"))?;
    tracing::info!(%addr, "management listener ready");
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let gateway = gateway.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let gateway = gateway.clone();
                async move { Ok::<_, Infallible>(handle(req.method(), req.uri().path(), &gateway)) }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body(res: Response<Full<Bytes>>) -> String {
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn readiness_is_503_until_converged_then_200_with_details() {
        let g = Gateway::new("n1".into(), "file", 30);
        assert_eq!(handle(&Method::GET, "/healthz", &g).status(), StatusCode::OK);
        let before = handle(&Method::GET, "/readyz", &g);
        assert_eq!(before.status(), StatusCode::SERVICE_UNAVAILABLE);
        g.health.mark_converged();
        let after = handle(&Method::GET, "/readyz", &g);
        assert_eq!(after.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body(after).await).unwrap();
        assert_eq!(json["ready"], true);
        assert_eq!(json["source"], "file");
        assert_eq!(json["stale"], false);
    }

    #[tokio::test]
    async fn metrics_status_and_unknown_paths() {
        metrics::init();
        let g = Gateway::new("n1".into(), "file", 30);
        let m = handle(&Method::GET, "/metrics", &g);
        assert_eq!(m.headers()["content-type"], "text/plain; version=0.0.4");
        assert!(body(m).await.contains("apg_config_converged"));
        let s: serde_json::Value = serde_json::from_str(&body(handle(&Method::GET, "/status", &g)).await).unwrap();
        assert_eq!(s["node_id"], "n1");
        assert_eq!(handle(&Method::GET, "/nope", &g).status(), StatusCode::NOT_FOUND);
        // a path that merely contains a known one is not that endpoint
        assert_eq!(handle(&Method::GET, "/x/healthz", &g).status(), StatusCode::NOT_FOUND);
        assert_eq!(handle(&Method::POST, "/healthz", &g).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn serves_over_a_real_socket() {
        let g = Gateway::new("n1".into(), "file", 30);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        drop(listener);
        tokio::spawn(serve(addr.clone(), g));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(&addr).await.unwrap();
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.ends_with("ok\n"), "{out}");
    }
}
