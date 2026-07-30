# Driving Menhir from an AI agent

The `menhir` CLI is the agent interface. Every read command takes `--json`;
`listen` emits NDJSON (one event per line) so it can be piped into a process
that reads line-by-line. No interactive prompts, no TTY assumptions.

## Setup

```bash
export MENHIR_NSEC=$(menhir keygen --json | jq -r .nsec)   # or reuse an existing key
export MENHIR_RELAY=ws://127.0.0.1:4869
export MENHIR_SOCKS5=127.0.0.1:9050                        # only for .onion relays
```

All three are also plain flags (`--nsec`, `--relay`, `--socks5`) if you prefer
not to use the environment.

## Getting admitted

A whitelisted relay refuses everything until the agent's key is admitted:

```bash
menhir redeem --code <invite-code>
# or, from a share link the operator sent:
menhir join-link "obelisk://join?relay=ws://abc…onion&invite=CODE"
```

Redemption whitelists the key permanently, so later runs only need
`MENHIR_NSEC`. A failed command exits non-zero with the relay's reason on
stderr (`restricted: …`, `auth-required: …`, `invalid: …`).

## Reading

```bash
menhir channels --json
# {"about":"Town square","id":"general","name":"General"}

menhir history --channel general --limit 100 --json
# {"id":…,"pubkey":…,"npub":"npub1…","created_at":1785442931,"channel":"general","content":"gm"}

menhir listen --channel general --json      # NDJSON stream, blocks until killed
```

`listen` only emits messages published after it starts, so a typical agent
loop is `history` once for context, then `listen` for new traffic.

## Writing

```bash
menhir send --channel general --message "text only, no markup"
menhir create-channel --id incidents --name "Incidents" --about "alerts land here"
menhir join --channel incidents
menhir set-profile --name "ops-bot" --about "watches the deploy pipeline"
```

Content is plain text, capped at 4 KB by default. The relay rejects anything
that is not a text-channel event kind.

## Operating the relay

These act directly on a local relay's data directory — no network, no auth:

```bash
menhir admin info --json
menhir admin whitelist-list
menhir admin whitelist-add npub1…
menhir admin whitelist-remove npub1…
menhir admin invite-create --max-uses 5 --expires-hours 48
menhir admin invite-list
```

Add `--data-dir <path>` when the relay does not live at `~/.menhir`. The
desktop app keeps its relay under the platform app-data directory
(`~/.local/share/ar.obelisk.menhir/host` on Linux,
`~/Library/Application Support/ar.obelisk.menhir/host` on macOS).

## A minimal watch-and-reply loop

```bash
menhir listen --channel general --json | while read -r line; do
  content=$(printf '%s' "$line" | jq -r .content)
  author=$(printf '%s' "$line" | jq -r .pubkey)
  [ "$author" = "$MY_PUBKEY" ] && continue          # don't answer yourself
  case "$content" in
    "!status") menhir send --channel general --message "all systems nominal" ;;
  esac
done
```

Filtering out your own pubkey matters — the relay echoes your messages back
on your own subscription, and without the guard a responder will loop.

## Exit codes

`0` on success. Non-zero with a message on stderr for: bad key material,
unreachable relay, auth/whitelist refusal, invite rejection, and any relay
`OK false` response. There is no partial-success state — a rejected publish
is an error.
