// The account's wallet names in the browser (owner, 10-23): what one save's answer does to the names on screen
// when renames race, the few words a failure says in the name's place, and how the screen degrades when the
// store's budget is spent — names kept, pencil gone, nothing broken. Pure functions, no DOM.

import { describe, expect, it } from "vitest";

import { afterRead, failureWords, namesAfterAnswer, pencilAfterSave, refusalWords, type SaveAnswer } from "@/components/wallets/wallet-names-context";
import { RENAME_COPY } from "@/lib/live-copy";
import type { ApiFailure } from "@/lib/vault-api";
import { WALLET_NAME_COPY } from "@/lib/wallet-names";

const A = "WalletA111111111111111111111111111111111111";
const B = "WalletB111111111111111111111111111111111111";

const answerOf = (over: Partial<SaveAnswer>): SaveAnswer => ({
  address: A,
  name: "Alpha",
  before: null,
  save: 1,
  newest: 1,
  latest: true,
  pending: new Set(),
  answer: { [A]: "Alpha" },
  ...over,
});

describe("namesAfterAnswer", () => {
  it("takes the newest answer's whole list", () => {
    expect(namesAfterAnswer({ [A]: "Alpha" }, answerOf({ answer: { [A]: "Alpha", [B]: "From another device" } }))).toEqual({ [A]: "Alpha", [B]: "From another device" });
  });

  it("lets a wallet whose save is still on its way keep the name it shows, whatever the newest answer says", () => {
    // A renamed (slow), then B renamed (fast): B's answer comes first, from a server that has not saved A yet.
    const shown = { [A]: "Alpha", [B]: "Beta" };
    const next = namesAfterAnswer(shown, answerOf({ address: B, name: "Beta", save: 2, newest: 2, pending: new Set([A]), answer: { [B]: "Beta" } }));
    expect(next).toEqual({ [A]: "Alpha", [B]: "Beta" });
  });

  it("sets only its own wallet when an older answer arrives late, so it never undoes a newer rename of another", () => {
    const shown = { [A]: "Alpha", [B]: "Beta" };
    expect(namesAfterAnswer(shown, answerOf({ save: 1, newest: 2, answer: { [A]: "Alpha" } }))).toEqual({ [A]: "Alpha", [B]: "Beta" });
  });

  it("changes nothing when its wallet was renamed again since", () => {
    const shown = { [A]: "Second" };
    expect(namesAfterAnswer(shown, answerOf({ name: "First", save: 1, newest: 2, latest: false, pending: new Set([A]), answer: { [A]: "First" } }))).toBe(shown);
  });

  it("puts the old name back when the save fails — the default when there was none", () => {
    expect(namesAfterAnswer({ [A]: "New" }, answerOf({ name: "New", before: "Old", answer: null }))).toEqual({ [A]: "Old" });
    expect(namesAfterAnswer({ [A]: "New", [B]: "Beta" }, answerOf({ name: "New", before: null, answer: null }))).toEqual({ [B]: "Beta" });
  });

  it("leaves a newer rename of the same wallet alone when an older save fails, and still undoes its own name", () => {
    // The newer save is on its way: its answer decides.
    const shown = { [A]: "Second" };
    expect(namesAfterAnswer(shown, answerOf({ name: "First", before: "Original", save: 1, newest: 2, latest: false, pending: new Set([A]), answer: null }))).toBe(shown);
    // The newer save already failed and put "First" back: the older one's failure takes it back to the original.
    expect(namesAfterAnswer({ [A]: "First" }, answerOf({ name: "First", before: "Original", save: 1, newest: 2, latest: false, answer: null }))).toEqual({ [A]: "Original" });
  });
});

describe("refusalWords", () => {
  it("says the broken rule short, in the name's place, with the rule's own sentence behind it", () => {
    expect(refusalWords(WALLET_NAME_COPY.tooLong)).toEqual({ message: RENAME_COPY.tooLong, detail: WALLET_NAME_COPY.tooLong });
    expect(refusalWords(WALLET_NAME_COPY.forbidden)).toEqual({ message: RENAME_COPY.forbidden, detail: WALLET_NAME_COPY.forbidden });
    expect(refusalWords("Something else.")).toEqual({ message: RENAME_COPY.failed, detail: "Something else." });
  });
});

const refusal = (status: number, code: string, message = ""): ApiFailure => ({ ok: false, status, code, message, retryAfterSeconds: null, body: {} });

describe("when the store's budget is spent (10-23: the short links come first)", () => {
  it("shows the account's names and the pencil after a read, and the names without it when the answer says paused", () => {
    expect(afterRead({ ok: true, status: 200, body: { names: { [A]: "Alpha" }, paused: false } })).toEqual({ names: { [A]: "Alpha" }, available: true, again: false });
    expect(afterRead({ ok: true, status: 200, body: { names: { [A]: "Alpha" }, paused: true } })).toEqual({ names: { [A]: "Alpha" }, available: false, again: false });
  });

  it("keeps the default names and no pencil when the read is not affordable, and does not ask again", () => {
    expect(afterRead(refusal(429, "names_budget"))).toEqual({ names: null, available: false, again: false });
    expect(afterRead(refusal(503, "names_off"))).toEqual({ names: null, available: false, again: false });
    expect(afterRead(refusal(401, "token_expired"))).toEqual({ names: null, available: false, again: false });
    // A moment's trouble is asked once more.
    expect(afterRead(refusal(503, "names_unavailable"))).toMatchObject({ names: null, available: false, again: true });
    expect(afterRead(refusal(429, "rate_limited"))).toMatchObject({ again: true });
  });

  it("takes the pencil away when a save is refused for the budget, or answered paused — and only then", () => {
    expect(pencilAfterSave(refusal(429, "names_budget"))).toBe(false);
    expect(pencilAfterSave({ ok: true, status: 200, body: { names: {}, paused: true } })).toBe(false);
    expect(pencilAfterSave({ ok: true, status: 200, body: { names: {}, paused: false } })).toBeNull();
    expect(pencilAfterSave(refusal(429, "rate_limited"))).toBeNull();
    expect(pencilAfterSave(refusal(503, "names_unavailable"))).toBeNull();
    expect(pencilAfterSave(null)).toBeNull();
  });

  it("says the budget's refusal as paused, in the name's place, the server's sentence behind it", () => {
    expect(failureWords(refusal(429, "names_budget", "Renaming wallets is paused for now. Retry in 600 s."))).toEqual({
      message: RENAME_COPY.paused,
      detail: "Renaming wallets is paused for now. Retry in 600 s.",
    });
    expect(failureWords(refusal(429, "rate_limited", "Too many requests from this client."))).toEqual({ message: RENAME_COPY.rateLimited, detail: null });
  });
});

describe("what a failure says in the name's place", () => {
  it("fits there whole: at most 20 characters, the room beside “Can’t settle yet” on a phone", () => {
    for (const words of [RENAME_COPY.failed, RENAME_COPY.rateLimited, RENAME_COPY.signIn, RENAME_COPY.tooLong, RENAME_COPY.forbidden, RENAME_COPY.tooManyNames, RENAME_COPY.paused]) {
      expect([...words].length, words).toBeLessThanOrEqual(20);
    }
  });
});
