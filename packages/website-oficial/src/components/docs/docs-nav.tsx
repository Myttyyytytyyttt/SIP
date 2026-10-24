/**
 * THE DOCS' INDEX ON THE LEFT, AND THE WAY ON AT THE BOTTOM (owner, 10-22: "un
 * apartado a la izquierda dinámico que es el índice").
 *
 * DocsNav is every group with its pages, read from src/lib/docs/pages.ts, the
 * current page marked, and the sub-page indented under its parent. It takes the
 * current page as a prop and holds no state, so the same list fills the desktop
 * sidebar and the phone's drawer, and a test can render it with any page
 * current. Which page is current is docs-chrome.tsx's question (the pathname).
 *
 * DocsPager is the Previous / Next pair at the bottom of every page, in the
 * index's own reading order.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { LABEL } from "@/lib/classes";
import { DOC_GROUPS, docHref, docNeighbours, type DocEntry, type DocPage, type DocSlug } from "@/lib/docs/pages";
import { cn } from "@/lib/utils";

export function DocsNav({
  current,
  onNavigate,
}: {
  /** The page on screen, or null (none is marked). */
  readonly current: DocSlug | null;
  /** Called as a link is pressed: the drawer closes itself with it. */
  readonly onNavigate?: () => void;
}) {
  const link = (page: DocPage) => {
    const here = page.slug === current;
    return (
      <Link
        href={docHref(page.slug)}
        aria-current={here ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "block rounded-md px-2 py-1.5 text-sm leading-5 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          here ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        {page.title}
      </Link>
    );
  };

  return (
    <nav aria-label="Docs" className="space-y-7">
      {DOC_GROUPS.map((group) => {
        const heading = `docs-group-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        return (
          <div key={group.title}>
            <p id={heading} className={cn(LABEL, "px-2")}>
              {group.title}
            </p>
            <ul aria-labelledby={heading} className="mt-2 space-y-0.5">
              {group.pages
                .filter((page) => page.parent === undefined)
                .map((page) => {
                  const children = group.pages.filter((child) => child.parent === page.slug);
                  return (
                    <li key={page.slug}>
                      {link(page)}
                      {children.length === 0 ? null : (
                        <ul className="mt-0.5 ml-3 space-y-0.5 border-l pl-2">
                          {children.map((child) => (
                            <li key={child.slug}>{link(child)}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function DocsPager({ slug }: { readonly slug: DocSlug }) {
  const { previous, next } = docNeighbours(slug);
  return (
    <nav aria-label="Previous and next page" className="mt-16 grid gap-3 border-t pt-8 sm:grid-cols-2">
      {previous === null ? null : <PagerLink page={previous} direction="previous" />}
      {next === null ? null : <PagerLink page={next} direction="next" />}
    </nav>
  );
}

function PagerLink({ page, direction }: { readonly page: DocEntry; readonly direction: "previous" | "next" }) {
  const next = direction === "next";
  return (
    <Link
      href={docHref(page.slug)}
      rel={next ? "next" : "prev"}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-xl border p-4 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50",
        // Next keeps the right-hand column even on the first page, where there is no Previous beside it.
        next && "flex-row-reverse text-right sm:col-start-2",
      )}
    >
      {next ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      ) : (
        <ChevronLeft className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn(LABEL, "block")}>{next ? "Next" : "Previous"}</span>
        <span className="mt-1 block text-sm font-medium text-pretty">{page.title}</span>
      </span>
    </Link>
  );
}
