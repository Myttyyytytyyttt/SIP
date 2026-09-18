// sip-vault's instruction builders, reached by name through the IDL.
//
// The generic Program<Idl> types `program.methods` as an index signature, so
// under noUncheckedIndexedAccess every builder is possibly undefined. Nuvem's
// keeper compiled without that flag and called program.methods.settle(...)
// directly. Here the lookup is one checked function, so an instruction missing
// from the IDL fails with its own name instead of "is not a function" halfway
// through a basket.

import type * as anchor from "@coral-xyz/anchor";

export type MethodBuilder = NonNullable<anchor.Program["methods"][string]>;

/**
 * ONE BUILDER, ALREADY CALLED WITH ITS ARGUMENTS: what `.accountsPartial(…)`,
 * `.remainingAccounts(…)`, `.signers(…)`, `.instruction()` and `.rpc()` hang
 * off. It is the return type the money paths' extracted builders hand back, so
 * that the caller keeps choosing HOW a fully-formed call is sent while the
 * arguments — the BNs — are constructed in one place a gate can run.
 */
export type MethodCall = ReturnType<MethodBuilder>;

export function method(program: anchor.Program, name: string): MethodBuilder {
  const builder = program.methods[name];
  if (builder === undefined) throw new Error(`the IDL behind this Program has no ${name} instruction`);
  return builder;
}
