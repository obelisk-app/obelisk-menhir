//! Schnorr keypairs and NIP-19 bech32 encoding (npub / nsec).

use bech32::{Bech32, Hrp};
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};

#[derive(Debug, Clone)]
pub struct Keys {
    /// 32-byte secret key, lowercase hex.
    pub sk_hex: String,
    /// 32-byte x-only public key, lowercase hex.
    pub pk_hex: String,
}

impl Keys {
    pub fn generate() -> Keys {
        let secp = Secp256k1::new();
        let sk = SecretKey::new(&mut rand::thread_rng());
        let kp = Keypair::from_secret_key(&secp, &sk);
        let (xonly, _) = kp.x_only_public_key();
        Keys {
            sk_hex: hex::encode(sk.secret_bytes()),
            pk_hex: hex::encode(xonly.serialize()),
        }
    }

    /// Accepts an nsec1… bech32 string or 64-char hex secret key.
    pub fn from_secret(input: &str) -> anyhow::Result<Keys> {
        let trimmed = input.trim();
        let sk_hex = if trimmed.starts_with("nsec1") {
            nip19_decode(trimmed, "nsec")?
        } else {
            let bytes = hex::decode(trimmed)
                .map_err(|_| anyhow::anyhow!("secret key must be nsec1… or 64-char hex"))?;
            if bytes.len() != 32 {
                anyhow::bail!("secret key must be 32 bytes");
            }
            hex::encode(bytes)
        };
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&hex::decode(&sk_hex)?)?;
        let kp = Keypair::from_secret_key(&secp, &sk);
        let (xonly, _) = kp.x_only_public_key();
        Ok(Keys {
            sk_hex,
            pk_hex: hex::encode(xonly.serialize()),
        })
    }

    pub fn npub(&self) -> String {
        nip19_encode("npub", &self.pk_hex)
    }

    pub fn nsec(&self) -> String {
        nip19_encode("nsec", &self.sk_hex)
    }

    /// Schnorr-sign a 32-byte digest, returning the 64-byte signature as hex.
    pub fn sign_digest(&self, digest: &[u8]) -> anyhow::Result<String> {
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&hex::decode(&self.sk_hex)?)?;
        let kp = Keypair::from_secret_key(&secp, &sk);
        let digest: [u8; 32] = digest
            .try_into()
            .map_err(|_| anyhow::anyhow!("digest must be 32 bytes"))?;
        let msg = Message::from_digest(digest);
        let sig = secp.sign_schnorr_no_aux_rand(&msg, &kp);
        Ok(hex::encode(sig.as_ref()))
    }
}

/// Encode 32 hex bytes under a bech32 human-readable part ("npub"/"nsec").
pub fn nip19_encode(hrp: &str, data_hex: &str) -> String {
    let hrp = Hrp::parse(hrp).expect("static hrp is valid");
    let bytes = hex::decode(data_hex).expect("hex payload");
    bech32::encode::<Bech32>(hrp, &bytes).expect("bech32 encodes")
}

/// Decode an npub/nsec bech32 string; returns the payload as hex.
pub fn nip19_decode(input: &str, expected_hrp: &str) -> anyhow::Result<String> {
    let (hrp, data) = bech32::decode(input.trim())?;
    if hrp.as_str() != expected_hrp {
        anyhow::bail!("expected {expected_hrp}1…, got {}1…", hrp.as_str());
    }
    if data.len() != 32 {
        anyhow::bail!("expected 32-byte payload");
    }
    Ok(hex::encode(data))
}

/// Convert an npub1… or 64-char hex pubkey to hex.
pub fn pubkey_to_hex(input: &str) -> anyhow::Result<String> {
    let trimmed = input.trim();
    if trimmed.starts_with("npub1") {
        nip19_decode(trimmed, "npub")
    } else {
        let bytes = hex::decode(trimmed)
            .map_err(|_| anyhow::anyhow!("pubkey must be npub1… or 64-char hex"))?;
        if bytes.len() != 32 {
            anyhow::bail!("pubkey must be 32 bytes");
        }
        Ok(hex::encode(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nip19_roundtrip() {
        let keys = Keys::generate();
        let npub = keys.npub();
        assert!(npub.starts_with("npub1"));
        assert_eq!(nip19_decode(&npub, "npub").unwrap(), keys.pk_hex);

        let nsec = keys.nsec();
        let restored = Keys::from_secret(&nsec).unwrap();
        assert_eq!(restored.pk_hex, keys.pk_hex);
    }

    #[test]
    fn from_secret_accepts_hex() {
        let keys = Keys::generate();
        let restored = Keys::from_secret(&keys.sk_hex).unwrap();
        assert_eq!(restored.pk_hex, keys.pk_hex);
    }

    #[test]
    fn pubkey_to_hex_accepts_both_forms() {
        let keys = Keys::generate();
        assert_eq!(pubkey_to_hex(&keys.npub()).unwrap(), keys.pk_hex);
        assert_eq!(pubkey_to_hex(&keys.pk_hex).unwrap(), keys.pk_hex);
        assert!(pubkey_to_hex("nonsense").is_err());
    }
}
