# @sip/solana-core

SIP's Solana web core. The web (`packages/website-oficial`) uses it to read the
`sip_vault` program, to relay a narrow set of JSON-RPC calls for Privy's signing UI,
and to verify and broadcast transactions its users sign.

## What it is

- **V2 only, and driven by the IDL.** Discriminators, argument order, account lists
  and account layouts come from `@sip/solana-program/idl`
  (`packages/solana-program/idl/sip_vault.json`). No offsets are written by hand, and
  no instruction names are hashed at runtime.
- **One program.** `SIP_PROGRAM_ID` is the IDL's `address`
  (`6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J`). `SIP_SOLANA_PROGRAM_ID` must equal
  it. Nuvem's program `7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy` is refused
  everywhere: in config, in the verifier, and at IDL load.
- **Two entries, with no `.` export.**
  - `@sip/solana-core/client` is browser-safe: the IDL codec, decoders, base58 and
    base64, PDA seeds, Solscan links, the program's validation rules, and the
    confirmation helper. It imports no `@solana/web3.js`, no `node:*` and no
    `server-only`. `test/client-entry.test.ts` enforces that.
  - `@sip/solana-core/server` is server-only (its first line is `import "server-only"`).
    It holds the RPC pool, the relay allowlist, the transaction verifier,
    simulate-then-send, builders, readers, rate limiting, and the route handler
    factories.
  - The split exists so a client component that imports a constant cannot pull the
    verifier, the pool or endpoint handling into the browser bundle.
- **A link is two server calls.** `link_wallet` no longer takes the trading wallet's
  transaction signature as consent, because a Privy seat holds that key. The program
  reads back an Ed25519SigVerify instruction, immediately before `link_wallet`, of the
  wallet's `signMessage` over 140 bytes: `0xFF ‖ "SIP_LINK_V1" ‖ program ‖ wallet ‖
  vault ‖ owner`. `prepareLinkWalletConsent` returns those bytes (the browser can rebuild
  them with `linkConsentMessage` from `./client`). `buildLinkWallet` takes the signature
  back, checks it, and compiles `[Ed25519SigVerify, link_wallet]`, which owner and wallet
  then sign. The verifier accepts an Ed25519 instruction only there, and only in
  that shape. `unlink_wallet` is the owner's alone.
- **`@sip/solana-core/public-ws-url`** is one plain-JavaScript validator for
  `SIP_SOLANA_PUBLIC_WS_URL`. The server config and the web's `security-headers.mjs`
  both import it, so they apply the same rule.

## What it is not

It never settles, invests, converts or wraps SOL, and it never reads a keeper
secret. `packages/solana-keeper` owns all of that. The relay refuses
`sendTransaction`, and the verifier refuses every keeper-only and authority-only
instruction.

## Tests

```sh
pnpm --dir packages/solana-core typecheck
pnpm --dir packages/solana-core test
pnpm --dir packages/solana-core check:idl   # the web's prebuild runs this
```

Tests use throwaway keys only and make no network calls.
