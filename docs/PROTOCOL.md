# Menhir wire protocol

Menhir speaks standard Nostr (NIP-01) over WebSocket, restricted to a
text-channel subset of NIP-29, plus one custom event kind for invites.
Everything below is enforced server-side by `menhir-relay`.

## Accepted event kinds

| Kind | Direction | Meaning |
|---|---|---|
| 0 | client → relay | Profile metadata (name shown in chat) |
| 9 | client → relay | Plain-text chat message. Requires `["h", "<channel-id>"]` |
| 9000 | client → relay | Put user (admin only): `["p", <pubkey>, <role?>]` tags |
| 9001 | client → relay | Remove user (admin only) |
| 9002 | client → relay | Edit channel metadata (admin only): `name` / `about` tags |
| 9007 | client → relay | Create channel: `["h", id]` (+ optional `name`, `about`) |
| 9008 | client → relay | Delete channel (admin only) — purges its events |
| 9021 / 9022 | client → relay | Join / leave a channel |
| 22242 | client → relay | NIP-42 auth (via `AUTH` verb, `EVENT` also tolerated) |
| 20284 | client → relay | **Menhir invite redemption** (ephemeral, custom): `content` = invite code |
| 39000 | relay → client | Channel metadata (`d` = channel id, `name`, `about`, signed by the relay key) |
| 39001 | relay → client | Channel admins (`d` + `["p", pk, role]`) |
| 39002 | relay → client | Channel members (`d` + `["p", pk]`) |

Everything else is rejected with `restricted: this relay accepts text-channel
events only`. Content is capped (default 4096 bytes). `created_at` may be at
most 15 minutes in the future.

Tags are bounded too, because each indexed tag becomes a stored row and the
content cap alone would not stop a small message carrying tens of thousands
of them: at most **100 tags** per event, each item at most **1024 bytes**.
Both limits are checked before signature verification and before the
authentication branches, so refusing costs the relay almost nothing and an
unauthenticated peer cannot use the path either.

## Channel ids

`h`/`d` values are 1–64 characters of `a-z 0-9 - _`. Chat into a channel that
was never created with kind 9007 is rejected (`invalid: unknown channel`).

## Access control

Two relay modes:

- **open** — no auth; anyone may read and write.
- **whitelist** (default) — the relay sends `["AUTH", <challenge>]` on
  connect. Until a connection is authenticated, `REQ` gets
  `CLOSED … auth-required:` and `EVENT` gets `OK false auth-required:` —
  with two exceptions: kind 22242 (auth itself) and kind 20284 (invite
  redemption).

Authentication passes when the NIP-42 event is valid, fresh (±10 min),
matches the connection's challenge, and the pubkey is whitelisted (the
configured operator pubkey is always allowed and is admin in every channel).

### Invites

An invite code is created by the operator (CLI: `menhir-relay invite create`,
app: Host panel). Redemption is a **signed ephemeral event**:

```json
{ "kind": 20284, "content": "<code>", "tags": [], … }
```

sent before authentication. If the signature verifies, the event is fresh
(±10 min), and the code is valid (not expired, uses remaining), the relay:

1. adds the event's pubkey to the whitelist permanently,
2. marks the current connection authenticated,
3. consumes one use of the code,
4. answers `OK true "invite accepted — welcome"`.

### Invite links

```
obelisk://join?relay=ws://<address>&invite=<code>
```

`relay` is required; `invite` is optional (without it the client just
authenticates and hopes to be whitelisted already).

## Group membership semantics (MVP)

- The whitelist is the boundary; channels inside a relay are open.
- Creating a channel (9007) makes the author its admin.
- Joining (9021) — or simply posting — adds you to the member list.
- Moderation events (9000/9001/9002/9008) require channel admin or operator.
- After every membership/metadata change the relay re-publishes the
  addressable 39000/39001/39002 trio signed with the **relay key**
  (newest-wins replacement).

## NIP-11

A plain HTTP GET on the relay URL returns the NIP-11 info document
(`supported_nips: [1, 11, 29, 42]`, `limitation.auth_required`, the relay
pubkey, software + version), CORS-open.

## Transport & Tor

The relay binds to loopback only. The desktop app (or `menhir-relay serve
--tor`) publishes it as a Tor hidden service (`HiddenServicePort 80 →
127.0.0.1:<port>`), so remote clients speak `ws://<addr>.onion` through a
SOCKS5 proxy. The onion key in `<data-dir>/tor/hs/` **is** the server's
address — back it up; losing it changes the address.
