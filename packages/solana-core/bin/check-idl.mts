// pnpm --dir packages/solana-core check:idl
//
// The build-time half of the IDL pinning (test/idl.test.ts is the other half).
// The Docker image runs no tests, so the web's prebuild runs this: a program
// change that adds an unclassified instruction, or a layout this codec cannot
// size, fails the build instead of the first request after deploy.

import { SIP_ACCOUNT_SPACE, SIP_IDL, idlInstruction, idlPartitionProblems, OWNER_INSTRUCTIONS } from "../src/client/index";

const problems = [...idlPartitionProblems()];

for (const name of Object.keys(SIP_ACCOUNT_SPACE) as (keyof typeof SIP_ACCOUNT_SPACE)[]) {
  try {
    void SIP_ACCOUNT_SPACE[name];
  } catch (error) {
    problems.push(`the ${name} account cannot be sized from the IDL: ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const name of OWNER_INSTRUCTIONS) {
  try {
    idlInstruction(name);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

if (problems.length > 0) {
  console.error(`check:idl failed for ${SIP_IDL.address}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `check:idl ok: ${SIP_IDL.instructions.length} instructions classified; accounts ` +
    `Vault ${SIP_ACCOUNT_SPACE.Vault} B, TradingLink ${SIP_ACCOUNT_SPACE.TradingLink} B, ` +
    `InvestmentPolicy ${SIP_ACCOUNT_SPACE.InvestmentPolicy} B, ProtocolConfig ${SIP_ACCOUNT_SPACE.ProtocolConfig} B`,
);
