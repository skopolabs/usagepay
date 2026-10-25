#!/usr/bin/env bash
# G1 step 4: upload the pinned one-way-channel wasm and deploy one channel funded by upay-g1-payer.
# Idempotent: if the contract alias already exists the deploy is skipped and only the read-only checks run.
# CLI output (including transaction hashes) is appended to scripts/testnet/runs/g1-deploy.log (gitignored).
# Testnet naming rule: aliases use the "upay" prefix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="testnet"
ALIAS="upay-g1-channel"
DEPOSIT="10000000"              # 1 USDC in base units (7 decimals)
REFUND_WAITING_PERIOD="100"     # ledgers; only gates the payer's unilateral refund
WASM="$ROOT/scripts/testnet/.vendor/out/channel.wasm"
RUNS="$ROOT/scripts/testnet/runs"
LOG="$RUNS/g1-deploy.log"
TOKEN="$(node -e "console.log(require('$ROOT/implementation-versions.json').network.assetSac)")"
mkdir -p "$RUNS"

[ -f "$WASM" ] || { echo "FAIL: $WASM missing; run build-channel.sh first" >&2; exit 1; }
EXPECTED_HASH="$(cat "$WASM.sha256")"
[ "$(shasum -a 256 "$WASM" | cut -d' ' -f1)" = "$EXPECTED_HASH" ] || { echo "FAIL: wasm does not match $WASM.sha256" >&2; exit 1; }

PAYER="$(stellar keys address upay-g1-payer)"
RECIPIENT="$(stellar keys address upay-g1-recipient)"
COMMITMENT_G="$(stellar keys address upay-g1-commitment)"
COMMITMENT_HEX="$(cd "$ROOT/packages/contracts" && node -e "
  const { StrKey } = require('@stellar/stellar-base');
  console.log(Buffer.from(StrKey.decodeEd25519PublicKey('$COMMITMENT_G')).toString('hex'));")"

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

if stellar contract alias show "$ALIAS" --network "$NETWORK" >/dev/null 2>&1; then
  echo "reuse    $ALIAS"
else
  log "upload wasm $EXPECTED_HASH"
  WASM_HASH="$(stellar contract upload --wasm "$WASM" --source-account upay-g1-payer --network "$NETWORK" 2>>"$LOG")"
  [ "$WASM_HASH" = "$EXPECTED_HASH" ] || { echo "FAIL: uploaded wasm hash $WASM_HASH != $EXPECTED_HASH" >&2; exit 1; }
  echo "uploaded wasm $WASM_HASH"
  log "deploy $ALIAS"
  stellar contract deploy --alias "$ALIAS" --wasm-hash "$WASM_HASH" --source-account upay-g1-payer --network "$NETWORK" \
    -- \
    --token "$TOKEN" \
    --from "$PAYER" \
    --commitment_key "$COMMITMENT_HEX" \
    --to "$RECIPIENT" \
    --amount "$DEPOSIT" \
    --refund_waiting_period "$REFUND_WAITING_PERIOD" >>"$LOG" 2>&1
  echo "deployed $ALIAS"
fi

CHANNEL="$(stellar contract alias show "$ALIAS" --network "$NETWORK")"
read_view() { stellar contract invoke --id "$CHANNEL" --source-account upay-g1-recipient --network "$NETWORK" --send=no -- "$1" 2>/dev/null | tr -d '"'; }

echo
echo "channel                $CHANNEL"
fail=0
check() { # label actual expected
  if [ "$2" = "$3" ]; then printf 'PASS  %-22s %s\n' "$1" "$2"; else printf 'FAIL  %-22s %s (expected %s)\n' "$1" "$2" "$3"; fail=1; fi
}
check token                 "$(read_view token)"                 "$TOKEN"
check from                  "$(read_view from)"                  "$PAYER"
check to                    "$(read_view to)"                    "$RECIPIENT"
check deposited             "$(read_view deposited)"             "$DEPOSIT"
check refund_waiting_period "$(read_view refund_waiting_period)" "$REFUND_WAITING_PERIOD"
printf 'INFO  %-22s %s\n' balance   "$(read_view balance)"
printf 'INFO  %-22s %s\n' withdrawn "$(read_view withdrawn)"
printf 'INFO  %-22s %s (%s)\n' commitment_key "$COMMITMENT_HEX" "$COMMITMENT_G"
exit "$fail"
