//! Obelisk Menhir app shell. The webview owns all Nostr client logic; this
//! crate provides the node manager (desktop) and .onion bridging via Tor.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod host;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "host_stub.rs"]
mod host;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must happen before anything touches TLS. rustls 0.23 will not guess a
    // crypto provider when several are present in the graph — it panics on
    // first use instead, and a panic inside a Tauri command leaves its promise
    // unresolved, which surfaces as the UI hanging with no error at all.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .setup(|app| {
            host::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host::host_status,
            host::host_start,
            host::host_stop,
            host::host_invite_create,
            host::host_whitelist_add,
            host::host_whitelist_remove,
            host::bridge_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Obelisk Menhir");
}

/// Snapshot of the local node, shown in the Host panel.
#[derive(Clone, Default, serde::Serialize)]
pub struct HostStatus {
    /// False on Android/iOS — hosting is a desktop feature.
    pub supported: bool,
    pub running: bool,
    pub name: String,
    pub relay_url: Option<String>,
    pub onion: Option<String>,
    pub share_link: Option<String>,
    pub tor_available: bool,
    pub tor_state: String,
    pub whitelist: Vec<String>,
}
