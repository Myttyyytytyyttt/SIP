import type { Address, Hex, RpcLog, TxWithReceipt, VenueDecoder, VenueFill } from "../../types.js";
import { ERC20_TRANSFER_TOPIC, GMGN_ROUTER, WETH } from "../../chain/constants.js";

/**
 * The GMGN router decoder. Owner: venues.
 *
 * The router emits two wallet-indexed events per fill (DESIGN.md §1, verified against the four
 * recorded fills in test/fixtures/mainnet-4663.json):
 *
 *   FILL  topics [sig, wallet, wallet, 0x0]; data 16 words
 *         w00 = amountIn, w01 = amountOut (NET of the fee on sells), w05 = 1 (v3-style pool) or
 *         2 (v4 PoolManager), w06 = path tokenIn, w07 = path tokenOut — the cash leg is spelled
 *         WETH on v3 and address(0) on v4 — w08 = pool (v3), w13 = PoolManager (v4).
 *   FEE   topics [sig, 0x0, wallet]; data 2 words: w00 = fee wei, w01 = unix timestamp.
 *
 * Buy:  notional = w00, which must equal tx.value.       Sell: notional GROSS = w01 + fee.
 *
 * REFUSE RATHER THAN GUESS: every shape check below returns null instead of a best effort. A null
 * costs nothing — the reconciler still measures a buy from tx.value and a lone sell from the block
 * residual — whereas a wrong fill is fabricated volume, the one unforgivable output.
 */

export const GMGN_FILL_TOPIC = "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a" as const;
export const GMGN_FEE_TOPIC = "0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92" as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const FILL_WORDS = 16;
const FEE_WORDS = 2;
const KIND_V3 = 1n;
const KIND_V4 = 2n;

export const gmgn: VenueDecoder = {
  name: "gmgn",
  decode(entry: TxWithReceipt, wallet: Address): VenueFill | null {
    const { tx, receipt } = entry;
    const me = lower(wallet);

    // A DIRECT CALL BY THE WALLET, AND ONLY THAT. A reverted receipt has no fill; a call through
    // any intermediary puts the intermediary in the FILL's sender topic, not the wallet.
    if (receipt.status !== "success") return null;
    if (lower(tx.from) !== me) return null;
    if (tx.to === null || lower(tx.to) !== GMGN_ROUTER) return null;

    // EXACTLY ONE FILL AND ONE FEE, both from the router and both addressed to this wallet.
    // Several fills in one tx only expose the net — out of scope by written policy (§4.1).
    const fills: RpcLog[] = [];
    const fees: RpcLog[] = [];
    for (const log of receipt.logs) {
      if (lower(log.address) !== GMGN_ROUTER) continue;
      const sig = log.topics[0];
      if (sig === GMGN_FILL_TOPIC && log.topics.length === 4) {
        if (topicAddress(log.topics[1]) === me && topicAddress(log.topics[2]) === me) fills.push(log);
      } else if (sig === GMGN_FEE_TOPIC && log.topics.length === 3) {
        if (topicAddress(log.topics[2]) === me) fees.push(log);
      }
    }
    const fillLog = fills[0];
    const feeLog = fees[0];
    if (fills.length !== 1 || fees.length !== 1 || fillLog === undefined || feeLog === undefined) return null;

    const fill = dataWords(fillLog.data);
    const fee = dataWords(feeLog.data);
    if (fill === null || fill.length !== FILL_WORDS) return null;
    if (fee === null || fee.length < FEE_WORDS) return null;

    const amountIn = fill[0];
    const amountOut = fill[1];
    const kind = fill[5];
    const pathIn = fill[6] === undefined ? null : wordAddress(fill[6]);
    const pathOut = fill[7] === undefined ? null : wordAddress(fill[7]);
    const feeWei = fee[0];
    if (amountIn === undefined || amountOut === undefined || feeWei === undefined) return null;
    if (kind !== KIND_V3 && kind !== KIND_V4) return null;
    if (pathIn === null || pathOut === null) return null;

    // THE CASH LEG IS "native" WHETHER THE ROUTER SPELLS IT WETH (v3) OR address(0) (v4): the wallet
    // pays tx.value and receives unwrapped ETH either way. A path with two tokens or two cash legs is
    // not a cash fill.
    const tokenIn = asLeg(pathIn);
    const tokenOut = asLeg(pathOut);
    if ((tokenIn === "native") === (tokenOut === "native")) return null;

    // DIRECTION: tx.value > 0 ⇒ buy, else sell — then CROSS-CHECKED against the ERC-20 Transfer of
    // the token leg (token to the wallet ⇒ buy, from the wallet ⇒ sell). The two must agree.
    if (tx.value > 0n) {
      if (tokenIn !== "native" || tokenOut === "native") return null;
      if (amountIn !== tx.value) return null;
      if (!hasTokenTransfer(receipt.logs, tokenOut, me, "to")) return null;
      return { side: "buy", venue: "gmgn", tokenIn: "native", tokenOut, notionalWei: amountIn, feeWei };
    }
    if (tokenOut !== "native" || tokenIn === "native") return null;
    if (amountOut <= 0n) return null;
    if (!hasTokenTransfer(receipt.logs, tokenIn, me, "from")) return null;
    // GROSS ON BOTH SIDES: w01 is what the wallet received after the fee; add the fee back so a
    // round trip is measured on one basis (DESIGN.md §3).
    return { side: "sell", venue: "gmgn", tokenIn, tokenOut: "native", notionalWei: amountOut + feeWei, feeWei };
  },
};

/** A 3-topic ERC-20 Transfer of `token` with the wallet in the `to` (topics[2]) or `from` (topics[1]) slot. */
function hasTokenTransfer(logs: readonly RpcLog[], token: Address, wallet: Address, slot: "to" | "from"): boolean {
  const index = slot === "to" ? 2 : 1;
  return logs.some(
    (log) =>
      lower(log.address) === token &&
      log.topics.length === 3 &&
      log.topics[0] === ERC20_TRANSFER_TOPIC &&
      topicAddress(log.topics[index]) === wallet,
  );
}

function asLeg(address: Address): Address | "native" {
  return address === WETH || address === ZERO_ADDRESS ? "native" : address;
}

/** Splits `0x…` log data into 32-byte words; null when the length is not a whole number of words. */
function dataWords(data: Hex): readonly bigint[] | null {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) return null;
  const out: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return out;
}

/** The address a 32-byte topic encodes; null unless the upper 12 bytes are zero. */
function topicAddress(topic: Hex | undefined): Address | null {
  if (topic === undefined || topic.length !== 66) return null;
  const body = topic.slice(2).toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(body)) return null;
  return `0x${body.slice(24)}`;
}

/** The address a data word encodes; null unless it fits in 20 bytes. */
function wordAddress(word: bigint): Address | null {
  if (word < 0n || word >= 1n << 160n) return null;
  return `0x${word.toString(16).padStart(40, "0")}`;
}

function lower(address: Address): Address {
  return address.toLowerCase() as Address;
}
