#!/usr/bin/env bash
# The Raydium fork test, one command: buy real NVDAx against cloned mainnet
# state, no mainnet fee paid.
#
#   ./scripts/fork.sh
#
# Clones the NVDAx/USDC pool and every account swap_v2 touches, injects a
# pre-funded USDC account for the vault (a clone has no USDC mint authority),
# deploys nuvem_vault, and runs invest() through the real swap route.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"

echo "── phase 1: fabricate the vault's USDC account ──"
npx tsx scripts/fork-setup.ts

# The pinned world, from the captured swap.
POOL=49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6
CLMM=CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
CLONES=(
  "$POOL"
  DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY   # ammConfig
  DyKsypuzQvhi37K8UvjCMBC43h4HtW4r6jhWoqHyrSSe   # NVDAx vault
  4JEtq7NraU9U5URcCKSv6sWRRgDSuSnUjYDqpSJSWohY   # USDC vault
  BhVGr6ZSa3kDc2d1XHXHTfoGQos8RbeDTjJfBaXMoLQH   # observation
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # USDC mint
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh    # NVDAx mint
)
# tick arrays + bitmap extension, from the captured swap.
while IFS= read -r ta; do CLONES+=("$ta"); done < <(node -e '
  JSON.parse(require("fs").readFileSync("../harness/raydium/tick-arrays.json")).forEach(t=>console.log(t))')
# the wSOL/USDC pool (first hop), every account its captured swap touched
while IFS= read -r a; do CLONES+=("$a"); done < <(node -e '
  const s=JSON.parse(require("fs").readFileSync("../harness/raydium/captured-swap-wsol.json"));
  const skip=new Set([s.accounts[0],s.accounts[3],s.accounts[4],
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr","CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "So11111111111111111111111111111111111111112"]); // trader+ATAs+programas+mint nativo
  [...new Set(s.accounts.filter(a=>!skip.has(a)))].forEach(a=>console.log(a))')

CLONE_ARGS=()
for a in "${CLONES[@]}"; do CLONE_ARGS+=(--clone "$a"); done

echo "── phase 2: start validator (cloning ${#CLONES[@]} accounts + Raydium CLMM) ──"
pkill -f solana-test-validator 2>/dev/null || true
sleep 2
USDC_ACCT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("scripts/.local/vault-usdc.json")).pubkey)')
solana-test-validator --reset --quiet \
  --url "$RPC" \
  --clone-upgradeable-program "$CLMM" \
  "${CLONE_ARGS[@]}" \
  --account "$USDC_ACCT" scripts/.local/vault-usdc.json \
  > /tmp/fork-validator.log 2>&1 &
sleep 12

echo "── phase 3: deploy nuvem_vault ──"
solana airdrop 10 -u http://127.0.0.1:8899 >/dev/null 2>&1 || true
anchor deploy --provider.cluster http://127.0.0.1:8899 2>&1 | tail -1

echo "── phase 4: buy NVDAx (isolated invest) ──"
npx tsx scripts/fork-test.ts

echo "── phase 5: THE FULL CHAIN — measure -> attest -> settle -> wrap -> convert -> invest ──"
npx tsx scripts/fork-e2e.ts
