# arti-probe

Drives the same embedded-Tor path the mobile app uses, on a host where the
errors are actually visible.

```bash
cargo run --release -- <address>.onion [port]
```

It prints every bootstrap status change with a timestamp, connects to the
onion service, and sends a WebSocket upgrade so you can see bytes move end to
end. A healthy run against a Menhir relay ends with:

```
[  18.7s] BOOTSTRAPPED
[  22.0s] CONNECTED to the onion service
[  22.1s] relay replied: HTTP/1.1 101 Switching Protocols
[  22.1s] PROBE PASSED — websocket upgrade over Tor
```

## Why this exists

The Android app once hung forever on "connecting through Tor…" with no error.
The cause was a rustls panic (`Could not automatically determine the
process-level CryptoProvider`) inside a Tauri command — and a panicked command
never resolves its promise, so the UI showed a spinner rather than a failure.
On a phone there was nothing to inspect.

Running the identical sequence on a host surfaced the panic in one line.

Reach for this whenever onion connectivity misbehaves on mobile: if the probe
passes, the Tor path is sound and the problem is in the app layer (the bridge,
the webview, permissions); if it fails, you have the real error with a stack.

## Notes

- It is a standalone workspace on purpose, so it can never be linked into the
  shipped app.
- `RUST_LOG=debug` turns on arti's own tracing.
- State lives in `$TMPDIR/arti-probe`; delete it to force a cold bootstrap,
  which is what a first run on a phone looks like.
