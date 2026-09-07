# @nuvem/solana-core

The Solana vault's reads, transaction builders and diagnostics — shared by both
web apps.

## Why this package exists

`packages/web` and `packages/website-oficial` already carry fourteen
byte-identical files between them, and fifteen more that started identical and
drifted. Porting the Solana surface by copying would have added another ~1,800
lines to that pile, in the part of the system that decides how much of a user's
money moves. Two copies of a transaction builder is two copies of a money bug.

So the logic lives here once and both apps import it. **Presentation does not**:
each app renders these results in its own design language, because the testing
surface and the product are different products.

## What is NOT here

- **React components.** The apps' visual languages differ; sharing markup would
  force one on the other.
- **Next.js route handlers.** Those are per-app by construction; they are thin
  and call into this package.
- **Anything from `packages/solana-lab-old`.** That is an experiment with its own
  toolchain and is deliberately unimportable from the product. The layouts here
  MIRROR the program's `state.rs` and are pinned against captured bytes by
  `packages/web/scripts/check-solana-decode.mts`.
