//! Mobile stubs: the Android/iOS app is a pure client — no relay, no Tor.

use tauri::State;

use crate::HostStatus;

#[derive(Default)]
pub struct NodeState;

pub fn setup(app: &tauri::App) {
    use tauri::Manager;
    app.manage(NodeState);
}

const UNSUPPORTED: &str = "hosting a server is available in the desktop app only";

#[tauri::command]
pub async fn host_status(_state: State<'_, NodeState>) -> Result<HostStatus, String> {
    Ok(HostStatus { supported: false, tor_state: "unsupported".into(), ..Default::default() })
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

#[tauri::command]
pub async fn bridge_open(onion_url: String) -> Result<String, String> {
    let _ = onion_url;
    Err("connecting to .onion servers needs the desktop app (it runs Tor for you)".into())
}
