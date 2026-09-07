import type { ReactNode } from "react";

import { MONO } from "@/lib/classes";
import { cn } from "@/lib/utils";

/** A number inside a sentence — mono and tabular like every other number on the page. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(MONO, className)}>{children}</span>;
}
