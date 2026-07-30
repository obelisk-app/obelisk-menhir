# Known limitations & next steps

Everything here is a deliberate MVP cut, not an accident. The spec this
implements is [tor-desktop-node.md](tor-desktop-node.md); the gaps below are
what separates this proof of concept from the "definition of done" there.

## Security / key handling

- **The nsec lives in `localStorage`** (webview) and in `MENHIR_NSEC` (CLI).
  Anyone with filesystem access to the profile can read it. Next: OS keychain
  via `tauri-plugin-stronghold` or platform secure storage, plus NIP-07 /
  NIP-46 signer support so the key never touches the app.
- **No relay-side rate limiting.** A whitelisted key can flood a channel. The
  whitelist is the only throttle. Next: per-pubkey token bucket in
  `handle_event`.
- **Invite codes are 12 chars from a 31-symbol alphabet** (~59 bits). Fine
  against guessing, but they travel in the share link — treat a link like a
  password.
- **The onion key is stored unencrypted** in `<data-dir>/tor/hs/`. Losing it
  changes your address; leaking it lets someone impersonate your server's
  location. The spec calls for encrypted backups — not implemented.

## Packaging

- **Tor is used from `PATH`, not bundled.** The spec requires production
  installers to ship compatible Tor binaries so a user never installs
  anything. Today the app degrades to local-only hosting with a visible
  warning when `tor` is missing.
- **Installers are unsigned.** No Apple notarization, no Windows
  Authenticode. macOS will gatekeeper-block the `.dmg` until the user
  right-click-opens it.
- **The Android APK is signed with a self-generated key** committed to
  nobody — see `scripts/build-android.sh`. Keep `menhir-release.keystore`
  safe; Play Store updates must reuse it.

## Protocol / product

- **No media, formatting, DMs, reactions, threads, or voice.** The relay
  rejects those kinds outright. Message bodies render as plain text
  (`textContent`, never `innerHTML`).
- **Channels inside a relay are open to any whitelisted member.** NIP-29
  private groups with per-group membership gating are not enforced — the
  whitelist is the boundary. Moderation kinds do check channel admin.
- **No message deletion or editing** (NIP-09 not implemented). Deleting a
  channel (kind 9008) purges its events; that is the only removal path.
- **`created_at` ordering is trusted.** A whitelisted client can backdate
  messages within the ±15 min future clamp and reorder its own history.
- **No read state, unread badges, or notifications.**

## Client behaviour

- **Reconnect is a fixed 4-second retry** with no backoff cap or jitter.
- **No pagination** — the client loads the most recent 100 messages per
  channel and live-tails from there. Older history needs a `until` filter
  that the UI does not expose yet (the CLI's `--limit` does).
- **Profile names come from a bulk kind-0 fetch** capped at 500 events. On a
  large relay some authors will show as truncated npubs.
- **Android cannot host or reach `.onion` servers.** Hosting is desktop-only
  by design; onion connections need the desktop app's Tor. An Android user
  can only join clearnet relays (`ws://`, `wss://`). Next: bundle a Tor
  library (e.g. arti) into the mobile build.
- **One relay at a time.** Switching servers tears down the connection and
  rebuilds channel state. This is intentional — it is what keeps events from
  different servers from mixing — but it means no cross-server unread view.

## Operational

- **No log rotation or diagnostic export** from the app (the spec asks for
  both). `menhir-relay serve` logs to stdout; set `RUST_LOG=debug` for detail.
- **No automatic restart with backoff** if the embedded relay dies — the spec
  calls for a bounded-backoff supervisor in the node manager. Today a crashed
  relay stays down until the user toggles hosting off and on.
- **No backup command.** Copy the whole app-data directory (it holds
  `relay.sqlite`, `relay-secret.hex`, `config.json`, and `tor/hs/`).
