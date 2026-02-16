import * as React from "react";
import { cn } from "@/lib/utils";

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "secondary" | "outline";
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const base =
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold";
  const variants: Record<string, string> = {
    default: "border-slate-200 bg-slate-100 text-slate-700",
    secondary: "border-blue-200 bg-blue-50 text-blue-700",
    outline: "border-slate-300 bg-transparent text-slate-700",
  };

  return <div className={cn(base, variants[variant], className)} {...props} />;
}
