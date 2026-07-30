#!/usr/bin/env bash
# Build the Obelisk Menhir desktop app + CLI tools.
#
#   ./scripts/build-desktop.sh          # app bundle (.dmg / .deb / .AppImage / .msi) + binaries
#   ./scripts/build-desktop.sh --cli    # just the menhir + menhir-relay binaries
#
# macOS: needs Xcode command line tools, Rust, and Node.
#   xcode-select --install
#   brew install rust node
#   brew install tor       # optional but needed to host through Tor
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> building CLI + relay (release)"
cargo build --release --bins
echo
echo "binaries:"
for b in menhir menhir-relay; do
  path="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import sys,json;print(json.load(sys.stdin)["target_directory"])')/release/$b"
  [[ -f "$path" ]] && ls -lh "$path"
done

if [[ "${1:-}" == "--cli" ]]; then
  echo
  echo "done — copy the two binaries above onto your PATH."
  exit 0
fi

echo
echo "==> building frontend"
(cd app/ui && npm install --no-audit --no-fund && npm run build)

echo
echo "==> building desktop app"
command -v cargo-tauri >/dev/null 2>&1 || cargo install tauri-cli --version '^2' --locked
(cd app/src-tauri && cargo tauri build)

echo
echo "bundles:"
find app/src-tauri/target/release/bundle -maxdepth 2 -type f \
  \( -name '*.dmg' -o -name '*.app' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.msi' -o -name '*.exe' \) \
  -exec ls -lh {} \; 2>/dev/null || true
