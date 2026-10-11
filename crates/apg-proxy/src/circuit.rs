use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Passive circuit breaker per backend instance.
///
/// State machine:
///   Closed (healthy) → [N consecutive failures] → Open (cooling down)
///   Open → [after open_duration] → Half-open (next request is a probe)
///   Half-open → [success] → Closed
///   Half-open → [failure] → Open (reset timer)
pub struct CircuitBreaker {
    failure_threshold: u32,
    open_duration:     Duration,
    failures:          AtomicU32,
    open_until:        Mutex<Option<Instant>>,
    half_open:         Mutex<bool>,
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, open_duration: Duration) -> Self {
        Self {
            failure_threshold,
            open_duration,
            failures:   AtomicU32::new(0),
            open_until: Mutex::new(None),
            half_open:  Mutex::new(false),
        }
    }

    /// Returns true if this backend should be skipped (circuit is open).
    pub fn is_open(&self) -> bool {
        let until = self.open_until.lock().unwrap();
        match *until {
            None => false,
            Some(t) => Instant::now() < t,
        }
    }

    /// Returns true if this backend is in half-open state (should try one probe).
    pub fn is_half_open(&self) -> bool {
        let until = self.open_until.lock().unwrap();
        match *until {
            None => false,
            Some(t) => {
                Instant::now() >= t && *self.half_open.lock().unwrap()
            }
        }
    }

    pub fn record_failure(&self) {
        let prev = self.failures.fetch_add(1, Ordering::Relaxed);
        if prev + 1 >= self.failure_threshold {
            let mut until = self.open_until.lock().unwrap();
            *until = Some(Instant::now() + self.open_duration);
            *self.half_open.lock().unwrap() = true;
        }
    }

    pub fn record_success(&self) {
        self.failures.store(0, Ordering::Relaxed);
        *self.open_until.lock().unwrap() = None;
        *self.half_open.lock().unwrap() = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_closed() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(30));
        assert!(!cb.is_open());
    }

    #[test]
    fn opens_after_threshold_failures() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(30));
        cb.record_failure();
        cb.record_failure();
        assert!(!cb.is_open());
        cb.record_failure();
        assert!(cb.is_open());
    }

    #[test]
    fn success_resets_to_closed() {
        let cb = CircuitBreaker::new(2, Duration::from_secs(30));
        cb.record_failure();
        cb.record_failure();
        assert!(cb.is_open());
        cb.record_success();
        assert!(!cb.is_open());
    }
}
