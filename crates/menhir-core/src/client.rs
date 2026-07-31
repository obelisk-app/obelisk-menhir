//! Minimal Nostr relay client (feature `client`).
//!
//! Speaks the NIP-01 wire protocol over tokio-tungstenite, understands the
//! NIP-42 AUTH flow and Menhir invite redemption, and can dial `.onion`
//! relays through a SOCKS5 proxy (Tor).

use std::collections::VecDeque;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

use crate::event::{Event, EventTemplate};
use crate::filter::Filter;
use crate::keys::Keys;
use crate::kinds;

pub struct Client {
    url: String,
    out_tx: mpsc::UnboundedSender<String>,
    in_rx: mpsc::UnboundedReceiver<Value>,
    pending: VecDeque<Value>,
    pub auth_challenge: Option<String>,
}

/// Parse `ws://host:port/path` / `wss://host/path` into (tls, host, port).
pub fn parse_ws_url(url: &str) -> Result<(bool, String, u16)> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        (false, r)
    } else {
        bail!("relay url must start with ws:// or wss://");
    };
    let hostport = rest.split('/').next().unwrap_or_default();
    if hostport.is_empty() {
        bail!("relay url has no host");
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().context("invalid port")?),
        None => (hostport.to_string(), if tls { 443 } else { 80 }),
    };
    Ok((tls, host, port))
}

fn spawn_ws_task<S>(
    mut ws: WebSocketStream<S>,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    in_tx: mpsc::UnboundedSender<Value>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            tokio::select! {
                m = out_rx.recv() => match m {
                    Some(txt) => {
                        if ws.send(WsMessage::Text(txt)).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = ws.close(None).await;
                        break;
                    }
                },
                m = ws.next() => match m {
                    Some(Ok(WsMessage::Text(txt))) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                            if in_tx.send(v).is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = ws.send(WsMessage::Pong(data)).await;
                    }
                    Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    });
}

/// Install a rustls crypto provider exactly once.
///
/// rustls 0.23 will not choose between backends when several are present in
/// the dependency graph — it panics the first time TLS is used. That turns a
/// `wss://` connection into a crash rather than an error, so pick one up front.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

impl Client {
    /// Connect to a relay. If `socks5_proxy` is given (e.g. `127.0.0.1:9050`),
    /// the TCP connection is dialed through it — required for `.onion` relays.
    pub async fn connect(url: &str, socks5_proxy: Option<&str>) -> Result<Client> {
        ensure_crypto_provider();
        let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<Value>();

        match socks5_proxy {
            None => {
                let (ws, _) = tokio_tungstenite::connect_async(url)
                    .await
                    .with_context(|| format!("connecting to {url}"))?;
                spawn_ws_task(ws, out_rx, in_tx);
            }
            Some(proxy) => {
                let (_tls, host, port) = parse_ws_url(url)?;
                let stream = tokio_socks::tcp::Socks5Stream::connect(proxy, (host.as_str(), port))
                    .await
                    .with_context(|| format!("SOCKS5 connect via {proxy} to {host}:{port}"))?;
                let (ws, _) = tokio_tungstenite::client_async_tls(url, stream)
                    .await
                    .with_context(|| format!("websocket handshake with {url}"))?;
                spawn_ws_task(ws, out_rx, in_tx);
            }
        }

        Ok(Client {
            url: url.to_string(),
            out_tx,
            in_rx,
            pending: VecDeque::new(),
            auth_challenge: None,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn send_json(&self, v: &Value) {
        let _ = self.out_tx.send(v.to_string());
    }

    /// Put a message back so the next `recv()` returns it first.
    pub fn push_pending(&mut self, v: Value) {
        self.pending.push_back(v);
    }

    fn note_message(&mut self, v: &Value) {
        if v.get(0).and_then(Value::as_str) == Some("AUTH") {
            if let Some(ch) = v.get(1).and_then(Value::as_str) {
                self.auth_challenge = Some(ch.to_string());
            }
        }
    }

    /// Next relay message (pending stash first), or `None` on timeout/close.
    pub async fn recv(&mut self, timeout: Duration) -> Option<Value> {
        if let Some(v) = self.pending.pop_front() {
            return Some(v);
        }
        match tokio::time::timeout(timeout, self.in_rx.recv()).await {
            Ok(Some(v)) => {
                self.note_message(&v);
                Some(v)
            }
            _ => None,
        }
    }

    /// Publish an event and wait for its OK. Non-matching messages are stashed.
    pub async fn publish(&mut self, ev: &Event, timeout: Duration) -> Result<(bool, String)> {
        self.send_json(&json!(["EVENT", ev]));
        let deadline = tokio::time::Instant::now() + timeout;
        let mut stash = VecDeque::new();
        let result = loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for OK from {}", self.url);
            }
            let Some(v) = self.recv(remaining).await else {
                bail!("relay closed while waiting for OK");
            };
            if v.get(0).and_then(Value::as_str) == Some("OK")
                && v.get(1).and_then(Value::as_str) == Some(ev.id.as_str())
            {
                let accepted = v.get(2).and_then(Value::as_bool).unwrap_or(false);
                let msg = v.get(3).and_then(Value::as_str).unwrap_or("").to_string();
                break (accepted, msg);
            }
            stash.push_back(v);
        };
        while let Some(v) = stash.pop_front() {
            self.pending.push_back(v);
        }
        Ok(result)
    }

    /// Wait for the relay's AUTH challenge (it is sent right after connect
    /// on whitelisted relays), then perform NIP-42 authentication.
    pub async fn auth(&mut self, keys: &Keys, timeout: Duration) -> Result<(bool, String)> {
        let deadline = tokio::time::Instant::now() + timeout;
        while self.auth_challenge.is_none() {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("relay sent no AUTH challenge (it may be an open relay)");
            }
            let Some(v) = self.recv(remaining).await else {
                bail!("relay closed before AUTH challenge");
            };
            if v.get(0).and_then(Value::as_str) != Some("AUTH") {
                self.pending.push_back(v);
            }
        }
        let challenge = self.auth_challenge.clone().unwrap();
        let ev = Event::sign(
            EventTemplate {
                kind: kinds::CLIENT_AUTH,
                tags: vec![
                    vec!["relay".into(), self.url.clone()],
                    vec!["challenge".into(), challenge],
                ],
                content: String::new(),
                created_at: None,
            },
            keys,
        )?;
        self.send_json(&json!(["AUTH", ev]));
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for AUTH result");
            }
            let Some(v) = self.recv(remaining).await else {
                bail!("relay closed during AUTH");
            };
            if v.get(0).and_then(Value::as_str) == Some("OK")
                && v.get(1).and_then(Value::as_str) == Some(ev.id.as_str())
            {
                let accepted = v.get(2).and_then(Value::as_bool).unwrap_or(false);
                let msg = v.get(3).and_then(Value::as_str).unwrap_or("").to_string();
                return Ok((accepted, msg));
            }
            self.pending.push_back(v);
        }
    }

    /// Redeem a Menhir invite code (signed ephemeral event, kind 20284).
    pub async fn redeem_invite(
        &mut self,
        keys: &Keys,
        code: &str,
        timeout: Duration,
    ) -> Result<(bool, String)> {
        let ev = Event::sign(
            EventTemplate {
                kind: kinds::INVITE_REDEEM,
                tags: vec![],
                content: code.trim().to_string(),
                created_at: None,
            },
            keys,
        )?;
        self.publish(&ev, timeout).await
    }

    /// Open a subscription and collect events until EOSE, then CLOSE it.
    pub async fn req_collect(
        &mut self,
        filters: Vec<Filter>,
        timeout: Duration,
    ) -> Result<Vec<Event>> {
        let sub = format!("m{}", rand::random::<u32>());
        let mut req = vec![json!("REQ"), json!(sub)];
        for f in &filters {
            req.push(serde_json::to_value(f)?);
        }
        self.send_json(&Value::Array(req));

        let mut events = Vec::new();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for EOSE");
            }
            let Some(v) = self.recv(remaining).await else {
                bail!("relay closed during REQ");
            };
            match v.get(0).and_then(Value::as_str) {
                Some("EVENT") if v.get(1).and_then(Value::as_str) == Some(sub.as_str()) => {
                    if let Some(raw) = v.get(2) {
                        if let Ok(ev) = serde_json::from_value::<Event>(raw.clone()) {
                            events.push(ev);
                        }
                    }
                }
                Some("EOSE") if v.get(1).and_then(Value::as_str) == Some(sub.as_str()) => break,
                Some("CLOSED") if v.get(1).and_then(Value::as_str) == Some(sub.as_str()) => {
                    let msg = v.get(2).and_then(Value::as_str).unwrap_or("");
                    bail!("subscription closed by relay: {msg}");
                }
                _ => self.pending.push_back(v),
            }
        }
        self.send_json(&json!(["CLOSE", sub]));
        events.sort_by_key(|e| e.created_at);
        Ok(events)
    }

    /// Open a live subscription and return its id; consume events via `recv()`.
    pub fn req_stream(&mut self, filters: Vec<Filter>) -> Result<String> {
        let sub = format!("m{}", rand::random::<u32>());
        let mut req = vec![json!("REQ"), json!(sub)];
        for f in &filters {
            req.push(serde_json::to_value(f)?);
        }
        self.send_json(&Value::Array(req));
        Ok(sub)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ws_urls() {
        assert_eq!(
            parse_ws_url("ws://127.0.0.1:4869").unwrap(),
            (false, "127.0.0.1".into(), 4869)
        );
        assert_eq!(
            parse_ws_url("ws://abc.onion/path").unwrap(),
            (false, "abc.onion".into(), 80)
        );
        assert_eq!(
            parse_ws_url("wss://relay.obelisk.ar").unwrap(),
            (true, "relay.obelisk.ar".into(), 443)
        );
        assert!(parse_ws_url("http://x").is_err());
    }
}
