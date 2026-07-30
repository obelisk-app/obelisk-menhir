//! Desktop node manager: embedded menhir-relay + managed Tor + onion bridges.

use std::collections::HashMap;
use std::path::PathBuf;

use menhir_core::keys::{nip19_encode, pubkey_to_hex};
use menhir_relay::config::{load_config, save_config};
use menhir_relay::db::Db;
use menhir_relay::{server, tor};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::HostStatus;

const SOCKS_PORT: u16 = 39050;

const TOR_MISSING: &str = "Tor is not installed, so nobody outside this computer could reach your \
                           server. Install it first — macOS: brew install tor — Linux: apt install \
                           tor — then start hosting again.";

#[derive(Default)]
pub struct NodeInner {
    relay: Option<server::RelayHandle>,
    relay_port: u16,
    tor: Option<tor::TorHandle>,
    onion: Option<String>,
    name: String,
    /// "host:port" of an onion service → local loopback bridge port.
    bridges: HashMap<String, u16>,
}

#[derive(Default)]
pub struct NodeState(Mutex<NodeInner>);

pub fn setup(app: &tauri::App) {
    app.manage(NodeState::default());
}

fn host_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("host"))
}

fn tor_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("tor"))
}

fn whitelist_npubs(dir: &PathBuf) -> Vec<String> {
    Db::open(&dir.join("relay.sqlite"))
        .and_then(|db| db.whitelist_list())
        .map(|pks| pks.iter().map(|pk| nip19_encode("npub", pk)).collect())
        .unwrap_or_default()
}

fn status_of(inner: &NodeInner, dir: &PathBuf) -> HostStatus {
    let tor_available = tor::tor_available();
    let running = inner.relay.is_some();
    let relay_url = running.then(|| format!("ws://127.0.0.1:{}", inner.relay_port));
    let share_link = inner
        .onion
        .as_ref()
        .map(|o| format!("obelisk://join?relay=ws://{o}"))
        .or_else(|| relay_url.as_ref().map(|u| format!("obelisk://join?relay={u}")));
    HostStatus {
        supported: true,
        running,
        name: inner.name.clone(),
        relay_url,
        onion: inner.onion.clone(),
        share_link,
        tor_available,
        tor_state: if !running {
            "off".into()
        } else if inner.onion.is_some() {
            "online via Tor".into()
        } else if tor_available {
            "local only".into()
        } else {
            "local only (Tor not installed)".into()
        },
        whitelist: if running { whitelist_npubs(dir) } else { vec![] },
    }
}

#[tauri::command]
pub async fn host_status(app: AppHandle, state: State<'_, NodeState>) -> Result<HostStatus, String> {
    let inner = state.0.lock().await;
    Ok(status_of(&inner, &host_dir(&app)?))
}

#[tauri::command]
pub async fn host_start(
    app: AppHandle,
    state: State<'_, NodeState>,
    name: String,
    operator_npub: String,
    use_tor: bool,
) -> Result<HostStatus, String> {
    let dir = host_dir(&app)?;
    let mut inner = state.0.lock().await;
    if inner.relay.is_some() {
        return Ok(status_of(&inner, &dir));
    }

    // Refuse up front rather than starting a relay nobody else can reach: a
    // loopback-only server is useless for chatting with other people.
    if use_tor && !tor::tor_available() {
        return Err(TOR_MISSING.to_string());
    }

    let operator = pubkey_to_hex(&operator_npub).map_err(|e| e.to_string())?;
    let mut cfg = load_config(&dir).map_err(|e| e.to_string())?;
    cfg.name = if name.trim().is_empty() { "My Menhir".into() } else { name.trim().to_string() };
    cfg.operator_pubkey = Some(operator);
    save_config(&dir, &cfg).map_err(|e| e.to_string())?;

    // The configured port may be taken by another process — fall back to ephemeral.
    let (handle, _st) = match server::start(&dir, cfg.clone()).await {
        Ok(r) => r,
        Err(_) => {
            let mut retry = cfg.clone();
            retry.port = 0;
            server::start(&dir, retry).await.map_err(|e| e.to_string())?
        }
    };
    inner.relay_port = handle.port;
    inner.relay = Some(handle);
    inner.name = cfg.name.clone();

    if use_tor && tor::tor_available() {
        // One managed Tor per app: restart it with the hidden service attached.
        if let Some(old) = inner.tor.take() {
            old.stop().await;
        }
        match tor::start(tor::TorOptions {
            tor_dir: tor_dir(&app)?,
            socks_port: SOCKS_PORT,
            hidden_service_target: Some(inner.relay_port),
            bootstrap_timeout_secs: 180,
        })
        .await
        {
            Ok(th) => {
                inner.onion = th.onion.clone();
                inner.tor = Some(th);
            }
            // The relay stays up local-only; surface the Tor failure so the
            // user knows the server is not reachable from outside.
            Err(e) => return Err(format!("relay started locally, but Tor failed: {e}")),
        }
    }
    Ok(status_of(&inner, &dir))
}

#[tauri::command]
pub async fn host_stop(app: AppHandle, state: State<'_, NodeState>) -> Result<HostStatus, String> {
    let dir = host_dir(&app)?;
    let mut inner = state.0.lock().await;
    if let Some(relay) = inner.relay.take() {
        relay.stop().await;
    }
    inner.onion = None;
    if let Some(tor_handle) = inner.tor.take() {
        tor_handle.stop().await;
    }
    // Live onion bridges still need a SOCKS engine — bring back a client-only Tor.
    if !inner.bridges.is_empty() && tor::tor_available() {
        if let Ok(th) = tor::start(tor::TorOptions {
            tor_dir: tor_dir(&app)?,
            socks_port: SOCKS_PORT,
            hidden_service_target: None,
            bootstrap_timeout_secs: 180,
        })
        .await
        {
            inner.tor = Some(th);
        }
    }
    Ok(status_of(&inner, &dir))
}

#[derive(serde::Serialize)]
pub struct InviteOut {
    pub code: String,
    pub share_link: String,
}

#[tauri::command]
pub async fn host_invite_create(
    app: AppHandle,
    state: State<'_, NodeState>,
    max_uses: u32,
    expires_hours: Option<u64>,
) -> Result<InviteOut, String> {
    let dir = host_dir(&app)?;
    let inner = state.0.lock().await;
    if inner.relay.is_none() {
        return Err("start hosting first".into());
    }
    let db = Db::open(&dir.join("relay.sqlite")).map_err(|e| e.to_string())?;
    let expires_at = expires_hours.map(|h| menhir_core::now() + h * 3600);
    let invite = db.invite_create(max_uses.max(1), expires_at).map_err(|e| e.to_string())?;
    let relay_ref = inner
        .onion
        .as_ref()
        .map(|o| format!("ws://{o}"))
        .unwrap_or_else(|| format!("ws://127.0.0.1:{}", inner.relay_port));
    Ok(InviteOut {
        share_link: format!("obelisk://join?relay={relay_ref}&invite={}", invite.code),
        code: invite.code,
    })
}

#[tauri::command]
pub async fn host_whitelist_add(app: AppHandle, pubkey: String) -> Result<(), String> {
    let dir = host_dir(&app)?;
    let hex = pubkey_to_hex(&pubkey).map_err(|e| e.to_string())?;
    let db = Db::open(&dir.join("relay.sqlite")).map_err(|e| e.to_string())?;
    db.whitelist_add(&hex, "app").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn host_whitelist_remove(app: AppHandle, pubkey: String) -> Result<(), String> {
    let dir = host_dir(&app)?;
    let hex = pubkey_to_hex(&pubkey).map_err(|e| e.to_string())?;
    let db = Db::open(&dir.join("relay.sqlite")).map_err(|e| e.to_string())?;
    db.whitelist_remove(&hex).map(|_| ()).map_err(|e| e.to_string())
}

/// Open a loopback → Tor SOCKS → onion TCP bridge so the webview's plain
/// WebSocket can reach a `.onion` relay. Returns the local ws:// URL.
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
    if !tor::tor_available() {
        return Err("Tor is not installed — install it (brew install tor / apt install tor) to reach .onion servers".into());
    }
    if inner.tor.is_none() {
        let th = tor::start(tor::TorOptions {
            tor_dir: tor_dir(&app)?,
            socks_port: SOCKS_PORT,
            hidden_service_target: None,
            bootstrap_timeout_secs: 180,
        })
        .await
        .map_err(|e| e.to_string())?;
        inner.tor = Some(th);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let target_host = host.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else { break };
            let target_host = target_host.clone();
            tokio::spawn(async move {
                match tokio_socks::tcp::Socks5Stream::connect(
                    format!("127.0.0.1:{SOCKS_PORT}").as_str(),
                    (target_host.as_str(), port),
                )
                .await
                {
                    Ok(mut outbound) => {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                    Err(e) => {
                        eprintln!("onion bridge to {target_host}:{port} failed: {e}");
                    }
                }
            });
        }
    });
    inner.bridges.insert(key, local_port);
    Ok(format!("ws://127.0.0.1:{local_port}"))
}
