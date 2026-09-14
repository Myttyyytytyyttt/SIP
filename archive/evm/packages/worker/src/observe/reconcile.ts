// The per-(wallet, block) reconciler with a refusal path. DESIGN.md §3, rule by
// rule. Owner: reconcile.
//
// One wallet, one block, every transaction that touched it, cash at both
// boundaries. The block is the unit because the balance delta is the only
// witness to sell proceeds without a tracer, and a delta can be attributed only
// when exactly one thing in the block could have produced it. Everything else is
// a refusal: recorded, retried on later ticks, never attested. Fabricated volume
// is the one unforgivable output, so every branch that cannot name its number
// refuses instead of guessing.
//
// Trade shapes ported from the session engine of the project this was forked from (src/classify.ts (the)
// unit is the transaction, not the transfer: a buy is "cash out AND token in" in
// one atomic act, and splitting it loses the only thing that distinguishes it
// from a withdrawal plus an airdrop). The gas-only-when-sender rule and the
// 3-topic filter come from session-engine-old/src/window.ts.
//
// Every placed transaction carries `explained`: its contribution to the block's
// cash delta with gas left out (gas is summed once per block over the sent
// transactions). The residual for an undecoded sell and the closing identity of
// §3.4 are both written in these terms, so the one number a residual sell can
// claim is exactly the number the identity would otherwise report as missing.
//
// Which is why the residual has to be PROVED, not assumed: §3.4 can never
// contradict it, because it is defined as whatever §3.4 would otherwise call
// missing. Native cash reaches an EOA through internal calls that leave no log,
// so any other transaction in the block that moved native could have sent some
// back, and the residual would book that as volume the user never traded. A
// residual is therefore attributable only when nothing else in the block moved
// native value, and — when the venue paid in WETH, which moves only by Transfer
// log — only when the leftover equals the WETH the sell itself received.
//
// And a candidate block is nominated by a Transfer log, whose indexed fields any
// third party can fill with any address. A block where the wallet sent nothing
// and its cash did not move holds no trade of ours whatever such a log claims:
// it is excluded, never refused, because a refusal parks the wallet's cursor for
// the whole retention window and a stranger must not be able to do that.

import { ERC20_TRANSFER_TOPIC, WETH } from "../chain/constants.js";
import type {
  Address,
  BlockContext,
  Exclusion,
  ExclusionReason,
  Fill,
  Hex,
  ReconcileOutcome,
  RefusalReason,
  RpcLog,
  TxWithReceipt,
  VenueDecoder,
} from "../types.js";
import { ZERO_ADDRESS, normalize, topicAddress, wordToBigInt } from "./context.js";

/** What one transaction did to the wallet's token positions and WETH, read from its 3-topic Transfer logs. */
interface Legs {
  /** Distinct non-WETH tokens that arrived. */
  readonly tokensIn: readonly Address[];
  /** Distinct non-WETH tokens that left. */
  readonly tokensOut: readonly Address[];
  readonly wethIn: bigint;
  readonly wethOut: bigint;
  /** Every WETH leg had 0x0 on the other side: a mint or burn, i.e. the wallet wrapping or unwrapping. */
  readonly wethOnlyMintBurn: boolean;
}

function legsOf(logs: readonly RpcLog[], wallet: Address): Legs {
  const tokensIn = new Set<Address>();
  const tokensOut = new Set<Address>();
  let wethIn = 0n;
  let wethOut = 0n;
  let wethOnlyMintBurn = true;
  for (const log of logs) {
    // ERC-721 and ERC-404 share ERC-20's Transfer topic but carry the tokenId in
    // topics[3] and leave data empty, giving four topics instead of three. They
    // move no fungible balance, so ignoring them is lossless for the cash
    // identity — and decoding one throws, because BigInt("0x") is a SyntaxError.
    // That fires on ordinary GMGN buys of tokens that mint an NFT as a side
    // effect. (Ported from session-engine-old/src/window.ts.)
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const fromTopic = log.topics[1];
    const toTopic = log.topics[2];
    if (fromTopic === undefined || toTopic === undefined) continue;
    const from = topicAddress(fromTopic);
    const to = topicAddress(toTopic);
    if (from !== wallet && to !== wallet) continue;
    const token = normalize(log.address);
    if (token === WETH) {
      // WETH is cash, not a position: its legs are measured, never held.
      const amount = wordToBigInt(log.data);
      if (to === wallet && from !== wallet) {
        wethIn += amount;
        if (from !== ZERO_ADDRESS) wethOnlyMintBurn = false;
      }
      if (from === wallet && to !== wallet) {
        wethOut += amount;
        if (to !== ZERO_ADDRESS) wethOnlyMintBurn = false;
      }
      continue;
    }
    if (to === wallet && from !== wallet) tokensIn.add(token);
    if (from === wallet && to !== wallet) tokensOut.add(token);
  }
  return {
    tokensIn: [...tokensIn].sort(),
    tokensOut: [...tokensOut].sort(),
    wethIn,
    wethOut,
    wethOnlyMintBurn,
  };
}

/** One transaction, placed. `explained` is its share of the block's cash delta, gas excluded. */
type Shape =
  | { readonly kind: "fill"; readonly hash: Hex; readonly fill: Fill; readonly explained: bigint }
  | { readonly kind: "exclusion"; readonly hash: Hex; readonly reason: ExclusionReason; readonly explained: bigint }
  | {
      /** Sell-shaped with no decoder: its number is the block residual, decided in §3.3 once every other tx is placed. */
      readonly kind: "sell";
      readonly hash: Hex;
      readonly index: number;
      readonly token: Address;
      /** WETH the venue paid into this transaction, 0 when it paid native. The residual must match it. */
      readonly wethIn: bigint;
    }
  | { readonly kind: "refusal"; readonly hash: Hex; readonly reason: RefusalReason; readonly detail: string };

type SellShape = Extract<Shape, { kind: "sell" }>;
type RefusalShape = Extract<Shape, { kind: "refusal" }>;

const explainedBy = (shape: Shape): bigint => (shape.kind === "fill" || shape.kind === "exclusion" ? shape.explained : 0n);

/** §3.2: assigns one transaction exactly one shape. */
function classify(
  entry: TxWithReceipt,
  wallet: Address,
  blockL2: bigint,
  venues: readonly VenueDecoder[],
  sent: boolean,
  legs: Legs,
  quiet: boolean,
): Shape {
  const { tx, receipt } = entry;
  const hash = tx.hash;
  const exclusion = (reason: ExclusionReason, explained: bigint): Shape => ({ kind: "exclusion", hash, reason, explained });
  const refusal = (reason: RefusalReason, detail: string): Shape => ({ kind: "refusal", hash, reason, detail });

  // A reverted transaction moved nothing but still burned gas; the gas is
  // charged in the block sum when the wallet sent it.
  if (receipt.status === "reverted") return exclusion("REVERTED", 0n);

  // Venue decoders first, in trust order. They read the venue's own events, so
  // the number is exact and gross, and it does not matter who sent the tx.
  for (const venue of venues) {
    const decoded = venue.decode(entry, wallet);
    if (decoded === null) continue;
    const fill: Fill = {
      wallet,
      txHash: hash,
      blockL2,
      txIndex: tx.transactionIndex,
      side: decoded.side,
      venue: decoded.venue,
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      notionalWei: decoded.notionalWei,
      feeWei: decoded.feeWei,
      source: "venue",
    };
    // Buy: the gross notional left as cash, the venue's fee inside it. Sell:
    // the gross came back and the venue kept its fee before paying.
    const explained = decoded.side === "buy" ? -decoded.notionalWei : decoded.notionalWei - decoded.feeWei;
    return { kind: "fill", hash, fill, explained };
  }

  const value = tx.value;
  const toWallet = tx.to === wallet;
  const tokenIn = legs.tokensIn[0];
  const tokenOut = legs.tokensOut[0];
  const wethTouched = legs.wethIn > 0n || legs.wethOut > 0n;

  if (!sent) {
    // The wallet did not send this and paid no gas for it. Cash or tokens
    // LEAVING the wallet here is a relayed, delegated or allowance-based
    // movement the balance rules were not written for; without a decoder it
    // refuses. Cash or tokens ARRIVING is a deposit or an airdrop.
    if (tokenOut !== undefined) {
      // ANY THIRD PARTY CAN PUT THIS WALLET IN A TRANSFER LOG'S INDEXED FIELDS.
      // In a block where the wallet sent nothing and its cash did not move, no
      // sale of ours happened whatever the log says — and refusing would hold
      // the cursor for the whole retention window on a stranger's say-so,
      // voiding the real fills that come after it.
      if (quiet) return exclusion("AIRDROP", 0n);
      return refusal(
        "UNDECODED_SELL",
        `token ${legs.tokensOut.join(", ")} left the wallet in tx ${hash}, which the wallet did not send; no venue decoder recognised it`,
      );
    }
    if (legs.wethOut > 0n) {
      return refusal("UNEXPLAINED_INFLOW", `${legs.wethOut} wei of WETH left the wallet in tx ${hash}, which the wallet did not send`);
    }
    const received = (toWallet ? value : 0n) + legs.wethIn;
    if (tokenIn !== undefined) return exclusion("AIRDROP", received);
    return exclusion("NOT_A_TRADE", received);
  }

  // Sent by the wallet from here on.
  if (toWallet) return exclusion("SELF_TRANSFER", legs.wethIn - legs.wethOut);

  if (legs.tokensIn.length > 1 || legs.tokensOut.length > 1) {
    // One payment delivering several tokens, or several tokens sold for one
    // payment, is several fills netted into one transaction. The cash is exact
    // but cannot be split, and stamping it on one token would be a guess.
    return refusal(
      "MULTI_FILL_BLOCK",
      `tx ${hash} moved ${legs.tokensIn.length} distinct tokens in and ${legs.tokensOut.length} out; several fills netted in one transaction cannot be split`,
    );
  }

  if (tokenIn === undefined && tokenOut === undefined && wethTouched && legs.wethOnlyMintBurn) {
    // Wrap: value went to WETH and came back minted. Unwrap: WETH burned and the
    // native returned by internal call. A wrap nets to zero within cash BY
    // DEFINITION, so it explains nothing — and a "wrap" that did not net to
    // zero (value paid, less WETH minted, the rest kept by whoever was called)
    // fails the block identity and refuses. That is the right answer: cash left
    // for something that was not a wrap, and nothing here can say what.
    return exclusion("WETH_WRAP", 0n);
  }

  if (tokenIn !== undefined && tokenOut === undefined && (value > 0n || legs.wethOut > 0n)) {
    if (legs.wethIn > 0n) {
      return refusal(
        "UNEXPLAINED_INFLOW",
        `tx ${hash} paid for a token and also received ${legs.wethIn} wei of WETH; a buy with cash coming back cannot be priced from tx.value`,
      );
    }
    // Buy: the notional is what the wallet paid, exact from the transaction
    // itself — tx.value plus any WETH it sent — before any venue fee.
    const notional = value + legs.wethOut;
    const fill: Fill = {
      wallet,
      txHash: hash,
      blockL2,
      txIndex: tx.transactionIndex,
      side: "buy",
      venue: "unknown",
      tokenIn: value > 0n ? "native" : WETH,
      tokenOut: tokenIn,
      notionalWei: notional,
      feeWei: 0n,
      source: "value",
    };
    return { kind: "fill", hash, fill, explained: -notional };
  }

  if (tokenOut !== undefined && tokenIn === undefined && value === 0n && legs.wethOut === 0n) {
    return { kind: "sell", hash, index: tx.transactionIndex, token: tokenOut, wethIn: legs.wethIn };
  }

  if (tokenIn !== undefined && tokenOut !== undefined) {
    // No cash leg: cost basis is not derivable and there is no notional to
    // attest. With a cash leg beside it, it is more than one fill.
    if (value === 0n && !wethTouched) return exclusion("TOKEN_FOR_TOKEN", 0n);
    return refusal(
      "MULTI_FILL_BLOCK",
      `tx ${hash} moved tokens both ways and cash (${value} wei native out, ${legs.wethOut} WETH out, ${legs.wethIn} WETH in); a cash leg beside a token-for-token swap is more than one fill`,
    );
  }

  if (tokenIn !== undefined) {
    // A token arrived and nothing was paid: a claim or a free mint the wallet
    // triggered itself. No cash moved, so there is no volume to attest.
    if (legs.wethIn > 0n) {
      return refusal("UNEXPLAINED_INFLOW", `tx ${hash} sent by the wallet received a token and ${legs.wethIn} wei of WETH with nothing leaving`);
    }
    return exclusion("NOT_A_TRADE", 0n);
  }

  // No token arrived. Cash leaving is a plain send, a contract call with
  // value, or the vault pull; nothing leaving is gas only (the approve before
  // every GMGN sell). Both are NOT_A_TRADE and both contribute their gas.
  if (value > 0n || legs.wethOut > 0n) return exclusion("NOT_A_TRADE", legs.wethIn - value - legs.wethOut);
  if (legs.wethIn > 0n) {
    return refusal(
      "UNEXPLAINED_INFLOW",
      `tx ${hash} sent by the wallet received ${legs.wethIn} wei of WETH with nothing leaving; cash that appears without a counterparty movement cannot be attributed`,
    );
  }
  return exclusion("NOT_A_TRADE", 0n);
}

/**
 * Applies DESIGN.md §3 to one (wallet, block).
 *
 * Returns the fills and exclusions of the block, or a refusal. A refusal voids
 * every fill AND every exclusion of the block: the ledger sees either the whole
 * block placed or the one reason it was not, and the block is retried whole.
 */
export function reconcileBlock(context: BlockContext, venues: readonly VenueDecoder[]): ReconcileOutcome {
  const wallet = normalize(context.wallet);
  const blockL2 = context.blockL2;
  const txs = [...context.txs].sort((a, b) => a.tx.transactionIndex - b.tx.transactionIndex);
  const cashDelta = context.nativeAfter - context.nativeBefore + (context.wethAfter - context.wethBefore);
  const refuse = (reason: RefusalReason, detail: string): ReconcileOutcome => ({
    fills: [],
    exclusions: [],
    refusal: { wallet, blockL2, reason, detail },
  });

  let gasPaid = 0n;
  // Cash that reached the wallet from outside in this block: native value
  // addressed to it and WETH transferred to it, in transactions it did not
  // send. The block residual is only attributable when this is zero.
  let inflow = 0n;
  // Transactions the wallet sent with native value attached. Whatever they paid
  // could have come partly back by internal call, unseen, so a residual cannot
  // be told apart from their refund.
  const nativeMovers: Hex[] = [];
  // A Transfer log is enough to nominate a block, and a stranger writes its
  // indexed fields. Whether the wallet itself did anything here is what decides
  // if an unplaceable log is a movement or noise.
  const walletSent = txs.some((entry) => normalize(entry.receipt.from) === wallet);
  const quiet = !walletSent && cashDelta === 0n;
  const shapes: Shape[] = [];
  for (const entry of txs) {
    // Gas is borne by whoever sent the transaction; receipt.from is who
    // actually paid. An airdrop's 239 logs cost the wallet nothing.
    // (Ported from session-engine-old/src/window.ts.)
    const sent = normalize(entry.receipt.from) === wallet;
    if (sent) gasPaid += entry.receipt.gasUsed * entry.receipt.effectiveGasPrice;
    if (sent && entry.tx.value > 0n) nativeMovers.push(entry.tx.hash);
    const legs = entry.receipt.status === "success" ? legsOf(entry.receipt.logs, wallet) : legsOf([], wallet);
    if (!sent && entry.receipt.status === "success") {
      if (entry.tx.to === wallet) inflow += entry.tx.value;
      inflow += legs.wethIn;
    }
    shapes.push(classify(entry, wallet, blockL2, venues, sent, legs, quiet));
  }

  // §3.1 — a wallet with code (EIP-7702 delegation, a contract) can move cash
  // by paths the balance rules cannot see. Only venue decoders may produce
  // fills; anything trade-shaped they did not recognise refuses.
  if (context.hasCode) {
    const unsafe = shapes.find((shape) => shape.kind === "sell" || (shape.kind === "fill" && shape.fill.source === "value"));
    if (unsafe !== undefined) {
      return refuse(
        "WALLET_HAS_CODE",
        `wallet has code at block ${blockL2} and tx ${unsafe.hash} is trade-shaped with no venue decoder; balance reasoning is unsafe for a delegated or contract wallet`,
      );
    }
  }

  // §3.2 — the first transaction the rules could not place refuses the block.
  const unplaced = shapes.find((shape): shape is RefusalShape => shape.kind === "refusal");
  if (unplaced !== undefined) return refuse(unplaced.reason, unplaced.detail);

  // §3.3 — at most one undecoded sell, in a block where nothing came in from
  // outside and nothing else the wallet sent moved native value: only then is
  // the leftover the sale's, and not the block's.
  const pending = shapes.filter((shape): shape is SellShape => shape.kind === "sell");
  if (pending.length > 1) {
    return refuse(
      "MULTI_FILL_BLOCK",
      `${pending.length} sell-shaped transactions without a venue decoder in one block (${pending.map((s) => s.hash).join(", ")}); one balance delta cannot be split between them`,
    );
  }
  const resolved: Shape[] = [...shapes];
  const sell = pending[0];
  if (sell !== undefined) {
    if (inflow > 0n) {
      return refuse(
        "UNEXPLAINED_INFLOW",
        `${inflow} wei arrived from outside the wallet in the same block as undecoded sell ${sell.hash}; the residual would count it as proceeds`,
      );
    }
    // Native value paid out by another of the wallet's own transactions can come
    // partly back inside the same block by an internal call no log records. The
    // residual, being whatever the balances do not otherwise explain, would
    // charge the user for that refund as if it were proceeds — and §3.4 cannot
    // object, because the residual is defined as the number §3.4 wants. So the
    // leftover is only this sell's when nothing else in the block moved native.
    if (nativeMovers.length > 0) {
      return refuse(
        "UNEXPLAINED_INFLOW",
        `undecoded sell ${sell.hash} shares its block with ${nativeMovers.length} transaction(s) the wallet sent carrying native value (${nativeMovers.join(", ")}); anything they sent back would be priced as proceeds`,
      );
    }
    // The residual: what the block's cash did that nothing else explains. With
    // an approve beside the sell this is exactly §3.3's cashDelta + gasPaid;
    // subtracting every other placed term keeps it right when a WETH-priced buy
    // or a venue fill shares the block. The venue's fee is invisible here, so a
    // residual notional is net of it — a lower bound of the gross, never above it.
    const others = shapes.reduce((sum, shape) => sum + explainedBy(shape), 0n);
    const residual = cashDelta + gasPaid - others;
    if (residual <= 0n) {
      return refuse(
        "UNDECODED_SELL",
        `sell-shaped tx ${sell.hash} has no venue decoder and the block residual is ${residual} wei (cashDelta ${cashDelta}, gasPaid ${gasPaid}, otherwise explained ${others}); no positive proceeds to attribute`,
      );
    }
    // Paid in WETH, the proceeds are stated rather than inferred: WETH moves
    // only by Transfer log, and the sell's own log carries the amount. A
    // leftover that disagrees with it is cash from somewhere else in the block.
    if (sell.wethIn > 0n && residual !== sell.wethIn) {
      return refuse(
        "UNEXPLAINED_INFLOW",
        `undecoded sell ${sell.hash} was paid ${sell.wethIn} wei of WETH but the block's leftover is ${residual} wei; the difference has no transaction to explain it`,
      );
    }
    const fill: Fill = {
      wallet,
      txHash: sell.hash,
      blockL2,
      txIndex: sell.index,
      side: "sell",
      venue: "unknown",
      tokenIn: sell.token,
      tokenOut: sell.wethIn > 0n ? WETH : "native",
      notionalWei: residual,
      feeWei: 0n,
      source: "residual",
    };
    const at = resolved.indexOf(sell);
    resolved[at] = { kind: "fill", hash: sell.hash, fill, explained: residual };
  }

  // §3.4 — every transaction is placed; the cash must now add up to the wei.
  // This is where the same-block approve's gas is absorbed: it is in gasPaid,
  // and a scan that missed it would show up here as exactly that gap.
  const explained = resolved.reduce((sum, shape) => sum + explainedBy(shape), 0n) - gasPaid;
  const gap = cashDelta - explained;
  if (gap !== 0n) {
    return refuse(
      "UNEXPLAINED_INFLOW",
      `cash moved ${gap} wei ${gap > 0n ? "more" : "less"} than the block explains (cashDelta ${cashDelta}, explained ${explained} after gas ${gasPaid})`,
    );
  }

  const fills: Fill[] = [];
  const exclusions: Exclusion[] = [];
  for (const shape of resolved) {
    if (shape.kind === "fill") fills.push(shape.fill);
    else if (shape.kind === "exclusion") exclusions.push({ wallet, txHash: shape.hash, blockL2, reason: shape.reason });
  }
  return { fills, exclusions, refusal: null };
}
