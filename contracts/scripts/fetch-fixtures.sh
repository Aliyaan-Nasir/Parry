#!/usr/bin/env bash
# Downloads the third-party contracts the sandbox tests run against, straight from the chain
# where they are deployed, and checks each one against its pinned code hash. Nothing third-party
# is committed: the hash is the pin, and the chain is the source.
#
#   lending   contract.main.burrow.near (mainnet)  Rhea lending v0.16.2, the code Parry deploys to testnet
#   wrap      wrap.testnet                         wNEAR
#   dex       ref-finance-101.testnet              Rhea (Ref v2) exchange
#   linear    linear-protocol.testnet              LiNEAR liquid staking
#   vault-v1  vault.parry.testnet                  Parry's vault as deployed, for the migration test
#   risk-v1   risk.parry.testnet                   Parry's risk board as deployed, for the migration test
#
# Output: contracts/target/fixtures/<name>.wasm. Re-running skips files whose hash already matches.
set -euo pipefail
cd "$(dirname "$0")/.."
out=target/fixtures
mkdir -p "$out"

fixtures=(
  "lending https://free.rpc.fastnear.com contract.main.burrow.near 6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa"
  "wrap https://test.rpc.fastnear.com wrap.testnet DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa"
  "dex https://test.rpc.fastnear.com ref-finance-101.testnet AEAm8sQ5KYZRgnpq2CN2NhX6d8QV76iRtiDpy5Ai6zDX"
  "linear https://test.rpc.fastnear.com linear-protocol.testnet 8Bby4ofnYGtudd3PinKZ1KyvmUKJVyxmfC99ZccRDVDv"
  "vault-v1 https://test.rpc.fastnear.com vault.parry.testnet 9c1tfY3TDGJDMjUCnriH1cza2eJZKXfJhCNRaFYshHQz"
  "risk-v1 https://test.rpc.fastnear.com risk.parry.testnet EVd56RoEga1Nrqsyeb81Aibk6k2QY8tDd49UQukoLiVg"
)

b58_sha256() { # file -> base58(sha256(file))
  python3 -c '
import hashlib, sys
d = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(d, "big"); s = ""
while n: n, r = divmod(n, 58); s = a[r] + s
print("1" * (len(d) - len(d.lstrip(b"\0"))) + s)' "$1"
}

for f in "${fixtures[@]}"; do
  read -r name rpc account hash <<<"$f"
  file="$out/$name.wasm"
  if [ -f "$file" ] && [ "$(b58_sha256 "$file")" = "$hash" ]; then
    echo "ok      $name ($account)"
    continue
  fi
  curl -sS --fail "$rpc" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$account\"}}" |
    python3 -c 'import sys, json, base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["result"]["code_base64"]))' >"$file"
  got="$(b58_sha256 "$file")"
  if [ "$got" != "$hash" ]; then
    echo "hash mismatch for $account: got $got, pinned $hash (the deployed code changed; review it and update the pin)" >&2
    rm -f "$file"
    exit 1
  fi
  echo "fetched $name ($account) $hash"
done
