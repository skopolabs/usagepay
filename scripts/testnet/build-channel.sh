#!/usr/bin/env bash
# G1 step 1 (offline build, no transactions): build the upstream experimental one-way-channel contract at the
# pinned revision from implementation-versions.json and print the SHA-256 of the resulting wasm, which is the
# wasm hash an upload to Testnet will produce.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_URL="https://github.com/stellar-experimental/one-way-channel.git"
PINNED_SHA="$(node -e "console.log(require('$ROOT/implementation-versions.json').upstreamSources['one-way-channel'].commit)")"
VENDOR="$ROOT/scripts/testnet/.vendor"
SRC="$VENDOR/one-way-channel"
OUT="$VENDOR/out"

mkdir -p "$VENDOR" "$OUT"
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$REPO_URL" "$SRC"
fi
git -C "$SRC" fetch --quiet origin
git -C "$SRC" -c advice.detachedHead=false checkout --quiet "$PINNED_SHA"
ACTUAL_SHA="$(git -C "$SRC" rev-parse HEAD)"
if [ "$ACTUAL_SHA" != "$PINNED_SHA" ]; then
  echo "FAIL: checked out $ACTUAL_SHA, expected pinned $PINNED_SHA" >&2
  exit 1
fi
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "FAIL: vendored source has local modifications; refusing to build" >&2
  exit 1
fi

stellar contract build --manifest-path "$SRC/Cargo.toml" --package channel --locked --out-dir "$OUT"

WASM="$OUT/channel.wasm"
HASH="$(shasum -a 256 "$WASM" | cut -d' ' -f1)"
echo "$HASH" > "$WASM.sha256"
echo "one-way-channel commit: $ACTUAL_SHA"
echo "stellar CLI:            $(stellar --version | head -1)"
echo "rustc:                  $(rustc --version)"
echo "wasm:                   $WASM ($(wc -c < "$WASM" | tr -d ' ') bytes)"
echo "wasm sha256:            $HASH"
