//! Nostr events: canonical id computation, signing, verification.

use secp256k1::schnorr::Signature;
use secp256k1::{Message, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::keys::Keys;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

#[derive(Debug, Clone, Default)]
pub struct EventTemplate {
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    /// Unix seconds; `None` means "now".
    pub created_at: Option<u64>,
}

/// True when `s` is exactly `bytes` worth of lowercase hex.
pub fn is_canonical_hex(s: &str, bytes: usize) -> bool {
    s.len() == bytes * 2
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Canonical NIP-01 serialization: `[0, pubkey, created_at, kind, tags, content]`.
pub fn event_id(
    pubkey: &str,
    created_at: u64,
    kind: u32,
    tags: &[Vec<String>],
    content: &str,
) -> String {
    let canonical = serde_json::json!([0, pubkey, created_at, kind, tags, content]);
    let serialized = serde_json::to_string(&canonical).expect("canonical event serializes");
    let digest = Sha256::digest(serialized.as_bytes());
    hex::encode(digest)
}

impl Event {
    /// Sign a template with the given keys, producing a complete event.
    pub fn sign(template: EventTemplate, keys: &Keys) -> anyhow::Result<Event> {
        let created_at = template.created_at.unwrap_or_else(crate::now);
        let id = event_id(
            &keys.pk_hex,
            created_at,
            template.kind,
            &template.tags,
            &template.content,
        );
        let sig = keys.sign_digest(&hex::decode(&id)?)?;
        Ok(Event {
            id,
            pubkey: keys.pk_hex.clone(),
            created_at,
            kind: template.kind,
            tags: template.tags,
            content: template.content,
            sig,
        })
    }

    /// Verify the event id matches its contents and the schnorr signature is valid.
    ///
    /// Hex fields must be **lowercase** (NIP-01's canonical form). `hex::decode`
    /// is case-insensitive, so without this one key would have many valid
    /// spellings that all verify — and since SQLite compares TEXT bytewise,
    /// a pubkey stored in one spelling is invisible to a lookup in another.
    /// That turns whitelist revocation into a silent no-op.
    pub fn verify(&self) -> anyhow::Result<()> {
        if !is_canonical_hex(&self.id, 32) {
            anyhow::bail!("event id must be 64 lowercase hex characters");
        }
        if !is_canonical_hex(&self.pubkey, 32) {
            anyhow::bail!("pubkey must be 64 lowercase hex characters");
        }
        if !is_canonical_hex(&self.sig, 64) {
            anyhow::bail!("signature must be 128 lowercase hex characters");
        }
        let expected = event_id(
            &self.pubkey,
            self.created_at,
            self.kind,
            &self.tags,
            &self.content,
        );
        if expected != self.id {
            anyhow::bail!("event id mismatch");
        }
        let secp = Secp256k1::verification_only();
        let pk = XOnlyPublicKey::from_slice(&hex::decode(&self.pubkey)?)?;
        let sig = Signature::from_slice(&hex::decode(&self.sig)?)?;
        let digest: [u8; 32] = hex::decode(&self.id)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("event id is not 32 bytes"))?;
        let msg = Message::from_digest(digest);
        secp.verify_schnorr(&sig, &msg, &pk)?;
        Ok(())
    }

    /// First value of the first tag whose name matches, e.g. `first_tag("h")`.
    pub fn first_tag(&self, name: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|t| t.first().map(|n| n == name).unwrap_or(false))
            .and_then(|t| t.get(1))
            .map(|s| s.as_str())
    }

    /// All values of tags with the given name.
    pub fn tag_values<'a>(&'a self, name: &str) -> Vec<&'a str> {
        self.tags
            .iter()
            .filter(|t| t.first().map(|n| n == name).unwrap_or(false))
            .filter_map(|t| t.get(1))
            .map(|s| s.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_roundtrip() {
        let keys = Keys::generate();
        let ev = Event::sign(
            EventTemplate {
                kind: 9,
                tags: vec![vec!["h".into(), "general".into()]],
                content: "hola menhir".into(),
                created_at: Some(1_700_000_000),
            },
            &keys,
        )
        .unwrap();
        ev.verify().unwrap();
        assert_eq!(ev.first_tag("h"), Some("general"));
    }

    #[test]
    fn tampered_content_fails_verification() {
        let keys = Keys::generate();
        let mut ev = Event::sign(
            EventTemplate {
                kind: 9,
                tags: vec![],
                content: "original".into(),
                created_at: Some(1_700_000_000),
            },
            &keys,
        )
        .unwrap();
        ev.content = "tampered".into();
        assert!(ev.verify().is_err());
    }

    #[test]
    fn tampered_sig_fails_verification() {
        let keys = Keys::generate();
        let other = Keys::generate();
        let ev = Event::sign(
            EventTemplate {
                kind: 9,
                tags: vec![],
                content: "hi".into(),
                created_at: Some(1_700_000_000),
            },
            &keys,
        )
        .unwrap();
        let forged = Event {
            pubkey: other.pk_hex.clone(),
            ..ev.clone()
        };
        assert!(forged.verify().is_err());
    }
}
