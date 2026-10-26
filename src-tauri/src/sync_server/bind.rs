// 동기화(beta) 바인딩 대상 판별 — Tailscale CGNAT(100.64.0.0/10) 대역에 있는 인터페이스가
// 있으면 거기에만 바인딩하고, 없으면 127.0.0.1(로컬 테스트용)로 폴백한다. 0.0.0.0은 절대 쓰지
// 않는다 — 이 함수가 그 규칙의 유일한 강제 지점(mod.rs::start 는 여기서 고른 IP만 쓴다).
use std::net::{IpAddr, Ipv4Addr};

/// 100.64.0.0/10 = 두 번째 옥텟이 64..=127 인 100.x.x.x. IPv4 전용(Tailscale IPv6 ULA는 다루지
/// 않는다 — 과제 범위가 명시적으로 CGNAT IPv4 대역이다).
fn is_tailscale_cgnat(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

/// 순수 함수 — 실제 인터페이스 열거(local_ipv4_addrs)와 분리해 유닛 테스트로 가짜 목록을 넣기
/// 쉽게 한다. 폴백은 항상 loopback: LAN 주소(192.168.x/10.x)는 절대 선택되지 않는다.
pub fn pick_bind_addr(candidates: &[IpAddr]) -> IpAddr {
    for ip in candidates {
        if let IpAddr::V4(v4) = ip {
            if is_tailscale_cgnat(v4) {
                return IpAddr::V4(*v4);
            }
        }
    }
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

/// 로컬 IPv4 인터페이스 열거 — 가장 작은 의존성(if-addrs)만 사용.
pub fn local_ipv4_addrs() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.addr {
            if_addrs::IfAddr::V4(v4) => Some(IpAddr::V4(v4.ip)),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_tailscale_cgnat_address_when_present() {
        let candidates = vec![
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)),
            IpAddr::V4(Ipv4Addr::new(100, 90, 12, 3)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)),
        ];
        assert_eq!(pick_bind_addr(&candidates), IpAddr::V4(Ipv4Addr::new(100, 90, 12, 3)));
    }

    #[test]
    fn falls_back_to_loopback_when_no_tailscale_interface() {
        let candidates = vec![
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)),
        ];
        assert_eq!(pick_bind_addr(&candidates), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn never_picks_addresses_outside_the_cgnat_second_octet_range() {
        // 100.63.x.x / 100.128.x.x 는 언뜻 Tailscale 처럼 보이지만 100.64.0.0/10 밖이다.
        let candidates = vec![
            IpAddr::V4(Ipv4Addr::new(100, 63, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1)),
        ];
        assert_eq!(pick_bind_addr(&candidates), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn ignores_ipv6_and_falls_back_to_loopback_not_a_lan_address() {
        let candidates = vec![
            "fe80::1".parse().unwrap(),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
        ];
        assert_eq!(pick_bind_addr(&candidates), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn empty_candidate_list_falls_back_to_loopback() {
        assert_eq!(pick_bind_addr(&[]), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
}
