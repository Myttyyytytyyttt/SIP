/**
 * THE PIECES A DOCS PAGE IS WRITTEN WITH (owner, 10-22): headings, paragraphs,
 * lists, numbered steps, a note, a "Good to know" box and a link to another
 * page. Plain TSX, no MDX and no new dependency: a page body is a component in
 * src/app/docs/_content/<slug>.tsx that returns these.
 *
 * SERVER COMPONENTS: no state, nothing to hydrate. The page's title, its
 * description and its clip are not here: the page around the body draws them
 * from the index (src/lib/docs/pages.ts), so a body starts with its first
 * paragraph.
 *
 * ONE SIZE OF TEXT FOR THE BODY, and the spacing is the pieces' own, so a writer
 * never sets a margin: a heading keeps its distance from what is above it, a
 * list from the paragraph before it.
 */

import { Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { LABEL } from "@/lib/classes";
import { docHref, docPage, type DocSlug } from "@/lib/docs/pages";
import { cn } from "@/lib/utils";

/** The body's text: a touch under the UI's 1rem lines would be too small to read at length, a touch over too loose. */
const BODY = "text-[0.95rem] leading-7";

/** "Saving from your profit" → "saving-from-your-profit": the anchor a heading gets when it is plain text. */
function anchorOf(children: ReactNode): string | undefined {
  if (typeof children !== "string") return undefined;
  const id = children
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return id === "" ? undefined : id;
}

/** A section of the page. Plain-text headings get an anchor of their own; pass `id` to choose it. */
export function H2({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <h2 id={id ?? anchorOf(children)} className="mt-12 scroll-mt-20 text-xl font-semibold tracking-tight text-balance first:mt-0">
      {children}
    </h2>
  );
}

/** A part of a section. */
export function H3({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <h3 id={id ?? anchorOf(children)} className="mt-8 scroll-mt-20 text-base font-semibold first:mt-0">
      {children}
    </h3>
  );
}

export function P({ children }: { readonly children: ReactNode }) {
  return <p className={cn(BODY, "mt-5 text-pretty first:mt-0")}>{children}</p>;
}

/** Bullets. The children are <li>s; a <ul> inside one nests, with a hollow bullet. */
export function List({ children }: { readonly children: ReactNode }) {
  return (
    <ul className={cn(BODY, "mt-5 ml-5 list-disc space-y-2 first:mt-0 marker:text-muted-foreground/70 [&_ul]:mt-2 [&_ul]:ml-5 [&_ul]:list-[circle] [&_ul]:space-y-1")}>
      {children}
    </ul>
  );
}

/**
 * Numbered steps, each number in a small circle. The children are <li>s, in
 * the order they are done.
 */
export function Steps({ children }: { readonly children: ReactNode }) {
  return (
    <ol
      className={cn(
        BODY,
        "mt-6 space-y-4 [counter-reset:step] first:mt-0",
        "[&>li]:relative [&>li]:pl-10 [&>li]:[counter-increment:step]",
        "[&>li]:before:absolute [&>li]:before:top-0 [&>li]:before:left-0 [&>li]:before:flex [&>li]:before:size-7 [&>li]:before:items-center [&>li]:before:justify-center [&>li]:before:rounded-full [&>li]:before:border [&>li]:before:bg-muted [&>li]:before:font-mono [&>li]:before:text-xs [&>li]:before:font-medium [&>li]:before:content-[counter(step)]",
      )}
    >
      {children}
    </ol>
  );
}

/**
 * A note beside the text. "note" is something worth knowing; "caution" is
 * something that catches people out ("Watch out"). Amber, not red: red on this
 * site is a transaction that did not land (src/lib/classes.ts), and not the
 * green accent either, which means money put aside and nothing else.
 */
const CALLOUT = {
  note: { icon: Info, title: "Note", frame: "border-border bg-muted/40", ink: "text-muted-foreground" },
  caution: { icon: TriangleAlert, title: "Watch out", frame: "border-amber-500/30 bg-amber-500/[0.06]", ink: "text-amber-700 dark:text-amber-400" },
} as const;

export function Callout({
  tone = "note",
  title,
  children,
}: {
  readonly tone?: keyof typeof CALLOUT;
  /** Defaults to "Note" or "Watch out". */
  readonly title?: string;
  /** Plain text, or a few <p>s. */
  readonly children: ReactNode;
}) {
  const { icon: Icon, title: fallback, frame, ink } = CALLOUT[tone];
  return (
    <aside role="note" className={cn("mt-6 flex gap-3 rounded-xl border p-4 text-sm leading-6 first:mt-0", frame)}>
      <Icon className={cn("mt-1 size-4 shrink-0", ink)} aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{title ?? fallback}</p>
        <div className="mt-1 text-muted-foreground [&>p+p]:mt-2">{children}</div>
      </div>
    </aside>
  );
}

/**
 * "Good to know": the few words a page uses that a reader may not, each with
 * its meaning. The children are <Term>s.
 */
export function GoodToKnow({ title = "Good to know", children }: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <aside className="mt-8 rounded-xl border bg-card p-5 first:mt-0">
      <p className={LABEL}>{title}</p>
      <dl className="mt-3 divide-y text-sm leading-6">{children}</dl>
    </aside>
  );
}

/** One entry of a GoodToKnow box: the word, then what it means. Side by side from sm, stacked on a phone. */
export function Term({ name, children }: { readonly name: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="font-medium">{name}</dt>
      <dd className="mt-1 text-muted-foreground sm:mt-0">{children}</dd>
    </div>
  );
}

/** A link to another docs page by its slug, so a renamed or removed page fails to compile. Its title when no text is given. */
export function DocLink({ to, children }: { readonly to: DocSlug; readonly children?: ReactNode }) {
  return (
    <Link
      href={docHref(to)}
      className="rounded-sm font-medium underline decoration-foreground/30 underline-offset-4 transition-colors outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children ?? docPage(to)?.title}
    </Link>
  );
}
