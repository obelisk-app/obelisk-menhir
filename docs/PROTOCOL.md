# Menhir wire protocol

Menhir speaks standard Nostr (NIP-01) over WebSocket, restricted to a
text-channel subset of NIP-29, plus one custom event kind for invites.
Everything below is enforced server-side by `menhir-relay`.

## Accepted event kinds

| Kind | Direction | Meaning |
|---|---|---|
| 0 | client → relay | Profile metadata (name shown in chat) |
| 9 | client → relay | Plain-text chat message. Requires `["h", "<channel-id>"]`. Optional `["e", <id>, "", "reply"]` + `["p", <author>]` to reply |
| 9000 | client → relay | Put user (admin only): `["p", <pubkey>, <role?>]` tags |
| 9001 | client → relay | Remove user (admin only) |
| 9002 | client → relay | Edit channel metadata (admin only): `name` / `about` / `t` tags |
| 9007 | client → relay | Create channel: `["h", id]` (+ optional `name`, `about`, `t`) |
| 9008 | client → relay | Delete channel (admin only) — purges its events |
| 9021 / 9022 | client → relay | Join / leave a channel |
| 22242 | client → relay | NIP-42 auth (via `AUTH` verb, `EVENT` also tolerated) |
| 20284 | client → relay | **Menhir invite redemption** (ephemeral, custom): `content` = invite code |
| 39000 | relay → client | Channel metadata (`d` = channel id, `name`, `about`, `t` = channel type, signed by the relay key) |
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

## Rules that exist because they were attacks

Each of these closes a hole found by auditing the relay, and each has a
regression test in `crates/menhir-relay/tests/relay_integration.rs`.

**Hex must be lowercase.** `id`, `pubkey`, and `sig` are rejected unless they
are canonical lowercase hex. Hex decoding is case-insensitive, so one key
otherwise has many spellings that all verify — and since SQLite compares TEXT
bytewise, a pubkey whitelisted under one spelling is invisible to a revocation
issued in another. That made banning a silent no-op while the ban *looked*
applied, because the whitelist listing re-encodes to the same npub.

**One channel per event.** An event may carry at most one `h` tag, and clients
may not send `d` tags at all. Authorization reads a single `h`, but the tag
index stores every one — so a second `h` let a message authorized against a
channel you own be delivered to subscribers of a channel you don't.

**Replays never re-run side effects.** A known event id is refused before any
membership table is touched. Otherwise re-sending a byte-identical join event
silently re-added a member an admin had just kicked.

**Deleted channel ids are retired forever.** Creating a channel makes you its
admin, so a recycled id would hand the name an admin just purged to whoever
asked next — along with the ability to re-publish the purged events, whose
signatures are still valid.

**Auth is bound to the endpoint.** The NIP-42 `relay` tag must name the host
the connection was dialled on (compared against the `Host` header). Without
it, a relay you visit can forward its own challenge, collect your signed
reply, and replay it to a third relay to open a session as you.

**Storage is transactional and ties break by id.** Replacement (delete-then-
insert) runs in one transaction, so a failure cannot leave a profile simply
gone. On an equal `created_at`, the lowest id wins, per NIP-01, so replicas
converge. Relay-generated channel metadata is stamped strictly newer than the
last version instead, since membership can change several times in a second.

**A reply must name a post in the same channel.** In a publication channel
the reply marker is what lets a non-admin write at all, so an `e` tag
pointing at an unknown id — or at a message in another channel — is refused
rather than treated as a reply. Otherwise "reply to anything" would be the
same as "post".

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

## Channel types

A channel carries a type on the `t` tag: `chat` (the default, and what an
absent tag means) or `publication`. Clients set it on 9007 when creating a
channel and on 9002 to change it; the relay stores it and republishes it on
the 39000 metadata, on the same tag [obelisk](https://github.com/obelisk-app/obelisk)
uses — so a client that has never heard of channel types simply sees an
ordinary channel. Any other value collapses to `chat`, so an invented type
cannot produce a channel with rules nobody implements.

In a `publication` channel, a kind 9 with no reply marker is accepted only
from a channel admin (or the operator). Everyone else must reply:

```json
{ "kind": 9, "tags": [["h", "notices"], ["e", "<post-id>", "", "reply"], ["p", "<author>"]], … }
```

and the relay checks that `<post-id>` is an event it holds carrying
`["h", "notices"]`. Without that check "reply" would be a hole straight
through the rule: any string in an `e` tag would turn a top-level post into
a permitted one. Only the NIP-10 **marked** form counts — an unmarked or
`root` `e` tag denotes thread membership, not a reply.

Replies are accepted in `chat` channels too; there they are ordinary
messages that happen to name what they answer.

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
