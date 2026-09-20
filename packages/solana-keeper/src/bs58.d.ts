// bs58@4 ships no types, and the keeper typechecks @sip/solana-program's .ts
// sources directly (they are imported, not built, so skipLibCheck does not
// apply) under strict/noImplicitAny — where an untyped module is an error. The
// program's own non-strict tsc check never needed this.
//
// NOTHING IN THE KEEPER'S GRAPH IMPORTS bs58 TODAY. This file used to say
// live-route.ts did, and that stopped being true on 2026-09-20 when live-route
// was rewritten to read the pool's own account: the old version base58-decoded
// instruction data while walking 60 signatures, and the walk is gone. Checked
// 2026-09-20 across the whole monorepo — the only remaining `import ... from
// "bs58"` is scripts/rehearse-route.ts, which @sip/solana-program's package.json
// does NOT list in its `exports` (only attestation, link-consent, live-route and
// raydium-swap), so the keeper cannot reach it and tsc never sees it. Every
// other mention is `anchor.utils.bytes.bs58`, a property of Anchor's own typed
// namespace, which needs nothing from here. Removing this file leaves
// `pnpm --dir packages/solana-keeper typecheck` green; that was measured, not
// assumed.
//
// KEPT ANYWAY, deliberately: it is eleven lines, it costs nothing at runtime,
// and it is exactly what would be needed again the day rehearse-route.ts (or
// any other bs58 user) joins that exports map. Delete it if you would rather —
// the evidence above is the whole check — but do re-run that typecheck, because
// the failure it prevents is reported against a file in another package.
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array | number[]): string;
    decode(source: string): Uint8Array;
  };
  export = bs58;
}
