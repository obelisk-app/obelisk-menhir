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
    /// Stop Tor and wait for the process to actually exit, so its listener
    /// ports are released before anything tries to bind them again.
    pub async fn stop(mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
    }
}

/// Where Tor is commonly installed, checked when it is not on `PATH`.
///
/// This matters most on macOS: an app launched from Finder inherits a minimal
/// `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so a Homebrew Tor is invisible to
/// a plain `Command::new("tor")` even though it works fine in the user's
/// terminal. Without this, hosting silently degrades to local-only.
const COMMON_TOR_PATHS: &[&str] = &[
    "/opt/homebrew/bin/tor", // macOS, Apple Silicon Homebrew
    "/usr/local/bin/tor",    // macOS Intel Homebrew, manual installs
    "/opt/local/bin/tor",    // MacPorts
    "/usr/bin/tor",          // Debian/Ubuntu/Arch
    "/usr/sbin/tor",         // some distro packages
    "/snap/bin/tor",         // snap
    "/usr/local/sbin/tor",   // FreeBSD ports
    "C:\\Program Files\\Tor\\tor.exe",
    "C:\\Program Files (x86)\\Tor\\tor.exe",
];

fn runs(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve the Tor executable: `PATH` first, then the usual install locations.
pub fn tor_binary() -> Option<String> {
    if runs("tor") {
        return Some("tor".to_string());
    }
    COMMON_TOR_PATHS
        .iter()
        .find(|p| Path::new(p).exists() && runs(p))
        .map(|p| p.to_string())
}

pub fn tor_available() -> bool {
    tor_binary().is_some()
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

/// Quote a path for torrc.
///
/// Load-bearing on macOS, where the application data directory lives under
/// `~/Library/Application Support/…`. Unquoted, Tor reads only up to the space
/// and rejects the file with "Reading config failed".
fn quote_path(path: &Path) -> String {
    let escaped = path
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Drop Tor's "Jul 30 23:23:34.673 [warn] " prefix so the message reads as a
/// sentence when shown to someone who never asked to think about Tor.
fn strip_tor_prefix(line: &str) -> String {
    match line.find(']') {
        Some(i) if line[..i].contains('[') => line[i + 1..].trim().to_string(),
        _ => line.trim().to_string(),
    }
}

/// True when nothing is listening on `127.0.0.1:port`.
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The SOCKS port to hand Tor: the preferred one when free, otherwise any
/// free port.
///
/// Tor binds its listeners while reading the config, so a busy port is not a
/// warning — it aborts with "Reading config failed", naming nothing. A Tor
/// left behind by a previous run (or Tor Browser, or a system Tor) is enough
/// to make hosting impossible, which is a miserable thing to hit.
fn usable_socks_port(preferred: u16) -> u16 {
    if preferred == 0 || port_is_free(preferred) {
        return preferred;
    }
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

/// Tor rejects a data or hidden-service directory that group/other can reach.
fn tighten(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("tightening permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub async fn start(opts: TorOptions) -> Result<TorHandle> {
    let Some(tor_bin) = tor_binary() else {
        bail!(
            "Tor is not installed. Install it (macOS: brew install tor — Linux: apt install tor) \
             and start hosting again; Menhir runs and manages it for you."
        );
    };
    std::fs::create_dir_all(&opts.tor_dir)?;
    let state_dir = opts.tor_dir.join("state");
    std::fs::create_dir_all(&state_dir)?;
    // Tor refuses to use a data directory others can read. create_dir_all
    // applies the umask (usually 0755), so tighten explicitly.
    tighten(&opts.tor_dir)?;
    tighten(&state_dir)?;

    let socks_port = usable_socks_port(opts.socks_port);
    if socks_port != opts.socks_port {
        tracing::info!(
            requested = opts.socks_port,
            using = socks_port,
            "SOCKS port was busy; using another"
        );
    }
    let mut torrc = format!(
        "SocksPort {}\nDataDirectory {}\nLog notice stdout\n",
        if socks_port == 0 {
            "0".to_string()
        } else {
            format!("127.0.0.1:{socks_port}")
        },
        quote_path(&state_dir),
    );
    if let Some(target_port) = opts.hidden_service_target {
        let hs_dir = hidden_service_dir(&opts.tor_dir);
        std::fs::create_dir_all(&hs_dir)?;
        tighten(&hs_dir)?;
        torrc.push_str(&format!(
            "HiddenServiceDir {}\nHiddenServicePort 80 127.0.0.1:{}\n",
            quote_path(&hs_dir),
            target_port
        ));
    }
    let torrc_path = opts.tor_dir.join("torrc");
    std::fs::write(&torrc_path, torrc)?;

    let mut child = Command::new(&tor_bin)
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
    // Tor's fatal line is usually "see warnings above" — so keep the warnings,
    // otherwise the error we surface names no cause at all.
    let mut recent_warnings: Vec<String> = Vec::new();
    let bootstrap = tokio::time::timeout(timeout, async {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "tor", "{line}");
            if line.contains("Bootstrapped 100%") {
                return Ok(());
            }
            if line.contains("[warn]") {
                // Keep the tail; a long bootstrap can emit many.
                if recent_warnings.len() == 5 {
                    recent_warnings.remove(0);
                }
                recent_warnings.push(strip_tor_prefix(&line));
            }
            if line.contains("[err]") {
                let detail = if recent_warnings.is_empty() {
                    strip_tor_prefix(&line)
                } else {
                    format!(
                        "{} ({})",
                        strip_tor_prefix(&line),
                        recent_warnings.join("; ")
                    )
                };
                bail!("tor failed to start: {detail}");
            }
        }
        let tail = if recent_warnings.is_empty() {
            String::new()
        } else {
            format!(": {}", recent_warnings.join("; "))
        };
        bail!("tor exited before finishing bootstrap{tail}");
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

    Ok(TorHandle {
        child,
        onion,
        // The port actually in use, which may not be the one asked for.
        socks_port,
    })
}
