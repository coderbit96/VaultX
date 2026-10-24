import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "default" | "small" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover shadow-[0_8px_30px_rgba(181,219,151,0.12)]",
  secondary: "border border-line bg-raised text-foreground hover:border-line-strong hover:bg-elevated",
  ghost: "text-foreground hover:bg-raised",
  danger: "border border-danger/35 bg-danger/10 text-danger hover:bg-danger/20",
};

const sizes: Record<ButtonSize, string> = {
  default: "min-h-11 px-5 py-2.5 text-sm",
  small: "min-h-11 px-4 py-2 text-sm",
  icon: "min-h-11 min-w-11 p-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "primary", size = "default", type = "button", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none",
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
