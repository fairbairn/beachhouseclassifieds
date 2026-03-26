import type { HTMLAttributes } from "react";

import { cn } from "@/core/ui/cn";

export function Separator({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("h-px w-full bg-slate-200 dark:bg-slate-800", className)}
      {...props}
    />
  );
}
