// The single place @nuvem/session-engine is imported from.
//
// HOW THIS RESOLVES, AND WHY IT IS WRITTEN THIS WAY.
//
// Every specifier below is `../node_modules/@nuvem/session-engine/src/<mod>.js` —
// a path that stays INSIDE packages/keeper-old and is satisfied by the workspace
// dependency declared in this package's package.json
// ("@nuvem/session-engine": "workspace:*"). Nothing here reaches out of the
// package with `../../`, and that is the whole point: the previous version
// imported `../../session-engine/src/session.js`, which resolved only because a
// sibling directory happened to exist in the monorepo checkout. In the container
// the keeper is a pruned `pnpm deploy` tree rooted at /app, so `../../session-engine`
// from /app/src resolved to the nonexistent absolute path /session-engine and the
// image died at boot with ERR_MODULE_NOT_FOUND before a single line of config was
// read. Under /app the dependency lives at exactly one place —
// /app/node_modules/@nuvem/session-engine — which is the path used below, and
// which is also where pnpm links it in the workspace. One specifier shape, both
// environments.
//
// COMPILING THIS PACKAGE AHEAD OF TIME DOES NOT WORK YET, and the reason is here.
//
// Running through tsx costs 40 MB of RSS per process — bare node is 35 MB, node
// plus tsx is 75 MB — so emitting JS is worth having. It was tried and reverted:
// the specifiers below name `@nuvem/session-engine/src/session.js`, which exists
// only because tsx transpiles the sibling's TypeScript on the fly. Compiled, that
// path resolves to a file that is not on disk, and the process dies at boot with
// ERR_MODULE_NOT_FOUND — the same failure this header already documents.
//
// Making it work means pointing a compiled build at the sibling's dist/ while the
// tsx path keeps using src/, which is a real change to module resolution in a
// service that signs transactions. It is worth doing deliberately, and it was not
// worth doing quickly: the supervisor now runs every account in ONE process, so
// the 40 MB is paid once for the whole service rather than once per user.
//
// WHY NOT THE BARE PACKAGE SPECIFIER. @nuvem/session-engine's "exports" map
// publishes a single entry, "." -> ./dist/src/session.js, so
// `@nuvem/session-engine/src/detector.js` is answered with
// ERR_PACKAGE_PATH_NOT_EXPORTED (verified) and the bare `@nuvem/session-engine`
// yields only buildSessionReport — and yields it untyped, because that package's
// tsconfig has no `declaration`, so dist ships no .d.ts and tsc reports TS7016
// (also verified; re-verified 2026-07-30 — packages/session-engine-old/tsconfig.json
// still has no "declaration", and dist/src/ still ships eight .js files and zero
// .d.ts). Its committed dist is additionally missing detector.js altogether.
// Fixing that means editing packages/session-engine-old, which is out of scope for
// this change, so the required engine change is reported rather than made. A
// path import is exempt from the "exports" gate, which is what makes this work
// today without touching the engine.
//
// WHY NOT REIMPLEMENT ANY OF IT HERE. Two implementations of session boundaries
// would eventually disagree, and the disagreement would be about money.
//
// =============================================================================
// THE PRECONDITION THIS FILE RIDES ON, AND WHAT ENFORCES IT
// =============================================================================
// A path import bypasses "exports". It does NOT bypass PACKAGING. The specifiers
// below name files under the DEPENDENCY'S OWN src/, and whether those files exist
// in a deployed tree is decided entirely by @nuvem/session-engine's package.json:
//
//   `pnpm deploy` copies each workspace package as it is on disk, HONOURING its
//   "files" field. @nuvem/session-engine declares NO "files" field, so the whole
//   package — src/*.ts included — is copied, and /app/node_modules/@nuvem/
//   session-engine/src/session.ts exists for tsx to resolve `src/session.js` to.
//
// That is a silent dependency on the ABSENCE of a field in a package this one
// does not own. The day someone adds `"files": ["dist"]` to packages/session-engine-old
// — an entirely reasonable, entirely local-looking tidy-up — the workspace keeps
// working (pnpm links the package directory, so src/ is still there) and the
// CONTAINER stops booting. `pnpm build` here would not catch it either: this
// package's typecheck resolves the same specifiers through the workspace symlink,
// where src/ is present regardless.
//
// So the fragility is made LOUD rather than left implicit. Two checks in
// packages/keeper-old/Dockerfile fail the image build, with an explanation, the
// moment the precondition breaks:
//
//   [engine-contract]  runs BEFORE the deploy, in the builder stage, and fails
//                      if packages/session-engine-old/package.json has grown a
//                      "files" field at all. That is the root cause, so it is
//                      checked directly and named directly.
//   [engine-graph]     runs AFTER the deploy, PARSES THIS FILE for its
//                      `../node_modules/...` specifiers, and asserts each one
//                      resolves to a real file in the pruned /out tree. It reads
//                      the list off the import statements below, so it cannot
//                      drift from them: add an import here and it is checked
//                      there, with no second list to remember.
//
// THE IMPORT STATEMENTS BELOW ARE THAT MANIFEST. Keep the specifier on the same
// line as the `from`, and keep it a plain double-quoted literal — [engine-graph]
// matches `../node_modules/@nuvem/session-engine/...` textually. A dynamic
// import(), a template literal or a specifier wrapped onto its own line is
// invisible to it, which would put back exactly the silence this replaces.
// =============================================================================
//
// The coupling is therefore funnelled through this ONE module, so it is a single
// auditable file rather than a habit spread through src/. The keeper runs from
// source under tsx, the same way session-engine's own scripts/*.mts do, so
// `pnpm build` typechecks rather than emitting.

export { buildSessionReport } from "../node_modules/@nuvem/session-engine/src/session.js";
export type {
  BuildSessionOptions,
  PositionDelta,
  RefusalReason,
  SessionReport,
  Verdict,
} from "../node_modules/@nuvem/session-engine/src/session.js";

export { classifyWindow, classifyTx, summariseFlows } from "../node_modules/@nuvem/session-engine/src/classify.js";
export type { ClassifiedTx, TokenDelta, TxKind } from "../node_modules/@nuvem/session-engine/src/classify.js";

export { detectSessions, openSessionStatus } from "../node_modules/@nuvem/session-engine/src/detector.js";
export type { DetectedSession, OpenSessionStatus, SessionState } from "../node_modules/@nuvem/session-engine/src/detector.js";

export { scanWindow } from "../node_modules/@nuvem/session-engine/src/window.js";
export type { NativeMove, RawTx, TokenMove, WindowScan } from "../node_modules/@nuvem/session-engine/src/window.js";

export { httpRpcClient, fixtureRpcClient, recordingRpcClient, rpcKey, RpcError } from "../node_modules/@nuvem/session-engine/src/rpc.js";
export { failoverRpcClient, isEndpointFault, probeEndpoints } from "../node_modules/@nuvem/session-engine/src/failover.js";
export type { EndpointCapability, FailoverEndpoint, FailoverEvent } from "../node_modules/@nuvem/session-engine/src/failover.js";
export type { Recording, RpcClient, RpcParams } from "../node_modules/@nuvem/session-engine/src/rpc.js";

export {
  CHAIN_ID as ENGINE_CHAIN_ID,
  SETTLEMENT_EXECUTOR as ENGINE_SETTLEMENT_EXECUTOR,
  // Re-exported so the keeper can refuse to start against an executor the
  // engine cannot read. See the startup check in bin/keeper-supervisor.mts.
  isKnownSettlementExecutor,
  SETTLE_SELECTOR,
  WETH as ENGINE_WETH,
  addressTopic,
  cashAt,
  hexToBigInt,
  normalize,
  toBlockTag,
  toL1Block,
  topicAddress,
  TRANSFER_TOPIC,
} from "../node_modules/@nuvem/session-engine/src/chain.js";
