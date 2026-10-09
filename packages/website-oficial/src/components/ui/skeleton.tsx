import { cn } from "cn"

// motion-safe: for someone who asked their system for no motion the block
// stands still — its shape alone already says something is coming (10-09).
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("motion-safe:animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
