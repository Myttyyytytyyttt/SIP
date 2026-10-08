// The real PrivyPolicyClient and ProbeChain: @privy-io/node and @solana/web3.js
// behind the interfaces src/privy-policy-cli.ts decides against.
//
// TRANSLATION ONLY. Nothing here chooses or interprets; an SDK error propagates
// untouched so classifyPrivyError sees its real shape (status, and Privy's
// `code` in the parsed body). Secrets are revealed inside the call that needs
// them and nowhere else, as in privy-signer.ts.
//
// THE TRANSPORT IS PINNED, NOT INHERITED. The client comes from
// pinnedPrivyClient (privy-signer.ts), the one place the keeper builds one:
//   * apiUrl and logLevel are set there. Left out, the SDK takes
//     PRIVY_API_BASE_URL and PRIVY_API_LOG from the environment, and the first
//     sends the app secret to whatever host it names. The third variable the
//     SDK reads, PRIVY_API_CUSTOM_HEADERS, has no option that overrides it, so
//     the CLI refuses all three by name before a client is built.
//   * maxRetries is 0: ONE ATTEMPT PER REQUEST. The SDK otherwise re-sends on
//     408, 409, 429, 5xx and dropped connections, POSTs included, with no
//     idempotency key of its own. A key quorum that landed behind a 504 would be
//     created again, and `create` could no longer say which objects exist.

import { randomUUID } from "node:crypto";
import type { PrivyClient } from "@privy-io/node";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Secret } from "@sip/solana-log";
import type { PrivyPolicyClient, ProbeChain } from "./privy-policy-cli.js";
import type { KeeperPolicy } from "./privy-policy.js";
import { SOLANA_MAINNET_CAIP2, pinnedPrivyClient } from "./privy-signer.js";
import { poolFetch } from "./rpc-pool.js";

/** The rules type Privy's SDK takes, read off its own create method. */
type SdkRules = Parameters<ReturnType<PrivyClient["policies"]>["create"]>[0]["rules"];

/**
 * The rules as Privy's create and update bodies take them. One translation, so
 * the two can never send different rules.
 *
 * EACH CONDITION GOES AS BUILT, a plain copy with every field it has: a string
 * value stays a string (spreading one into a list would send its characters),
 * and the instruction_name condition keeps its `idl`.
 *
 * PAST THE SDK'S TYPES, ON PURPOSE. @privy-io/node 0.28 predates Privy's
 * solana_instruction_data source: its condition union has no `idl`, so the type
 * checker refuses the one condition the policy rests on. The SDK sends the body
 * it is handed as JSON (resources/policies.js passes it through), so the cast
 * changes what tsc sees and not the request; test/privy-policy-client.test.ts
 * reads the request body to prove the IDL arrives.
 */
function ruleBodies(policy: KeeperPolicy): SdkRules {
  return policy.rules.map((rule) => ({
    name: rule.name,
    method: rule.method,
    action: rule.action,
    conditions: rule.conditions.map((condition) => JSON.parse(JSON.stringify(condition)) as unknown),
  })) as unknown as SdkRules;
}

export interface PrivyPolicyClientOptions {
  /** Tests only: a fetch that answers in-process, so the transport settings above are checked with no network. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createPrivyPolicyClient(
  credentials: { readonly appId: string; readonly appSecret: Secret },
  options: PrivyPolicyClientOptions = {},
): PrivyPolicyClient {
  const privy = pinnedPrivyClient({ appId: credentials.appId, appSecret: credentials.appSecret.reveal(), fetch: options.fetch });
  const authorization = (key: Secret): { authorization_private_keys: string[] } => ({ authorization_private_keys: [key.reveal()] });
  return {
    async createKeyQuorum({ publicKey, displayName }) {
      const quorum = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: displayName });
      return { id: quorum.id };
    },

    async getKeyQuorum(keyQuorumId) {
      // A GET takes no authorization signature — only the app id and secret
      // (the SDK threads prepareRequest through update and delete alone). That
      // is what makes `key` possible: the credentials already proven good read
      // the ground truth the questionable credential is measured against.
      const quorum = await privy.keyQuorums().get(keyQuorumId);
      // EVERY KIND OF MEMBER, not only the direct keys. A nested quorum or a
      // user holds keys that authorize exactly as these do and that this read
      // cannot see, and compareWithQuorum needs to know they exist before it
      // calls a key missing.
      return {
        id: quorum.id,
        authorizationKeys: (quorum.authorization_keys ?? []).map((entry) => ({
          publicKey: entry.public_key,
          displayName: entry.display_name,
        })),
        keyQuorumIds: quorum.key_quorum_ids ?? [],
        userIds: quorum.user_ids ?? [],
        authorizationThreshold: quorum.authorization_threshold,
      };
    },

    async createPolicy(policy, ownerId) {
      return privy.policies().create({
        // Already one attempt; the key keeps it one policy if anything between here and Privy re-sends it.
        idempotency_key: randomUUID(),
        version: policy.version,
        name: policy.name,
        chain_type: policy.chain_type,
        rules: ruleBodies(policy),
        owner_id: ownerId,
      });
    },

    async updatePolicy(policyId, policy, adminKey) {
      // SIGNED BY THE POLICY'S OWNER. The SDK signs the PATCH with the keys in
      // authorization_context (prepareRequest), and Privy accepts it only from
      // the owner quorum. No idempotency key: the same PATCH sent twice leaves
      // the same policy, and this client sends it once.
      return privy.policies().update(policyId, { name: policy.name, rules: ruleBodies(policy), authorization_context: authorization(adminKey) });
    },

    async getPolicy(policyId) {
      return privy.policies().get(policyId);
    },

    async getWallet(walletId) {
      return privy.wallets().get(walletId);
    },

    async signMessage(walletId, message, authorizationKey) {
      // BYTES, NOT A STRING: the SDK assumes a string message is already base64
      // (public-api/services/solana.js) and would sign the decoding of it.
      const response = await privy.wallets().solana().signMessage(walletId, { message, authorization_context: authorization(authorizationKey) });
      return { signature: response.signature };
    },

    async signAndSendTransaction(walletId, transaction, authorizationKey) {
      const response = await privy
        .wallets()
        .solana()
        .signAndSendTransaction(walletId, {
          caip2: SOLANA_MAINNET_CAIP2 as `${string}:${string}`,
          transaction: Buffer.from(transaction).toString("base64"),
          authorization_context: authorization(authorizationKey),
        });
      return { hash: response.hash };
    },
  };
}

/** Failover under the transport, as in the keeper: the endpoints are Secrets because they carry API keys. */
export function createProbeChain(rpcUrls: readonly Secret[]): ProbeChain {
  const connection = new Connection(rpcUrls[0]!.reveal(), { commitment: "confirmed", fetch: poolFetch(rpcUrls) });
  return {
    genesisHash: () => connection.getGenesisHash(),
    latestBlockhash: async () => (await connection.getLatestBlockhash("confirmed")).blockhash,
    balanceLamports: (address) => connection.getBalance(new PublicKey(address), "confirmed"),
  };
}
