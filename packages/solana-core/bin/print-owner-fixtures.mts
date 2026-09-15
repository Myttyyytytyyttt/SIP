// pnpm --dir packages/solana-core exec tsx bin/print-owner-fixtures.mts
//
// Prints the owner-transaction byte fixtures as the builders produce them now,
// for a DELIBERATE update of test/fixtures/owner-transactions.ts. It writes no
// file: a changed byte must be read, understood and pasted by a person, because
// builders.test.ts and the web's local proof hold the builders to these strings.

import { buildOwnerFixtures } from "../test/fixtures/owner-transactions";

const fixtures = Object.entries(buildOwnerFixtures());

console.log("export const OWNER_INSTRUCTION_DATA_HEX = {");
for (const [name, fixture] of fixtures) console.log(`  ${name}: "${fixture.dataHex}",`);
console.log("} as const;\n");
console.log("export const OWNER_WIRE_HEX: Readonly<Record<OwnerFixtureName, string>> = {");
for (const [name, fixture] of fixtures) console.log(`  ${name}: "${fixture.wireHex}",`);
console.log("};");
