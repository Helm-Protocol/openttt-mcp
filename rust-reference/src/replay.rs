//! Replay preparation: process-local development store, not a production durability claim.
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
pub const MAX_AGE_US: u64 = 600_000_000;
pub const MAX_DISPERSION_US: u64 = 1_000;
pub const MAX_FUTURE_US: u64 = 500_000;
pub const SAFETY_MARGIN_US: u64 = 1_000_000;
#[derive(Debug, PartialEq, Eq)]
pub enum ReplayError { InvalidLifetime, Capacity, StoreUnavailable }
#[derive(Debug, PartialEq, Eq)]
pub enum Claim { New, AlreadySeen }
// Domain is derived from trusted tenant + issuer identity, never client-provided authority.
#[derive(Clone, Copy, Hash, PartialEq, Eq)]
pub struct ReplayKey { pub domain: [u8;32], pub context: [u8;16], pub nonce: [u8;16] }
pub trait ReplayStore: Send + Sync {
    fn check_and_set(&self, key: ReplayKey, ttl: Duration) -> Result<Claim, ReplayError>;
}
/// Inclusive timestamp validity; retain claims beyond the last permitted instant.
pub fn replay_ttl(timestamp_us: u64, dispersion_us: u64, now_us: u64) -> Result<Duration, ReplayError> {
    if dispersion_us > MAX_DISPERSION_US || timestamp_us.saturating_sub(now_us) > MAX_FUTURE_US {
        return Err(ReplayError::InvalidLifetime);
    }
    let last = timestamp_us.checked_add(MAX_AGE_US).and_then(|v|v.checked_add(dispersion_us)).ok_or(ReplayError::InvalidLifetime)?;
    if now_us > last { return Err(ReplayError::InvalidLifetime); }
    let remaining = last.checked_sub(now_us).and_then(|v|v.checked_add(SAFETY_MARGIN_US)).ok_or(ReplayError::InvalidLifetime)?;
    Ok(Duration::from_micros(remaining))
}
/// Bounded mutex provides atomic claim. No live entry is evicted on capacity pressure.
/// Restart loses entries: use only development/isolated runs. Production uses MemoryDB.
pub struct LocalNonceCache { entries: Mutex<HashMap<ReplayKey,Instant>>, capacity: usize }
impl LocalNonceCache { pub fn new(capacity: usize) -> Self { Self { entries: Mutex::new(HashMap::new()), capacity } } }
impl ReplayStore for LocalNonceCache {
    fn check_and_set(&self, key: ReplayKey, ttl: Duration) -> Result<Claim, ReplayError> {
        if ttl.is_zero() { return Err(ReplayError::InvalidLifetime); }
        let mut entries = self.entries.lock().map_err(|_|ReplayError::StoreUnavailable)?;
        let now = Instant::now();
        let until = now.checked_add(ttl).ok_or(ReplayError::InvalidLifetime)?;
        if let Some(expiry) = entries.get(&key) { if *expiry > now { return Ok(Claim::AlreadySeen); } }
        if entries.len() >= self.capacity { entries.retain(|_,expiry|*expiry > now); }
        if entries.len() >= self.capacity && !entries.contains_key(&key) { return Err(ReplayError::Capacity); }
        entries.insert(key,until); Ok(Claim::New)
    }
}
