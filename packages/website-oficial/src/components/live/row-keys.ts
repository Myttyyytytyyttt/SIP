/**
 * A ROW'S KEY IS ITS TRANSACTION, NEVER ITS PLACE (10-09, G12).
 *
 * /activity keyed its rows by their position in the day, so one new row at the
 * top shifted every key under it and React remounted the whole day — any
 * entrance would have replayed on rows that were already there. The bar's chips
 * were keyed by signature alone, and one settle that pays two wallets is one
 * signature: two chips, one key.
 *
 * So: the signature, and how many times that signature has come up before in
 * the same list — `${signature}:${n}`, the scheme the adapter already gives the
 * strip's chips and the sidebar's events (live-mock.ts idsFor). A row arriving
 * above changes no key below it, because a new transaction is a new signature.
 *
 * One counter per list and per render: call this once, then once per row, in
 * order.
 */
export function keyBySignature(): (signature: string) => string {
  const seen = new Map<string, number>();
  return (signature) => {
    const n = seen.get(signature) ?? 0;
    seen.set(signature, n + 1);
    return `${signature}:${n}`;
  };
}
