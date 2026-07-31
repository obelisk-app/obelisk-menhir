//! Mobile build: a client, not a server.
//!
//! Hosting stays desktop-only — Android kills long-running background
//! services, so a phone-hosted relay would be offline most of the time.
//!
//! Reaching `.onion` servers, however, works here with no Tor app installed:
//! `arti` (Tor implemented in Rust) runs in-process, and `bridge_open` puts a
//! loopback TCP listener in front of it so the webview's plain WebSocket can
//! dial an onion address like any other host.

use std::collections::HashMap;
use std::sync::Arc;

use arti_client::config::TorClientConfigBuilder;
use arti_client::TorClient;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tor_rtcompat::PreferredRuntime;

use crate::HostStatus;

#[derive(Default)]
pub struct NodeInner {
    /// Shared so every bridge reuses the one bootstrapped client rather than
    /// building a fresh set of circuits per server.
    tor: Option<Arc<TorClient<PreferredRuntime>>>,
    /// "host:port" of an onion service → local loopback bridge port.
    bridges: HashMap<String, u16>,
}

#[derive(Default)]
pub struct NodeState(Mutex<NodeInner>);

pub fn setup(app: &tauri::App) {
    // Route arti's tracing into logcat. Without this a Tor failure on a phone
    // leaves nothing to look at; `adb logcat -s menhir` now shows bootstrap
    // progress and the real error.
    #[cfg(target_os = "android")]
    {
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Debug)
                .with_tag("menhir"),
        );
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new("info,arti_client=debug,tor_dirmgr=debug"))
            .with_ansi(false)
            .try_init();
    }
    app.manage(NodeState::default());
}

const UNSUPPORTED: &str = "hosting a server is available in the desktop app only";

/// Bootstrapping builds a directory and a circuit from scratch; on a phone
/// network that is tens of seconds, but it must not be unbounded.
const BOOTSTRAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Host and port of a ws:// or wss:// URL.
///
/// Deliberately not reusing menhir-core's parser: pulling that crate into the
/// mobile build would drag secp256k1's C sources along for one line of string
/// splitting, and with them a cross C toolchain requirement.
fn ws_host_port(url: &str) -> Result<(String, u16), String> {
    let (rest, default_port) = match url.strip_prefix("wss://") {
        Some(rest) => (rest, 443u16),
        None => match url.strip_prefix("ws://") {
            Some(rest) => (rest, 80u16),
            None => return Err("relay url must start with ws:// or wss://".into()),
        },
    };
    let hostport = rest.split('/').next().unwrap_or_default();
    if hostport.is_empty() {
        return Err("relay url has no host".into());
    }
    match hostport.rsplit_once(':') {
        Some((host, port)) => {
            let port = port.parse().map_err(|_| "invalid port".to_string())?;
            Ok((host.to_string(), port))
        }
        None => Ok((hostport.to_string(), default_port)),
    }
}

#[tauri::command]
pub async fn host_status(_state: State<'_, NodeState>) -> Result<HostStatus, String> {
    Ok(HostStatus {
        supported: false,
        // Tor is embedded here, so onion addresses always work.
        tor_available: true,
        tor_state: "embedded (arti)".into(),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn host_start(
    _state: State<'_, NodeState>,
    name: String,
    operator_npub: String,
    use_tor: bool,
) -> Result<HostStatus, String> {
    let _ = (name, operator_npub, use_tor);
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_stop(_state: State<'_, NodeState>) -> Result<HostStatus, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_invite_create(
    _state: State<'_, NodeState>,
    max_uses: u32,
    expires_hours: Option<u64>,
) -> Result<serde_json::Value, String> {
    let _ = (max_uses, expires_hours);
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_set_locked(_state: State<'_, NodeState>, locked: bool) -> Result<HostStatus, String> {
    let _ = locked;
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_invite_revoke(
    _state: State<'_, NodeState>,
    code: Option<String>,
) -> Result<HostStatus, String> {
    let _ = code;
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_whitelist_add(pubkey: String) -> Result<(), String> {
    let _ = pubkey;
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_whitelist_remove(pubkey: String) -> Result<(), String> {
    let _ = pubkey;
    Err(UNSUPPORTED.into())
}

/// Boot the embedded Tor client, reusing it across calls.
///
/// Deliberately takes no lock: bootstrapping is a minutes-long operation, and
/// holding the node lock across it would queue every later call — including
/// the client's own reconnect attempts — behind a wait that looks like a hang.
/// Callers take the lock only to read or store the result.
async fn bootstrap_tor(app: &AppHandle) -> Result<Arc<TorClient<PreferredRuntime>>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = data_dir.join("arti-cache");
    let state_dir = data_dir.join("arti-state");
    // arti will not create these itself if the parents are missing.
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("tor cache dir: {e}"))?;
    std::fs::create_dir_all(&state_dir).map_err(|e| format!("tor state dir: {e}"))?;

    let mut cfg = TorClientConfigBuilder::from_directories(state_dir, cache_dir);
    // arti walks the ancestors of its data dir checking permissions, and on
    // Android those are owned by the system — a check the app cannot satisfy,
    // and it fails in a way that reads like a hang. The OS sandbox is what
    // actually protects this directory.
    cfg.storage().permissions().dangerously_trust_everyone();
    let cfg = cfg.build().map_err(|e| format!("tor config: {e}"))?;

    // Bootstrap with a deadline. Without one, an unreachable or censored
    // network leaves the UI on "connecting through Tor…" forever with nothing
    // to act on; a timeout at least names the failure.
    let client = match tokio::time::timeout(
        BOOTSTRAP_TIMEOUT,
        TorClient::create_bootstrapped(cfg),
    )
    .await
    {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => return Err(format!("could not start Tor: {e}")),
        Err(_) => {
            return Err(format!(
                "Tor did not finish connecting within {}s. Check the network — \
                 some mobile networks and captive portals block Tor.",
                BOOTSTRAP_TIMEOUT.as_secs()
            ))
        }
    };
    Ok(client)
}

/// Open a loopback → arti → onion bridge and return the local ws:// URL.
#[tauri::command]
pub async fn bridge_open(
    app: AppHandle,
    state: State<'_, NodeState>,
    onion_url: String,
) -> Result<String, String> {
    let (host, port) = ws_host_port(&onion_url)?;
    if !host.ends_with(".onion") {
        return Err("bridge_open is only for .onion relays".into());
    }

    let key = format!("{host}:{port}");

    // Take the lock only to look things up, never across the bootstrap.
    let (existing_bridge, existing_tor) = {
        let inner = state.0.lock().await;
        (inner.bridges.get(&key).copied(), inner.tor.clone())
    };
    if let Some(local) = existing_bridge {
        return Ok(format!("ws://127.0.0.1:{local}"));
    }

    let tor = match existing_tor {
        Some(tor) => tor,
        None => {
            let tor = bootstrap_tor(&app).await?;
            let mut inner = state.0.lock().await;
            // Another call may have bootstrapped while this one was waiting;
            // keep whichever landed first so there is only ever one client.
            inner.tor.get_or_insert(tor).clone()
        }
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tokio::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                break;
            };
            let tor = tor.clone();
            let host = host.clone();
            tokio::spawn(async move {
                match tor.connect((host.as_str(), port)).await {
                    Ok(stream) => {
                        let (mut tor_r, mut tor_w) = stream.split();
                        let (mut in_r, mut in_w) = inbound.split();
                        // Pump both directions; either side closing ends the pair.
                        let up = async { tokio::io::copy(&mut in_r, &mut tor_w).await };
                        let down = async { tokio::io::copy(&mut tor_r, &mut in_w).await };
                        let _ = tokio::join!(up, down);
                    }
                    Err(e) => {
                        tracing::warn!("onion bridge to {host}:{port} failed: {e}");
                        let _ = inbound.shutdown().await;
                    }
                }
            });
        }
    });

    state.0.lock().await.bridges.insert(key, local_port);
    Ok(format!("ws://127.0.0.1:{local_port}"))
}
