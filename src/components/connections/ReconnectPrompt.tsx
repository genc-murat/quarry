import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspace } from "@/stores/workspace";

/**
 * After a connection's settings are saved while a session for it is open, that
 * session is still using the settings it connected with. The app does not swap
 * the connection behind the user's back — it offers, and only that one session is
 * touched. Rendered once, next to the toaster, so both places that edit a
 * connection (the list and the explorer) reach it.
 */
export function ReconnectPrompt() {
  const offer = useWorkspace((s) => s.reconnectOffer);
  const dismiss = useWorkspace((s) => s.dismissReconnect);
  const reconnect = useWorkspace((s) => s.reconnectSession);
  const [busy, setBusy] = useState(false);

  return (
    <ConfirmDialog
      open={offer !== null}
      title="Reconnect with the new settings?"
      description={
        offer
          ? `${offer.name} is still open with the settings it was connected with. Reconnecting opens a fresh session for it; the current one is closed once the new connection is up.`
          : undefined
      }
      confirmLabel="Reconnect"
      cancelLabel="Later"
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        await reconnect();
        setBusy(false);
      }}
      onClose={dismiss}
    />
  );
}
