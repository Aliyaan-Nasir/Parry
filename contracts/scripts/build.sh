#!/usr/bin/env bash
# Builds Parry's contracts to wasm.
#
#   scripts/build.sh                        local toolchain, to target/near/<crate>/<crate>.wasm, for tests.
#                                           Local builds embed the builder's file paths in panic locations,
#                                           so they are never deployed.
#   scripts/build.sh --reproducible [rev]   SourceScan's pinned Docker image (each crate's
#                                           [package.metadata.near.reproducible_build]) building commit `rev`
#                                           (default HEAD) from a clean git worktree, to
#                                           target/near-reproducible/<commit>/<crate>.wasm. The wasm records the
#                                           repository and commit (NEP-330), so anyone can rebuild and compare it
#                                           with `near contract verify`. Only these builds are deployed.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOYABLE=(token oracle risk account accounts vault)
HELPERS=(tests/publisher tests/mock-signer)

build_local() { # crate dir
  if ! (cd "$1" && cargo near build non-reproducible-wasm --no-abi --locked >/dev/null 2>&1); then
    echo "build failed: $1" >&2
    (cd "$1" && cargo near build non-reproducible-wasm --no-abi --locked)
    exit 1
  fi
  echo "built $1"
}

case "${1:-}" in
  "")
    for c in "${DEPLOYABLE[@]}" "${HELPERS[@]}"; do
      [ -d "$c" ] && build_local "$c"
    done
    ls -la target/near/*/*.wasm | awk '{print $5, $9}'
    ;;
  --reproducible)
    rev=$(git rev-parse "${2:-HEAD}^{commit}")
    out="$(pwd)/target/near-reproducible/$rev"
    tree=$(mktemp -d "${TMPDIR:-/tmp}/parry-build.XXXXXX")
    git worktree add --detach "$tree" "$rev" >/dev/null
    trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
    mkdir -p "$out"
    for c in "${DEPLOYABLE[@]}"; do
      [ -d "$tree/contracts/$c" ] || continue
      if ! (cd "$tree/contracts/$c" && cargo near build reproducible-wasm >"$tree/build-$c.log" 2>&1); then
        echo "build failed: $c" >&2
        tail -40 "$tree/build-$c.log" >&2
        exit 1
      fi
      cp "$tree/contracts/target/near/parry_$c/parry_$c.wasm" "$out/"
      echo "built $c at ${rev:0:12}"
    done
    ls -la "$out"/*.wasm | awk '{print $5, $9}'
    ;;
  *)
    echo "usage: scripts/build.sh [--reproducible [rev]]" >&2
    exit 1
    ;;
esac
