use openttt_draft13_reference::{replay::{replay_ttl, Claim, LocalNonceCache, ReplayError, ReplayKey, ReplayStore, MAX_AGE_US, SAFETY_MARGIN_US}, strict_json};
use std::{sync::Arc, time::Duration};

fn key(n: u8) -> ReplayKey { ReplayKey { domain: [1;32], context: [2;16], nonce: [n;16] } }

#[test]
fn lifetime_covers_remaining_validity_and_margin() {
    let ts = 2_000_000_000;
    assert_eq!(replay_ttl(ts, 100, ts).unwrap().as_micros(), (MAX_AGE_US + 100 + SAFETY_MARGIN_US) as u128);
    assert!(replay_ttl(ts, 100, ts + 360_000_000).unwrap() > Duration::from_secs(240));
    assert_eq!(replay_ttl(ts, 100, ts + MAX_AGE_US + 100).unwrap(), Duration::from_micros(SAFETY_MARGIN_US));
    assert_eq!(replay_ttl(ts, 100, ts + MAX_AGE_US + 101), Err(ReplayError::InvalidLifetime));
}
#[test]
fn reject_invalid_clock_dispersion_and_overflow() {
    assert_eq!(replay_ttl(1_000_000, 1001, 1_000_000), Err(ReplayError::InvalidLifetime));
    assert_eq!(replay_ttl(1_500_001, 0, 1_000_000), Err(ReplayError::InvalidLifetime));
    assert!(replay_ttl(1_500_000, 0, 1_000_000).is_ok());
    assert_eq!(replay_ttl(u64::MAX, 0, u64::MAX), Err(ReplayError::InvalidLifetime));
}
#[test]
fn atomic_concurrent_claim_has_one_winner() {
    let store = Arc::new(LocalNonceCache::new(32));
    let handles: Vec<_> = (0..16).map(|_| { let store = store.clone(); std::thread::spawn(move || store.check_and_set(key(0), Duration::from_secs(601))) }).collect();
    let claims: Vec<_> = handles.into_iter().map(|h|h.join().unwrap().unwrap()).collect();
    assert_eq!(claims.iter().filter(|c|**c == Claim::New).count(), 1);
    assert_eq!(claims.iter().filter(|c|**c == Claim::AlreadySeen).count(), 15);
}
#[test]
fn capacity_preserves_live_claims() {
    let store = LocalNonceCache::new(1);
    assert_eq!(store.check_and_set(key(0), Duration::from_secs(601)), Ok(Claim::New));
    assert_eq!(store.check_and_set(key(1), Duration::from_secs(601)), Err(ReplayError::Capacity));
    assert_eq!(store.check_and_set(key(0), Duration::from_secs(601)), Ok(Claim::AlreadySeen));
    assert_eq!(store.check_and_set(key(2), Duration::ZERO), Err(ReplayError::InvalidLifetime));
}
#[test]
fn expiry_allows_cleanup_without_live_eviction() {
    let store = LocalNonceCache::new(1);
    store.check_and_set(key(0), Duration::from_nanos(1)).unwrap();
    // The duration has elapsed by the next claim; no wall-clock or sleep dependency.
    assert_eq!(store.check_and_set(key(1), Duration::from_secs(601)), Ok(Claim::New));
}
#[test]
fn duplicate_keys_rejected_at_all_depths() {
    for text in [r#"{"amount":1,"amount":2}"#, r#"{"action":{"amount":1,"\u0061mount":2}}"#, r#"[{"x":1,"x":2}]"#] {
        let result: Result<serde_json::Value,_> = strict_json::from_slice(text.as_bytes());
        assert!(result.unwrap_err().to_string().contains("DUPLICATE_JSON_KEY"));
    }
    let valid: serde_json::Value = strict_json::from_slice(br#"{"x":[{"x":1},{"x":2}],"null":null}"#).unwrap();
    assert_eq!(valid["x"][1]["x"], 2);
}
#[test]
fn malformed_unicode_and_json_rejected() {
    for text in [r#"{"x":"\ud800"}"#, r#"{"x":1,}"#, r#"{"x":NaN}"#] {
        assert!(strict_json::from_slice::<serde_json::Value>(text.as_bytes()).is_err());
    }
}
