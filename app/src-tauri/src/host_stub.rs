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

use arti_client::{TorClient, TorClientConfig};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tor_rtcompat::PreferredRuntime;

use crate::HostStatus;

#[derive(Default)]
pub struct NodeInner {
    tor: Option<Arc<TorClient<PreferredRuntime>>>,
    /// "host:port" of an onion service → local loopback bridge port.
    bridges: HashMap<String, u16>,
}

#[derive(Default)]
pub struct NodeState(Mutex<NodeInner>);

pub fn setup(app: &tauri::App) {
    app.manage(NodeState::default());
}

const UNSUPPORTED: &str = "hosting a server is available in the desktop app only";

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
pub async fn host_whitelist_add(pubkey: String) -> Result<(), String> {
    let _ = pubkey;
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn host_whitelist_remove(pubkey: String) -> Result<(), String> {
    let _ = pubkey;
    Err(UNSUPPORTED.into())
}

/// Boot the embedded Tor client, reusing it across calls. The first call
/// bootstraps a circuit, which takes a few seconds on a phone network.
async fn tor_client(
    app: &AppHandle,
    inner: &mut NodeInner,
) -> Result<Arc<TorClient<PreferredRuntime>>, String> {
    if let Some(client) = &inner.tor {
        return Ok(client.clone());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut cfg = TorClientConfig::builder();
    // Keep Tor's cache and persistent state inside the app sandbox.
    cfg.storage()
        .cache_dir(arti_client::config::CfgPath::new_literal(
            data_dir.join("arti-cache"),
        ))
        .state_dir(arti_client::config::CfgPath::new_literal(
            data_dir.join("arti-state"),
        ));
    let cfg = cfg.build().map_err(|e| format!("tor config: {e}"))?;

    let client = TorClient::create_bootstrapped(cfg)
        .await
        .map_err(|e| format!("could not start Tor: {e}"))?;
    let client = Arc::new(client);
    inner.tor = Some(client.clone());
    Ok(client)
}

/// Open a loopback → arti → onion bridge and return the local ws:// URL.
#[tauri::command]
pub async fn bridge_open(
    app: AppHandle,
    state: State<'_, NodeState>,
    onion_url: String,
) -> Result<String, String> {
    let (_tls, host, port) =
        menhir_core::client::parse_ws_url(&onion_url).map_err(|e| e.to_string())?;
    if !host.ends_with(".onion") {
        return Err("bridge_open is only for .onion relays".into());
    }

    let key = format!("{host}:{port}");
    let mut inner = state.0.lock().await;
    if let Some(local) = inner.bridges.get(&key) {
        return Ok(format!("ws://127.0.0.1:{local}"));
    }

    let tor = tor_client(&app, &mut inner).await?;
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
                        eprintln!("onion bridge to {host}:{port} failed: {e}");
                        let _ = inbound.shutdown().await;
                    }
                }
            });
        }
    });

    inner.bridges.insert(key, local_port);
    Ok(format!("ws://127.0.0.1:{local_port}"))
}
