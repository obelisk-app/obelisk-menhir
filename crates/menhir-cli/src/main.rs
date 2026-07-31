//! menhir — terminal Nostr text-channel client and relay admin.
//!
//! Built for AI agents and operators: every read command takes `--json`
//! (NDJSON for streams), keys come from flags or `MENHIR_NSEC`, and `.onion`
//! relays work through `--socks5` / `MENHIR_SOCKS5`.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use menhir_core::client::Client;
use menhir_core::keys::{nip19_encode, pubkey_to_hex};
use menhir_core::{kinds, Event, EventTemplate, Filter, Keys};
use serde_json::{json, Value};

const T: Duration = Duration::from_secs(15);

#[derive(Parser)]
#[command(
    name = "menhir",
    version,
    about = "Obelisk Menhir — text channels over Nostr, in your terminal"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Args, Clone)]
struct ConnOpts {
    /// Relay websocket URL (ws:// or wss://). Env: MENHIR_RELAY.
    #[arg(long, env = "MENHIR_RELAY")]
    relay: String,
    /// Secret key, nsec1… or hex. Env: MENHIR_NSEC.
    #[arg(long, env = "MENHIR_NSEC", hide_env_values = true)]
    nsec: Option<String>,
    /// SOCKS5 proxy (host:port) for .onion relays. Env: MENHIR_SOCKS5.
    #[arg(long, env = "MENHIR_SOCKS5")]
    socks5: Option<String>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate a new Nostr keypair.
    Keygen {
        #[arg(long)]
        json: bool,
    },
    /// Show the identity derived from --nsec / MENHIR_NSEC.
    Whoami {
        /// Secret key, nsec1… or hex. Env: MENHIR_NSEC.
        #[arg(long, env = "MENHIR_NSEC", hide_env_values = true)]
        nsec: String,
        #[arg(long)]
        json: bool,
    },
    /// List the relay's text channels.
    Channels {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        json: bool,
    },
    /// Fetch recent messages from a channel.
    History {
        #[command(flatten)]
        conn: ConnOpts,
        /// Channel id (the `h` tag).
        #[arg(long)]
        channel: String,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Stream a channel live (NDJSON with --json). Ctrl-C to stop.
    Listen {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        channel: String,
        #[arg(long)]
        json: bool,
    },
    /// Send a plain-text message to a channel.
    Send {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        channel: String,
        #[arg(long)]
        message: String,
        /// Reply to this event id (NIP-10). Required for non-admins in a
        /// publication channel.
        #[arg(long)]
        reply_to: Option<String>,
    },
    /// Create a new text channel.
    CreateChannel {
        #[command(flatten)]
        conn: ConnOpts,
        /// Channel id: 1-64 chars of a-z 0-9 - _
        #[arg(long)]
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        about: Option<String>,
        /// chat (anyone posts) or publication (admins post, anyone replies).
        #[arg(long, value_name = "TYPE", default_value = "chat")]
        r#type: String,
    },
    /// Join a channel (adds you to its member list).
    Join {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        channel: String,
    },
    /// Redeem an invite code — whitelists your key on the relay.
    Redeem {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        code: String,
    },
    /// Redeem an obelisk://join?relay=…&invite=… link in one step.
    JoinLink {
        /// The invite link.
        link: String,
        /// Secret key, nsec1… or hex. Env: MENHIR_NSEC.
        #[arg(long, env = "MENHIR_NSEC", hide_env_values = true)]
        nsec: String,
        #[arg(long, env = "MENHIR_SOCKS5")]
        socks5: Option<String>,
    },
    /// Publish your profile (kind 0).
    SetProfile {
        #[command(flatten)]
        conn: ConnOpts,
        #[arg(long)]
        name: String,
        #[arg(long)]
        about: Option<String>,
    },
    /// Administer a local relay's data directory (whitelist, invites, info).
    Admin {
        /// Relay data directory (default ~/.menhir).
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[command(subcommand)]
        action: AdminCmd,
    },
}

#[derive(Subcommand)]
enum AdminCmd {
    /// Show relay identity, onion address, channels, and counts.
    Info {
        #[arg(long)]
        json: bool,
    },
    /// List whitelisted npubs.
    WhitelistList,
    /// Whitelist an npub (or hex pubkey).
    WhitelistAdd { pubkey: String },
    /// Remove an npub from the whitelist.
    WhitelistRemove { pubkey: String },
    /// Create an invite code.
    InviteCreate {
        #[arg(long, default_value_t = 1)]
        max_uses: u32,
        #[arg(long)]
        expires_hours: Option<u64>,
    },
    /// List invite codes.
    InviteList,
}

fn short_npub(pk_hex: &str) -> String {
    let npub = nip19_encode("npub", pk_hex);
    format!("{}…{}", &npub[..12], &npub[npub.len() - 4..])
}

fn print_message(ev: &Event, json: bool) {
    if json {
        // `reply_to` is the NIP-10 marked parent, so an agent can thread a
        // conversation without re-deriving it from the raw tags.
        let reply_to = ev
            .tags
            .iter()
            .find(|t| {
                t.first().map(String::as_str) == Some("e")
                    && t.get(3).map(String::as_str) == Some("reply")
            })
            .and_then(|t| t.get(1));
        println!(
            "{}",
            json!({
                "id": ev.id,
                "pubkey": ev.pubkey,
                "npub": nip19_encode("npub", &ev.pubkey),
                "created_at": ev.created_at,
                "channel": ev.first_tag("h"),
                "reply_to": reply_to,
                "content": ev.content,
            })
        );
    } else {
        println!(
            "[{}] {}: {}",
            ev.created_at,
            short_npub(&ev.pubkey),
            ev.content
        );
    }
}

/// Connect, and authenticate when the relay asks for it (whitelisted relays
/// send an AUTH challenge right away; open relays send none).
async fn connect_and_auth(conn: &ConnOpts) -> Result<(Client, Option<Keys>)> {
    let keys = conn.nsec.as_deref().map(Keys::from_secret).transpose()?;
    let mut client = Client::connect(&conn.relay, conn.socks5.as_deref())
        .await
        .with_context(|| format!("connecting to {}", conn.relay))?;

    let challenge_wait = if conn.socks5.is_some() { 3000 } else { 1000 };
    if client.auth_challenge.is_none() {
        if let Some(v) = client.recv(Duration::from_millis(challenge_wait)).await {
            if v.get(0).and_then(Value::as_str) != Some("AUTH") {
                // Not a challenge — keep it for whoever reads next.
                client_pending_push(&mut client, v);
            }
        }
    }
    if client.auth_challenge.is_some() {
        let Some(keys) = &keys else {
            bail!("this relay requires auth — pass --nsec or set MENHIR_NSEC");
        };
        let (ok, msg) = client.auth(keys, T).await?;
        if !ok {
            bail!("auth failed: {msg} (use `menhir redeem` if you have an invite code)");
        }
    }
    Ok((client, keys))
}

// Client keeps its pending queue private; re-inject via the public seam.
fn client_pending_push(client: &mut Client, v: Value) {
    client.push_pending(v);
}

fn require_keys(keys: Option<Keys>) -> Result<Keys> {
    keys.ok_or_else(|| anyhow::anyhow!("this command needs a key — pass --nsec or set MENHIR_NSEC"))
}

async fn publish_checked(client: &mut Client, ev: &Event) -> Result<()> {
    let (ok, msg) = client.publish(ev, T).await?;
    if !ok {
        bail!("relay rejected the event: {msg}");
    }
    Ok(())
}

fn parse_join_link(link: &str) -> Result<(String, Option<String>)> {
    let query = link
        .strip_prefix("obelisk://join?")
        .or_else(|| link.split_once("/join?").map(|(_, q)| q))
        .ok_or_else(|| anyhow::anyhow!("not an obelisk://join link"))?;
    let mut relay = None;
    let mut invite = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("relay", v)) => relay = Some(v.replace("%3A", ":").replace("%2F", "/")),
            Some(("invite", v)) => invite = Some(v.to_string()),
            _ => {}
        }
    }
    Ok((
        relay.ok_or_else(|| anyhow::anyhow!("link has no relay parameter"))?,
        invite,
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Keygen { json } => {
            let keys = Keys::generate();
            if json {
                println!(
                    "{}",
                    json!({
                        "nsec": keys.nsec(),
                        "npub": keys.npub(),
                        "pubkey": keys.pk_hex,
                        "seckey": keys.sk_hex,
                    })
                );
            } else {
                println!("nsec:   {}", keys.nsec());
                println!("npub:   {}", keys.npub());
                println!("pubkey: {}", keys.pk_hex);
            }
        }
        Cmd::Whoami { nsec, json } => {
            let keys = Keys::from_secret(&nsec)?;
            if json {
                println!("{}", json!({ "npub": keys.npub(), "pubkey": keys.pk_hex }));
            } else {
                println!("npub:   {}", keys.npub());
                println!("pubkey: {}", keys.pk_hex);
            }
        }
        Cmd::Channels { conn, json } => {
            let (mut client, _) = connect_and_auth(&conn).await?;
            let metas = client
                .req_collect(
                    vec![Filter::new().kinds(vec![kinds::GROUP_METADATA]).limit(500)],
                    T,
                )
                .await?;
            for ev in metas {
                let id = ev.first_tag("d").unwrap_or("?").to_string();
                let name = ev.first_tag("name").unwrap_or(&id).to_string();
                let about = ev.first_tag("about").unwrap_or("").to_string();
                // No `t` tag means an ordinary chat channel — relays predating
                // channel types publish metadata without one.
                let kind = ev.first_tag("t").unwrap_or("chat").to_string();
                if json {
                    println!(
                        "{}",
                        json!({ "id": id, "name": name, "about": about, "type": kind })
                    );
                } else {
                    let marker = if kind == "publication" { "▤" } else { "#" };
                    if about.is_empty() {
                        println!("{marker}{id}  —  {name}");
                    } else {
                        println!("{marker}{id}  —  {name}  ({about})");
                    }
                }
            }
        }
        Cmd::History {
            conn,
            channel,
            limit,
            json,
        } => {
            let (mut client, _) = connect_and_auth(&conn).await?;
            let events = client
                .req_collect(
                    vec![Filter::new()
                        .kinds(vec![kinds::CHAT])
                        .tag("h", vec![channel.clone()])
                        .limit(limit)],
                    T,
                )
                .await?;
            for ev in &events {
                print_message(ev, json);
            }
        }
        Cmd::Listen {
            conn,
            channel,
            json,
        } => {
            let (mut client, _) = connect_and_auth(&conn).await?;
            let now = menhir_core::now();
            let sub = client.req_stream(vec![Filter::new()
                .kinds(vec![kinds::CHAT])
                .tag("h", vec![channel.clone()])
                .since(now.saturating_sub(5))])?;
            if !json {
                eprintln!("listening on #{channel} — Ctrl-C to stop");
            }
            loop {
                let Some(v) = client.recv(Duration::from_secs(3600)).await else {
                    bail!("relay closed the connection");
                };
                if v.get(0).and_then(Value::as_str) == Some("EVENT")
                    && v.get(1).and_then(Value::as_str) == Some(sub.as_str())
                {
                    if let Some(raw) = v.get(2) {
                        if let Ok(ev) = serde_json::from_value::<Event>(raw.clone()) {
                            print_message(&ev, json);
                        }
                    }
                }
            }
        }
        Cmd::Send {
            conn,
            channel,
            message,
            reply_to,
        } => {
            let (mut client, keys) = connect_and_auth(&conn).await?;
            let keys = require_keys(keys)?;
            let mut tags = vec![vec!["h".to_string(), channel.clone()]];
            if let Some(parent) = reply_to {
                // NIP-10 marked reply, the same shape obelisk publishes.
                tags.push(vec!["e".into(), parent, String::new(), "reply".into()]);
            }
            let ev = Event::sign(
                EventTemplate {
                    kind: kinds::CHAT,
                    tags,
                    content: message,
                    created_at: None,
                },
                &keys,
            )?;
            publish_checked(&mut client, &ev).await?;
            println!("sent to #{channel} ({})", ev.id);
        }
        Cmd::CreateChannel {
            conn,
            id,
            name,
            about,
            r#type,
        } => {
            let (mut client, keys) = connect_and_auth(&conn).await?;
            let keys = require_keys(keys)?;
            if !matches!(r#type.as_str(), "chat" | "publication") {
                bail!("--type must be chat or publication");
            }
            let mut tags = vec![vec!["h".to_string(), id.clone()]];
            if let Some(name) = name {
                tags.push(vec!["name".into(), name]);
            }
            if let Some(about) = about {
                tags.push(vec!["about".into(), about]);
            }
            tags.push(vec!["t".into(), r#type]);
            let ev = Event::sign(
                EventTemplate {
                    kind: kinds::CREATE_GROUP,
                    tags,
                    content: String::new(),
                    created_at: None,
                },
                &keys,
            )?;
            publish_checked(&mut client, &ev).await?;
            println!("created #{id}");
        }
        Cmd::Join { conn, channel } => {
            let (mut client, keys) = connect_and_auth(&conn).await?;
            let keys = require_keys(keys)?;
            let ev = Event::sign(
                EventTemplate {
                    kind: kinds::JOIN_REQUEST,
                    tags: vec![vec!["h".into(), channel.clone()]],
                    content: String::new(),
                    created_at: None,
                },
                &keys,
            )?;
            publish_checked(&mut client, &ev).await?;
            println!("joined #{channel}");
        }
        Cmd::Redeem { conn, code } => {
            let keys = require_keys(conn.nsec.as_deref().map(Keys::from_secret).transpose()?)?;
            let mut client = Client::connect(&conn.relay, conn.socks5.as_deref()).await?;
            let (ok, msg) = client.redeem_invite(&keys, &code, T).await?;
            if !ok {
                bail!("invite rejected: {msg}");
            }
            println!(
                "invite accepted — {} is now whitelisted on {}",
                keys.npub(),
                conn.relay
            );
        }
        Cmd::JoinLink { link, nsec, socks5 } => {
            let (relay, invite) = parse_join_link(&link)?;
            let keys = Keys::from_secret(&nsec)?;
            let needs_socks = relay.contains(".onion");
            let socks = socks5.or_else(|| needs_socks.then(|| "127.0.0.1:9050".to_string()));
            let mut client = Client::connect(&relay, socks.as_deref()).await?;
            match invite {
                Some(code) => {
                    let (ok, msg) = client.redeem_invite(&keys, &code, T).await?;
                    if !ok {
                        bail!("invite rejected: {msg}");
                    }
                    println!("joined {relay} — invite accepted");
                }
                None => {
                    let (ok, msg) = client.auth(&keys, T).await?;
                    if !ok {
                        bail!("auth failed: {msg}");
                    }
                    println!("joined {relay} — authenticated");
                }
            }
        }
        Cmd::SetProfile { conn, name, about } => {
            let (mut client, keys) = connect_and_auth(&conn).await?;
            let keys = require_keys(keys)?;
            let mut profile = json!({ "name": name });
            if let Some(about) = about {
                profile["about"] = json!(about);
            }
            let ev = Event::sign(
                EventTemplate {
                    kind: kinds::PROFILE,
                    tags: vec![],
                    content: profile.to_string(),
                    created_at: None,
                },
                &keys,
            )?;
            publish_checked(&mut client, &ev).await?;
            println!("profile published");
        }
        Cmd::Admin { data_dir, action } => {
            let data_dir = data_dir.unwrap_or_else(menhir_relay::config::default_data_dir);
            let db = menhir_relay::db::Db::open(&data_dir.join("relay.sqlite"))?;
            match action {
                AdminCmd::Info { json: json_out } => {
                    let cfg = menhir_relay::config::load_config(&data_dir)?;
                    let keys = menhir_relay::config::load_or_create_identity(&data_dir)?;
                    let info = json!({
                        "data_dir": data_dir.display().to_string(),
                        "name": cfg.name,
                        "port": cfg.port,
                        "open": cfg.open,
                        "relay_npub": nip19_encode("npub", &keys.pk_hex),
                        "onion": menhir_relay::tor::read_onion_hostname(&data_dir.join("tor")),
                        "tor_available": menhir_relay::tor::tor_available(),
                        "whitelist_count": db.whitelist_list()?.len(),
                        "channels": db.group_list()?.iter().map(|g| g.id.clone()).collect::<Vec<_>>(),
                    });
                    if json_out {
                        println!("{info}");
                    } else {
                        println!("{}", serde_json::to_string_pretty(&info)?);
                    }
                }
                AdminCmd::WhitelistList => {
                    for pk in db.whitelist_list()? {
                        println!("{}", nip19_encode("npub", &pk));
                    }
                }
                AdminCmd::WhitelistAdd { pubkey } => {
                    let hex = pubkey_to_hex(&pubkey)?;
                    db.whitelist_add(&hex, "cli")?;
                    println!("whitelisted {}", nip19_encode("npub", &hex));
                }
                AdminCmd::WhitelistRemove { pubkey } => {
                    let hex = pubkey_to_hex(&pubkey)?;
                    println!(
                        "{}",
                        if db.whitelist_remove(&hex)? {
                            "removed"
                        } else {
                            "not on the whitelist"
                        }
                    );
                }
                AdminCmd::InviteCreate {
                    max_uses,
                    expires_hours,
                } => {
                    let expires_at = expires_hours.map(|h| menhir_core::now() + h * 3600);
                    let invite = db.invite_create(max_uses, expires_at)?;
                    println!("{}", invite.code);
                    if let Some(onion) =
                        menhir_relay::tor::read_onion_hostname(&data_dir.join("tor"))
                    {
                        println!(
                            "share: obelisk://join?relay=ws://{onion}&invite={}",
                            invite.code
                        );
                    }
                }
                AdminCmd::InviteList => {
                    for inv in db.invite_list()? {
                        println!(
                            "{}  uses {}/{}  expires {}",
                            inv.code,
                            inv.uses,
                            inv.max_uses,
                            inv.expires_at
                                .map(|e| e.to_string())
                                .unwrap_or_else(|| "never".into())
                        );
                    }
                }
            }
        }
    }
    Ok(())
}
