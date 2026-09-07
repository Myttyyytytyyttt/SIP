#!/usr/bin/env bash
# The local-validator equivalent of the EVM fork tests (M3+).
#
# Clones the REAL mainnet state this program trades against into a local
# validator: the xStocks mints (Token-2022), the USDC mint, the Raydium CLMM
# program and the USDC/NVDAx pool whose program-owned custody was the proof in
# reports/SOLANA_2026-08-17.md. A swap executed here runs the real AMM code
# against the real pool state, for free.
#
# What this CANNOT clone: Jupiter (routes come from an API, not an account) —
# which is one of the reasons invest v1 targets Raydium CLMM directly.
#
# Usage:  ./clone-fixtures.sh [RPC_URL]
set -euo pipefail
RPC="${1:-https://api.mainnet-beta.solana.com}"

NVDAX=Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
SPYX=XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W
TSLAX=XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB
USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
RAYDIUM_CLMM=CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
POOL_USDC_NVDAX=49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6

# NOTE for M3: the pool needs its tick arrays and vaults cloned too; discover
# them with `solana account` on the pool and add them here. The mints alone are
# enough for M2 (settle touches no pool).
exec solana-test-validator --reset \
  --url "$RPC" \
  --clone-upgradeable-program "$RAYDIUM_CLMM" \
  --clone "$NVDAX" --clone "$SPYX" --clone "$TSLAX" --clone "$USDC" \
  --clone "$POOL_USDC_NVDAX"
