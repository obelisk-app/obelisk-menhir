//! menhir-relay — run and administer an Obelisk Menhir text-channel relay.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use menhir_relay::config::{default_data_dir, load_config, load_or_create_identity, save_config};
use menhir_relay::db::Db;
use menhir_relay::{server, tor};

#[derive(Parser)]
#[command(name = "menhir-relay", version, about = "Obelisk Menhir relay — text channels over Nostr, at home behind Tor")]
struct Cli {
    /// Relay data directory (config, sqlite, keys, tor state).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the relay (loopback only; add --tor to publish an onion service).
    Serve {
        /// Loopback port (0 = ephemeral). Persisted to config.
        #[arg(long)]
        port: Option<u16>,
        /// Server name shown in NIP-11.
        #[arg(long)]
        name: Option<String>,
        /// Disable the whitelist — anyone may read and write.
        #[arg(long)]
        open: bool,
        /// Operator pubkey (npub or hex); always whitelisted, admin everywhere.
        #[arg(long)]
        operator: Option<String>,
        /// Start Tor and expose the relay as a persistent onion service.
        #[arg(long)]
        tor: bool,
        /// SOCKS port for the managed Tor (0 disables outbound SOCKS).
        #[arg(long, default_value_t = 39050)]
        socks_port: u16,
    },
    /// Show relay identity, onion address, and counts.
    Info,
    /// Manage the npub whitelist.
    Whitelist {
        #[command(subcommand)]
        action: WhitelistCmd,
    },
    /// Manage invite codes.
    Invite {
        #[command(subcommand)]
        action: InviteCmd,
    },
}

#[derive(Subcommand)]
enum WhitelistCmd {
    List,
    Add { pubkey: String },
    Remove { pubkey: String },
}

#[derive(Subcommand)]
enum InviteCmd {
    List,
    Create {
        #[arg(long, default_value_t = 1)]
        max_uses: u32,
        /// Hours until the invite expires (default: never).
        #[arg(long)]
        expires_hours: Option<u64>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);

    match cli.cmd {
        Cmd::Serve { port, name, open, operator, tor: with_tor, socks_port } => {
            let mut cfg = load_config(&data_dir)?;
            if let Some(port) = port {
                cfg.port = port;
            }
            if let Some(name) = name {
                cfg.name = name;
            }
            if open {
                cfg.open = true;
            }
            if let Some(op) = operator {
                cfg.operator_pubkey = Some(menhir_core::keys::pubkey_to_hex(&op)?);
            }
            save_config(&data_dir, &cfg)?;

            let (handle, st) = server::start(&data_dir, cfg.clone()).await?;
            println!("relay:   ws://127.0.0.1:{}", handle.port);
            println!("name:    {}", cfg.name);
            println!("pubkey:  {}", menhir_core::keys::nip19_encode("npub", &st.keys.pk_hex));
            println!("access:  {}", if cfg.open { "open" } else { "whitelist + invites" });

            let tor_handle = if with_tor {
                let th = tor::start(tor::TorOptions {
                    tor_dir: data_dir.join("tor"),
                    socks_port,
                    hidden_service_target: Some(handle.port),
                    bootstrap_timeout_secs: 120,
                })
                .await?;
                if let Some(onion) = &th.onion {
                    println!("onion:   ws://{onion}");
                    println!("share:   obelisk://join?relay=ws://{onion}");
                }
                Some(th)
            } else {
                None
            };

            println!("press Ctrl-C to stop");
            tokio::signal::ctrl_c().await?;
            if let Some(th) = tor_handle {
                th.stop().await;
            }
            handle.stop().await;
        }
        Cmd::Info => {
            let cfg = load_config(&data_dir)?;
            let keys = load_or_create_identity(&data_dir)?;
            let db = Db::open(&data_dir.join("relay.sqlite"))?;
            let info = serde_json::json!({
                "data_dir": data_dir.display().to_string(),
                "name": cfg.name,
                "port": cfg.port,
                "open": cfg.open,
                "relay_npub": menhir_core::keys::nip19_encode("npub", &keys.pk_hex),
                "operator_pubkey": cfg.operator_pubkey,
                "onion": tor::read_onion_hostname(&data_dir.join("tor")),
                "whitelist_count": db.whitelist_list()?.len(),
                "channels": db.group_list()?.iter().map(|g| g.id.clone()).collect::<Vec<_>>(),
                "tor_available": tor::tor_available(),
            });
            println!("{}", serde_json::to_string_pretty(&info)?);
        }
        Cmd::Whitelist { action } => {
            let db = Db::open(&data_dir.join("relay.sqlite"))?;
            match action {
                WhitelistCmd::List => {
                    for pk in db.whitelist_list()? {
                        println!("{}", menhir_core::keys::nip19_encode("npub", &pk));
                    }
                }
                WhitelistCmd::Add { pubkey } => {
                    let hex = menhir_core::keys::pubkey_to_hex(&pubkey)?;
                    db.whitelist_add(&hex, "cli")?;
                    println!("whitelisted {}", menhir_core::keys::nip19_encode("npub", &hex));
                }
                WhitelistCmd::Remove { pubkey } => {
                    let hex = menhir_core::keys::pubkey_to_hex(&pubkey)?;
                    if db.whitelist_remove(&hex)? {
                        println!("removed");
                    } else {
                        println!("not on the whitelist");
                    }
                }
            }
        }
        Cmd::Invite { action } => {
            let db = Db::open(&data_dir.join("relay.sqlite"))?;
            match action {
                InviteCmd::List => {
                    for inv in db.invite_list()? {
                        println!(
                            "{}  uses {}/{}  expires {}",
                            inv.code,
                            inv.uses,
                            inv.max_uses,
                            inv.expires_at.map(|e| e.to_string()).unwrap_or_else(|| "never".into())
                        );
                    }
                }
                InviteCmd::Create { max_uses, expires_hours } => {
                    let expires_at = expires_hours.map(|h| menhir_core::now() + h * 3600);
                    let invite = db.invite_create(max_uses, expires_at)?;
                    println!("{}", invite.code);
                    let cfg = load_config(&data_dir)?;
                    if let Some(onion) = tor::read_onion_hostname(&data_dir.join("tor")) {
                        println!("share: obelisk://join?relay=ws://{onion}&invite={}", invite.code);
                    } else {
                        println!("share: obelisk://join?relay=ws://127.0.0.1:{}&invite={}", cfg.port, invite.code);
                    }
                }
            }
        }
    }
    Ok(())
}
