import type { HTMLAttributes } from "react";

import { cn } from "@/core/ui/cn";

export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
        className,
      )}
      {...props}
    />
  );
}
