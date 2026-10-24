"use client";

/**
 * Its children on one pathname, and nothing anywhere else.
 *
 * FOR THE LANDING'S STRUCTURED DATA (owner, 10-22). "/" is a page of the
 * (dashboard) group, and its frame draws the landing INSTEAD of the page for a
 * visitor (dashboard-shell.tsx's Body), so anything the page itself renders
 * never reaches the HTML a search engine reads. The group's layout renders this
 * beside the frame instead, and a server layout cannot know the path — only the
 * router can, here, on the server render as in the browser.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function OnlyAtPath({ path, children }: { readonly path: string; readonly children: ReactNode }) {
  return usePathname() === path ? children : null;
}
