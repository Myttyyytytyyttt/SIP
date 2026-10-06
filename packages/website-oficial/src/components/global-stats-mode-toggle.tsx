"use client";

/**
 * The header's Live|Mock control on the public dashboard.
 *
 * A REAL NAVIGATION, not the pension page's history.pushState: that page
 * decides what to show in the browser, this one decides on the server from the
 * URL, so the server has to be asked again.
 */

import { useRouter } from "next/navigation";

import { DataModeToggle } from "@/components/data-mode";
import { urlWithMode } from "@/lib/dashboard-mode";

export function GlobalStatsModeToggle({ mode, path }: { readonly mode: "live" | "mock"; readonly path: string }) {
  const router = useRouter();
  return (
    <DataModeToggle
      mode={mode}
      onModeChange={(next) => {
        if (next !== mode) router.push(urlWithMode(path, next));
      }}
    />
  );
}
