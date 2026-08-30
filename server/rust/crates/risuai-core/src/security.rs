use std::net::{IpAddr, Ipv4Addr};
use url::Url;

pub fn normalize_auth_header(header: Option<&str>) -> Option<String> {
    let header = header?.trim();
    if header.is_empty() {
        return None;
    }
    if let Some(stripped) = header.strip_prefix("Bearer ") {
        let s = stripped.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    Some(header.to_string())
}

pub fn is_private_or_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback()
                || ipv4.is_private()
                || ipv4.is_link_local()
                || ipv4 == Ipv4Addr::UNSPECIFIED
                || ipv4 == Ipv4Addr::BROADCAST
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || ipv6.is_unspecified()
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00 // Unique local
                || (ipv6.segments()[0] & 0xffc0) == 0xfe80 // Link-local
        }
    }
}

pub fn sanitize_target_url(raw_url: &str) -> Option<String> {
    let parsed = Url::parse(raw_url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    Some(parsed.to_string())
}

pub fn is_secure_postgres_config_request(client_ip: &str, is_tls: bool) -> bool {
    if is_tls {
        return true;
    }
    if let Ok(ip) = client_ip.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    client_ip == "localhost" || client_ip == "127.0.0.1" || client_ip == "::1"
}
