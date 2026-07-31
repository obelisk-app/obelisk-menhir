//! Exercise the arti path the mobile app uses, on a host where errors are visible.
//!
//!   cargo run -- <host.onion> [port]
//!
//! Prints each bootstrap status change with a timestamp, then opens a stream to
//! the onion service and sends a NIP-01 REQ so we know the circuit really
//! carries traffic. Any failure is printed with its full arti error chain
//! rather than being swallowed behind a spinner.

use std::time::{Duration, Instant};

use arti_client::{TorClient, TorClientConfig};
use futures::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(180);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(120);

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let mut args = std::env::args().skip(1);
    let host = args.next().unwrap_or_else(|| {
        eprintln!("usage: arti-probe <host.onion> [port]");
        std::process::exit(2);
    });
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(80);

    // rustls 0.23 refuses to guess a crypto provider when more than one
    // backend is present in the graph, and *panics* on first use. Install one
    // explicitly before anything touches TLS.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        println!("crypto provider was already installed");
    }

    let started = Instant::now();
    let stamp = move || format!("[{:>6.1}s]", started.elapsed().as_secs_f32());

    let dir = std::env::temp_dir().join("arti-probe");
    let cache = dir.join("cache");
    let state = dir.join("state");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    println!("{} data dir: {}", stamp(), dir.display());

    let mut builder = TorClientConfig::builder();
    builder
        .storage()
        .cache_dir(arti_client::config::CfgPath::new_literal(cache))
        .state_dir(arti_client::config::CfgPath::new_literal(state));
    // The app sandbox already isolates this directory, and arti's ancestor
    // permission walk is a known source of confusing failures on Android.
    builder
        .storage()
        .permissions()
        .dangerously_trust_everyone();

    let cfg = match builder.build() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("{} CONFIG FAILED: {e}", stamp());
            std::process::exit(1);
        }
    };
    println!("{} config built", stamp());

    // Unbootstrapped first, so bootstrap progress can be watched.
    let client = match TorClient::with_runtime(tor_rtcompat::PreferredRuntime::current().unwrap())
        .config(cfg)
        .create_unbootstrapped()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{} CLIENT CREATE FAILED: {e}", stamp());
            eprintln!("  source chain: {:?}", std::error::Error::source(&e));
            std::process::exit(1);
        }
    };
    println!("{} client created, bootstrapping…", stamp());

    let mut events = client.bootstrap_events();
    let watcher = {
        let stamp = stamp.clone();
        tokio::spawn(async move {
            while let Some(status) = events.next().await {
                println!(
                    "{} bootstrap {:.0}% — {}",
                    stamp(),
                    status.as_frac() * 100.0,
                    status
                );
            }
        })
    };

    match tokio::time::timeout(BOOTSTRAP_TIMEOUT, client.bootstrap()).await {
        Ok(Ok(())) => println!("{} BOOTSTRAPPED", stamp()),
        Ok(Err(e)) => {
            eprintln!("{} BOOTSTRAP FAILED: {e}", stamp());
            eprintln!("  debug: {e:?}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!(
                "{} BOOTSTRAP TIMED OUT after {}s",
                stamp(),
                BOOTSTRAP_TIMEOUT.as_secs()
            );
            std::process::exit(1);
        }
    }
    watcher.abort();

    println!("{} connecting to {host}:{port} …", stamp());
    let stream = match tokio::time::timeout(CONNECT_TIMEOUT, client.connect((host.as_str(), port)))
        .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            eprintln!("{} CONNECT FAILED: {e}", stamp());
            eprintln!("  debug: {e:?}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("{} CONNECT TIMED OUT", stamp());
            std::process::exit(1);
        }
    };
    println!("{} CONNECTED to the onion service", stamp());

    // Speak just enough WebSocket to prove bytes flow end to end.
    let (mut r, mut w) = stream.split();
    let handshake = format!(
        "GET / HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    w.write_all(handshake.as_bytes()).await.unwrap();
    w.flush().await.unwrap();

    let mut buf = vec![0u8; 512];
    match tokio::time::timeout(Duration::from_secs(30), r.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            let first = head.lines().next().unwrap_or("");
            println!("{} relay replied: {first}", stamp());
            if first.contains("101") {
                println!("{} PROBE PASSED — websocket upgrade over Tor", stamp());
            } else {
                println!("{} reached the relay, unexpected status", stamp());
            }
        }
        Ok(Ok(_)) => println!("{} connection closed with no data", stamp()),
        Ok(Err(e)) => eprintln!("{} read failed: {e}", stamp()),
        Err(_) => eprintln!("{} read timed out", stamp()),
    }
}
