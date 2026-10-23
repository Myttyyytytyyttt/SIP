"use client";

/**
 * A WALLET'S NAME, AND THE PENCIL THAT RENAMES IT (owner, 10-23: "ponemos el
 * pequeño icono de lápiz al lado con opacidad media, hover con opacidad 100, y
 * si se hace click aparece la caja para editar el nombre y con el texto
 * preseleccionado todo").
 *
 * One component for every place a trading wallet's name can be changed: the
 * live column's wallet cards and the Manage wallets rows. The pencil sits right
 * after the name at half opacity, whole on hover and on keyboard focus; a press
 * swaps the name for a box holding it, focused, every character selected, so
 * typing replaces it. Enter or leaving the box saves, Escape puts it back.
 * Empty goes back to the default name; the same text saves nothing
 * (lib/wallet-names.ts renameOutcome).
 *
 * THE NEW NAME SHOWS AT ONCE (wallet-names-context.tsx), and a save that fails
 * puts the old one back and says so in the name's own place for a few seconds,
 * in a few words that fit there whole (RENAME_COPY), the rule it broke as their
 * tooltip — the card never grows a line for it. Pressing the pencil again ends
 * those seconds: an old failure never stands over a newer name. The box is as
 * tall as the pencil, so opening and closing it moves nothing.
 *
 * NO PENCIL WITHOUT A PLACE TO SAVE: without a names host that read the
 * account's names (a deployment with no store, a failed read) the name is
 * plain text — still as tall as the pencil once someone is signed in, so the
 * card does not move when the read lands and the pencil appears. Signed out
 * (the sample) it is exactly what the row showed before.
 *
 * AN INPUT METHOD'S ENTER IS NOT A SAVE. Japanese, Chinese and Korean typing
 * confirm a word with Enter, and Escape drops the word being composed: while a
 * composition is open, both keys are the input method's, and the box stays.
 *
 * ESCAPE IS THE BOX'S, NOT THE DIALOG'S. The column is also drawn inside the
 * header's sheet and the rows inside the wallets modal, and Radix closes both on
 * an Escape it hears on the document in the capture phase — before any handler
 * on the box. So while the box is open it listens on the window, which the
 * capture phase reaches first, and keeps an Escape meant for it to itself.
 */

import { Pencil } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { refusalWords, useWalletNames, type RenameFailure } from "@/components/wallets/wallet-names-context";
import { useFlash } from "@/hooks/use-flash";
import { RENAME_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import { WALLET_NAME_MAX_CHARS, renameOutcome } from "@/lib/wallet-names";

/** How long a failed save's words stand in for the name. */
const FAILURE_MS = 4_000;

export function WalletName({
  address,
  name,
  className,
}: {
  readonly address: string;
  /** The name on screen: the account's own, or the derived "Trading wallet N". */
  readonly name: string;
  /** The name's text style where it is drawn; the box keeps its own. */
  readonly className?: string;
}) {
  const { account, available, names, rename } = useWalletNames();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [failure, setFailure] = useState<RenameFailure | null>(null);
  const [failed, flashFailed] = useFlash(FAILURE_MS);
  const input = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  // An edit ends once: Enter, then the blur its unmount may fire, must not save twice.
  const ended = useRef(false);
  // Back to the pencil after Enter or Escape; after a blur the focus went where it was sent.
  const refocus = useRef(false);
  const hintId = useId();

  const open = () => {
    ended.current = false;
    // A new try: the last one's failure is over, whatever its seconds left.
    setFailure(null);
    setDraft(name);
    setEditing(true);
  };

  const fail = useCallback(
    (words: RenameFailure) => {
      setFailure(words);
      flashFailed();
    },
    [flashFailed],
  );

  const finish = useCallback(
    (save: boolean, keyboard: boolean) => {
      if (ended.current) return;
      ended.current = true;
      refocus.current = keyboard;
      setEditing(false);
      if (!save) return;
      const outcome = renameOutcome(input.current?.value ?? draft, name, names[address] ?? null);
      if (outcome.kind === "unchanged") return;
      if (outcome.kind === "invalid") {
        fail(refusalWords(outcome.message));
        return;
      }
      void rename(address, outcome.name).then((result) => {
        if (!result.ok) fail(result);
      });
    },
    [address, draft, fail, name, names, rename],
  );

  // Focused with every character selected, so the first key typed replaces the name.
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  // Escape, heard before the sheet or the modal hears it (see the header).
  useEffect(() => {
    if (!editing) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.target !== input.current) return;
      event.stopPropagation();
      event.preventDefault();
      finish(false, true);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [editing, finish]);

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    pencil.current?.focus();
  }, [editing]);

  if (!available) {
    const plain = <span className={cn("min-w-0 truncate", className)}>{name}</span>;
    return account ? <span className="flex h-6 min-w-0 items-center">{plain}</span> : plain;
  }

  if (editing) {
    return (
      <span className="flex h-6 min-w-0 flex-1 items-center">
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // keyCode 229: Safari's composing key, which it sends with isComposing already false.
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            finish(true, true);
          }}
          onBlur={() => finish(true, false)}
          // UTF-16 units: a name the box takes is never too long for the server, which counts characters.
          maxLength={WALLET_NAME_MAX_CHARS}
          aria-label={RENAME_COPY.input}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          data-wallet-name-input=""
          className="h-6 w-full min-w-0 rounded-md border border-input bg-background px-1.5 text-sm font-medium text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <span id={hintId} className="sr-only">
          {RENAME_COPY.hint}
        </span>
      </span>
    );
  }

  return (
    <span className="flex h-6 min-w-0 items-center gap-0.5">
      {failed && failure !== null ? (
        <span role="alert" title={failure.detail ?? undefined} className="min-w-0 truncate text-xs text-destructive">
          {failure.message}
          {failure.detail === null ? null : <span className="sr-only"> {failure.detail}</span>}
        </span>
      ) : (
        <span className={cn("min-w-0 truncate", className)}>{name}</span>
      )}
      <button
        ref={pencil}
        type="button"
        aria-label={RENAME_COPY.rename(name)}
        title={RENAME_COPY.rename(name)}
        onClick={open}
        data-wallet-rename=""
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-50 transition-opacity outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Pencil className="size-3" aria-hidden />
      </button>
    </span>
  );
}
