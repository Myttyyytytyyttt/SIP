/**
 * /prices, rendered. A SERVER COMPONENT WITH NO CLIENT HALF: no hook, no
 * effect, no fetch, no state. Everything it shows was read before the response
 * started (src/lib/prices-data.ts), so the page is complete in the HTML and a
 * reader with JavaScript off, a wallet they have not connected, or no wallet at
 * all sees every figure.
 *
 * THE ONE RULE THIS FILE ENFORCES: no number is printed without what makes it
 * checkable beside it — an age, a slot, an epoch, or the name of whoever said
 * it. `Figure` takes `from` and is the only way a value reaches the page, and
 * `Unread` is what a failed source renders instead. A block that cannot read its
 * source loses that block and nothing else.
 */
import type { ReactNode } from "react";

import type { Comparison, PricesModel, ShelfRow } from "@/lib/prices-data";
import { HERMES_EQUITY_SYMBOL } from "@/lib/prices-data";
import { formatAge, formatBps, formatUsd, isoFromUnix, type Reading } from "@/lib/prices-units";

const Section = ({ id, eyebrow, title, blurb, children }: { id: string; eyebrow: string; title: string; blurb: ReactNode; children: ReactNode }) => (
  <section id={id} className="border-t border-border/60 py-8 first:border-t-0 sm:py-10">
    <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">{eyebrow}</p>
    <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">{title}</h2>
    <div className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{blurb}</div>
    <div className="mt-6 space-y-4">{children}</div>
  </section>
);

/** One figure, its unit, and the thing that makes it checkable. `from` is not optional anywhere in this file. */
const Figure = ({ label, value, from, tone = "plain" }: { label: string; value: string; from: ReactNode; tone?: "plain" | "good" | "warn" }) => (
  <div className="rounded-lg border border-border/60 bg-card/50 p-4">
    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
    <p className={`mt-1 font-mono text-2xl ${tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>{value}</p>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{from}</p>
  </div>
);

/** What a source that did not answer renders. It carries the reason, because a reader learns more from the reason than from a gap. */
const Unread = ({ label, why }: { label: string; why: string }) => (
  <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4">
    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
    <p className="mt-1 text-sm font-medium text-foreground">could not be read</p>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{why}</p>
  </div>
);

/** A Reading rendered either way: the figure, or the reason there is none. */
function Read<T>({ label, reading, render }: { label: string; reading: Reading<T>; render: (value: T) => ReactNode }) {
  return reading.ok ? <>{render(reading.value)}</> : <Unread label={label} why={reading.why} />;
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[0.8em] break-all">{children}</span>;

const Grid = ({ children }: { children: ReactNode }) => <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;

/** The gap between two figures, or the sentence that says why no gap is shown. A premium is never printed on a hunch. */
const Gap = ({ label, gap, from }: { label: string; gap: Comparison; from: ReactNode }) =>
  gap.bps === null ? (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">not shown — the two sides are not the same quantity</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{gap.incomparable}</p>
    </div>
  ) : (
    <Figure label={label} value={formatBps(gap.bps)} from={from} tone={gap.bps > 500n || gap.bps < -500n ? "warn" : "plain"} />
  );

const ShelfCard = ({ row }: { row: ShelfRow }) => (
  <li className="rounded-lg border border-border/60 bg-card/50 p-4">
    <div className="flex items-baseline justify-between gap-3">
      <p className="font-semibold text-foreground">{row.symbol}</p>
      <p className={`text-xs font-medium ${row.offered ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{row.offered ? "on the shelf" : "not offered"}</p>
    </div>
    <p className="mt-0.5 text-xs text-muted-foreground">{row.name}</p>
    {row.offered ? (
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Every rule below passed at the reference leg. The keeper still re-measures depth and price inside the turn that spends the money.</p>
    ) : (
      <ul className="mt-3 space-y-2">
        {row.failures.map((failure) => (
          <li key={failure.rule} className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-mono text-[0.9em] text-foreground">{failure.rule}</span> — {failure.why}
          </li>
        ))}
      </ul>
    )}
    <p className="mt-3 text-[0.65rem] leading-relaxed text-muted-foreground/70">
      <Mono>{row.mint}</Mono>
    </p>
  </li>
);

export function PricesView({ model }: { model: PricesModel }) {
  const { sol, spyx, anthropic, guard } = model;
  const slot = model.slot === null ? "a slot the RPC did not report" : `slot ${model.slot}`;
  const chainClock = model.chain.ok ? `${isoFromUnix(model.chain.value.unixSeconds)} (epoch ${model.chain.value.epoch})` : "unread";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <header>
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">SaverFi · public</p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">Prices, and where every one of them comes from</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Read on the server, on mainnet, when this page was requested: no wallet, no session and no client-side fetch. Each figure is printed with
          its age, its slot or its source, because a number without its provenance goes stale in silence. Anything that would not read says so and
          takes nothing else down with it.
        </p>
        <dl className="mt-5 grid gap-x-8 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Accounts read at</dt>
            <dd>{slot}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Chain clock</dt>
            <dd>{chainClock}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Ages measured against</dt>
            <dd>the Clock sysvar, never this server&apos;s wall clock</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Page built at</dt>
            <dd>{model.builtAt} (this server&apos;s clock, used for nothing else)</dd>
          </div>
        </dl>
      </header>

      <Section
        id="sol"
        eyebrow="1 · Pyth, where it already stops money"
        title="SOL/USDC: the pool against the oracle"
        blurb={
          <>
            <p>
              This is the one place in SaverFi where an oracle is not decoration. Before the keeper converts a vault&apos;s saved SOL into the USDC a
              purchase is paid in, it prices that hop against Pyth&apos;s SOL/USD and USDC/USD push accounts and <strong>refuses the conversion</strong>{" "}
              when the oracle is too old or too far from the route it captured. Both bars are read from the keeper&apos;s own source, below.
            </p>
          </>
        }
      >
        <Grid>
          <Read
            label="Pool mid, SOL/USDC"
            reading={sol.pool}
            render={(pool) => (
              <Figure
                label="Pool mid, SOL/USDC"
                value={formatUsd(pool.microUsd)}
                from={
                  <>
                    Raydium CLMM <Mono>{pool.pool}</Mono>, sqrt price at {pool.slot === null ? "the slot read" : `slot ${pool.slot}`}. A mid, not a
                    quote: it is the price at zero size, before any fee or impact.
                  </>
                }
              />
            )}
          />
          <Read
            label="Pyth SOL/USD ÷ USDC/USD"
            reading={sol.oracle}
            render={(oracle) => (
              <Figure
                label="Pyth SOL/USD ÷ USDC/USD"
                value={formatUsd(oracle.microUsd)}
                from={
                  <>
                    SOL/USD {formatUsd(oracle.sol.microUsd)} published {formatAge(oracle.sol.ageSeconds)} ago; USDC/USD{" "}
                    {formatUsd(oracle.usdc.microUsd, 4)} published {formatAge(oracle.usdc.ageSeconds)} ago. Both accounts are owned by the Pyth
                    receiver and carry the feed ids this repository pins, or they are not read at all.
                  </>
                }
              />
            )}
          />
          <Read
            label="Pool against oracle"
            reading={sol.deviation}
            render={(bps) => (
              <Figure
                label="Pool against oracle"
                value={formatBps(bps)}
                tone={bps > guard.maxDeviationBps || -bps > guard.maxDeviationBps ? "warn" : "good"}
                from={<>Signed, as bps of the oracle&apos;s rate, taken in the same 1e18 unit the keeper&apos;s own gate compares in.</>}
              />
            )}
          />
        </Grid>

        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground">The guard that is already live</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            In <Mono>{guard.source}</Mono>, <Mono>{guard.decision}</Mono> will not price the SOL hop when the stalest of the two publishes is more
            than <strong>{guard.maxAgeSeconds.toString()} s</strong>{" "}behind the chain&apos;s clock, and skips the hop when the route it captured and
            the oracle disagree by more than <strong>{guard.maxDeviationBps.toString()} bps</strong>{" "}of the oracle&apos;s rate, in either direction.
            The keeper calls it from its investment tick, <Mono>{guard.calledFrom}</Mono>. A skipped hop means the vault&apos;s SOL stays SOL: the product
            would rather not buy than buy at a price nothing vouched for.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            The two numbers above are read out of that file by a test in this repository, so this paragraph cannot outlive the code it describes. What
            the keeper compares is the route it captured for the turn; this page compares the pinned pool&apos;s mid, which is the closest thing a
            public page can show without a wallet or a quote.
          </p>
          <div className="mt-4">
            <Read
              label="What the bars say about this reading"
              reading={sol.guard}
              render={(verdict) => (
                <Figure
                  label="What the bars say about this reading"
                  value={verdict.wouldConvert ? "both arms pass" : "would refuse"}
                  tone={verdict.wouldConvert ? "good" : "warn"}
                  from={
                    verdict.wouldConvert ? (
                      <>
                        At this reading the oracle is inside {guard.maxAgeSeconds.toString()} s and inside {guard.maxDeviationBps.toString()} bps, so a
                        conversion would be priced. It is a reading, not a promise: the keeper re-reads both at the moment it moves money.
                      </>
                    ) : (
                      <>{verdict.reasons.join("; ")}</>
                    )
                  }
                />
              )}
            />
          </div>
        </div>
      </Section>

      <Section
        id="spyx"
        eyebrow="2 · the xStock and its underlying"
        title="SPYx: the pool against Pyth's SPYX/USD"
        blurb={
          <p>
            SPYx is the only asset on this shelf that SaverFi reads a Pyth push account for. That account is refreshed by a third party on that
            party&apos;s schedule, not SaverFi&apos;s — an equity feed can be minutes or hours old — so the age sits beside the price and you can
            judge it instead of trusting it.
          </p>
        }
      >
        <Grid>
          <Read
            label="Pool mid, per SPYx token"
            reading={spyx.pool}
            render={(pool) => (
              <Figure
                label="Pool mid, per SPYx token"
                value={formatUsd(pool.microUsd)}
                from={
                  <>
                    Raydium CLMM <Mono>{spyx.poolAddress}</Mono> at {pool.slot === null ? "the slot read" : `slot ${pool.slot}`}. The pool trades RAW
                    units; the mint&apos;s live scaledUiAmount multiplier is folded in first, so this is a price for one token as a holder&apos;s
                    balance counts it.
                  </>
                }
              />
            )}
          />
          <Read
            label="Pyth Crypto.SPYX/USD"
            reading={spyx.feed}
            render={(feed) => (
              <Figure
                label="Pyth Crypto.SPYX/USD"
                value={formatUsd(feed.microUsd)}
                tone={feed.ageSeconds > 300n ? "warn" : "plain"}
                from={
                  <>
                    Push account <Mono>{feed.address}</Mono>, owned by the Pyth receiver, feed id <Mono>{feed.feedIdHex.slice(0, 16)}…</Mono>.
                    Published <strong>{formatAge(feed.ageSeconds)}</strong>{" "}before the chain&apos;s clock. Nobody in this product refreshes it.
                  </>
                }
              />
            )}
          />
          <Read
            label="Pool against the feed"
            reading={spyx.premium}
            render={(gap) => (
              <Gap
                label="Pool against the feed"
                gap={gap}
                from={
                  <>
                    Pool {formatUsd(gap.poolMicroUsd)} against the feed&apos;s {formatUsd(gap.referenceMicroUsd)}, as bps of the feed. Both sides are
                    priced per UI-scaled token. Read the age above before reading this: a gap against a reading that old is as much a fact about the
                    feed as about the pool.
                  </>
                }
              />
            )}
          />
        </Grid>
        <Read
          label="The mint's scaling"
          reading={spyx.mint}
          render={(mint) => (
            <p className="text-xs leading-relaxed text-muted-foreground">
              <strong className="text-foreground">Why the multiplier matters here.</strong> <Mono>{spyx.mintAddress}</Mono> has {mint.decimals}{" "}
              decimals and{" "}
              {mint.scaled ? (
                <>
                  carries Token-2022&apos;s scaledUiAmount extension with a multiplier of <Mono>{mint.multiplier.value}</Mono>
                  {mint.multiplier.fromNewRecord ? " (its scheduled record, whose timestamp has arrived)" : ""}
                  {mint.multiplier.pending === null ? "" : ` and ${mint.multiplier.pending.value} written for ${isoFromUnix(mint.multiplier.pending.effectiveAt)}`}. A
                  raw-unit price compared with a per-token price without folding that in would be off by about{" "}
                  {Math.round((mint.multiplier.value - 1) * 10_000)} bps — larger than most of the gaps this page exists to show.
                </>
              ) : (
                <>carries no scaledUiAmount extension, so a raw-unit price is already a per-token price.</>
              )}
            </p>
          )}
        />
      </Section>

      <Section
        id="anthropic"
        eyebrow="3 · the PreStock"
        title="ANTHROPIC: the pool, the issuer's own numbers, and the fee"
        blurb={
          <p>
            PreStocks publishes its own marks at <Mono>prestocks.com/api/prestocks</Mono> — public, keyless, and fetched here on the server. The
            issuer also controls the mint: the transfer fee below is read from the mint account, not from the API, and the rate written for a future
            epoch is read there too.
          </p>
        }
      >
        <Read
          label="Units"
          reading={anthropic.units}
          render={(units) => (
            <div className={`rounded-lg border p-4 ${units.comparable ? "border-border bg-card" : "border-amber-500/40 bg-amber-500/5"}`}>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Units, checked before any premium</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{units.comparable ? "the two sides count the same token" : "the two sides do NOT count the same token"}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{units.why}</p>
            </div>
          )}
        />
        <Grid>
          <Read
            label="Pool mid, per ANTHROPIC token"
            reading={anthropic.pool}
            render={(pool) => (
              <Figure
                label="Pool mid, per ANTHROPIC token"
                value={formatUsd(pool.microUsd)}
                from={
                  <>
                    Raydium CLMM <Mono>{anthropic.poolAddress}</Mono> at {pool.slot === null ? "the slot read" : `slot ${pool.slot}`}, the pool this
                    product pins for the leg&apos;s floor. It is not the route a purchase takes: the keeper buys through Jupiter, which picks its own.
                  </>
                }
              />
            )}
          />
          <Read
            label="PreStocks tokenPrice"
            reading={anthropic.api}
            render={(api) => (
              <Figure
                label="PreStocks tokenPrice"
                value={formatUsd(api.tokenMicroUsd)}
                from={
                  <>
                    The issuer&apos;s own figure, read from <Mono>prestocks.com/api/prestocks</Mono>{" "}when this page was requested. The API has no
                    timestamp in it, so its age is this request&apos;s age and nothing better; the entry was matched to the mint{" "}
                    <Mono>{api.contract}</Mono>, never to the symbol alone.
                  </>
                }
              />
            )}
          />
          <Read
            label="PreStocks markPrice"
            reading={anthropic.api}
            render={(api) => (
              <Figure
                label="PreStocks markPrice"
                value={formatUsd(api.markMicroUsd)}
                from={<>The issuer&apos;s mark for the same token, same answer, same request. The two differ because they are two different numbers the issuer publishes, not two readings of one.</>}
              />
            )}
          />
        </Grid>
        <Grid>
          <Read label="Pool against tokenPrice" reading={anthropic.premiumOverToken} render={(gap) => <Gap label="Pool against tokenPrice" gap={gap} from={<>Pool {formatUsd(gap.poolMicroUsd)} against {formatUsd(gap.referenceMicroUsd)}, as bps of the issuer&apos;s figure.</>} />} />
          <Read label="Pool against markPrice" reading={anthropic.premiumOverMark} render={(gap) => <Gap label="Pool against markPrice" gap={gap} from={<>Pool {formatUsd(gap.poolMicroUsd)} against {formatUsd(gap.referenceMicroUsd)}, as bps of the issuer&apos;s mark.</>} />} />
          <Read
            label="Transfer fee, from the mint"
            reading={anthropic.fee}
            render={(fee) =>
              fee === null ? (
                <Figure label="Transfer fee, from the mint" value="none" from={<>The mint carries no TransferFeeConfig, and an extension cannot be added after initialisation.</>} />
              ) : (
                <Figure
                  label="Transfer fee, from the mint"
                  value={`${fee.bps} bps`}
                  tone={fee.scheduled === null ? "plain" : "warn"}
                  from={
                    <>
                      In force since epoch {fee.sinceEpoch.toString()}, read from <Mono>{anthropic.mintAddress}</Mono>&apos;s TransferFeeConfig at the
                      epoch in the Clock sysvar above.{" "}
                      {fee.scheduled === null ? (
                        <>Nothing higher is written for a later epoch.</>
                      ) : (
                        <>
                          <strong>{fee.scheduled.bps} bps is already written for epoch {fee.scheduled.fromEpoch.toString()}</strong> — an epoch is
                          hours, and nobody signs for it. A floor signed today therefore nets {fee.netBps} bps, the higher of the two.
                        </>
                      )}
                    </>
                  }
                />
              )
            }
          />
        </Grid>
        <Read
          label="Depth at the size a purchase uses"
          reading={anthropic.depth}
          render={(depth) => (
            <div className="rounded-lg border border-border/60 bg-card/50 p-4">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Depth, at the size a purchase really uses</p>
              <p className="mt-1 font-mono text-2xl text-foreground">{formatUsd(depth.usdcRaw, 0)}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                USDC held by the pinned pool <Mono>{depth.pool}</Mono>, counted at {depth.slot === null ? "the slot read" : `slot ${depth.slot}`}{" "}from
                the vault the pool itself names. The size one leg of a full basket spends at this product&apos;s shipped caps is{" "}
                {formatUsd(model.reference.legRaw, 0)}, and an asset is only put on the shelf when a venue covers that{" "}
                {model.reference.venueMultiple.toString()}× — {formatUsd(model.reference.minVenueRaw, 0)}. This pool is one pinned price source, and
                the keeper counts the accounts the CHOSEN route names at the moment it spends, which is a different and smaller number: depth is a
                moment, not a property of an asset.
              </p>
            </div>
          )}
        />
      </Section>

      <Section
        id="shelf"
        eyebrow="4 · the eight PreStocks"
        title="Why each one is or is not offered"
        blurb={
          <p>
            The shelf is not hand-picked. It is every asset the rules in <Mono>@sip/solana-core</Mono>{" "}find nothing wrong with, and the sentences below
            are those rules&apos; own — measured on mainnet on the date each one names, not written for this page. A reader who disagrees with an
            exclusion can re-run its rule.
          </p>
        }
      >
        <ul className="grid gap-4 sm:grid-cols-2">
          {model.shelf.filter((row) => row.group === "prestock").map((row) => (
            <ShelfCard key={row.mint} row={row} />
          ))}
        </ul>
        <p className="text-xs leading-relaxed text-muted-foreground">
          SPYx is on the same shelf under the same rules and has its own block above. All eight PreStocks were read on {model.issuer.readOn} with one
          key — <Mono>{model.issuer.issuerKey}</Mono> — holding every one of their {model.issuer.oneKeyHolds.join(", ")} authorities
          {model.issuer.pausable ? ", and every one of them is pausable" : ""}. That is as true of the one that is offered as of the seven that are
          not, and it is why the transfer fee above is read from the mint on every request rather than remembered.
        </p>
      </Section>

      <Section
        id="underlying"
        eyebrow="the seam"
        title="What this page still cannot tell you"
        blurb={
          <p>
            A PreStock&apos;s <em>underlying</em> has no on-chain oracle here. SPYx above has a Pyth push account; {HERMES_EQUITY_SYMBOL}{" "}does not, and
            no figure on this page is the underlying company&apos;s price.
          </p>
        }
      >
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-5">
          <p className="text-sm font-semibold text-foreground">{HERMES_EQUITY_SYMBOL} — not read</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {model.hermes.kind === "absent" ? (
              <>
                Pyth&apos;s Hermes service serves equity feeds behind a credential, and this deployment has none: <Mono>{model.hermes.variable}</Mono>{" "}
                is not set. So the block that would sit here is empty on purpose, and the page is correct without it — the issuer&apos;s own marks
                above are the issuer&apos;s, not an independent price for the company.
              </>
            ) : (
              <>
                <Mono>{model.hermes.variable}</Mono> is set in this environment, but this build deliberately contains no Hermes request: the seam is
                marked and not filled. Until the fetch is written, server-side, with a publish age like every other figure here, nothing on this page
                is the underlying&apos;s price.
              </>
            )}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Where it goes: <Mono>src/lib/prices-data.ts</Mono>, beside the reads above. Server-side — the app&apos;s pinned Content-Security-Policy
            lists no such origin for the browser, and a credential has no business in a bundle.
          </p>
        </div>
      </Section>

      <footer className="border-t border-border/60 py-8 text-xs leading-relaxed text-muted-foreground">
        <p>
          Every figure here is a public account or a public API, read on the server at request time. Mids are mids: they are the price at zero size,
          before a fee, before impact, and before a router picks a venue. Nothing on this page is advice, and nothing on it is a quote you can trade
          on.
        </p>
      </footer>
    </main>
  );
}
