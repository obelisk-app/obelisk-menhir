#!/usr/bin/env bash
# Build the Obelisk Menhir Android APK (client-only build).
#
#   ./scripts/build-android.sh            # build + sign a release APK
#   ./scripts/build-android.sh --debug    # faster, debug-signed
#
# On an arm64 Linux host the Android SDK/NDK ship x86_64 binaries only, so this
# script sets up QEMU user emulation for them (needs qemu-user-static and the
# amd64 cross libs — see setup-qemu-x86 below).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/app/src-tauri"

# ---- toolchain locations (override by exporting these before running) ----
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)}"
export JAVA_HOME="${JAVA_HOME:-$(ls -d /usr/lib/jvm/java-21-openjdk-* 2>/dev/null | head -1)}"
export PATH="$JAVA_HOME/bin:$PATH"

MODE="release"
[[ "${1:-}" == "--debug" ]] && MODE="debug"

echo "ANDROID_HOME = $ANDROID_HOME"
echo "NDK_HOME     = $NDK_HOME"
echo "JAVA_HOME    = $JAVA_HOME"
echo "mode         = $MODE"

[[ -d "$ANDROID_HOME" ]] || { echo "ERROR: Android SDK not found at $ANDROID_HOME"; exit 1; }
[[ -d "$NDK_HOME" ]]     || { echo "ERROR: Android NDK not found under $ANDROID_HOME/ndk"; exit 1; }

# ---- x86_64 emulation shim for arm64 Linux hosts ----
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "aarch64" ]]; then
  export QEMU_LD_PREFIX="${QEMU_LD_PREFIX:-/usr/x86_64-linux-gnu}"
  if ! "$ANDROID_HOME"/build-tools/*/aapt2 version >/dev/null 2>&1; then
    cat <<'SETUP'
ERROR: the x86_64 SDK tools cannot run on this arm64 host yet.

Run once as root to enable QEMU emulation:

  apt install -y qemu-user-static libc6-amd64-cross libgcc-s1-amd64-cross
  mkdir -p /lib64
  ln -sf /usr/x86_64-linux-gnu/lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
  echo /usr/x86_64-linux-gnu/lib > /etc/ld.so.conf.d/x86_64-cross.conf
  ldconfig
  # NDK clang also needs an amd64 libz:
  cd /tmp && curl -sO https://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g_1.2.8.dfsg-1ubuntu1.1_amd64.deb
  dpkg-deb -x zlib1g_*_amd64.deb zout
  cp zout/lib/x86_64-linux-gnu/libz.so.1.2.8 /usr/x86_64-linux-gnu/lib/
  ln -sf libz.so.1.2.8 /usr/x86_64-linux-gnu/lib/libz.so.1
SETUP
    exit 1
  fi
fi

# ---- rust targets ----
rustup target add aarch64-linux-android armv7-linux-androideabi >/dev/null 2>&1 || true

# ---- frontend ----
(cd "$REPO_ROOT/app/ui" && npm install --no-audit --no-fund && npm run build)

# ---- android project (idempotent) ----
[[ -d gen/android ]] || cargo tauri android init

# ---- release signing key ----
KEYSTORE="$REPO_ROOT/app/src-tauri/gen/android/menhir-release.keystore"
KEY_PROPS="$REPO_ROOT/app/src-tauri/gen/android/keystore.properties"
STORE_PASS="${MENHIR_KEYSTORE_PASS:-menhir-mvp}"

if [[ "$MODE" == "release" ]]; then
  if [[ ! -f "$KEYSTORE" ]]; then
    echo "generating a release keystore at $KEYSTORE"
    "$JAVA_HOME/bin/keytool" -genkeypair -v \
      -keystore "$KEYSTORE" -alias menhir \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass "$STORE_PASS" -keypass "$STORE_PASS" \
      -dname "CN=Obelisk Menhir, OU=Obelisk, O=Obelisk, L=Buenos Aires, C=AR"
  fi
  cat > "$KEY_PROPS" <<EOF
password=$STORE_PASS
keyAlias=menhir
storeFile=$KEYSTORE
EOF
  echo "NOTE: keep $KEYSTORE safe — Android updates must be signed with the same key."
fi

# ---- build ----
if [[ "$MODE" == "release" ]]; then
  cargo tauri android build --apk --target aarch64
else
  cargo tauri android build --apk --debug --target aarch64
fi

echo
echo "APKs:"
find gen/android/app/build/outputs/apk -name '*.apk' -exec ls -lh {} \;
echo
echo "verify a release APK with:"
echo "  \$ANDROID_HOME/build-tools/*/apksigner verify --print-certs <apk>"
