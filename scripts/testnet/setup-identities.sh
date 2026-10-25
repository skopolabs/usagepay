#!/usr/bin/env bash
# G1 steps 2-3: disposable Testnet-only identities, Friendbot XLM and USDC trustlines.
# Idempotent: existing identities are reused, existing trustlines are not recreated.
# Secrets stay in the Stellar CLI config (outside the repo) and are never printed.
# Testnet naming rule: identities use the "upay" prefix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="testnet"
HORIZON="https://horizon-testnet.stellar.org"
USDC_LINE="$(node -e "console.log(require('$ROOT/implementation-versions.json').network.assetClassic)")"
USDC_ISSUER="${USDC_LINE#USDC:}"

ensure_identity() { # name fund(yes|no)
  if stellar keys address "$1" >/dev/null 2>&1; then
    echo "reuse    $1"
  elif [ "$2" = "yes" ]; then
    stellar keys generate "$1" --network "$NETWORK" --fund >/dev/null
    echo "created  $1 (funded by Friendbot)"
  else
    stellar keys generate "$1" >/dev/null
    echo "created  $1 (key only, not funded)"
  fi
}

has_usdc_trustline() { # address
  curl -fsS "$HORIZON/accounts/$1" | node -e "
    let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
      const a=JSON.parse(s);
      process.exit(a.balances.some(b=>b.asset_code==='USDC'&&b.asset_issuer==='$USDC_ISSUER')?0:1);
    });"
}

ensure_trustline() { # name
  local address; address="$(stellar keys address "$1")"
  if has_usdc_trustline "$address"; then
    echo "reuse    USDC trustline for $1"
  else
    stellar tx new change-trust --source-account "$1" --line "$USDC_LINE" --network "$NETWORK" >/dev/null
    has_usdc_trustline "$address" || { echo "FAIL: trustline for $1 not visible on Horizon" >&2; exit 1; }
    echo "created  USDC trustline for $1"
  fi
}

ensure_identity upay-g1-payer yes
ensure_identity upay-g1-recipient yes
ensure_identity upay-g1-commitment no
ensure_trustline upay-g1-payer
ensure_trustline upay-g1-recipient

echo
for name in upay-g1-payer upay-g1-recipient upay-g1-commitment; do
  address="$(stellar keys address "$name")"
  if curl -fsS "$HORIZON/accounts/$address" -o /dev/null 2>/dev/null; then
    balances="$(curl -fsS "$HORIZON/accounts/$address" | node -e "
      let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
        console.log(JSON.parse(s).balances.map(b=>(b.asset_code??'XLM')+'='+b.balance).join(' '));
      });")"
  else
    balances="(no on-chain account: signing key only)"
  fi
  printf '%-20s %s  %s\n' "$name" "$address" "$balances"
done
