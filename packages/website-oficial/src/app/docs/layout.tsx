/**
 * /docs — how SaverFi works, page by page (owner, 10-22: "una página simple como
 * si fuera GitBook o Mintlify… un apartado a la izquierda dinámico que es el
 * índice, después la parte central que es el contenido que va de centro a
 * derecha").
 *
 * THREE PARTS: a slim bar on top, the index on the left (sticky, and scrolling
 * on its own, from lg; a drawer below it), and the page from the centre to the
 * right, at a width a paragraph can be read at.
 *
 * PUBLIC, AND OUTSIDE THE (dashboard) ROUTE GROUP: that layout mounts the Privy
 * provider for every visitor, and reading the docs needs no wallet. Nothing here
 * imports wallet code.
 *
 * LINKED AND INDEXED (owner, 10-22): the header, the footer and the landing
 * link the first page, and every page says index, follow (DOCS_ROBOTS, set here
 * and again on each page, with its own canonical address and social card).
 */

import type { Metadata } from "next";

import { DocsSidebar, DocsTopBar } from "@/components/docs/docs-chrome";
import { DOCS_ROBOTS } from "@/lib/docs/pages";

export const metadata: Metadata = {
  title: "SaverFi Docs",
  description: "How SaverFi works: saving from your trades, investing your savings, and who controls what.",
  robots: DOCS_ROBOTS,
};

export default function DocsLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <DocsTopBar />
      <div className="mx-auto flex w-full max-w-[90rem] flex-1">
        {/* self-start and its own height: a stretched flex item is as tall as the page, and would never stick. */}
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-72 shrink-0 self-start overflow-y-auto overscroll-contain border-r px-4 py-8 lg:block">
          <DocsSidebar />
        </aside>
        <main className="min-w-0 flex-1 px-4 pt-8 pb-16 sm:px-6 lg:px-10 lg:pt-12 xl:px-16">{children}</main>
      </div>
    </div>
  );
}
