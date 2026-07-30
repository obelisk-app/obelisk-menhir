//! Tor process manager: SOCKS client port + persistent onion service that
//! forwards to the loopback relay. Uses the system `tor` binary — bundling
//! platform Tor binaries is a post-MVP packaging step.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub struct TorOptions {
    /// Directory for torrc, tor state, and the onion service keys.
    pub tor_dir: PathBuf,
    /// Loopback SOCKS port for outbound onion connections. 0 disables it.
    pub socks_port: u16,
    /// When set, expose 127.0.0.1:<port> as <onion>:80 via a hidden service.
    pub hidden_service_target: Option<u16>,
    /// Seconds to wait for bootstrap (default 120).
    pub bootstrap_timeout_secs: u64,
}

pub struct TorHandle {
    child: Child,
    /// The .onion hostname when a hidden service is configured.
    pub onion: Option<String>,
    pub socks_port: u16,
}

impl TorHandle {
    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
    }
}

pub fn tor_available() -> bool {
    std::process::Command::new("tor")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn hidden_service_dir(tor_dir: &Path) -> PathBuf {
    tor_dir.join("hs")
}

/// Read the persisted onion hostname if the hidden service already exists.
pub fn read_onion_hostname(tor_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(hidden_service_dir(tor_dir).join("hostname")).ok()?;
    let host = raw.trim().to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

pub async fn start(opts: TorOptions) -> Result<TorHandle> {
    if !tor_available() {
        bail!(
            "the `tor` binary was not found on PATH. Install Tor (apt install tor / brew install tor) — \
             Menhir manages it for you once it is installed"
        );
    }
    std::fs::create_dir_all(&opts.tor_dir)?;
    let state_dir = opts.tor_dir.join("state");
    std::fs::create_dir_all(&state_dir)?;

    let mut torrc = format!(
        "SocksPort {}\nDataDirectory {}\nLog notice stdout\n",
        if opts.socks_port == 0 { "0".to_string() } else { format!("127.0.0.1:{}", opts.socks_port) },
        state_dir.display(),
    );
    if let Some(target_port) = opts.hidden_service_target {
        let hs_dir = hidden_service_dir(&opts.tor_dir);
        std::fs::create_dir_all(&hs_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hs_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        torrc.push_str(&format!(
            "HiddenServiceDir {}\nHiddenServicePort 80 127.0.0.1:{}\n",
            hs_dir.display(),
            target_port
        ));
    }
    let torrc_path = opts.tor_dir.join("torrc");
    std::fs::write(&torrc_path, torrc)?;

    let mut child = Command::new("tor")
        .arg("-f")
        .arg(&torrc_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("spawning tor")?;

    // Watch stdout until Tor reports full bootstrap.
    let stdout = child.stdout.take().context("tor stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let timeout = Duration::from_secs(opts.bootstrap_timeout_secs.max(10));
    let bootstrap = tokio::time::timeout(timeout, async {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "tor", "{line}");
            if line.contains("Bootstrapped 100%") {
                return Ok(());
            }
            if line.contains("[err]") {
                bail!("tor error: {line}");
            }
        }
        bail!("tor exited before finishing bootstrap");
    })
    .await;
    match bootstrap {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill().await;
            bail!("tor did not bootstrap within {}s", timeout.as_secs());
        }
    }
    // Keep draining stdout so tor never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

    let onion = if opts.hidden_service_target.is_some() {
        let mut found = None;
        for _ in 0..40 {
            if let Some(host) = read_onion_hostname(&opts.tor_dir) {
                found = Some(host);
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if found.is_none() {
            let _ = child.kill().await;
            bail!("tor bootstrapped but the onion hostname never appeared");
        }
        found
    } else {
        None
    };

    Ok(TorHandle { child, onion, socks_port: opts.socks_port })
}
