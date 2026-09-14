// @sip/solana-core/client — the browser-safe entry.
//
// Imports nothing but relative modules and @sip/solana-program/idl (JSON). No
// web3 SDK, no node:* module, no server-marker import, no Node byte-array global:
// test/client-entry.test.ts walks every file reachable from here and fails on
// any of them, because a client component importing a constant must never drag
// the verifier or the RPC pool into the bundle.

export * from "./addresses";
export * from "./base58";
export * from "./base64";
export {
  BorshError,
  accountSpace,
  decodeArgs,
  decodeStruct,
  decodeType,
  encodeArgs,
  encodeStruct,
  fieldOffset,
  structMaxSize,
  typeMaxSize,
  type Decoded,
} from "./borsh";
export * from "./confirm";
export * from "./decoders";
export * from "./diagnostics-types";
export * from "./idl";
export * from "./pda";
export * from "./pending";
export * from "./rules";
export { DEFAULT_PUBLIC_WS_URL, checkPublicWsUrl, type PublicWsUrlCheck } from "../shared/public-ws-url.mjs";
