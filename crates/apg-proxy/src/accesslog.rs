//! The access log (spec §12.2): one JSON object per request.
//!
//! Writing never blocks a request. Lines go through a bounded queue to one
//! writer thread; when the queue is full the line is dropped and counted
//! (spec OBS-2). Header values are never logged, and query parameters that
//! carry credentials are masked (spec OBS-3).

use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::metrics;

/// Where lines go, as the `access_log` setting says.
#[derive(Debug, Clone, PartialEq)]
pub enum Sink {
    Stdout,
    Off,
    /// Appended to; opened again for every batch, so the file can be rotated away at any time.
    File(PathBuf),
}

impl Sink {
    /// Reads the setting's `sink` value. Anything not understood is `stdout`:
    /// losing the access log to a typo would be worse than an unexpected place.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("off") => Sink::Off,
            Some(v) => match v.strip_prefix("file:") {
                Some(path) if !path.is_empty() => Sink::File(PathBuf::from(path)),
                _ => Sink::Stdout,
            },
            None => Sink::Stdout,
        }
    }
}

pub struct AccessLogger {
    tx: SyncSender<(Sink, String)>,
    /// Query parameter names whose values are masked.
    redact: Vec<String>,
}

fn write_batch(sink: &Sink, lines: &[String]) {
    let joined: String = lines.iter().flat_map(|l| [l.as_str(), "\n"]).collect();
    match sink {
        Sink::Off => {}
        Sink::Stdout => {
            let _ = std::io::stdout().lock().write_all(joined.as_bytes());
        }
        Sink::File(path) => {
            let written = std::fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut f| f.write_all(joined.as_bytes()));
            if written.is_err() {
                metrics::ACCESS_LOG_DROPPED.inc_by(lines.len() as u64);
            }
        }
    }
}

impl AccessLogger {
    /// Starts the writer thread. `capacity` is how many lines may wait.
    pub fn new(capacity: usize, redact: Vec<String>) -> Self {
        let (tx, rx) = sync_channel::<(Sink, String)>(capacity);
        let _ = std::thread::Builder::new().name("apg-access-log".into()).spawn(move || {
            while let Ok((sink, first)) = rx.recv() {
                // Take what else is waiting for the same sink, up to a batch.
                let mut batch = vec![first];
                let mut other: Option<(Sink, String)> = None;
                while batch.len() < 1000 {
                    match rx.recv_timeout(Duration::from_millis(if batch.len() < 10 { 0 } else { 5 })) {
                        Ok((s, line)) if s == sink => batch.push(line),
                        Ok(different) => {
                            other = Some(different);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                write_batch(&sink, &batch);
                if let Some((s, line)) = other {
                    write_batch(&s, &[line]);
                }
            }
        });
        Self { tx, redact }
    }

    /// Queues one line. Never waits.
    pub fn write(&self, sink: &Sink, line: String) {
        if *sink == Sink::Off {
            return;
        }
        if let Err(TrySendError::Full(_)) = self.tx.try_send((sink.clone(), line)) {
            metrics::ACCESS_LOG_DROPPED.inc();
        }
    }

    /// The query string as it may be logged: values of credential-bearing
    /// parameters, and of any in `also`, replaced by `***`.
    pub fn redact_query(&self, query: &str, also: &[String]) -> String {
        if query.is_empty() {
            return String::new();
        }
        query
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((name, _)) if self.redact.iter().chain(also).any(|r| r.eq_ignore_ascii_case(name)) => format!("{name}=***"),
                _ => pair.to_string(),
            })
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// `2026-10-10T12:30:45.123Z`.
pub fn rfc3339_millis(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs() as i64, since.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ── Trace context (spec §12.3) ───────────────────────────────────────────────

/// A W3C trace context: the trace this request belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceContext {
    pub trace_id: String,
    /// The caller's span, when the request arrived with a context.
    pub parent_span: Option<String>,
    pub flags: String,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && s.bytes().any(|b| b != b'0')
}

impl TraceContext {
    /// Continues the trace named by an inbound `traceparent`, or starts one.
    /// A malformed header is ignored, as the specification requires.
    pub fn from_header(traceparent: Option<&str>, random: impl Fn() -> u64) -> Self {
        if let Some(value) = traceparent {
            let parts: Vec<&str> = value.trim().split('-').collect();
            if let [version, trace_id, span_id, flags, ..] = parts.as_slice()
                && version.len() == 2
                && *version != "ff"
                && is_hex(trace_id, 32)
                && is_hex(span_id, 16)
                && flags.len() == 2
                && flags.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Self { trace_id: trace_id.to_string(), parent_span: Some(span_id.to_string()), flags: flags.to_ascii_lowercase() };
            }
        }
        // Not sampled: this node exports no spans of its own.
        Self { trace_id: format!("{:016x}{:016x}", random() | 1, random()), parent_span: None, flags: "00".into() }
    }

    /// The `traceparent` to send upstream: same trace, a span of this node's own.
    pub fn outgoing(&self, random: impl Fn() -> u64) -> String {
        format!("00-{}-{:016x}-{}", self.trace_id, random() | 1, self.flags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sinks_are_read_from_the_setting() {
        assert_eq!(Sink::parse(None), Sink::Stdout);
        assert_eq!(Sink::parse(Some("stdout")), Sink::Stdout);
        assert_eq!(Sink::parse(Some("off")), Sink::Off);
        assert_eq!(Sink::parse(Some("file:/var/log/apg/access.log")), Sink::File("/var/log/apg/access.log".into()));
        assert_eq!(Sink::parse(Some("file:")), Sink::Stdout);
    }

    // spec OBS-3
    #[test]
    fn credential_bearing_query_parameters_are_masked() {
        let log = AccessLogger::new(8, vec!["apikey".into(), "token".into()]);
        assert_eq!(log.redact_query("page=2&apikey=secret123&Token=abc&flag", &[]), "page=2&apikey=***&Token=***&flag");
        assert_eq!(log.redact_query("k=v&session=abc", &["session".to_string()]), "k=v&session=***");
        assert_eq!(log.redact_query("", &[]), "");
        assert!(!log.redact_query("apikey=secret123", &[]).contains("secret123"));
    }

    // spec OBS-2
    #[test]
    fn lines_reach_a_file_and_a_full_queue_drops_rather_than_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("access.log");
        let log = AccessLogger::new(1024, vec![]);
        let sink = Sink::File(path.clone());
        for i in 0..50 {
            log.write(&sink, format!("{{\"n\":{i}}}"));
        }
        log.write(&Sink::Off, "never written".into());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let lines = loop {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text.lines().count() == 50 || std::time::Instant::now() > deadline {
                break text;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(lines.lines().count(), 50);
        assert_eq!(lines.lines().next(), Some("{\"n\":0}"), "in order");
        assert!(!lines.contains("never written"));

        // A sink that cannot keep up: writes return at once and the overflow is counted.
        let slow = AccessLogger::new(1, vec![]);
        let unwritable = Sink::File(dir.path().join("no/such/dir/access.log"));
        let before = metrics::ACCESS_LOG_DROPPED.get();
        let started = std::time::Instant::now();
        for _ in 0..5000 {
            slow.write(&unwritable, "x".repeat(200));
        }
        assert!(started.elapsed() < Duration::from_secs(2), "writing never waits for the sink");
        std::thread::sleep(Duration::from_millis(200));
        assert!(metrics::ACCESS_LOG_DROPPED.get() > before);
    }

    #[test]
    fn timestamps_are_rfc3339_in_utc_with_milliseconds() {
        assert_eq!(rfc3339_millis(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339_millis(UNIX_EPOCH + Duration::from_millis(1_791_635_445_123)), "2026-10-10T12:30:45.123Z");
    }

    // spec §12.3
    #[test]
    fn a_trace_is_continued_when_one_arrives_and_started_otherwise() {
        let fixed = || 0x1234_5678_9abc_def0u64;
        let inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let continued = TraceContext::from_header(Some(inbound), fixed);
        assert_eq!(continued, TraceContext { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(), parent_span: Some("00f067aa0ba902b7".into()), flags: "01".into() });
        let out = continued.outgoing(fixed);
        assert!(out.starts_with("00-4bf92f3577b34da6a3ce929d0e0e4736-") && out.ends_with("-01"));
        assert_ne!(out, inbound, "the upstream sees this node's span, not the caller's");

        for malformed in ["", "garbage", "00-short-00f067aa0ba902b7-01", "00-00000000000000000000000000000000-00f067aa0ba902b7-01", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"] {
            let fresh = TraceContext::from_header(Some(malformed), fixed);
            assert_eq!(fresh.parent_span, None, "{malformed}");
            assert_eq!(fresh.trace_id.len(), 32);
        }
        let fresh = TraceContext::from_header(None, fixed);
        assert_eq!((fresh.trace_id.len(), fresh.flags.as_str()), (32, "00"));
        assert_eq!(fresh.outgoing(fixed).len(), 55);
    }
}
