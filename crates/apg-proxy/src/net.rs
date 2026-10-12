//! Client address resolution (spec HDR-2).

use std::net::IpAddr;

/// A network in CIDR notation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parses `10.0.0.0/8`, `fd00::/8`, or a bare address (a /32 or /128).
    pub fn parse(s: &str) -> Option<Self> {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a.trim().parse::<IpAddr>().ok()?, p.trim().parse::<u8>().ok()?),
            None => {
                let a = s.trim().parse::<IpAddr>().ok()?;
                (a, if a.is_ipv4() { 32 } else { 128 })
            }
        };
        let max = if addr.is_ipv4() { 32 } else { 128 };
        (prefix <= max).then_some(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(self.prefix)) };
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(self.prefix)) };
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// Parses a comma-separated CIDR list. Fails on the first malformed entry.
pub fn parse_cidr_list(value: &str) -> Result<Vec<Cidr>, String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| Cidr::parse(s).ok_or_else(|| format!("'{s}' is not a CIDR")))
        .collect()
}

fn trusted(list: &[Cidr], ip: IpAddr) -> bool {
    list.iter().any(|c| c.contains(ip))
}

/// The client's address.
///
/// It is the socket peer, unless the peer is a trusted proxy; then it is the
/// right-most address in `X-Forwarded-For` that is not itself a trusted proxy.
/// A header from an untrusted peer is ignored, so a client cannot choose its
/// own address.
pub fn client_ip(peer: Option<IpAddr>, forwarded_for: Option<&str>, trusted_proxies: &[Cidr]) -> Option<IpAddr> {
    let peer = peer?;
    if !trusted(trusted_proxies, peer) {
        return Some(peer);
    }
    let Some(header) = forwarded_for else { return Some(peer) };
    for hop in header.rsplit(',') {
        match hop.trim().parse::<IpAddr>() {
            Ok(ip) if trusted(trusted_proxies, ip) => continue,
            Ok(ip) => return Some(ip),
            // A malformed hop means the chain cannot be trusted past this point.
            Err(_) => break,
        }
    }
    Some(peer)
}

/// Splits a backend target into host and port: `api.internal:8080`, `10.0.0.1:80`, `[::1]:80`.
pub fn split_target(target: &str) -> Option<(&str, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    (!host.is_empty()).then_some((host, port.parse().ok()?))
}

/// True when the public internet cannot route to `ip`: loopback, link-local
/// (which includes cloud metadata endpoints), private and reserved ranges
/// (spec SEC-4). The admin applies the same list on write.
pub fn is_non_public(ip: IpAddr) -> bool {
    static RANGES: std::sync::LazyLock<Vec<Cidr>> = std::sync::LazyLock::new(|| {
        [
            "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
            "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3", "::/127", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96",
        ]
        .iter()
        .filter_map(|c| Cidr::parse(c))
        .collect()
    });
    // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    };
    RANGES.iter().any(|c| c.contains(ip))
}

/// Lower-cases a host and removes any port. Handles bracketed IPv6 literals.
pub fn normalize_host(raw: &str) -> String {
    let host = match raw.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => raw.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(raw, |(h, _)| h),
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_parsing_and_containment() {
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains(ip("10.255.1.2")));
        assert!(!c.contains(ip("11.0.0.1")));
        assert!(!c.contains(ip("::1")));
        assert!(Cidr::parse("192.168.1.7").unwrap().contains(ip("192.168.1.7")));
        assert!(!Cidr::parse("192.168.1.7").unwrap().contains(ip("192.168.1.8")));
        assert!(Cidr::parse("fd00::/8").unwrap().contains(ip("fd12::1")));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        for bad in ["10.0.0.0/33", "nope", "10.0.0.0/x", "::/129", ""] {
            assert!(Cidr::parse(bad).is_none(), "{bad}");
        }
        assert!(parse_cidr_list("10.0.0.0/8, 172.16.0.0/12,").unwrap().len() == 2);
        assert!(parse_cidr_list("10.0.0.0/8, oops").is_err());
        assert!(parse_cidr_list("").unwrap().is_empty());
    }

    // spec HDR-2
    #[test]
    fn an_untrusted_peer_cannot_choose_its_own_address() {
        let none: Vec<Cidr> = vec![];
        assert_eq!(client_ip(Some(ip("203.0.113.9")), Some("1.2.3.4"), &none), Some(ip("203.0.113.9")));
        let lb = parse_cidr_list("10.0.0.0/8").unwrap();
        assert_eq!(client_ip(Some(ip("203.0.113.9")), Some("1.2.3.4"), &lb), Some(ip("203.0.113.9")));
    }

    #[test]
    fn behind_trusted_proxies_the_right_most_untrusted_hop_is_the_client() {
        let lb = parse_cidr_list("10.0.0.0/8").unwrap();
        assert_eq!(client_ip(Some(ip("10.0.0.5")), Some("198.51.100.7"), &lb), Some(ip("198.51.100.7")));
        // a client-supplied prefix on the left is not believed
        assert_eq!(client_ip(Some(ip("10.0.0.5")), Some("6.6.6.6, 198.51.100.7, 10.0.0.9"), &lb), Some(ip("198.51.100.7")));
        // no header, or only trusted hops: fall back to the peer
        assert_eq!(client_ip(Some(ip("10.0.0.5")), None, &lb), Some(ip("10.0.0.5")));
        assert_eq!(client_ip(Some(ip("10.0.0.5")), Some("10.0.0.9"), &lb), Some(ip("10.0.0.5")));
        assert_eq!(client_ip(Some(ip("10.0.0.5")), Some("198.51.100.7, garbage"), &lb), Some(ip("10.0.0.5")));
        assert_eq!(client_ip(None, Some("1.2.3.4"), &lb), None);
    }

    #[test]
    fn targets_split_into_host_and_port() {
        assert_eq!(split_target("api.internal:8080"), Some(("api.internal", 8080)));
        assert_eq!(split_target("10.0.0.1:80"), Some(("10.0.0.1", 80)));
        assert_eq!(split_target("[::1]:443"), Some(("::1", 443)));
        for bad in ["nohost", ":80", "a:port", "a:99999"] {
            assert_eq!(split_target(bad), None, "{bad}");
        }
    }

    // spec SEC-4
    #[test]
    fn non_public_addresses_are_recognised() {
        for private in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"] {
            assert!(is_non_public(ip(private)), "{private}");
        }
        for public in ["8.8.8.8", "203.0.113.9", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_non_public(ip(public)), "{public}");
        }
    }

    #[test]
    fn host_normalisation() {
        assert_eq!(normalize_host("API.Example.com:8443"), "api.example.com");
        assert_eq!(normalize_host("api.example.com."), "api.example.com");
        assert_eq!(normalize_host("[::1]:8443"), "::1");
        assert_eq!(normalize_host("localhost"), "localhost");
    }
}
