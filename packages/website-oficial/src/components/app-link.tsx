"use client";

/**
 * A link to one of the app's own pages that does nothing when it points at the
 * page already on screen.
 *
 * WHY IT IS NOT A PLAIN <Link>. Next navigates even to the URL that is already
 * showing, and that navigation REPLACES the current history entry's state with
 * its own. The new-user setup tags its entries (dashboard-shell.tsx,
 * setupState: "open" / "closed") so that Back and Forward carry the setup's
 * close with them; pressing the current tab or its footer link wiped that tag,
 * and Forward then landed on a page that no longer knew the setup was closed.
 * Now that the tabs carry ?mode, the current tab's href IS the current URL, so
 * this is every visitor's current tab, not a corner case.
 */

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";

type LinkProps = ComponentProps<typeof Link>;

export function AppLink({ href, onClick, ...rest }: Omit<LinkProps, "href"> & { readonly href: string }) {
  const click = (event: MouseEvent<HTMLAnchorElement>): void => {
    // Already here: no navigation, and no history entry rewritten.
    if (typeof window !== "undefined" && href === window.location.pathname + window.location.search) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return <Link href={href} onClick={click} {...rest} />;
}
