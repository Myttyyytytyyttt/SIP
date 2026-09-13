// bs58@4 ships no types. @sip/solana-program's live-route.ts imports it, and the
// keeper typechecks that file under strict (noImplicitAny), where an untyped
// module is an error; the program's own non-strict tsc check never needed this.
// The surface declared is exactly what live-route.ts uses.
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array | number[]): string;
    decode(source: string): Uint8Array;
  };
  export = bs58;
}
