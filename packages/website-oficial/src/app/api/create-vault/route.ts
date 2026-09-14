/**
 * Server side of the one write that makes a vault. Ported from the Nuvem
 * dashboard's src/app/api/create-vault/route.ts (HEAD fd927b0); the contract
 * (preview / receipt) is unchanged, the default cap is not.
 *
 * The BROWSER never touches an RPC here. It asks this route to prepare the call
 * ("preview"), gets back the exact `initData` and the CREATE2 address the vault
 * will have, shows them, and then asks the pension key to sign and broadcast.
 * Afterwards it asks this route whether the transaction landed ("receipt").
 *
 * WHY `initData` IS BUILT FROM THE CHAIN AND NOT FROM ENVIRONMENT VARIABLES:
 * PersonalVault._validateInitialization requires
 * `factory.isProtocolConfiguration(weth, pause, attester, executor)` to accept
 * all four component addresses. They are therefore read from
 * VaultFactory.protocolConfiguration(). A stale .env cannot produce a vault wired
 * to the wrong executor — such a vault simply cannot be built.
 *
 * THE CAP DEFAULTS TO UINT128_MAX (WEB_WALLETS.md §0.6). The vault policy is one
 * field, the 30-day aggregate ceiling shared by every trading wallet, and under
 * volume-mode skims it is consumed first-come-first-served: the dashboard's old
 * 1 ETH default would have blocked every skim after the first ETH each month.
 * Zero is still refused — PersonalVault._validateVaultPolicy rejects it
 * unconditionally, and that is the entire validation.
 *
 * NOTE FOR WHOEVER CHANGES THIS NEXT: `initData` is `bytes`, so createVault and
 * initialize keep their selectors no matter how VaultInitialization is reshaped.
 * A wrong encoding here fails as a confusing InvalidPolicy revert, not as a type
 * error. scripts/check-abis.mts reconstructs the tuple from the compiled ABI and
 * fails on drift; that guard is the only thing standing between this file and a
 * silent mis-encode.
 */

import { encodeAbiParameters, getAddress, isAddress, isHex, keccak256, stringToHex } from "viem";

import { vaultFactoryAbi, vaultInitializationParam } from "@/lib/abi";
import type { CreateVaultPreview, ReceiptState } from "@/lib/api-types";
import { EVM_ROUTE_OFF_MESSAGE, UINT128_MAX, evmRouteGate, loadEvmConfig } from "@/lib/config";
import { errorSummary } from "@/lib/redact";
import { jsonResponse } from "@/lib/serialize";
import { createReadClient, predictVault, readCohort, readProtocol } from "@/lib/vault";

export const dynamic = "force-dynamic";

interface Body {
  readonly action?: unknown;
  readonly owner?: unknown;
  readonly label?: unknown;
  readonly capWei?: unknown;
  readonly hash?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  // An EVM route: under SIP_CHAIN=solana it does not exist on this deployment.
  const gate = evmRouteGate(process.env);
  if (gate.kind === "solana") return jsonResponse({ error: EVM_ROUTE_OFF_MESSAGE }, 404);
  if (gate.kind === "invalid") {
    return jsonResponse({ error: "This deployment is not configured.", problems: [gate.problem] }, 503);
  }

  const load = loadEvmConfig(process.env, { needPrivyAppId: false });
  if (!load.ok) {
    return jsonResponse({ error: "This deployment is not configured.", problems: load.problems }, 503);
  }
  const config = load.config;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonResponse({ error: "Body must be JSON." }, 400);
  }

  const client = createReadClient(config);

  if (body.action === "receipt") {
    if (typeof body.hash !== "string" || !isHex(body.hash) || body.hash.length !== 66) {
      return jsonResponse({ error: "`hash` must be a 32-byte hex transaction hash." }, 400);
    }
    try {
      const receipt = await client.getTransactionReceipt({ hash: body.hash });
      const state: ReceiptState = receipt.status === "success" ? { state: "success" } : { state: "reverted" };
      return jsonResponse(state);
    } catch {
      // viem throws TransactionReceiptNotFoundError while it is still in flight.
      // "Not found" and "not mined yet" are indistinguishable here, and treating
      // both as pending is the honest reading: the caller keeps polling and
      // eventually times out rather than being told something false.
      return jsonResponse({ state: "pending" } satisfies ReceiptState);
    }
  }

  if (body.action !== "preview") {
    return jsonResponse({ error: '`action` must be "preview" or "receipt".' }, 400);
  }

  if (typeof body.owner !== "string" || !isAddress(body.owner)) {
    return jsonResponse({ error: "`owner` must be a valid EVM address." }, 400);
  }
  const owner = getAddress(body.owner);

  if (typeof body.label !== "string" || body.label.trim() === "" || body.label.length > 200) {
    return jsonResponse({ error: "`label` must be a non-empty string of at most 200 characters." }, 400);
  }

  // Optional, and absent means the maximum the field holds — see the header.
  let capWei: bigint = UINT128_MAX;
  if (body.capWei !== undefined && body.capWei !== null) {
    try {
      if (typeof body.capWei !== "string") throw new Error("not a string");
      capWei = BigInt(body.capWei);
    } catch {
      return jsonResponse({ error: "`capWei` must be a decimal integer string, or omitted for the uint128 maximum." }, 400);
    }
  }
  if (capWei <= 0n) {
    return jsonResponse(
      { error: "`capWei` must be greater than zero: PersonalVault._validateVaultPolicy rejects a zero aggregate cap." },
      400,
    );
  }
  // uint128 in NuvemTypes.VaultPolicy.
  if (capWei > UINT128_MAX) {
    return jsonResponse({ error: "`capWei` exceeds uint128." }, 400);
  }

  const protocol = await readProtocol(client, config);
  if (!protocol.configuration.ok) {
    return jsonResponse(
      {
        error:
          "VaultFactory.protocolConfiguration() could not be read, and a vault cannot be built without it — the " +
          "component addresses are not ours to guess. " +
          protocol.configuration.error,
      },
      502,
    );
  }
  const onchain = protocol.configuration.value;

  const userSalt = keccak256(stringToHex(body.label));
  const initData = encodeAbiParameters(
    [vaultInitializationParam],
    [
      {
        weth: onchain.weth,
        pauseController: onchain.pauseController,
        attesterRegistry: onchain.attesterRegistry,
        settlementExecutor: onchain.settlementExecutor,
        policy: {
          maxAggregateRolling30dWei: capWei,
        },
      },
    ],
  );

  const [cohort, prediction] = await Promise.all([
    readCohort(client, config, config.cohortId),
    predictVault(client, config, owner, userSalt, config.cohortId, initData),
  ]);

  // Simulated through our pinned RPC so a revert is reported by name
  // (VaultAdminAlreadyRegistered, TradingAccountAlreadyLinked, InvalidCohort,
  // VaultAlreadyExists…) BEFORE the user is asked to sign anything.
  //
  // Two lines, because a viem revert puts the useful part on the second one:
  //
  //   The contract function "createVault" reverted.
  //   Error: VaultAdminAlreadyRegistered(address vaultAdmin, address vault)
  //
  // and through errorSummary, because on a TRANSPORT failure (unreachable
  // endpoint, timeout, or an Alchemy 429) viem puts `URL: <endpoint with API
  // key>` on that same second line, and this string is returned to the browser.
  let simulationError: string | null = null;
  try {
    await client.simulateContract({
      address: getAddress(config.factory),
      abi: vaultFactoryAbi,
      functionName: "createVault",
      args: [userSalt, Number(config.cohortId), initData],
      account: owner,
    });
  } catch (error) {
    simulationError = errorSummary(error, config.rpcUrl, 2);
  }

  const preview: CreateVaultPreview = {
    userSalt,
    initData,
    cohortId: config.cohortId,
    cohortRegistered: cohort.ok ? cohort.value.registered : false,
    vaultId: prediction.ok ? prediction.value.vaultId : null,
    predicted: prediction.ok ? prediction.value.predicted : null,
    predictionError: prediction.ok ? null : prediction.error,
    simulationError,
  };
  return jsonResponse(preview);
}
