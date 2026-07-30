//! menhir-core — minimal Nostr protocol core for Obelisk Menhir.
//!
//! Text-channels only: events, schnorr keys/signatures, NIP-19 encoding,
//! subscription filters, and (behind the `client` feature) a small relay
//! client that can dial through a SOCKS5 proxy (Tor).

pub mod event;
pub mod filter;
pub mod keys;
pub mod kinds;

#[cfg(feature = "client")]
pub mod client;

pub use event::{Event, EventTemplate};
pub use filter::Filter;
pub use keys::Keys;

/// Current unix timestamp in seconds.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
