//! End-to-end tests: real relay on an ephemeral loopback port, real ws clients.

use std::path::PathBuf;
use std::time::Duration;

use menhir_core::client::Client;
use menhir_core::{kinds, Event, EventTemplate, Filter, Keys};
use menhir_relay::config::RelayConfig;
use menhir_relay::server;
use serde_json::Value;

const T: Duration = Duration::from_secs(5);

fn scratch_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "menhir-test-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn start_relay(
    label: &str,
    operator: &Keys,
    open: bool,
) -> (server::RelayHandle, server::Shared, String) {
    let cfg = RelayConfig {
        port: 0,
        open,
        operator_pubkey: Some(operator.pk_hex.clone()),
        ..RelayConfig::default()
    };
    let (handle, st) = server::start(&scratch_dir(label), cfg).await.unwrap();
    let url = format!("ws://127.0.0.1:{}", handle.port);
    (handle, st, url)
}

fn chat(keys: &Keys, channel: &str, text: &str) -> Event {
    Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags: vec![vec!["h".into(), channel.into()]],
            content: text.into(),
            created_at: None,
        },
        keys,
    )
    .unwrap()
}

fn create_channel(keys: &Keys, id: &str, name: &str) -> Event {
    Event::sign(
        EventTemplate {
            kind: kinds::CREATE_GROUP,
            tags: vec![
                vec!["h".into(), id.into()],
                vec!["name".into(), name.into()],
            ],
            content: String::new(),
            created_at: None,
        },
        keys,
    )
    .unwrap()
}

#[tokio::test]
async fn operator_auth_create_channel_and_chat() {
    let operator = Keys::generate();
    let (_handle, _st, url) = start_relay("op", &operator, false).await;

    let mut client = Client::connect(&url, None).await.unwrap();
    let (authed, msg) = client.auth(&operator, T).await.unwrap();
    assert!(authed, "operator auth should pass: {msg}");

    let (ok, msg) = client
        .publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();
    assert!(ok, "create channel: {msg}");

    let (ok, msg) = client
        .publish(&chat(&operator, "general", "first!"), T)
        .await
        .unwrap();
    assert!(ok, "chat should be accepted: {msg}");

    // History comes back, and the relay generated channel metadata.
    let history = client
        .req_collect(
            vec![Filter::new()
                .kinds(vec![kinds::CHAT])
                .tag("h", vec!["general".into()])],
            T,
        )
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].content, "first!");

    let meta = client
        .req_collect(vec![Filter::new().kinds(vec![kinds::GROUP_METADATA])], T)
        .await
        .unwrap();
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].first_tag("d"), Some("general"));
    assert_eq!(meta[0].first_tag("name"), Some("General"));

    let members = client
        .req_collect(
            vec![Filter::new()
                .kinds(vec![kinds::GROUP_MEMBERS])
                .tag("d", vec!["general".into()])],
            T,
        )
        .await
        .unwrap();
    assert_eq!(members.len(), 1);
    assert!(members[0]
        .tag_values("p")
        .contains(&operator.pk_hex.as_str()));
}

#[tokio::test]
async fn stranger_needs_invite_then_can_chat() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("invite", &operator, false).await;

    // Operator sets the room up.
    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    // A stranger cannot authenticate or write.
    let stranger = Keys::generate();
    let mut client = Client::connect(&url, None).await.unwrap();
    let (authed, msg) = client.auth(&stranger, T).await.unwrap();
    assert!(!authed);
    assert!(msg.starts_with("restricted"), "got: {msg}");
    let (ok, msg) = client
        .publish(&chat(&stranger, "general", "let me in"), T)
        .await
        .unwrap();
    assert!(!ok);
    assert!(msg.starts_with("auth-required"), "got: {msg}");

    // A bad invite code is refused.
    let (ok, _) = client
        .redeem_invite(&stranger, "wrong-code", T)
        .await
        .unwrap();
    assert!(!ok);

    // A real invite whitelists the key and authenticates the connection.
    let invite = st.db.invite_create(1, None).unwrap();
    let (ok, msg) = client
        .redeem_invite(&stranger, &invite.code, T)
        .await
        .unwrap();
    assert!(ok, "redeem: {msg}");
    let (ok, msg) = client
        .publish(&chat(&stranger, "general", "thanks!"), T)
        .await
        .unwrap();
    assert!(ok, "post-invite chat: {msg}");

    // The invite is single-use.
    let second = Keys::generate();
    let mut other = Client::connect(&url, None).await.unwrap();
    let (ok, msg) = other.redeem_invite(&second, &invite.code, T).await.unwrap();
    assert!(!ok);
    assert!(msg.contains("used up"), "got: {msg}");

    // …but the stranger's whitelisting persists across reconnects.
    let mut back = Client::connect(&url, None).await.unwrap();
    let (authed, _) = back.auth(&stranger, T).await.unwrap();
    assert!(authed);
}

#[tokio::test]
async fn text_only_policy_rejects_other_kinds_and_huge_content() {
    let operator = Keys::generate();
    let (_handle, _st, url) = start_relay("policy", &operator, false).await;

    let mut client = Client::connect(&url, None).await.unwrap();
    client.auth(&operator, T).await.unwrap();
    client
        .publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    // Reactions (kind 7) are not text-channel logic.
    let reaction = Event::sign(
        EventTemplate {
            kind: 7,
            tags: vec![],
            content: "+".into(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    let (ok, msg) = client.publish(&reaction, T).await.unwrap();
    assert!(!ok);
    assert!(msg.contains("text-channel"), "got: {msg}");

    // Oversized content is refused.
    let huge = chat(&operator, "general", &"x".repeat(5000));
    let (ok, msg) = client.publish(&huge, T).await.unwrap();
    assert!(!ok);
    assert!(msg.contains("content exceeds"), "got: {msg}");

    // Chatting into a non-existent channel is refused.
    let (ok, msg) = client
        .publish(&chat(&operator, "nope", "hello?"), T)
        .await
        .unwrap();
    assert!(!ok);
    assert!(msg.contains("unknown channel"), "got: {msg}");
}

/// Tags are indexed storage, so the content cap alone does not bound an
/// event: a small message carrying tens of thousands of tags would write a
/// row per tag. The relay must refuse it.
#[tokio::test]
async fn oversized_tag_lists_are_rejected() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("tags", &operator, false).await;

    let mut client = Client::connect(&url, None).await.unwrap();
    client.auth(&operator, T).await.unwrap();
    client
        .publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    // 20k tags: tiny content, ~1.3 MB event.
    let mut tags = vec![vec!["h".to_string(), "general".to_string()]];
    for i in 0..20_000 {
        tags.push(vec!["e".to_string(), format!("{i:064x}")]);
    }
    let flood = Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags,
            content: "x".into(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    let (ok, msg) = client.publish(&flood, T).await.unwrap();
    assert!(!ok, "20k-tag event must be refused");
    assert!(msg.contains("too many tags"), "got: {msg}");

    // A single enormous tag value is refused too.
    let fat_tag = Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags: vec![
                vec!["h".into(), "general".into()],
                vec!["e".into(), "z".repeat(9000)],
            ],
            content: "x".into(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    let (ok, msg) = client.publish(&fat_tag, T).await.unwrap();
    assert!(!ok, "oversized tag value must be refused");
    assert!(msg.contains("tag value exceeds"), "got: {msg}");

    // Nothing was stored, and ordinary messages still work.
    let stored = st
        .db
        .query(&[Filter::new().kinds(vec![kinds::CHAT])])
        .unwrap();
    assert!(stored.is_empty(), "rejected events must not be stored");
    let (ok, msg) = client
        .publish(&chat(&operator, "general", "still fine"), T)
        .await
        .unwrap();
    assert!(ok, "normal chat after rejection: {msg}");
}

/// Authorization reads one `h` tag; storage indexes every one. A second `h`
/// would smuggle a message into a channel it was never authorized against.
#[tokio::test]
async fn a_second_h_tag_cannot_smuggle_into_another_channel() {
    let operator = Keys::generate();
    let (_handle, _st, url) = start_relay("smuggle", &operator, false).await;

    let mut client = Client::connect(&url, None).await.unwrap();
    client.auth(&operator, T).await.unwrap();
    for id in ["sandbox", "announcements"] {
        client
            .publish(&create_channel(&operator, id, id), T)
            .await
            .unwrap();
    }

    let smuggled = Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags: vec![
                vec!["h".into(), "sandbox".into()],
                vec!["h".into(), "announcements".into()],
            ],
            content: "not authorized here".into(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    let (ok, msg) = client.publish(&smuggled, T).await.unwrap();
    assert!(!ok, "multi-channel event must be refused");
    assert!(msg.contains("only one channel"), "got: {msg}");

    let leaked = client
        .req_collect(
            vec![Filter::new()
                .kinds(vec![kinds::CHAT])
                .tag("h", vec!["announcements".into()])],
            T,
        )
        .await
        .unwrap();
    assert!(leaked.is_empty(), "nothing may reach #announcements");
}

/// Replaying a join must not undo a moderator's kick.
#[tokio::test]
async fn replayed_join_does_not_resurrect_a_kicked_member() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("replay", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    let member = Keys::generate();
    st.db.whitelist_add(&member.pk_hex, "test").unwrap();
    let mut mem = Client::connect(&url, None).await.unwrap();
    mem.auth(&member, T).await.unwrap();

    let join = Event::sign(
        EventTemplate {
            kind: kinds::JOIN_REQUEST,
            tags: vec![vec!["h".into(), "general".into()]],
            content: String::new(),
            created_at: None,
        },
        &member,
    )
    .unwrap();
    assert!(mem.publish(&join, T).await.unwrap().0);
    assert!(st
        .db
        .members("general")
        .unwrap()
        .iter()
        .any(|(pk, _)| pk == &member.pk_hex));

    // Admin kicks them.
    let kick = Event::sign(
        EventTemplate {
            kind: kinds::REMOVE_USER,
            tags: vec![
                vec!["h".into(), "general".into()],
                vec!["p".into(), member.pk_hex.clone()],
            ],
            content: String::new(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    assert!(op.publish(&kick, T).await.unwrap().0);

    // The byte-identical join is replayed.
    let (ok, _) = mem.publish(&join, T).await.unwrap();
    assert!(ok, "a replay is acknowledged, not an error");
    assert!(
        !st.db
            .members("general")
            .unwrap()
            .iter()
            .any(|(pk, _)| pk == &member.pk_hex),
        "the kicked member must stay out"
    );
}

/// A deleted channel id must not be reusable — re-creating it would hand
/// admin of that name to whoever asks, and re-admit the purged events.
#[tokio::test]
async fn deleted_channel_ids_are_not_recycled() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("retire", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();
    let abusive = chat(&operator, "general", "spam");
    op.publish(&abusive, T).await.unwrap();

    let delete = Event::sign(
        EventTemplate {
            kind: kinds::DELETE_GROUP,
            tags: vec![vec!["h".into(), "general".into()]],
            content: String::new(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    assert!(op.publish(&delete, T).await.unwrap().0);

    let squatter = Keys::generate();
    st.db.whitelist_add(&squatter.pk_hex, "test").unwrap();
    let mut sq = Client::connect(&url, None).await.unwrap();
    sq.auth(&squatter, T).await.unwrap();
    let (ok, msg) = sq
        .publish(&create_channel(&squatter, "general", "General"), T)
        .await
        .unwrap();
    assert!(!ok, "a purged channel id must not be reusable");
    assert!(msg.contains("cannot be reused"), "got: {msg}");

    // And the purged message cannot be re-published into it.
    let (ok, _) = sq.publish(&abusive, T).await.unwrap();
    assert!(!ok, "purged events must not come back");
}

/// An auth event names the relay it was signed for; one signed for a
/// different host must not open a session here.
#[tokio::test]
async fn auth_event_is_bound_to_this_relay() {
    let operator = Keys::generate();
    let (_handle, _st, url) = start_relay("authbind", &operator, false).await;

    let mut client = Client::connect(&url, None).await.unwrap();
    let challenge = loop {
        let v = client.recv(T).await.expect("challenge");
        if v.get(0).and_then(Value::as_str) == Some("AUTH") {
            break v.get(1).and_then(Value::as_str).unwrap().to_string();
        }
    };

    let forwarded = Event::sign(
        EventTemplate {
            kind: kinds::CLIENT_AUTH,
            tags: vec![
                vec!["relay".into(), "wss://evil.example".into()],
                vec!["challenge".into(), challenge.clone()],
            ],
            content: String::new(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    client.send_json(&serde_json::json!(["AUTH", forwarded]));
    let (ok, msg) = loop {
        let v = client.recv(T).await.expect("ok");
        if v.get(0).and_then(Value::as_str) == Some("OK") {
            break (
                v.get(2).and_then(Value::as_bool).unwrap_or(false),
                v.get(3).and_then(Value::as_str).unwrap_or("").to_string(),
            );
        }
    };
    assert!(!ok, "auth naming another relay must be refused");
    assert!(msg.contains("different relay"), "got: {msg}");

    // The honest client (which names the host it dialled) still gets in.
    let (ok, msg) = client.auth(&operator, T).await.unwrap();
    assert!(ok, "normal auth still works: {msg}");
}

/// Uppercase hex is a second spelling of the same key. If it were accepted,
/// it would land in the whitelist as a row that revocation can never match.
#[tokio::test]
async fn non_canonical_hex_pubkeys_are_rejected() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("hexcase", &operator, false).await;

    let stranger = Keys::generate();
    let invite = st.db.invite_create(1, None).unwrap();

    let mut client = Client::connect(&url, None).await.unwrap();
    let mut redeem = Event::sign(
        EventTemplate {
            kind: kinds::INVITE_REDEEM,
            tags: vec![],
            content: invite.code.clone(),
            created_at: None,
        },
        &stranger,
    )
    .unwrap();
    // Same key, different spelling — and a matching id so only the case differs.
    redeem.pubkey = stranger.pk_hex.to_uppercase();
    redeem.id = menhir_core::event::event_id(
        &redeem.pubkey,
        redeem.created_at,
        redeem.kind,
        &redeem.tags,
        &redeem.content,
    );

    let (ok, _) = client.publish(&redeem, T).await.unwrap();
    assert!(!ok, "non-canonical hex must not authenticate");
    assert!(
        !st.db
            .whitelist_contains(&stranger.pk_hex.to_uppercase())
            .unwrap(),
        "no aliased row may reach the whitelist"
    );
}

/// Creating a channel is not an operator privilege: anyone the relay admits
/// can make one from an ordinary client, and becomes its admin.
#[tokio::test]
async fn any_member_can_create_a_channel_and_administer_it() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("usercreate", &operator, false).await;

    let member = Keys::generate();
    st.db.whitelist_add(&member.pk_hex, "test").unwrap();
    let mut mem = Client::connect(&url, None).await.unwrap();
    mem.auth(&member, T).await.unwrap();

    let (ok, msg) = mem
        .publish(&create_channel(&member, "watercooler", "Watercooler"), T)
        .await
        .unwrap();
    assert!(ok, "a plain member must be able to create a channel: {msg}");

    // …and is its admin, so moderation there is theirs.
    let rename = Event::sign(
        EventTemplate {
            kind: kinds::EDIT_METADATA,
            tags: vec![
                vec!["h".into(), "watercooler".into()],
                vec!["name".into(), "Water Cooler".into()],
            ],
            content: String::new(),
            created_at: None,
        },
        &member,
    )
    .unwrap();
    let (ok, msg) = mem.publish(&rename, T).await.unwrap();
    assert!(ok, "the creator administers their own channel: {msg}");

    let meta = mem
        .req_collect(
            vec![Filter::new()
                .kinds(vec![kinds::GROUP_METADATA])
                .tag("d", vec!["watercooler".into()])],
            T,
        )
        .await
        .unwrap();
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].first_tag("name"), Some("Water Cooler"));

    // A different member cannot rename someone else's channel.
    let outsider = Keys::generate();
    st.db.whitelist_add(&outsider.pk_hex, "test").unwrap();
    let mut out = Client::connect(&url, None).await.unwrap();
    out.auth(&outsider, T).await.unwrap();
    let hijack = Event::sign(
        EventTemplate {
            kind: kinds::EDIT_METADATA,
            tags: vec![
                vec!["h".into(), "watercooler".into()],
                vec!["name".into(), "Hijacked".into()],
            ],
            content: String::new(),
            created_at: None,
        },
        &outsider,
    )
    .unwrap();
    let (ok, msg) = out.publish(&hijack, T).await.unwrap();
    assert!(!ok);
    assert!(msg.contains("admins only"), "got: {msg}");
}

/// Closing the door stops new members without evicting the existing ones.
#[tokio::test]
async fn locking_the_relay_stops_invites_but_not_members() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("locked", &operator, false).await;

    // Someone who got in before the lock.
    let member = Keys::generate();
    st.db.whitelist_add(&member.pk_hex, "test").unwrap();

    st.set_locked(true);

    // A fresh invite is now worthless.
    let invite = st.db.invite_create(1, None).unwrap();
    let newcomer = Keys::generate();
    let mut client = Client::connect(&url, None).await.unwrap();
    let (ok, msg) = client
        .redeem_invite(&newcomer, &invite.code, T)
        .await
        .unwrap();
    assert!(!ok, "a locked relay must refuse invites");
    assert!(msg.contains("not accepting new members"), "got: {msg}");
    assert!(
        !st.db.whitelist_contains(&newcomer.pk_hex).unwrap(),
        "a refused redemption must not whitelist anyone"
    );

    // …but existing members are unaffected.
    let mut mem = Client::connect(&url, None).await.unwrap();
    let (authed, msg) = mem.auth(&member, T).await.unwrap();
    assert!(authed, "existing members keep their access: {msg}");

    // Reopening restores the previous behaviour.
    st.set_locked(false);
    let mut again = Client::connect(&url, None).await.unwrap();
    let (ok, msg) = again
        .redeem_invite(&newcomer, &invite.code, T)
        .await
        .unwrap();
    assert!(ok, "reopening lets invites work again: {msg}");
}

#[tokio::test]
async fn live_subscription_delivers_messages() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("live", &operator, false).await;

    let mut sender = Client::connect(&url, None).await.unwrap();
    sender.auth(&operator, T).await.unwrap();
    sender
        .publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    let friend = Keys::generate();
    st.db.whitelist_add(&friend.pk_hex, "test").unwrap();
    let mut listener = Client::connect(&url, None).await.unwrap();
    listener.auth(&friend, T).await.unwrap();
    let sub = listener
        .req_stream(vec![Filter::new()
            .kinds(vec![kinds::CHAT])
            .tag("h", vec!["general".into()])])
        .unwrap();

    // Drain until EOSE so the live phase starts.
    loop {
        let v = listener.recv(T).await.expect("eose");
        if v.get(0).and_then(Value::as_str) == Some("EOSE") {
            break;
        }
    }

    sender
        .publish(&chat(&operator, "general", "ping"), T)
        .await
        .unwrap();

    let received = loop {
        let v = listener.recv(T).await.expect("live event");
        if v.get(0).and_then(Value::as_str) == Some("EVENT")
            && v.get(1).and_then(Value::as_str) == Some(sub.as_str())
        {
            break serde_json::from_value::<Event>(v.get(2).cloned().unwrap()).unwrap();
        }
    };
    assert_eq!(received.content, "ping");
    assert_eq!(received.pubkey, operator.pk_hex);
}

#[tokio::test]
async fn open_relay_needs_no_auth() {
    let operator = Keys::generate();
    let (_handle, _st, url) = start_relay("open", &operator, true).await;

    let visitor = Keys::generate();
    let mut client = Client::connect(&url, None).await.unwrap();
    let (ok, msg) = client
        .publish(&create_channel(&visitor, "lobby", "Lobby"), T)
        .await
        .unwrap();
    assert!(ok, "open relay create: {msg}");
    let (ok, msg) = client
        .publish(&chat(&visitor, "lobby", "hi"), T)
        .await
        .unwrap();
    assert!(ok, "open relay chat: {msg}");
}

#[tokio::test]
async fn admin_moderation_and_membership() {
    let operator = Keys::generate();
    let (_handle, st, url) = start_relay("mod", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general", "General"), T)
        .await
        .unwrap();

    let member = Keys::generate();
    st.db.whitelist_add(&member.pk_hex, "test").unwrap();
    let mut mem = Client::connect(&url, None).await.unwrap();
    mem.auth(&member, T).await.unwrap();

    // Non-admins cannot moderate.
    let kick = Event::sign(
        EventTemplate {
            kind: kinds::REMOVE_USER,
            tags: vec![
                vec!["h".into(), "general".into()],
                vec!["p".into(), operator.pk_hex.clone()],
            ],
            content: String::new(),
            created_at: None,
        },
        &member,
    )
    .unwrap();
    let (ok, msg) = mem.publish(&kick, T).await.unwrap();
    assert!(!ok);
    assert!(msg.contains("admins only"), "got: {msg}");

    // Joining updates the relay-signed member list.
    let join = Event::sign(
        EventTemplate {
            kind: kinds::JOIN_REQUEST,
            tags: vec![vec!["h".into(), "general".into()]],
            content: String::new(),
            created_at: None,
        },
        &member,
    )
    .unwrap();
    let (ok, _) = mem.publish(&join, T).await.unwrap();
    assert!(ok);
    let members = mem
        .req_collect(
            vec![Filter::new()
                .kinds(vec![kinds::GROUP_MEMBERS])
                .tag("d", vec!["general".into()])],
            T,
        )
        .await
        .unwrap();
    assert_eq!(
        members.len(),
        1,
        "member list is addressable — exactly one survives"
    );
    assert!(members[0].tag_values("p").contains(&member.pk_hex.as_str()));
}
