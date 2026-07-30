#!/usr/bin/env bash
# End-to-end demo of the Menhir stack, no GUI required.
# Starts a relay in a temp dir, creates a channel, proves the whitelist blocks
# a stranger, invites them in, and prints the resulting history.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_DIR="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import sys,json;print(json.load(sys.stdin)["target_directory"])')"
BIN="$TARGET_DIR/debug"
PORT="${MENHIR_DEMO_PORT:-14869}"
WORK="$(mktemp -d)"
trap 'kill %1 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "==> building"
cargo build -q -p menhir-cli -p menhir-relay

echo "==> generating the operator key"
"$BIN/menhir" keygen --json > "$WORK/op.json"
OP_NSEC=$(python3 -c "import json;print(json.load(open('$WORK/op.json'))['nsec'])")
OP_NPUB=$(python3 -c "import json;print(json.load(open('$WORK/op.json'))['npub'])")
echo "operator: $OP_NPUB"

echo "==> starting the relay on 127.0.0.1:$PORT"
"$BIN/menhir-relay" --data-dir "$WORK/relay" serve --port "$PORT" --name "Demo Menhir" --operator "$OP_NPUB" &
sleep 2

export MENHIR_RELAY="ws://127.0.0.1:$PORT"

echo "==> operator creates #general and posts"
"$BIN/menhir" create-channel --nsec "$OP_NSEC" --id general --name "General" --about "Town square"
"$BIN/menhir" send --nsec "$OP_NSEC" --channel general --message "gm from the operator"

echo "==> a stranger tries to post (should be refused)"
"$BIN/menhir" keygen --json > "$WORK/guest.json"
GUEST_NSEC=$(python3 -c "import json;print(json.load(open('$WORK/guest.json'))['nsec'])")
if "$BIN/menhir" send --nsec "$GUEST_NSEC" --channel general --message "sneak" 2>"$WORK/err.txt"; then
  echo "!! FAIL: the stranger got in"; exit 1
else
  echo "refused as expected: $(head -1 "$WORK/err.txt")"
fi

echo "==> operator issues an invite; the stranger redeems it"
CODE=$("$BIN/menhir" admin --data-dir "$WORK/relay" invite-create | head -1)
echo "invite code: $CODE"
"$BIN/menhir" redeem --nsec "$GUEST_NSEC" --code "$CODE"
"$BIN/menhir" send --nsec "$GUEST_NSEC" --channel general --message "thanks for the invite!"

echo
echo "==> channels"
"$BIN/menhir" channels --nsec "$OP_NSEC"
echo
echo "==> history"
"$BIN/menhir" history --nsec "$OP_NSEC" --channel general
echo
echo "==> relay info"
"$BIN/menhir" admin --data-dir "$WORK/relay" info

echo
echo "demo complete — the relay stops when this script exits."
