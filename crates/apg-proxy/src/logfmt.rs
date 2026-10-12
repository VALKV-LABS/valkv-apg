//! The node's JSON log lines: `{"timestamp", "level", "fields", "target"}`.
//!
//! The stock JSON format also writes where in the source a line came from
//! for every record a library emits through the `log` crate (`log.file`,
//! `log.line`, `log.module_path`, `log.target`). That is a build machine's
//! path in every line, and of no use to whoever runs the gateway, so it is
//! left out here. The library's name is kept, as `target`.

use std::fmt;

use serde_json::{Map, Value, json};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

/// One JSON object per line.
pub struct JsonLines;

#[derive(Default)]
struct Fields {
    map: Map<String, Value>,
    /// The emitting library, for a record that came through the `log` crate.
    log_target: Option<String>,
}

impl Fields {
    fn put(&mut self, name: &str, value: Value) {
        match name {
            "log.target" => self.log_target = value.as_str().map(str::to_string),
            hidden if hidden.starts_with("log.") => {}
            kept => {
                self.map.insert(kept.to_string(), value);
            }
        }
    }
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field.name(), Value::String(format!("{value:?}")));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field.name(), value.into());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field.name(), value.into());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field.name(), value.into());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field.name(), value.into());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field.name(), value.into());
    }
}

/// The line for one event, without the timestamp's dependence on the clock.
fn line(event: &Event<'_>, timestamp: &str) -> Value {
    let mut fields = Fields::default();
    event.record(&mut fields);
    let meta = event.metadata();
    json!({
        "timestamp": timestamp,
        "level": meta.level().as_str(),
        "fields": fields.map,
        "target": fields.log_target.as_deref().unwrap_or(meta.target()),
    })
}

impl<S, N> FormatEvent<S, N> for JsonLines
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, _ctx: &FmtContext<'_, S, N>, mut writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        let mut timestamp = String::new();
        SystemTime.format_time(&mut Writer::new(&mut timestamp))?;
        writeln!(writer, "{}", line(event, &timestamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn lines_keep_the_message_and_fields_and_leave_out_source_locations() {
        let buffer = Buffer::default();
        let sink = buffer.clone();
        let subscriber = tracing_subscriber::fmt().event_format(JsonLines).with_writer(move || sink.clone()).finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(service = "orders", attempts = 3u64, ok = false, "backend cannot be used");
            // What a record from a library using the `log` crate looks like once bridged.
            tracing::info!(log.target = "some_library::server", log.module_path = "some_library::server", log.file = "/usr/local/cargo/registry/src/some-library/src/server.rs", log.line = 643u64, "Server starting");
        });
        let text = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);

        assert_eq!(lines[0]["level"], "WARN");
        assert_eq!(lines[0]["fields"], json!({ "message": "backend cannot be used", "service": "orders", "attempts": 3, "ok": false }));
        assert_eq!(lines[0]["target"], module_path!());
        assert!(lines[0]["timestamp"].as_str().unwrap().ends_with('Z'));

        assert_eq!(lines[1]["fields"], json!({ "message": "Server starting" }), "no file, line or module path");
        assert_eq!(lines[1]["target"], "some_library::server", "the library is still named");
        assert!(!text.contains("cargo"));
    }
}
