//! Request path normalisation (spec RT-3).
//!
//! Routes are matched against a normalised path so that `/a/../admin`,
//! `/a//b` and `/%61dmin` cannot reach a route their literal form would not.

/// The path tried to climb above the root, or is not a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidPath;

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

/// Decodes percent-escapes of unreserved characters only. Escapes of reserved
/// characters (such as `%2F`) are kept, upper-cased, so an encoded slash stays
/// data and never becomes a path separator.
fn decode_unreserved(segment: &str, out: &mut String) -> Result<(), InvalidPath> {
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let (Some(h), Some(l)) = (bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) else {
                return Err(InvalidPath);
            };
            let decoded = h * 16 + l;
            if unreserved(decoded) {
                out.push(decoded as char);
            } else {
                out.push('%');
                out.push(char::from_digit(u32::from(h), 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit(u32::from(l), 16).unwrap().to_ascii_uppercase());
            }
            i += 3;
        } else {
            // Copy one whole UTF-8 character.
            let ch_len = segment[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&segment[i..i + ch_len]);
            i += ch_len;
        }
    }
    Ok(())
}

/// Normalises a request path (no query string).
///
/// Decodes escapes of unreserved characters, removes `.` segments, resolves
/// `..` segments, and merges repeated slashes. A trailing slash is kept.
/// Fails if the path does not start with `/`, has a malformed escape, or
/// climbs above the root.
pub fn normalize(raw: &str) -> Result<String, InvalidPath> {
    if !raw.starts_with('/') {
        return Err(InvalidPath);
    }
    let mut segments: Vec<String> = Vec::new();
    let mut trailing_slash = false;
    for part in raw.split('/').skip(1) {
        let mut seg = String::with_capacity(part.len());
        decode_unreserved(part, &mut seg)?;
        trailing_slash = false;
        match seg.as_str() {
            "" | "." => trailing_slash = true,
            ".." => {
                if segments.pop().is_none() {
                    return Err(InvalidPath);
                }
                trailing_slash = true;
            }
            _ => segments.push(seg),
        }
    }
    let mut out = String::with_capacity(raw.len());
    for s in &segments {
        out.push('/');
        out.push_str(s);
    }
    if trailing_slash || segments.is_empty() {
        out.push('/');
    }
    Ok(out)
}

/// True when `path` is `prefix` or lies beneath it on a segment boundary:
/// `/v1/stores` covers `/v1/stores` and `/v1/stores/a`, not `/v1/storesx`.
pub fn prefix_matches(prefix: &str, path: &str) -> bool {
    if prefix == "/" {
        return true;
    }
    let p = prefix.strip_suffix('/').unwrap_or(prefix);
    match path.strip_prefix(p) {
        Some(rest) => rest.is_empty() || rest.starts_with('/'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_ordinary_paths_alone() {
        for p in ["/", "/a", "/a/b", "/a/b/", "/a.b/c-d_e~f", "/caf\u{e9}"] {
            assert_eq!(normalize(p).unwrap(), p, "{p}");
        }
    }

    #[test]
    fn merges_slashes_and_removes_dot_segments() {
        assert_eq!(normalize("//a///b").unwrap(), "/a/b");
        assert_eq!(normalize("/a/./b/.").unwrap(), "/a/b/");
        assert_eq!(normalize("/a/b/../c").unwrap(), "/a/c");
        assert_eq!(normalize("/a/b/..").unwrap(), "/a/");
        assert_eq!(normalize("/a/..").unwrap(), "/");
    }

    // The attack this exists for: reaching a route by a spelling its literal form would not match.
    #[test]
    fn cannot_climb_above_the_root() {
        assert_eq!(normalize("/.."), Err(InvalidPath));
        assert_eq!(normalize("/a/../../etc/passwd"), Err(InvalidPath));
        assert_eq!(normalize("/%2e%2e/admin"), Err(InvalidPath));
        assert_eq!(normalize("/a/%2E%2E/%2e%2e/x"), Err(InvalidPath));
    }

    #[test]
    fn decodes_unreserved_escapes_so_they_cannot_dodge_a_route() {
        assert_eq!(normalize("/%61dmin").unwrap(), "/admin");
        assert_eq!(normalize("/a/%2e/b").unwrap(), "/a/b");
        assert_eq!(normalize("/public/%2e%2e/admin").unwrap(), "/admin");
    }

    #[test]
    fn keeps_reserved_escapes_encoded() {
        // An encoded slash is data, not a separator.
        assert_eq!(normalize("/files/a%2fb").unwrap(), "/files/a%2Fb");
        assert_eq!(normalize("/q/%3f%23").unwrap(), "/q/%3F%23");
        assert_eq!(normalize("/a%20b").unwrap(), "/a%20b");
    }

    #[test]
    fn rejects_malformed_input() {
        assert_eq!(normalize(""), Err(InvalidPath));
        assert_eq!(normalize("a/b"), Err(InvalidPath));
        assert_eq!(normalize("/a%2"), Err(InvalidPath));
        assert_eq!(normalize("/a%zz"), Err(InvalidPath));
    }

    #[test]
    fn prefix_matching_respects_segment_boundaries() {
        assert!(prefix_matches("/v1/stores", "/v1/stores"));
        assert!(prefix_matches("/v1/stores", "/v1/stores/"));
        assert!(prefix_matches("/v1/stores", "/v1/stores/a/b"));
        assert!(!prefix_matches("/v1/stores", "/v1/storesx"));
        assert!(!prefix_matches("/v1/stores", "/v1/store"));
        assert!(prefix_matches("/v1/stores/", "/v1/stores/a"));
        assert!(prefix_matches("/", "/anything"));
    }
}
