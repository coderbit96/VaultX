import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

type LoadingIndicatorProps = {
  label?: string;
  showLabel?: boolean;
  className?: string;
};

export function LoadingIndicator({ label = "Loading", showLabel = false, className }: LoadingIndicatorProps) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-muted", className)}>
      <LoaderCircle aria-hidden="true" size={18} className="motion-safe:animate-spin" />
      <span className={showLabel ? "" : "sr-only"}>{label}</span>
    </span>
  );
}
