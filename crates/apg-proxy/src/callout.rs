//! Plugins that ask another service: `forward_auth` and `http_callout` (spec §9.4).
//!
//! Both have an explicit `fail_open`: what happens to the request when the
//! service cannot be reached is the operator's decision, not an accident
//! (spec PL-4).

use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::{Value, json};

use crate::plugins::Req;

fn names(config: &Value, key: &str, default: &[&str]) -> Vec<String> {
    match config.get(key).and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect(),
        None => default.iter().map(|s| s.to_ascii_lowercase()).collect(),
    }
}

// ── forward_auth ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ForwardAuth {
    url: String,
    method: reqwest::Method,
    request_headers: Vec<String>,
    response_headers: Vec<String>,
    timeout: Duration,
    fail_open: bool,
    cache_for: Duration,
    cache_key_headers: Vec<String>,
    /// Allowed answers: cache key to the headers to pass on, and when the answer was given.
    cache: DashMap<String, (Vec<(String, String)>, Instant)>,
}

/// What the authorisation service said.
#[derive(Debug, PartialEq)]
pub enum Forwarded {
    /// Let the request through, with these headers added for the upstream.
    Allow(Vec<(String, String)>),
    /// Give the client the service's own answer.
    Respond { status: u16, headers: Vec<(String, String)>, body: String },
    /// The service could not be asked, and `fail_open` is false.
    Unavailable,
}

impl ForwardAuth {
    pub fn build(config: &Value) -> Result<Self, String> {
        let url = config.get("url").and_then(Value::as_str).ok_or("url is required")?.to_string();
        let method = config.get("method").and_then(Value::as_str).unwrap_or("GET").parse::<reqwest::Method>().map_err(|_| "method is not an HTTP method".to_string())?;
        Ok(Self {
            url,
            method,
            request_headers: names(config, "request_headers", &["authorization", "cookie"]),
            response_headers: names(config, "response_headers", &[]),
            timeout: Duration::from_millis(config.get("timeout_ms").and_then(Value::as_u64).unwrap_or(2000)),
            fail_open: config.get("fail_open").and_then(Value::as_bool).unwrap_or(false),
            cache_for: Duration::from_secs(config.get("cache_secs").and_then(Value::as_u64).unwrap_or(0)),
            cache_key_headers: names(config, "cache_key_headers", &["authorization"]),
            cache: DashMap::new(),
        })
    }

    fn cache_key(&self, req: &Req<'_>) -> String {
        self.cache_key_headers.iter().map(|h| format!("{h}={}\u{1}", req.header(h).unwrap_or(""))).collect()
    }

    pub async fn check(&self, http: &reqwest::Client, req: &Req<'_>, scheme: &str) -> Forwarded {
        let key = (!self.cache_for.is_zero()).then(|| self.cache_key(req));
        if let Some(key) = &key
            && let Some(hit) = self.cache.get(key).filter(|e| e.1.elapsed() < self.cache_for)
        {
            return Forwarded::Allow(hit.0.clone());
        }
        let uri = if req.query.is_empty() { req.path.to_string() } else { format!("{}?{}", req.path, req.query) };
        let mut request = http
            .request(self.method.clone(), &self.url)
            .timeout(self.timeout)
            .header("x-forwarded-method", req.method)
            .header("x-forwarded-proto", scheme)
            .header("x-forwarded-host", req.host)
            .header("x-forwarded-uri", uri)
            .header("x-forwarded-for", req.client_ip);
        for name in &self.request_headers {
            if let Some(value) = req.header(name) {
                request = request.header(name.as_str(), value);
            }
        }
        let response = match request.send().await {
            Ok(r) => r,
            Err(error) => {
                tracing::warn!(url = %self.url, %error, fail_open = self.fail_open, "the authorisation service could not be asked");
                return if self.fail_open { Forwarded::Allow(Vec::new()) } else { Forwarded::Unavailable };
            }
        };
        let status = response.status();
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        if status.is_success() {
            let passed: Vec<(String, String)> = self.response_headers.iter().filter_map(|name| Some((name.clone(), header(name)?))).collect();
            if let Some(key) = key {
                if self.cache.len() > 50_000 {
                    self.cache.clear();
                }
                self.cache.insert(key, (passed.clone(), Instant::now()));
            }
            return Forwarded::Allow(passed);
        }
        // The service's refusal is the client's answer: a login redirect, a challenge.
        let headers: Vec<(String, String)> = ["www-authenticate", "location", "content-type"].iter().filter_map(|name| Some((name.to_string(), header(name)?))).collect();
        let body = response.text().await.unwrap_or_default();
        Forwarded::Respond { status: status.as_u16(), headers, body }
    }
}

// ── http_callout ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct HttpCallout {
    url: String,
    pub on_request: bool,
    pub on_response: bool,
    timeout: Duration,
    pub fail_open: bool,
    /// Headers to describe to the service. Empty means all but `Authorization` and `Cookie`.
    include_headers: Vec<String>,
    secret: Option<String>,
}

/// What the service wants done.
#[derive(Debug, Default, PartialEq)]
pub struct Answer {
    /// Answer the client here instead of continuing.
    pub respond: bool,
    pub set_headers: Vec<(String, String)>,
    pub remove_headers: Vec<String>,
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value.and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((k.to_ascii_lowercase(), v.as_str()?.to_string()))).collect()
}

/// Reads the service's reply (schema `schemas/callout-response.json`).
pub fn parse_answer(reply: &Value) -> Result<Answer, String> {
    let respond = match reply.get("action").and_then(Value::as_str).unwrap_or("continue") {
        "continue" => false,
        "respond" => true,
        other => return Err(format!("unknown action '{other}'")),
    };
    Ok(Answer {
        respond,
        set_headers: pairs(reply.get("set_headers")),
        remove_headers: reply.get("remove_headers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect(),
        status: reply.get("status").and_then(Value::as_u64).filter(|s| (100..=599).contains(s)).map(|s| s as u16),
        headers: pairs(reply.get("headers")),
        body: reply.get("body").and_then(Value::as_str).map(str::to_string),
    })
}

impl HttpCallout {
    /// Builds the plugin. `secret` resolves a secret-typed value (spec §9.6).
    pub fn build(config: &Value, secret: &dyn Fn(&Value) -> Result<String, String>) -> Result<Self, String> {
        let phases = names(config, "phases", &["request"]);
        Ok(Self {
            url: config.get("url").and_then(Value::as_str).ok_or("url is required")?.to_string(),
            on_request: phases.iter().any(|p| p == "request"),
            on_response: phases.iter().any(|p| p == "response"),
            timeout: Duration::from_millis(config.get("timeout_ms").and_then(Value::as_u64).unwrap_or(500)),
            fail_open: config.get("fail_open").and_then(Value::as_bool).unwrap_or(false),
            include_headers: names(config, "include_headers", &[]),
            secret: config.get("secret").map(secret).transpose()?,
        })
    }

    /// The headers of a message as the service is shown them.
    pub fn visible_headers(&self, headers: &http::HeaderMap) -> Value {
        let mut out = serde_json::Map::new();
        for (name, value) in headers {
            let name = name.as_str();
            let shown = if self.include_headers.is_empty() { !matches!(name, "authorization" | "cookie") } else { self.include_headers.iter().any(|h| h == name) };
            if shown && let Ok(text) = value.to_str() {
                out.insert(name.to_string(), Value::String(text.to_string()));
            }
        }
        Value::Object(out)
    }

    /// The description of a request sent to the service (schema `schemas/callout-request.json`).
    pub fn describe(&self, phase: &str, req: &Req<'_>, request_id: &str, scheme: &str, route: (&str, &str), consumer: Option<(&str, &str)>) -> Value {
        json!({
            "phase": phase,
            "request": {
                "id": request_id, "method": req.method, "scheme": scheme, "host": req.host, "path": req.path, "query": req.query,
                "client_ip": req.client_ip, "headers": self.visible_headers(req.headers),
            },
            "workspace_id": req.workspace_id,
            "route": { "id": route.0, "name": route.1 },
            "consumer": consumer.map(|(id, name)| json!({ "id": id, "name": name })),
        })
    }

    /// The `X-Apg-Signature` value for a body sent at `now`: `t=<unix>,v1=<hmac-sha256 of "<t>.<body>">`.
    pub fn signature(secret: &str, now: i64, body: &str) -> Option<String> {
        crate::acme::hmac_hex(secret, format!("{now}.{body}").as_bytes()).ok().map(|mac| format!("t={now},v1={mac}"))
    }

    /// Asks the service. An error means it could not be asked or did not answer usably.
    pub async fn call(&self, http: &reqwest::Client, payload: &Value, now: i64) -> Result<Answer, String> {
        let body = payload.to_string();
        let mut request = http.post(&self.url).timeout(self.timeout).header("content-type", "application/json");
        if let Some(secret) = &self.secret
            && let Some(signature) = Self::signature(secret, now, &body)
        {
            request = request.header("x-apg-signature", signature);
        }
        let response = request.body(body).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("the service answered {}", response.status()));
        }
        parse_answer(&response.json::<Value>().await.map_err(|e| e.to_string())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-shot HTTP server: answers with `response` and returns the request it saw.
    async fn server(response: &'static str, times: usize) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for _ in 0..times {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 16384];
                let mut text = String::new();
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    text.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                    let length = head.to_ascii_lowercase().lines().find_map(|l| l.strip_prefix("content-length: ").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
                socket.write_all(response.as_bytes()).await.unwrap();
                seen.push(text);
            }
            seen
        });
        (format!("http://{addr}"), handle)
    }

    fn req<'a>(headers: &'a HeaderMap) -> Req<'a> {
        Req { method: "POST", host: "api.example.com", path: "/orders", query: "page=2", client_ip: "203.0.113.9", headers, workspace_id: "w", system_route: true, now: 0 }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        h
    }

    #[tokio::test]
    async fn forward_auth_allows_on_2xx_and_passes_headers_on() {
        let (url, seen) = server("HTTP/1.1 200 OK\r\nx-user: alice\r\nx-ignored: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", 1).await;
        let plugin = ForwardAuth::build(&json!({ "url": format!("{url}/verify"), "response_headers": ["X-User"], "cache_secs": 60 })).unwrap();
        let h = headers(&[("authorization", "Bearer abc"), ("x-other", "not forwarded")]);
        let http = reqwest::Client::new();
        assert_eq!(plugin.check(&http, &req(&h), "https").await, Forwarded::Allow(vec![("x-user".into(), "alice".into())]));
        // The answer is remembered for the same credentials: the service is not asked again.
        assert_eq!(plugin.check(&http, &req(&h), "https").await, Forwarded::Allow(vec![("x-user".into(), "alice".into())]));
        let asked = seen.await.unwrap();
        assert_eq!(asked.len(), 1);
        let sent = asked[0].to_ascii_lowercase();
        for expected in ["get /verify", "authorization: bearer abc", "x-forwarded-method: post", "x-forwarded-host: api.example.com", "x-forwarded-uri: /orders?page=2", "x-forwarded-for: 203.0.113.9", "x-forwarded-proto: https"] {
            assert!(sent.contains(expected), "{expected} in {sent}");
        }
        assert!(!sent.contains("x-other"));
    }

    #[tokio::test]
    async fn forward_auth_hands_a_refusal_to_the_client_and_fails_closed_unless_told_otherwise() {
        let (url, _) = server("HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Bearer\r\ncontent-length: 6\r\nconnection: close\r\n\r\ndenied", 1).await;
        let plugin = ForwardAuth::build(&json!({ "url": url })).unwrap();
        let h = HeaderMap::new();
        let http = reqwest::Client::new();
        assert_eq!(plugin.check(&http, &req(&h), "http").await, Forwarded::Respond { status: 401, headers: vec![("www-authenticate".into(), "Bearer".into())], body: "denied".into() });

        // Nothing listens here.
        let closed = ForwardAuth::build(&json!({ "url": "http://127.0.0.1:9/", "timeout_ms": 300 })).unwrap();
        assert_eq!(closed.check(&http, &req(&h), "http").await, Forwarded::Unavailable);
        let open = ForwardAuth::build(&json!({ "url": "http://127.0.0.1:9/", "timeout_ms": 300, "fail_open": true })).unwrap();
        assert_eq!(open.check(&http, &req(&h), "http").await, Forwarded::Allow(vec![]));
        assert!(ForwardAuth::build(&json!({})).is_err());
    }

    #[tokio::test]
    async fn http_callout_describes_the_request_signs_it_and_reads_the_answer() {
        let reply = r#"{"action":"continue","set_headers":{"X-Risk":"low"},"remove_headers":["X-Debug"]}"#;
        let response: &'static str = Box::leak(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).into_boxed_str());
        let (url, seen) = server(response, 1).await;
        let plugin = HttpCallout::build(&json!({ "url": url, "secret": { "$env": "X" } }), &|_| Ok("s3cret".into())).unwrap();
        assert!(plugin.on_request && !plugin.on_response);
        let h = headers(&[("authorization", "Bearer abc"), ("cookie", "session=1"), ("x-tenant", "acme")]);
        let payload = plugin.describe("request", &req(&h), "req-1", "https", ("r1", "orders"), Some(("c1", "alice")));
        assert_eq!(payload["request"]["headers"], json!({ "x-tenant": "acme" }), "credentials are not shown to the service");
        assert_eq!(payload["consumer"], json!({ "id": "c1", "name": "alice" }));

        let answer = plugin.call(&reqwest::Client::new(), &payload, 1_800_000_000).await.unwrap();
        assert_eq!(answer, Answer { set_headers: vec![("x-risk".into(), "low".into())], remove_headers: vec!["x-debug".into()], ..Default::default() });
        let sent = seen.await.unwrap().remove(0);
        let (head, body) = sent.split_once("\r\n\r\n").unwrap();
        let expected = HttpCallout::signature("s3cret", 1_800_000_000, body).unwrap();
        assert!(head.to_ascii_lowercase().contains(&format!("x-apg-signature: {expected}")), "{head}");
        assert!(expected.starts_with("t=1800000000,v1="));

        // Only the listed headers, when a list is given.
        let listed = HttpCallout::build(&json!({ "url": "http://x", "include_headers": ["Authorization"], "phases": ["response"] }), &|_| Err("unused".into())).unwrap();
        assert_eq!(listed.visible_headers(&h), json!({ "authorization": "Bearer abc" }));
        assert!(!listed.on_request && listed.on_response);
    }

    #[test]
    fn callout_answers() {
        let respond = parse_answer(&json!({ "action": "respond", "status": 451, "headers": { "Content-Type": "text/plain" }, "body": "no" })).unwrap();
        assert_eq!(respond, Answer { respond: true, status: Some(451), headers: vec![("content-type".into(), "text/plain".into())], body: Some("no".into()), ..Default::default() });
        assert_eq!(parse_answer(&json!({})).unwrap(), Answer::default());
        assert!(parse_answer(&json!({ "action": "explode" })).is_err());
        // A status that is not an HTTP status is ignored rather than sent.
        assert_eq!(parse_answer(&json!({ "action": "respond", "status": 9000 })).unwrap().status, None);
    }
}
