import { forwardRef } from "react";

import { cn } from "@/lib/utils";

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, id, ...props }, ref) => (
    <label
      htmlFor={id}
      className={cn("flex items-center gap-2 text-xs text-foreground", props.disabled && "opacity-60")}
    >
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          "h-3.5 w-3.5 shrink-0 rounded border border-border bg-surface accent-primary",
          className,
        )}
        {...props}
      />
      {label ? <span className="select-none">{label}</span> : null}
    </label>
  ),
);
Checkbox.displayName = "Checkbox";
