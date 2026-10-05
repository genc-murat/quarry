import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  /** Body content, e.g. the SQL that will run. */
  children?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this exact text to enable confirmation. */
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  destructive = false,
  requireText,
  busy = false,
  onConfirm,
  onClose,
}: Props) {
  const [typed, setTyped] = useState("");

  // Reset the typed confirmation whenever the dialog reopens.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const ready = !requireText || typed.trim() === requireText;

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
            onClick={onConfirm}
            disabled={!ready || busy}
          >
            {busy ? "Running…" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireText ? (
        <div className="mt-4">
          <Label htmlFor="confirm-text" className="mb-2 flex items-center gap-1.5 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Type <span className="font-mono">{requireText}</span> to confirm
          </Label>
          <Input
            id="confirm-text"
            value={typed}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) onConfirm();
            }}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
