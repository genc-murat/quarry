import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  children?: React.ReactNode;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  confirmLabel = "Save",
  destructive = false,
  busy = false,
  children,
  onConfirm,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={!value.trim() || busy}
            onClick={() => onConfirm(value.trim())}
          >
            {busy ? "Running…" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <Label htmlFor="prompt-value" className="mb-2 block">
        {label}
      </Label>
      <Input
        id="prompt-value"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) onConfirm(value.trim());
        }}
      />
    </Dialog>
  );
}
