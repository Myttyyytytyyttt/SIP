/**
 * /docs/<slug> — one page of the docs: its group, its title and its one line
 * (from the index, src/lib/docs/pages.ts), its clip, its body (its own module,
 * src/app/docs/_content/<slug>.tsx), and the way on.
 *
 * STATIC: every page is built ahead from the index, and an address that is not
 * in it is a 404 — `dynamicParams = false` at the router, and notFound() here
 * for anything that reaches the page some other way.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DOC_CONTENT } from "@/app/docs/_content";
import { Clip } from "@/components/docs/docs-clip";
import { DocsPager } from "@/components/docs/docs-nav";
import { LABEL } from "@/lib/classes";
import { DOC_PAGES, DOCS_ROBOTS, docPage, docTitle, type DocSlug } from "@/lib/docs/pages";

type Props = { readonly params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams(): { slug: DocSlug }[] {
  return DOC_PAGES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = docPage((await params).slug);
  if (page === null) notFound();
  return { title: docTitle(page), description: page.description, robots: DOCS_ROBOTS };
}

export default async function DocsPage({ params }: Props) {
  const page = docPage((await params).slug);
  if (page === null) notFound();
  const Body = DOC_CONTENT[page.slug];

  return (
    <article className="mx-auto w-full max-w-[46rem]">
      <header>
        <p className={LABEL}>{page.group}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{page.title}</h1>
        <p className="mt-3 text-lg text-pretty text-muted-foreground">{page.description}</p>
      </header>
      <Clip slug={page.slug} className="mt-8" />
      <div data-slot="docs-body" className="mt-10">
        <Body />
      </div>
      <DocsPager slug={page.slug} />
    </article>
  );
}
