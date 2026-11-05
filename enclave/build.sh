#!/usr/bin/env bash
# Builds the guardian enclave program for OutLayer and prints its sha256: the hash OutLayer binds
# the enclave's keys to, and that every run's attestation reports.
#
# rust-toolchain.toml pins the compiler and paths are remapped, so the same commit gives the same
# bytes on any machine. Endpoints and contract ids are compiled in (src/config.rs) and covered by
# the hash: a mainnet build (PARRY_NETWORK=mainnet with its endpoints) is a different program.
set -euo pipefail
cd "$(dirname "$0")"
network="${PARRY_NETWORK:-testnet}"
case "$network" in
  testnet) ;;
  mainnet) # #mainnet
    export PARRY_RPC_URL="${PARRY_RPC_URL:-https://free.rpc.fastnear.com}"
    export PARRY_SIGNER="${PARRY_SIGNER:-v1.signer}"
    export PARRY_HYPERLIQUID_URL="${PARRY_HYPERLIQUID_URL:-https://api.hyperliquid.xyz}"
    export PARRY_WNEAR="${PARRY_WNEAR:-wrap.near}"
    export PARRY_LINEAR="${PARRY_LINEAR:-linear-protocol.near}"
    ;;
  *) echo "PARRY_NETWORK must be testnet or mainnet" >&2; exit 1 ;;
esac
export PARRY_NETWORK="$network"
# The deployed ids come from deployments/<network>.json when it exists.
dep="../deployments/$network.json"
if [ -f "$dep" ]; then
  get() { python3 -c "import json,sys; d=json.load(open('$dep')); print(d.get('contracts',{}).get('$1',{}).get('account','') or d.get('$1',''))"; }
  for pair in RISK:risk VAULT:vault LENDING:lending ORACLE:oracle USDC:usdc; do
    var="PARRY_${pair%%:*}"; val="$(get "${pair##*:}")"
    [ -n "$val" ] && [ -z "${!var:-}" ] && export "$var=$val"
  done
  pool="$(python3 -c "import json; print(json.load(open('$dep')).get('dexPool',''))")"
  [ -n "$pool" ] && export PARRY_DEX_POOL="${PARRY_DEX_POOL:-$pool}"
fi
unset RUSTUP_TOOLCHAIN CARGO_TARGET_DIR CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
RUSTFLAGS="--remap-path-prefix=$(pwd)=/build --remap-path-prefix=$cargo_home=/cargo" \
  cargo build --locked --release --target wasm32-wasip2 --bin parry-enclave
echo "toolchain: $(rustc -V), $(cargo -V), target wasm32-wasip2"
env | grep '^PARRY_' | grep -v SEED | sort
shasum -a 256 target/wasm32-wasip2/release/parry-enclave.wasm
