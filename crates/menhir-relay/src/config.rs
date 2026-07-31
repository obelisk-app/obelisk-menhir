//! Relay configuration + relay identity keys, persisted in the data dir.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use menhir_core::Keys;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    pub name: String,
    pub description: String,
    /// Loopback port the relay listens on. 0 picks an ephemeral port.
    pub port: u16,
    /// When true, no NIP-42 auth / whitelist is enforced.
    pub open: bool,
    /// Operator pubkey (hex). Always treated as whitelisted + group admin.
    pub operator_pubkey: Option<String>,
    /// Maximum accepted content length in bytes — text channels only.
    pub max_content_len: usize,
    /// When true, invite codes stop being accepted: already-whitelisted people
    /// keep their access, but nobody new can let themselves in. The operator's
    /// "close the door" switch once a community is assembled.
    #[serde(default)]
    pub locked: bool,
    /// Listen on every interface instead of loopback only.
    ///
    /// Off by default: Tor is the intended ingress and loopback keeps the
    /// relay unreachable except through it. Turn it on to serve a LAN, or to
    /// sit behind a reverse proxy terminating TLS for a real domain — both
    /// are legitimate, both mean the relay is exposed to whatever can route
    /// to it, so the whitelist becomes the only thing standing there.
    #[serde(default)]
    pub bind_all: bool,
    /// Start this server again when the app next opens.
    ///
    /// Set when hosting is started from the desktop app and cleared when it is
    /// stopped, so "keep the app running to keep your server online" holds
    /// across a restart of the app — otherwise everyone's invite links point
    /// at a relay that quietly never came back.
    #[serde(default)]
    pub autostart: bool,
    /// Whether the last start published an onion service, so a resumed server
    /// comes back at the same address it was shared under.
    #[serde(default)]
    pub use_tor: bool,
}

impl Default for RelayConfig {
    fn default() -> Self {
        RelayConfig {
            name: "Menhir".to_string(),
            description: "An Obelisk Menhir text-channel relay".to_string(),
            port: 4869,
            open: false,
            operator_pubkey: None,
            max_content_len: 4096,
            locked: false,
            bind_all: false,
            autostart: false,
            use_tor: false,
        }
    }
}

pub fn default_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    Path::new(&home).join(".menhir")
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load_config(data_dir: &Path) -> Result<RelayConfig> {
    let path = config_path(data_dir);
    if path.exists() {
        let raw =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        Ok(serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?)
    } else {
        Ok(RelayConfig::default())
    }
}

pub fn save_config(data_dir: &Path, cfg: &RelayConfig) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    fs::write(config_path(data_dir), serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

/// Load the relay's identity keypair, generating and persisting it on first run.
/// The secret lives in `<data_dir>/relay-secret.hex` — include it in backups;
/// it signs the relay's NIP-29 group metadata events.
pub fn load_or_create_identity(data_dir: &Path) -> Result<Keys> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join("relay-secret.hex");
    if path.exists() {
        let raw = fs::read_to_string(&path)?;
        Keys::from_secret(raw.trim())
    } else {
        let keys = Keys::generate();
        fs::write(&path, &keys.sk_hex)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(keys)
    }
}
