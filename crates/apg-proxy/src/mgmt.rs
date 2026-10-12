//! The management listener (spec §6.1): health, readiness, metrics, status,
//! backend health, and the route tester (spec RT-6).
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

/// `GET /debug/match?host=&path=&method=&query=&header=Name:Value` (spec RT-6):
/// which route a request would hit on this node, and why not the others.
fn debug_match(query: &str, gateway: &Gateway) -> Response<Full<Bytes>> {
    let params = apg_core::snapshot::parse_query(query);
    let get = |name: &str| params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let (Some(host), Some(raw_path)) = (get("host"), get("path")) else {
        return reply(StatusCode::BAD_REQUEST, "application/json", r#"{"error":"host and path are required"}"#);
    };
    let Ok(path) = apg_core::path::normalize(raw_path) else {
        return reply(StatusCode::BAD_REQUEST, "application/json", r#"{"error":"the path is not valid"}"#);
    };
    let host = host.to_ascii_lowercase();
    let host = host.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map_or(host.as_str(), |(h, _)| h);
    let method = get("method").unwrap_or("GET").to_ascii_uppercase();
    let headers: Vec<(String, String)> = params
        .iter()
        .filter(|(k, _)| k == "header")
        .filter_map(|(_, v)| v.split_once(':').map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string())))
        .collect();
    let lookup = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let snapshot = gateway.snapshot();
    let explanation = snapshot.explain(&apg_core::snapshot::Request { host, path: &path, method: &method, query: get("query").unwrap_or(""), header: &lookup });
    let mut body = serde_json::to_value(&explanation).unwrap_or_default();
    body["applied_seq"] = serde_json::json!(gateway.applied_seq());
    body["node_id"] = serde_json::json!(gateway.node_id);
    reply(StatusCode::OK, "application/json", body.to_string())
}

/// `GET /upstreams?service=&workspace=&backend=` (spec OBS-4): what this node
/// knows about each backend. `service` is a name or an id, `workspace` an id,
/// `backend` a target. Asking for something the node does not have is a 404.
fn upstreams(query: &str, gateway: &Gateway) -> Response<Full<Bytes>> {
    let params = apg_core::snapshot::parse_query(query);
    let get = |name: &str| params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let mut services = gateway.upstreams.health(&gateway.snapshot(), usize::MAX, usize::MAX);
    if let Some(wanted) = get("service") {
        services.retain(|s| s["name"] == wanted || s["service_id"] == wanted);
    }
    if let Some(wanted) = get("workspace") {
        services.retain(|s| s["workspace_id"] == wanted);
    }
    if let Some(wanted) = get("backend") {
        for service in &mut services {
            if let Some(backends) = service["backends"].as_array_mut() {
                backends.retain(|b| b["target"] == wanted);
            }
        }
        services.retain(|s| s["backends"].as_array().is_some_and(|b| !b.is_empty()));
    }
    if services.is_empty() && (get("service").is_some() || get("backend").is_some()) {
        return reply(StatusCode::NOT_FOUND, "application/json", r#"{"error":"this node has no such service or backend"}"#);
    }
    let body = serde_json::json!({ "node_id": gateway.node_id, "applied_seq": gateway.applied_seq(), "services": services });
    reply(StatusCode::OK, "application/json", body.to_string())
}

/// Answers one management request. Separate from the listener so it can be tested without a socket.
pub fn handle(method: &Method, path: &str, query: &str, gateway: &Gateway) -> Response<Full<Bytes>> {
    match (method, path) {
        (&Method::GET, "/debug/match") => debug_match(query, gateway),
        (&Method::GET, "/upstreams") => upstreams(query, gateway),
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
        (_, "/healthz" | "/readyz" | "/metrics" | "/status" | "/debug/match" | "/upstreams") => reply(StatusCode::METHOD_NOT_ALLOWED, "text/plain", "method not allowed\n"),
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
                async move { Ok::<_, Infallible>(handle(req.method(), req.uri().path(), req.uri().query().unwrap_or(""), &gateway)) }
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
        assert_eq!(handle(&Method::GET, "/healthz", "", &g).status(), StatusCode::OK);
        let before = handle(&Method::GET, "/readyz", "", &g);
        assert_eq!(before.status(), StatusCode::SERVICE_UNAVAILABLE);
        g.health.mark_converged();
        let after = handle(&Method::GET, "/readyz", "", &g);
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
        let m = handle(&Method::GET, "/metrics", "", &g);
        assert_eq!(m.headers()["content-type"], "text/plain; version=0.0.4");
        assert!(body(m).await.contains("apg_config_converged"));
        let s: serde_json::Value = serde_json::from_str(&body(handle(&Method::GET, "/status", "", &g)).await).unwrap();
        assert_eq!(s["node_id"], "n1");
        assert_eq!(handle(&Method::GET, "/nope", "", &g).status(), StatusCode::NOT_FOUND);
        // a path that merely contains a known one is not that endpoint
        assert_eq!(handle(&Method::GET, "/x/healthz", "", &g).status(), StatusCode::NOT_FOUND);
        assert_eq!(handle(&Method::POST, "/healthz", "", &g).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn the_route_tester_needs_a_host_and_a_path_and_answers_json() {
        let g = Gateway::new("n1".into(), "file", 30);
        assert_eq!(handle(&Method::GET, "/debug/match", "host=a.example.com", &g).status(), StatusCode::BAD_REQUEST);
        assert_eq!(handle(&Method::GET, "/debug/match", "host=a.example.com&path=/../..", &g).status(), StatusCode::BAD_REQUEST);
        let res = handle(&Method::GET, "/debug/match", "host=A.Example.com:8443&path=/a/./b&method=post&header=X-Beta:%201", &g);
        assert_eq!(res.status(), StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body(res).await).unwrap();
        assert_eq!(json["host"], "a.example.com");
        assert_eq!(json["path"], "/a/b");
        assert_eq!(json["method"], "POST");
        assert_eq!(json["selected"], serde_json::Value::Null);
        assert_eq!(json["node_id"], "n1");
        assert_eq!(handle(&Method::POST, "/debug/match", "", &g).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    // spec OBS-4
    #[tokio::test]
    async fn upstreams_lists_backends_and_filters_by_service_and_backend() {
        use apg_core::model::ChangeEvent;
        use apg_core::resources::Resources;
        use serde_json::json;
        let g = Gateway::new("n1".into(), "file", 30);
        let mut r = Resources::new();
        r.apply(&ChangeEvent::upsert("workspace", "w", None, json!({ "name": "default", "slug": "default", "system": true })));
        r.apply(&ChangeEvent::upsert("service", "s1", Some("w".into()), json!({ "name": "orders", "backends": [{ "target": "10.0.0.1:80" }, { "target": "10.0.0.2:80", "status": "down" }] })));
        r.apply(&ChangeEvent::upsert("service", "s2", Some("w".into()), json!({ "name": "users", "backends": [{ "target": "10.0.0.3:80" }] })));
        g.install(&r, 3);

        let all: serde_json::Value = serde_json::from_str(&body(handle(&Method::GET, "/upstreams", "", &g)).await).unwrap();
        assert_eq!(all["node_id"], "n1");
        assert_eq!(all["services"].as_array().unwrap().len(), 2);

        let one: serde_json::Value = serde_json::from_str(&body(handle(&Method::GET, "/upstreams", "service=orders", &g)).await).unwrap();
        let orders = &one["services"][0];
        assert_eq!(orders["service_id"], "s1");
        // Nothing has been sent to it, so nothing is claimed about it.
        assert_eq!((orders["unknown"].as_u64(), orders["healthy"].as_u64(), orders["unhealthy"].as_u64()), (Some(1), Some(0), Some(0)));
        let states: Vec<&str> = orders["backends"].as_array().unwrap().iter().map(|b| b["state"].as_str().unwrap()).collect();
        assert_eq!(states, ["unknown", "down"]);

        let by_id: serde_json::Value = serde_json::from_str(&body(handle(&Method::GET, "/upstreams", "service=s2&backend=10.0.0.3:80", &g)).await).unwrap();
        assert_eq!(by_id["services"][0]["backends"][0]["target"], "10.0.0.3:80");

        assert_eq!(handle(&Method::GET, "/upstreams", "service=nope", &g).status(), StatusCode::NOT_FOUND);
        assert_eq!(handle(&Method::GET, "/upstreams", "service=orders&backend=10.9.9.9:1", &g).status(), StatusCode::NOT_FOUND);
        assert_eq!(handle(&Method::POST, "/upstreams", "", &g).status(), StatusCode::METHOD_NOT_ALLOWED);
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
