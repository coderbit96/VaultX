import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "min-h-12 w-full rounded-xl border border-line bg-input px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted/65 hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/30 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
});
