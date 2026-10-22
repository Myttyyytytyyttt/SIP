/**
 * Structured data in the server's HTML (src/lib/json-ld.ts says what and why).
 *
 * A DATA BLOCK, NOT A SCRIPT: the browser never runs it, so the CSP has nothing
 * to say about it, and React does not warn about a <script> it renders on a
 * client navigation when its type is not JavaScript. The text is escaped for
 * the inside of a <script> element (serializeJsonLd).
 */

import { serializeJsonLd, type JsonLdDocument } from "@/lib/json-ld";

export function JsonLd({ data }: { readonly data: JsonLdDocument }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
