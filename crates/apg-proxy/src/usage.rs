//! Usage metering (spec §11).
//!
//! Requests are counted per (workspace, service, route), and per consumer when
//! asked for, into fixed windows aligned to the clock. A closed window is
//! queued and handed to a sink: the control plane, a file, or nothing. The
//! queue lives on disk as well, so an outage of the control plane or a restart
//! of the node during one loses nothing for up to a day (spec USG-5).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::metrics;

/// Windows older than this are dropped from the queue, oldest first.
const KEEP_SECS: i64 = 24 * 3600;

/// What a counter set is about.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Dimensions {
    pub workspace_id: String,
    pub service_id: String,
    pub route_id: String,
    /// Empty unless usage is kept per consumer and the request had one.
    #[serde(default)]
    pub consumer_id: String,
}

/// The counters of spec USG-2.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Counters {
    pub requests: u64,
    /// Body bytes actually transferred; headers are not counted (spec USG-3).
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub status_2xx: u64,
    pub status_3xx: u64,
    pub status_4xx: u64,
    pub status_5xx: u64,
    pub latency_ms_sum: u64,
    pub upstream_latency_ms_sum: u64,
}

/// One finished request, as usage sees it.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub status: u16,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub latency_ms: u64,
    pub upstream_latency_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    #[serde(flatten)]
    pub dimensions: Dimensions,
    #[serde(flatten)]
    pub counters: Counters,
}

/// A closed window, as it is sent (`POST /dp/usage`) and stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    /// Start of the window, seconds since the epoch, aligned to `interval_secs`.
    pub window_start: i64,
    pub interval_secs: u64,
    pub rows: Vec<Row>,
}

struct Open {
    start: i64,
    counters: HashMap<Dimensions, Counters>,
}

pub struct Usage {
    interval: i64,
    by_consumer: bool,
    open: Mutex<Open>,
    queue: Mutex<VecDeque<Window>>,
    /// Where the queue is kept across restarts.
    queue_file: Option<PathBuf>,
}

impl Usage {
    pub fn new(interval_secs: u64, by_consumer: bool, queue_file: Option<PathBuf>) -> Self {
        let usage = Self { interval: interval_secs.max(1) as i64, by_consumer, open: Mutex::new(Open { start: 0, counters: HashMap::new() }), queue: Mutex::new(VecDeque::new()), queue_file };
        usage.load();
        usage
    }

    fn window_of(&self, now: i64) -> i64 {
        now - now.rem_euclid(self.interval)
    }

    /// Counts one request. `consumer_id` is ignored unless usage is kept per consumer.
    pub fn record(&self, now: i64, workspace_id: &str, service_id: &str, route_id: &str, consumer_id: Option<&str>, sample: Sample) {
        let dimensions = Dimensions {
            workspace_id: workspace_id.to_string(),
            service_id: service_id.to_string(),
            route_id: route_id.to_string(),
            consumer_id: consumer_id.filter(|_| self.by_consumer).unwrap_or_default().to_string(),
        };
        let start = self.window_of(now);
        let mut open = self.open.lock();
        if open.start != start {
            self.close(&mut open, start);
        }
        let c = open.counters.entry(dimensions).or_default();
        c.requests += 1;
        c.bytes_in += sample.bytes_in;
        c.bytes_out += sample.bytes_out;
        match sample.status {
            200..=299 => c.status_2xx += 1,
            300..=399 => c.status_3xx += 1,
            400..=499 => c.status_4xx += 1,
            _ => c.status_5xx += 1,
        }
        c.latency_ms_sum += sample.latency_ms;
        c.upstream_latency_ms_sum += sample.upstream_latency_ms;
    }

    /// Moves the open window to the queue and opens the one starting at `next`.
    fn close(&self, open: &mut Open, next: i64) {
        let counters = std::mem::take(&mut open.counters);
        let finished = std::mem::replace(&mut open.start, next);
        if counters.is_empty() {
            return;
        }
        let mut rows: Vec<Row> = counters.into_iter().map(|(dimensions, counters)| Row { dimensions, counters }).collect();
        rows.sort_by(|a, b| (&a.dimensions.workspace_id, &a.dimensions.route_id, &a.dimensions.service_id, &a.dimensions.consumer_id).cmp(&(&b.dimensions.workspace_id, &b.dimensions.route_id, &b.dimensions.service_id, &b.dimensions.consumer_id)));
        let mut queue = self.queue.lock();
        queue.push_back(Window { window_start: finished, interval_secs: self.interval as u64, rows });
        metrics::USAGE_PENDING.set(queue.len() as i64);
    }

    /// Closes the open window if its time has passed, and drops queued windows
    /// that have waited longer than a day. Called on a timer.
    pub fn tick(&self, now: i64) {
        let start = self.window_of(now);
        {
            let mut open = self.open.lock();
            if open.start != start {
                self.close(&mut open, start);
            }
        }
        let mut queue = self.queue.lock();
        while queue.front().is_some_and(|w| now - w.window_start > KEEP_SECS) {
            queue.pop_front();
            metrics::USAGE_DROPPED.inc();
        }
        metrics::USAGE_PENDING.set(queue.len() as i64);
    }

    /// The oldest window waiting to be delivered.
    pub fn next(&self) -> Option<Window> {
        self.queue.lock().front().cloned()
    }

    /// Removes a window once its sink has taken it.
    pub fn delivered(&self, window: &Window) {
        let mut queue = self.queue.lock();
        if queue.front().is_some_and(|w| w.window_start == window.window_start) {
            queue.pop_front();
        }
        metrics::USAGE_PENDING.set(queue.len() as i64);
    }

    pub fn pending(&self) -> usize {
        self.queue.lock().len()
    }

    /// Forgets everything counted and queued (the `usage_metering` flag was switched off).
    pub fn clear(&self) {
        self.open.lock().counters.clear();
        self.queue.lock().clear();
        metrics::USAGE_PENDING.set(0);
    }

    /// Writes the queue to disk, beside the old copy and renamed over it.
    pub fn save(&self) -> std::io::Result<()> {
        let Some(path) = &self.queue_file else { return Ok(()) };
        let queue: Vec<Window> = self.queue.lock().iter().cloned().collect();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(&queue).unwrap_or_default())?;
        std::fs::rename(tmp, path)
    }

    fn load(&self) {
        let Some(path) = &self.queue_file else { return };
        let Ok(bytes) = std::fs::read(path) else { return };
        if let Ok(windows) = serde_json::from_slice::<Vec<Window>>(&bytes) {
            let mut queue = self.queue.lock();
            queue.extend(windows);
            metrics::USAGE_PENDING.set(queue.len() as i64);
        }
    }
}

/// Appends a window to the day's file: `<path>.<YYYY-MM-DD>`, one JSON object per line (spec USG-9).
pub fn append_to_file(path: &Path, window: &Window) -> std::io::Result<()> {
    use std::io::Write;
    let days = window.window_start.div_euclid(86_400);
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + i64::from(m <= 2);
    let dated = PathBuf::from(format!("{}.{y:04}-{m:02}-{d:02}", path.display()));
    if let Some(dir) = dated.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dated)?;
    let mut line = serde_json::to_vec(window).unwrap_or_default();
    line.push(b'\n');
    file.write_all(&line)
}

/// Where closed windows go.
pub enum UsageSink {
    /// Nowhere (file mode with `APG_USAGE_SINK=none`).
    Discard,
    File(PathBuf),
    /// `POST <url>/usage` on the control plane.
    ControlPlane { http: reqwest::Client, url: String, token: Option<String>, node_id: String, region: Option<String> },
}

/// Runs for the life of the node: closes windows on the clock, delivers them
/// oldest first, and keeps the queue on disk in between.
pub async fn run(usage: std::sync::Arc<Usage>, gateway: std::sync::Arc<crate::gateway::Gateway>, sink: UsageSink) {
    use std::time::{Duration, Instant};
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut saved = Instant::now();
    let mut retry_at = Instant::now();
    // Set when the control plane has no usage endpoint (spec CFG-12b): stop asking.
    let mut absent = false;
    loop {
        tick.tick().await;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        if !gateway.snapshot().flag("usage_metering") {
            usage.clear();
            continue;
        }
        usage.tick(now);
        while Instant::now() >= retry_at
            && let Some(window) = usage.next()
        {
            let delivered = match &sink {
                UsageSink::Discard => true,
                UsageSink::File(path) => append_to_file(path, &window).is_ok(),
                UsageSink::ControlPlane { .. } if absent => true,
                UsageSink::ControlPlane { http, url, token, node_id, region } => {
                    let mut body = serde_json::to_value(&window).unwrap_or_default();
                    body["node_id"] = serde_json::json!(node_id);
                    body["region"] = serde_json::json!(region);
                    let request = http.post(format!("{}/usage", url.trim_end_matches('/'))).timeout(Duration::from_secs(10)).json(&body);
                    let request = match token {
                        Some(t) => request.bearer_auth(t),
                        None => request,
                    };
                    match request.send().await {
                        Ok(res) if res.status().is_success() => true,
                        Ok(res) if res.status() == reqwest::StatusCode::NOT_FOUND => {
                            tracing::info!("the config source offers no usage endpoint; usage is counted but not reported");
                            absent = true;
                            true
                        }
                        Ok(res) => {
                            tracing::warn!(status = %res.status(), "the control plane refused a usage window; it will be sent again");
                            false
                        }
                        Err(error) => {
                            tracing::debug!(%error, "a usage window could not be delivered; it will be sent again");
                            false
                        }
                    }
                }
            };
            if delivered {
                usage.delivered(&window);
            } else {
                metrics::USAGE_FLUSH_FAILURES.inc();
                retry_at = Instant::now() + Duration::from_secs(5);
            }
        }
        if saved.elapsed() >= Duration::from_secs(10) {
            if let Err(error) = usage.save() {
                tracing::warn!(%error, "the usage queue could not be written to disk");
            }
            saved = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(status: u16, bytes_in: u64, bytes_out: u64) -> Sample {
        Sample { status, bytes_in, bytes_out, latency_ms: 10, upstream_latency_ms: 7 }
    }

    // 2026-10-10T12:30:45Z
    const NOW: i64 = 1_791_635_445;

    // spec USG-1, USG-2, USG-4
    #[test]
    fn requests_are_counted_into_clock_aligned_windows() {
        let usage = Usage::new(60, false, None);
        usage.record(NOW, "w", "s", "r1", Some("c1"), sample(200, 5, 100));
        usage.record(NOW + 5, "w", "s", "r1", Some("c2"), sample(404, 0, 20));
        usage.record(NOW + 6, "w", "s", "r2", None, sample(502, 0, 0));
        assert_eq!(usage.pending(), 0, "the window is still open");

        // The next minute begins: the first window is closed and queued.
        usage.record(NOW + 20, "w", "s", "r1", None, sample(301, 1, 1));
        let window = usage.next().unwrap();
        assert_eq!((window.window_start, window.interval_secs), (NOW - 45, 60), "aligned to the minute");
        assert_eq!(window.rows.len(), 2, "one row per route; the consumer is not a dimension by default");
        let r1 = &window.rows[0];
        assert_eq!(r1.dimensions, Dimensions { workspace_id: "w".into(), service_id: "s".into(), route_id: "r1".into(), consumer_id: String::new() });
        assert_eq!(r1.counters, Counters { requests: 2, bytes_in: 5, bytes_out: 120, status_2xx: 1, status_4xx: 1, latency_ms_sum: 20, upstream_latency_ms_sum: 14, ..Default::default() });
        assert_eq!(window.rows[1].counters.status_5xx, 1);

        // Delivery removes it; an idle window produces nothing.
        usage.delivered(&window);
        assert_eq!(usage.pending(), 0);
        usage.tick(NOW + 200);
        assert_eq!(usage.pending(), 1, "the second window closed on the timer");
        usage.tick(NOW + 400);
        assert_eq!(usage.pending(), 1, "no requests, no window");
    }

    #[test]
    fn the_consumer_is_a_dimension_only_when_asked_for() {
        let usage = Usage::new(60, true, None);
        usage.record(NOW, "w", "s", "r", Some("c1"), sample(200, 0, 0));
        usage.record(NOW, "w", "s", "r", Some("c2"), sample(200, 0, 0));
        usage.record(NOW, "w", "s", "r", None, sample(200, 0, 0));
        usage.tick(NOW + 60);
        let consumers: Vec<String> = usage.next().unwrap().rows.iter().map(|r| r.dimensions.consumer_id.clone()).collect();
        assert_eq!(consumers, ["", "c1", "c2"]);
    }

    // spec USG-5
    #[test]
    fn the_queue_survives_a_restart_and_drops_what_is_older_than_a_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-queue.json");
        let usage = Usage::new(60, false, Some(path.clone()));
        for minute in 0..3 {
            usage.record(NOW + minute * 60, "w", "s", "r", None, sample(200, 1, 1));
        }
        usage.tick(NOW + 180);
        assert_eq!(usage.pending(), 3);
        usage.save().unwrap();

        // A new process finds the windows it had not delivered.
        let restarted = Usage::new(60, false, Some(path));
        assert_eq!(restarted.pending(), 3);
        assert_eq!(restarted.next().unwrap().window_start, NOW - 45, "oldest first");

        // After a day of failed deliveries the oldest are given up, and counted.
        let before = metrics::USAGE_DROPPED.get();
        restarted.tick(NOW + KEEP_SECS + 20);
        assert_eq!(restarted.pending(), 1);
        assert_eq!(metrics::USAGE_DROPPED.get() - before, 2);
        restarted.clear();
        assert_eq!(restarted.pending(), 0);
    }

    #[test]
    fn a_retried_delivery_is_the_same_window() {
        let usage = Usage::new(60, false, None);
        usage.record(NOW, "w", "s", "r", None, sample(200, 1, 1));
        usage.tick(NOW + 60);
        // The sink failed: the window is still first, unchanged, so the receiver can upsert it.
        assert_eq!(usage.next(), usage.next());
        let wire = serde_json::to_value(usage.next().unwrap()).unwrap();
        assert_eq!(wire["rows"][0]["route_id"], "r");
        assert_eq!(wire["rows"][0]["requests"], 1);
        assert_eq!(serde_json::from_value::<Window>(wire).unwrap(), usage.next().unwrap());
    }

    // spec USG-9
    #[test]
    fn the_file_sink_writes_one_line_per_window_into_a_file_per_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out/usage.ndjson");
        let window = |start: i64| Window { window_start: start, interval_secs: 60, rows: vec![] };
        append_to_file(&path, &window(NOW - 45)).unwrap();
        append_to_file(&path, &window(NOW + 15)).unwrap();
        append_to_file(&path, &window(NOW + 86_400)).unwrap();
        let today = std::fs::read_to_string(dir.path().join("out/usage.ndjson.2026-10-10")).unwrap();
        assert_eq!(today.lines().count(), 2);
        assert!(today.lines().all(|l| serde_json::from_str::<Window>(l).is_ok()));
        assert!(dir.path().join("out/usage.ndjson.2026-10-11").exists());
    }
}
