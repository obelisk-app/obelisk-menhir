# Obelisk Menhir

**Sovereign text channels over Nostr — host a private chat server from your own computer, published through Tor, with one click.**

A *menhir* is a single standing stone. Every Menhir user can plant their own: the app is both a chat client and an optional server. No domain, no TLS certificate, no public IP, no port forwarding, no Docker.

This is the MVP implementation of the [Obelisk Desktop Tor Node spec](docs/tor-desktop-node.md) — text channels only: no media, no formatting, no voice. Identity comes from Nostr keypairs (no emails, no passwords).

<p>
  <a href="https://github.com/obelisk-app/obelisk-menhir/releases"><img src="https://img.shields.io/github/v/release/obelisk-app/obelisk-menhir?style=flat&color=b4f953&labelColor=0a0a0a" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/obelisk-app/obelisk-menhir?style=flat&color=b4f953&labelColor=0a0a0a" alt="License" /></a>
</p>

## What's in the box

| Piece | What it is |
|---|---|
| **Obelisk Menhir app** (`app/`) | Tauri 2 desktop + Android app. Chat client on every platform; on desktop it also embeds the relay and manages Tor (the *node manager*). |
| **`menhir-relay`** (`crates/menhir-relay/`) | Standalone text-only NIP-29-lite Nostr relay: NIP-42 auth, npub whitelist, invite codes, SQLite storage; loopback by default, reachable over a Tor onion service, a LAN, or your own domain behind TLS. Concepts borrowed from [obelisk-relay](https://github.com/obelisk-app/obelisk-relay), rebuilt small. |
| **`menhir`** (`crates/menhir-cli/`) | Terminal client + relay admin, built for AI agents and operators: `--json` output everywhere, keys via env vars, `.onion` support through SOCKS5. |
| **`menhir-core`** (`crates/menhir-core/`) | Shared Nostr protocol core: events, schnorr signatures, NIP-19, filters, relay client. |

## The 5-minute tour

### Host a server (desktop app)

1. Install Tor once: `brew install tor` (macOS) / `apt install tor` (Linux). Only needed for the onion route — a network-only server does not require it, and the app tells you which you are missing.
2. Open Obelisk Menhir, log in (extension, remote signer, nsec, or a fresh key).
3. Press **⌂ Host a server**, choose how to be reachable (Tor, your network, or both) → **Start hosting**.
4. Tor bootstraps and shows your permanent onion address.
5. Press **Create invite** (pick how many uses and when it expires) → **Show QR**, and let a friend scan it.
6. Keep the app running — your computer *is* the server. Opening the app again starts it back up on its own; **Stop hosting** is what takes it down for good.

Your friend scans the QR (or pastes the `obelisk://join?relay=ws://…onion&invite=CODE` link into **+ Add a server**) and is whitelisted automatically on redemption. The onion address and all data persist across restarts — back up the app data directory, it holds the relay database and the onion key.

### Channels

Two kinds, chosen when you create one and changeable later by an admin:

| | Who may post | For |
|---|---|---|
| **Chat** | everyone the server admits | ordinary conversation |
| **Publication** | admins start a post; everyone may reply to one | announcements, releases, a notice board with discussion under each item |

The rule is enforced by the relay, not just hidden in the UI: a top-level
message in a publication channel from a non-admin is refused, and a "reply"
must point at a message that really is in that channel.

Replies work in both (they carry a NIP-10 `["e", <id>, "", "reply"]` tag, the
same shape obelisk publishes). In a chat channel a reply shows the line it
answers; in a publication channel replies gather under their post.

### Joining someone else's server

**+ Add a server** takes an invite QR, an `obelisk://join` link, or a plain
address — an onion, a machine on your network (`192.168.1.20:4869`), or a
relay on the open internet (`wss://relay.example.com`). An address with no
scheme is dialled over TLS unless it is a private one, where there is no
certificate to be had.

### Logging in

| Method | Where the key lives |
|---|---|
| **Browser extension** (NIP-07) | in the extension — never reaches Menhir |
| **Remote signer** (NIP-46) | in a bunker (Amber, nsec.app…). Scan the QR or paste a `bunker://` URI |
| **Secret key** | on this device, in local storage |
| **Create a new identity** | generated locally; you are shown the nsec once |

`bunker://` sessions resume after a restart. A QR (`nostrconnect://`) session does not — it has no address to dial back out to, so you reconnect by scanning again.

### Run the relay headless (servers, Raspberry Pi, …)

```bash
menhir-relay serve --name "My Menhir" --operator npub1… --tor
# relay:   ws://127.0.0.1:4869
# onion:   ws://abc…xyz.onion
# share:   obelisk://join?relay=ws://abc…xyz.onion
menhir-relay invite create --max-uses 5 --expires-hours 48
menhir-relay whitelist add npub1…
menhir-relay info
```

By default the relay listens on loopback only and Tor is the public ingress.
Add `--clearnet` to also bind every interface — for a LAN, or behind a reverse
proxy terminating TLS for your own domain. The three routes coexist; the invite
link carries whichever address you share.

### Terminal client (humans and AI agents)

```bash
menhir keygen --json
export MENHIR_NSEC=nsec1…
export MENHIR_RELAY=ws://127.0.0.1:4869

menhir redeem --code CODE            # or: menhir join-link "obelisk://join?relay=…&invite=…"
menhir channels --json
menhir create-channel --id general --name "General"
menhir send --channel general --message "gm"
menhir history --channel general --limit 50 --json
menhir listen --channel general --json   # NDJSON stream, one message per line

# .onion relays via any Tor SOCKS proxy:
menhir channels --relay ws://abc…xyz.onion --socks5 127.0.0.1:9050

# local admin (same commands as menhir-relay):
menhir admin info --json
menhir admin invite-create --max-uses 1
menhir admin whitelist-add npub1…
```

Every read command takes `--json`; streams emit NDJSON — pipe straight into an agent. See [docs/AGENTS.md](docs/AGENTS.md) for the full agent-facing contract, including a watch-and-reply loop.

## Building from source

```bash
# Relay + CLI (any platform with Rust)
cargo build --release                    # target/release/menhir, target/release/menhir-relay
cargo test                               # full suite must be green

# Desktop app
cd app/ui && npm install && npm run build
cd ../src-tauri && cargo tauri build     # or `cargo tauri dev`

# Android (client-only build)
cd app/src-tauri && cargo tauri android build --apk --target aarch64
```

macOS note: install prerequisites with `brew install rust node` plus Xcode command-line tools, then the desktop build commands above produce the `.app`/`.dmg`.

## How it works

```
┌────────────────────────── Obelisk Menhir (desktop) ─────────────────────────┐
│  webview UI (vanilla JS + nostr-tools)                                      │
│    │  plain WebSocket (NIP-01)                                              │
│    ├──────────────► ws://127.0.0.1:4869  embedded menhir-relay (SQLite)     │
│    │                        ▲                                               │
│    │                        │ HiddenServicePort 80 → 127.0.0.1:4869         │
│    │                 managed tor ── your-address.onion  ◄─── friends        │
│    └── bridge_open ► 127.0.0.1:<p> ── SOCKS5 ── friend's-address.onion      │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Access control**: the onion address locates the server; the relay authorizes. NIP-42 AUTH + npub whitelist; invites are signed redemption events (kind 20284) that consume a code and whitelist the key.
- **Channels**: NIP-29 subset. Clients send kind 9 chat (`h` tag), kind 9007 create, 9021/9022 join/leave, 9000-9002/9008 moderation; the relay answers with relay-signed 39000/39001/39002 metadata, carrying the channel type as a `t` tag. See [docs/PROTOCOL.md](docs/PROTOCOL.md).
- **Text only**: the relay rejects every other kind and caps content at 4 KB. No media, no formatting — rendered as plain text. Emoji are text, so the picker costs nothing extra and needs no host to fetch images from.
- **Server isolation**: the client binds one relay at a time; events from different servers never mix.
- **Tor everywhere**: desktop drives the system `tor` and publishes your onion service; Android embeds [arti](https://gitlab.torproject.org/tpo/core/arti) (Tor in Rust) in-process, so onion servers work on a phone with nothing to install. Either way a loopback bridge fronts it, so the webview dials `.onion` like any other host.

## Where this is going

[ROADMAP.md](ROADMAP.md) — what the MVP still needs, and the order features are
being ported from [obelisk](https://github.com/obelisk-app/obelisk), with the
reasoning for what does and does not transfer to a Tor-hosted server.

## Repo layout

```
crates/menhir-core/    protocol core (events, keys, filters, ws client)
crates/menhir-relay/   the relay (lib + `menhir-relay` binary)
crates/menhir-cli/     the `menhir` terminal client / admin
app/ui/                webview UI (vanilla JS + nostr-tools, esbuild)
app/src-tauri/         Tauri shell: node manager (desktop), pure client (Android)
docs/                  spec, protocol, notes
```

## MVP limitations (deliberate)

- A pasted nsec is stored in the webview's localStorage (and `MENHIR_NSEC` for the CLI). Use a remote signer or an extension if that bothers you; a keychain integration comes later.
- Tor is used from the system, not bundled. Production installers should bundle it (see spec §Desktop packaging).
- No media, no formatting, no DMs, no voice, no reactions — text channels only. Replies and Unicode emoji are in; both are just text on the wire.
- Groups are open inside a whitelisted relay; fine-grained private groups come later.
- Android is a client: it reaches `.onion` servers fine (Tor is embedded — see below), but hosting stays desktop-only, since Android kills long-running services and arti cannot publish an onion service yet.

## Testing

```bash
cargo test                      # 26 tests: protocol units + relay integration over real websockets
npm --prefix app/ui test        # 31 checks: boots the built UI in jsdom and asserts the wiring
npm --prefix app/ui run test:live  # 17 checks: the built UI against a real relay, over a real socket
./scripts/demo.sh               # end-to-end: relay, channel, whitelist refusal, invite, history
```

The relay suite covers the security rules specifically — invite single-use, cross-channel smuggling, replayed moderation, auth replay, hex aliasing, channel-id recycling, and who may post in a publication channel. See [docs/PROTOCOL.md](docs/PROTOCOL.md) § *Rules that exist because they were attacks*.

`test:live` starts a relay on an ephemeral port and drives the real UI through
it: creating both channel types, sending, replying, and confirming that a
non-admin cannot open a post in a publication channel but can answer one. It
needs `cargo build -p menhir-relay -p menhir-cli` first.

## The Obelisk family

| Repo | What |
|---|---|
| [obelisk-app/obelisk](https://github.com/obelisk-app/obelisk) | The full-featured web chat app |
| [obelisk-app/obelisk-relay](https://github.com/obelisk-app/obelisk-relay) | Production NIP-29 relay |
| **obelisk-app/obelisk-menhir** | This repo — self-hosted desktop node + text-only MVP stack |
| [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) | Voice/video SFU |

## License

MIT
