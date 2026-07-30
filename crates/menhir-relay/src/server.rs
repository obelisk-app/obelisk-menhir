//! WebSocket relay server: NIP-01 wire protocol, NIP-42 auth + whitelist,
//! Menhir invites, and NIP-29-lite text-channel group logic.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use menhir_core::{kinds, Event, EventTemplate, Filter, Keys};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::config::{load_or_create_identity, RelayConfig};
use crate::db::{Db, StoreResult};

const MAX_SUBS_PER_CONN: usize = 32;
const MAX_FUTURE_DRIFT_SECS: u64 = 900;
const AUTH_FRESHNESS_SECS: u64 = 600;

pub struct RelayState {
    pub cfg: RelayConfig,
    pub db: Db,
    pub keys: Keys,
    pub broadcast: broadcast::Sender<Event>,
}

pub type Shared = Arc<RelayState>;

struct ConnCtx {
    authed: Option<String>,
    challenge: String,
    subs: HashMap<String, Vec<Filter>>,
}

pub struct RelayHandle {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl RelayHandle {
    /// Stop the relay, dropping the listener and all live connections.
    pub async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

/// Start the relay on 127.0.0.1 (loopback only — Tor is the public ingress).
/// `cfg.port` of 0 picks an ephemeral port; the actual port is on the handle.
pub async fn start(data_dir: &Path, cfg: RelayConfig) -> Result<(RelayHandle, Shared)> {
    let keys = load_or_create_identity(data_dir)?;
    let db = Db::open(&data_dir.join("relay.sqlite"))?;
    if let Some(op) = &cfg.operator_pubkey {
        db.whitelist_add(op, "operator")?;
    }
    let (tx, _) = broadcast::channel(512);
    let st: Shared = Arc::new(RelayState {
        cfg: cfg.clone(),
        db,
        keys,
        broadcast: tx,
    });

    let app = Router::new().route("/", get(root)).with_state(st.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await?;
    let port = listener.local_addr()?.port();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tracing::info!(port, name = %cfg.name, open = cfg.open, "menhir relay listening on 127.0.0.1");
    Ok((RelayHandle { port, task }, st))
}

async fn root(State(st): State<Shared>, req: Request) -> Response {
    let wants_ws = req
        .headers()
        .get("upgrade")
        .map(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        .unwrap_or(false);
    if wants_ws {
        let (mut parts, _body) = req.into_parts();
        match WebSocketUpgrade::from_request_parts(&mut parts, &st).await {
            Ok(ws) => ws.on_upgrade(move |socket| handle_socket(socket, st)),
            Err(rejection) => rejection.into_response(),
        }
    } else {
        nip11(&st)
    }
}

/// NIP-11 relay information document (also served to plain HTTP GETs).
fn nip11(st: &RelayState) -> Response {
    let body = json!({
        "name": st.cfg.name,
        "description": st.cfg.description,
        "pubkey": st.keys.pk_hex,
        "supported_nips": [1, 11, 29, 42],
        "software": "https://github.com/obelisk-app/obelisk-menhir",
        "version": env!("CARGO_PKG_VERSION"),
        "limitation": {
            "auth_required": !st.cfg.open,
            "max_message_length": st.cfg.max_content_len + 1024,
            "restricted_writes": !st.cfg.open,
        }
    });
    (
        [
            ("content-type", "application/nostr+json"),
            ("access-control-allow-origin", "*"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, st: Shared) {
    let mut rx = st.broadcast.subscribe();
    let mut ctx = ConnCtx {
        authed: None,
        challenge: hex::encode(rand::random::<[u8; 16]>()),
        subs: HashMap::new(),
    };
    if !st.cfg.open {
        let hello = json!(["AUTH", ctx.challenge]).to_string();
        if socket.send(Message::Text(hello.into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(txt))) => {
                    let replies = handle_client_message(&st, &mut ctx, txt.as_str());
                    for reply in replies {
                        if socket.send(Message::Text(reply.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    if st.cfg.open || ctx.authed.is_some() {
                        for (subid, filters) in &ctx.subs {
                            if filters.iter().any(|f| f.matches(&ev)) {
                                let frame = json!(["EVENT", subid, ev]).to_string();
                                if socket.send(Message::Text(frame.into())).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            },
        }
    }
}

fn handle_client_message(st: &RelayState, ctx: &mut ConnCtx, txt: &str) -> Vec<Value> {
    let Ok(msg) = serde_json::from_str::<Value>(txt) else {
        return vec![json!(["NOTICE", "invalid: could not parse message"])];
    };
    match msg.get(0).and_then(Value::as_str) {
        Some("EVENT") => {
            match serde_json::from_value::<Event>(msg.get(1).cloned().unwrap_or(Value::Null)) {
                Ok(ev) => handle_event(st, ctx, ev),
                Err(_) => vec![json!(["NOTICE", "invalid: malformed event"])],
            }
        }
        Some("AUTH") => {
            match serde_json::from_value::<Event>(msg.get(1).cloned().unwrap_or(Value::Null)) {
                Ok(ev) => handle_auth(st, ctx, ev),
                Err(_) => vec![json!(["NOTICE", "invalid: malformed auth event"])],
            }
        }
        Some("REQ") => handle_req(st, ctx, &msg),
        Some("CLOSE") => {
            if let Some(subid) = msg.get(1).and_then(Value::as_str) {
                ctx.subs.remove(subid);
            }
            vec![]
        }
        _ => vec![json!(["NOTICE", "unknown message type"])],
    }
}

fn handle_req(st: &RelayState, ctx: &mut ConnCtx, msg: &Value) -> Vec<Value> {
    let Some(subid) = msg.get(1).and_then(Value::as_str) else {
        return vec![json!(["NOTICE", "invalid: REQ needs a subscription id"])];
    };
    if !st.cfg.open && ctx.authed.is_none() {
        return vec![json!([
            "CLOSED",
            subid,
            "auth-required: authenticate or redeem an invite first"
        ])];
    }
    let filters: Vec<Filter> = msg
        .as_array()
        .map(|a| {
            a.iter()
                .skip(2)
                .filter_map(|f| serde_json::from_value(f.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    if filters.is_empty() {
        return vec![json!([
            "CLOSED",
            subid,
            "invalid: REQ needs at least one filter"
        ])];
    }
    if ctx.subs.len() >= MAX_SUBS_PER_CONN && !ctx.subs.contains_key(subid) {
        return vec![json!([
            "CLOSED",
            subid,
            "rate-limited: too many subscriptions"
        ])];
    }

    let mut replies = Vec::new();
    match st.db.query(&filters) {
        Ok(events) => {
            for ev in events {
                replies.push(json!(["EVENT", subid, ev]));
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "query failed");
            return vec![json!(["CLOSED", subid, "error: query failed"])];
        }
    }
    replies.push(json!(["EOSE", subid]));
    ctx.subs.insert(subid.to_string(), filters);
    replies
}

fn handle_auth(st: &RelayState, ctx: &mut ConnCtx, ev: Event) -> Vec<Value> {
    let ok = |accepted: bool, msg: &str, id: &str| vec![json!(["OK", id, accepted, msg])];
    if ev.verify().is_err() {
        return ok(false, "invalid: bad signature", &ev.id);
    }
    if ev.kind != kinds::CLIENT_AUTH {
        return ok(false, "invalid: auth event must be kind 22242", &ev.id);
    }
    if ev.first_tag("challenge") != Some(ctx.challenge.as_str()) {
        return ok(false, "invalid: challenge mismatch", &ev.id);
    }
    let now = menhir_core::now();
    if ev.created_at.abs_diff(now) > AUTH_FRESHNESS_SECS {
        return ok(false, "invalid: auth event is not fresh", &ev.id);
    }
    if is_allowed(st, &ev.pubkey) {
        ctx.authed = Some(ev.pubkey.clone());
        ok(true, "welcome", &ev.id)
    } else {
        ok(
            false,
            "restricted: pubkey not whitelisted — ask the operator for an invite",
            &ev.id,
        )
    }
}

fn is_allowed(st: &RelayState, pubkey: &str) -> bool {
    if st.cfg.open {
        return true;
    }
    if st.cfg.operator_pubkey.as_deref() == Some(pubkey) {
        return true;
    }
    st.db.whitelist_contains(pubkey).unwrap_or(false)
}

fn is_admin(st: &RelayState, group_id: &str, pubkey: &str) -> bool {
    st.cfg.operator_pubkey.as_deref() == Some(pubkey)
        || st.db.is_group_admin(group_id, pubkey).unwrap_or(false)
}

fn valid_group_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn handle_event(st: &RelayState, ctx: &mut ConnCtx, ev: Event) -> Vec<Value> {
    let id = ev.id.clone();
    let ok = |accepted: bool, msg: String| vec![json!(["OK", id, accepted, msg])];

    if ev.verify().is_err() {
        return ok(false, "invalid: bad signature or id".into());
    }
    if ev.kind == kinds::CLIENT_AUTH {
        return handle_auth(st, ctx, ev);
    }

    // Invite redemption is the one write allowed before authentication:
    // the signature proves key ownership, the code proves the invitation.
    if ev.kind == kinds::INVITE_REDEEM {
        let now = menhir_core::now();
        if ev.created_at.abs_diff(now) > AUTH_FRESHNESS_SECS {
            return ok(false, "invalid: redemption event is not fresh".into());
        }
        return match st.db.invite_redeem(ev.content.trim()) {
            Ok(Ok(())) => {
                let _ = st.db.whitelist_add(&ev.pubkey, "invite");
                ctx.authed = Some(ev.pubkey.clone());
                ok(true, "invite accepted — welcome".into())
            }
            Ok(Err(reason)) => ok(false, format!("restricted: {reason}")),
            Err(e) => {
                tracing::warn!(error = %e, "invite redemption failed");
                ok(false, "error: could not redeem invite".into())
            }
        };
    }

    if !st.cfg.open && ctx.authed.as_deref() != Some(ev.pubkey.as_str()) {
        return ok(
            false,
            "auth-required: authenticate or redeem an invite first".into(),
        );
    }
    if !kinds::ALLOWED_CLIENT_KINDS.contains(&ev.kind) {
        return ok(
            false,
            "restricted: this relay accepts text-channel events only".into(),
        );
    }
    if ev.content.len() > st.cfg.max_content_len {
        return ok(
            false,
            format!(
                "invalid: content exceeds {} bytes (text only)",
                st.cfg.max_content_len
            ),
        );
    }
    if ev.created_at > menhir_core::now() + MAX_FUTURE_DRIFT_SECS {
        return ok(false, "invalid: created_at too far in the future".into());
    }

    // Kind-specific group logic. May append relay-signed metadata events.
    let mut extra_events: Vec<Event> = Vec::new();
    let verdict: Result<(), String> = (|| {
        match ev.kind {
            kinds::PROFILE => Ok(()),
            kinds::CHAT => {
                let group_id = ev
                    .first_tag("h")
                    .ok_or("invalid: chat needs an h tag")?
                    .to_string();
                if st.db.group_get(&group_id).map_err(db_err)?.is_none() {
                    return Err("invalid: unknown channel".into());
                }
                // First message in a channel makes you a listed member.
                if st
                    .db
                    .member_add_if_absent(&group_id, &ev.pubkey, "member")
                    .map_err(db_err)?
                {
                    extra_events.extend(group_meta_events(st, &group_id).map_err(db_err)?);
                }
                Ok(())
            }
            kinds::CREATE_GROUP => {
                let group_id = ev
                    .first_tag("h")
                    .ok_or("invalid: create-group needs an h tag")?
                    .to_string();
                if !valid_group_id(&group_id) {
                    return Err("invalid: channel id must be 1-64 chars of a-z 0-9 - _".into());
                }
                let name = ev
                    .first_tag("name")
                    .map(str::to_string)
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| group_id.clone());
                let about = ev.first_tag("about").unwrap_or("").to_string();
                if !st
                    .db
                    .group_create(&group_id, &name, &about, &ev.pubkey)
                    .map_err(db_err)?
                {
                    return Err("duplicate: channel already exists".into());
                }
                st.db
                    .member_add(&group_id, &ev.pubkey, "admin")
                    .map_err(db_err)?;
                extra_events.extend(group_meta_events(st, &group_id).map_err(db_err)?);
                Ok(())
            }
            kinds::JOIN_REQUEST => {
                let group_id = ev
                    .first_tag("h")
                    .ok_or("invalid: join needs an h tag")?
                    .to_string();
                if st.db.group_get(&group_id).map_err(db_err)?.is_none() {
                    return Err("invalid: unknown channel".into());
                }
                if st
                    .db
                    .member_add_if_absent(&group_id, &ev.pubkey, "member")
                    .map_err(db_err)?
                {
                    extra_events.extend(group_meta_events(st, &group_id).map_err(db_err)?);
                }
                Ok(())
            }
            kinds::LEAVE_REQUEST => {
                let group_id = ev
                    .first_tag("h")
                    .ok_or("invalid: leave needs an h tag")?
                    .to_string();
                st.db.member_remove(&group_id, &ev.pubkey).map_err(db_err)?;
                extra_events.extend(group_meta_events(st, &group_id).map_err(db_err)?);
                Ok(())
            }
            kinds::PUT_USER | kinds::REMOVE_USER | kinds::EDIT_METADATA | kinds::DELETE_GROUP => {
                let group_id = ev
                    .first_tag("h")
                    .ok_or("invalid: moderation needs an h tag")?
                    .to_string();
                if st.db.group_get(&group_id).map_err(db_err)?.is_none() {
                    return Err("invalid: unknown channel".into());
                }
                if !is_admin(st, &group_id, &ev.pubkey) {
                    return Err("restricted: channel admins only".into());
                }
                match ev.kind {
                    kinds::PUT_USER => {
                        for tag in &ev.tags {
                            if tag.first().map(String::as_str) == Some("p") {
                                if let Some(pubkey) = tag.get(1) {
                                    let role = match tag.get(2).map(String::as_str) {
                                        Some("admin") => "admin",
                                        Some("moderator") => "moderator",
                                        _ => "member",
                                    };
                                    st.db.member_add(&group_id, pubkey, role).map_err(db_err)?;
                                }
                            }
                        }
                    }
                    kinds::REMOVE_USER => {
                        for pubkey in ev.tag_values("p") {
                            st.db.member_remove(&group_id, pubkey).map_err(db_err)?;
                        }
                    }
                    kinds::EDIT_METADATA => {
                        st.db
                            .group_update_meta(
                                &group_id,
                                ev.first_tag("name"),
                                ev.first_tag("about"),
                            )
                            .map_err(db_err)?;
                    }
                    kinds::DELETE_GROUP => {
                        st.db.group_delete(&group_id).map_err(db_err)?;
                        st.db.purge_group_events(&group_id).map_err(db_err)?;
                        return Ok(());
                    }
                    _ => unreachable!(),
                }
                extra_events.extend(group_meta_events(st, &group_id).map_err(db_err)?);
                Ok(())
            }
            _ => Err("restricted: kind not handled".into()),
        }
    })();

    if let Err(reason) = verdict {
        return ok(false, reason);
    }

    if !kinds::is_ephemeral(ev.kind) {
        match st.db.insert_event(&ev) {
            Ok(StoreResult::Stored) => {}
            Ok(StoreResult::Duplicate) => {
                return ok(true, "duplicate: already have this event".into())
            }
            Ok(StoreResult::Stale) => return ok(true, "duplicate: newer version exists".into()),
            Err(e) => {
                tracing::warn!(error = %e, "event insert failed");
                return ok(false, "error: storage failure".into());
            }
        }
    }
    let _ = st.broadcast.send(ev.clone());
    for meta in extra_events {
        let _ = st.db.insert_event(&meta);
        let _ = st.broadcast.send(meta);
    }
    ok(true, String::new())
}

fn db_err(e: anyhow::Error) -> String {
    tracing::warn!(error = %e, "db error");
    "error: storage failure".to_string()
}

/// Build the relay-signed NIP-29 metadata trio (39000/39001/39002) for a group.
pub fn group_meta_events(st: &RelayState, group_id: &str) -> anyhow::Result<Vec<Event>> {
    let Some(group) = st.db.group_get(group_id)? else {
        return Ok(vec![]);
    };
    let members = st.db.members(group_id)?;
    let now = menhir_core::now();

    let mut meta_tags = vec![
        vec!["d".to_string(), group.id.clone()],
        vec!["name".to_string(), group.name.clone()],
        vec!["open".to_string()],
    ];
    if !group.about.is_empty() {
        meta_tags.push(vec!["about".to_string(), group.about.clone()]);
    }
    let metadata = Event::sign(
        EventTemplate {
            kind: kinds::GROUP_METADATA,
            tags: meta_tags,
            content: String::new(),
            created_at: Some(now),
        },
        &st.keys,
    )?;

    let mut admin_tags = vec![vec!["d".to_string(), group.id.clone()]];
    let mut member_tags = vec![vec!["d".to_string(), group.id.clone()]];
    for (pubkey, role) in &members {
        member_tags.push(vec!["p".to_string(), pubkey.clone()]);
        if role == "admin" || role == "moderator" {
            admin_tags.push(vec!["p".to_string(), pubkey.clone(), role.clone()]);
        }
    }
    let admins = Event::sign(
        EventTemplate {
            kind: kinds::GROUP_ADMINS,
            tags: admin_tags,
            content: String::new(),
            created_at: Some(now),
        },
        &st.keys,
    )?;
    let member_list = Event::sign(
        EventTemplate {
            kind: kinds::GROUP_MEMBERS,
            tags: member_tags,
            content: String::new(),
            created_at: Some(now),
        },
        &st.keys,
    )?;
    Ok(vec![metadata, admins, member_list])
}
