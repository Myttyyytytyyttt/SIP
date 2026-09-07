# Robinhood Testnet AA smoke

This harness validates the narrow account-abstraction path only:

1. create the trading address as Alchemy Modular Account v2 in EIP-7702 mode;
2. install one non-global, UserOperation-only session key;
3. allow only the account's single-call `execute` entrypoint;
4. allow only `SettlementExecutor.settle(...)` at one exact executor address;
5. enforce a cumulative native-token limit;
6. enforce one exact paymaster when sponsorship is configured; and
7. optionally submit calldata prepared and signed by the attester service.

There is deliberately no TimeRange hook, so the session permission has no
expiry. Revocation remains an explicit operational requirement. `executeBatch`,
message signing, arbitrary targets, and other selectors are not authorized.

## Environment

Keep all real values in the gitignored root `.env`. The harness never prints
private keys, the Alchemy API key, or the gas policy ID. Dependency diagnostic
sinks are disabled for broadcast runs so verbose request logging cannot expose
signed operations or credential-bearing URLs.

Generate the two disposable keys with the helper rather than by hand. It writes
the key straight into a gitignored `.env*` file and prints only the address, so
the key never reaches a terminal scrollback, a screen share, or a chat log:

```powershell
node packages/aa-smoke-old/scripts/new-canary-wallet.mjs TRADING_OWNER_PRIVATE_KEY .env
node packages/aa-smoke-old/scripts/new-canary-wallet.mjs SESSION_KEY_PRIVATE_KEY .env
```

It refuses to overwrite a variable that already has a value and refuses any
destination that is not a gitignored `.env*` file. Treat every key it produces
as burned when the drill ends; never reuse one for the real product.

Required for every action:

```text
TRADING_OWNER_PRIVATE_KEY=0x...
SESSION_KEY_PRIVATE_KEY=0x...
SETTLEMENT_EXECUTOR_ADDRESS=0x...
SESSION_NATIVE_LIMIT_WEI=100000000000000000
RH_TESTNET_CHAIN_ID=46630
```

Optional:

```text
SESSION_ENTITY_ID=1
ALCHEMY_GAS_POLICY_ID=...
ALCHEMY_PAYMASTER_ADDRESS=0x...
```

`SESSION_ENTITY_ID` must be unused on that trading account and be in
`1..2147483646`; Alchemy reserves the upper half of `uint32` for hook-storage
namespaces. Increment it when installing a rotated key.

The policy ID and paymaster address must be supplied together. The address must
be the paymaster that the Alchemy policy actually returns; otherwise the
onchain guard rejects the UserOperation.

For a prepared settlement:

```text
SETTLEMENT_CALLDATA=0x...
SETTLEMENT_VALUE_WEI=...
```

The harness decodes the calldata before any network request and requires:

- the finalized `settle((...),bytes)` selector;
- attestation account equal to the trading owner;
- executor equal to `SETTLEMENT_EXECUTOR_ADDRESS`;
- chain ID `46630`;
- contribution equal to `SETTLEMENT_VALUE_WEI`; and
- native limit greater than the contribution, leaving gas headroom when gas is
  not sponsored.

## Run

Node 22 can load the root environment file without another dependency:

```powershell
node --env-file=.env --import tsx packages/aa-smoke-old/src/robinhood-testnet.ts
```

`AA_SMOKE_ACTION` defaults to `dry-run`. This mode performs strict parsing and
builds the exact permission definition without making a network request.

Broadcast actions are explicit:

```powershell
$env:AA_SMOKE_ACTION = "install"
node --env-file=.env --import tsx packages/aa-smoke-old/src/robinhood-testnet.ts

$env:AA_SMOKE_ACTION = "settle"
node --env-file=.env --import tsx packages/aa-smoke-old/src/robinhood-testnet.ts

$env:AA_SMOKE_ACTION = "install-and-settle"
node --env-file=.env --import tsx packages/aa-smoke-old/src/robinhood-testnet.ts
```

Every broadcast action requires `ALCHEMY_API_KEY`. `settle` assumes the
permission is already installed. `install-and-settle` waits for the install
receipt before signing with the session key.

## Verifying the delegation

The account is **not** delegated when the key is created. `toModularAccountV2`
in `7702` mode only attaches the authorization to the first UserOperation the
account sends, which in this harness means `install`. A `dry-run` touches
nothing onchain, so an address that has only been through `dry-run` is still a
plain EOA.

That distinction is the whole point of the GMGN canary: a virgin EOA has no
code and every wallet and router accepts it. The risk only begins once
`eth_getCode` stops returning `0x`. Check it at three points and keep all three
outputs as canary evidence:

```powershell
node packages/aa-smoke-old/scripts/check-delegation.mjs https://rpc.testnet.chain.robinhood.com 0xYourAddress
```

| When | Expected |
| --- | --- |
| Before `install` | `"status": "eoa"` |
| After `install` | `"status": "delegated"`, `delegatedTo` = the MAv2 implementation |
| After importing into MetaMask and using the wallet | still `"delegated"`, at the **same** `delegatedTo` |

A changed `delegatedTo` means something replaced the delegation — MetaMask
installing its own smart-account implementation is the documented risk. A
return to `"eoa"` means it was revoked. Either outcome invalidates the run and
must be recorded rather than retried.

Before treating the permission as safe beyond an offline harness, install it on
a disposable testnet account, read back the native-limit state for the entity,
and prove negative calls fail for a different target, selector, value above the
cap, batch execution, and the revoked validation. The shared gas-plus-value
limit configuration is intentionally stricter than Alchemy's high-level
builder and still requires this live confirmation.

Run the offline checks with:

```powershell
pnpm --dir packages/aa-smoke-old typecheck
pnpm --dir packages/aa-smoke-old test
```

Passing this harness is not evidence of GMGN compatibility or mainnet
readiness. Those require the separate disposable-wallet canary.
