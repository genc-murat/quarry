import { useEffect, useState } from "react";

import { ColumnDialog } from "@/components/objects/ColumnDialog";
import { ExportDialog } from "@/components/objects/ExportDialog";
import { IndexDialog } from "@/components/objects/IndexDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { dialectForDriver, objectKey, quoteIdentifier } from "@/lib/objects";
import type { ObjectActionRequest } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

/**
 * Renders whichever shared object dialog is currently requested, no matter
 * which surface opened it (the explorer context menu or the inspector).
 */
export function ObjectDialogHost() {
  const dialog = useWorkspace((s) => s.objectDialog);
  const close = useWorkspace((s) => s.closeObjectDialog);
  const cache = useWorkspace((s) => s.objectCache);
  const loadObjectDetail = useWorkspace((s) => s.loadObjectDetail);
  const runObjectAction = useWorkspace((s) => s.runObjectAction);
  const sessions = useWorkspace((s) => s.sessions);
  const requireTypedConfirmation = useWorkspace((s) => s.settings.general.requireTypedConfirmation);
  const [busy, setBusy] = useState(false);

  const ref = dialog?.ref ?? null;
  const detail = ref ? cache[objectKey(ref)] : undefined;
  const needsColumns =
    dialog?.kind === "index" || dialog?.kind === "addColumn" || dialog?.kind === "alterColumn";

  useEffect(() => {
    if (ref && needsColumns && !detail) void loadObjectDetail(ref);
  }, [ref, needsColumns, detail, loadObjectDetail]);

  if (!dialog || !ref) return null;

  const quote = detail?.identifierQuote ?? '"';
  const dialect = dialectForDriver(sessions.find((s) => s.id === ref.sessionId)?.driver);

  const base: Pick<
    ObjectActionRequest,
    "connectionId" | "database" | "namespace" | "object" | "objectKind"
  > = {
    connectionId: ref.sessionId,
    database: ref.database,
    namespace: ref.namespace,
    object: ref.object,
    objectKind: ref.objectKind,
  };

  async function run(request: ObjectActionRequest) {
    setBusy(true);
    const ok = await runObjectAction(request);
    setBusy(false);
    if (ok) close();
  }

  switch (dialog.kind) {
    case "index":
      if (!detail) return null;
      return (
        <IndexDialog
          open
          objectRef={ref}
          detail={detail}
          dialect={dialect}
          busy={busy}
          onClose={close}
          onRun={(index) => run({ ...base, action: "createIndex", index })}
        />
      );
    case "addColumn":
      if (!detail) return null;
      return (
        <ColumnDialog
          open
          mode="add"
          objectRef={ref}
          detail={detail}
          dialect={dialect}
          busy={busy}
          onClose={close}
          onRun={(column) => run({ ...base, action: "addColumn", column })}
        />
      );
    case "alterColumn":
      if (!detail) return null;
      return (
        <ColumnDialog
          open
          mode="alter"
          objectRef={ref}
          detail={detail}
          initial={dialog.column}
          dialect={dialect}
          busy={busy}
          onClose={close}
          onRun={(column, renameTo) =>
            run({ ...base, action: "alterColumn", column, renameTo: renameTo ?? null })
          }
        />
      );
    case "export":
      return (
        <ExportDialog
          open
          objectRef={ref}
          identifierQuote={detail?.identifierQuote ?? '"'}
          onClose={close}
        />
      );
    case "rename":
      return (
        <PromptDialog
          open
          title={`Rename ${ref.object}`}
          label="New name"
          initialValue={ref.object}
          confirmLabel="Rename"
          busy={busy}
          onClose={close}
          onConfirm={(newName) => run({ ...base, action: "renameObject", newName })}
        />
      );
    case "duplicate":
      return (
        <PromptDialog
          open
          title={`Duplicate ${ref.object}`}
          label="New table name"
          initialValue={`${ref.object}_copy`}
          confirmLabel="Duplicate"
          busy={busy}
          onClose={close}
          onConfirm={(newName) => run({ ...base, action: "duplicateObject", newName })}
        />
      );
    case "truncate":
      return (
        <ConfirmDialog
          open
          title={`Truncate ${ref.object}?`}
          description="Every row is deleted. The table and its structure remain."
          confirmLabel="Truncate"
          destructive
          requireText={requireTypedConfirmation ? ref.object : undefined}
          busy={busy}
          onClose={close}
          onConfirm={() => run({ ...base, action: "truncate" })}
        />
      );
    case "drop":
      return (
        <ConfirmDialog
          open
          title={`Drop ${ref.objectKind} ${ref.object}?`}
          description="This cannot be undone."
          confirmLabel="Drop"
          destructive
          requireText={requireTypedConfirmation ? ref.object : undefined}
          busy={busy}
          onClose={close}
          onConfirm={() => run({ ...base, action: "dropObject", ifExists: true, cascade: false })}
        />
      );
    case "reindex":
      return (
        <ConfirmDialog
          open
          title={`Reindex ${ref.object}?`}
          confirmLabel="Reindex"
          busy={busy}
          onClose={close}
          onConfirm={() => run({ ...base, action: "reindex" })}
        >
          <p className="text-xs text-muted-foreground">Rebuilds every index on the table.</p>
        </ConfirmDialog>
      );
    case "dropIndex":
      return (
        <ConfirmDialog
          open
          title="Drop index?"
          confirmLabel="Drop index"
          destructive
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run({ ...base, action: "dropIndex", indexName: dialog.indexName, cascade: false })
          }
        >
          <pre className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px]">
            DROP INDEX {quoteIdentifier(dialog.indexName, quote)}
          </pre>
        </ConfirmDialog>
      );
    case "dropColumn":
      return (
        <ConfirmDialog
          open
          title="Drop column?"
          confirmLabel="Drop column"
          destructive
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run({ ...base, action: "dropColumn", column: dialog.column, cascade: false })
          }
        >
          <p className="text-xs text-muted-foreground">
            Column <span className="font-mono text-foreground">{dialog.column.name}</span> and its
            data will be removed.
          </p>
        </ConfirmDialog>
      );
    case "maintenance":
      return (
        <ConfirmDialog
          open
          title={`Run ${dialog.maintenance}?`}
          confirmLabel="Run"
          busy={busy}
          onClose={close}
          onConfirm={() =>
            run({ ...base, action: "maintenance", maintenance: dialog.maintenance })
          }
        >
          <p className="text-xs text-muted-foreground">
            Runs the engine's maintenance command for{" "}
            <span className="font-mono">{ref.object}</span>.
          </p>
        </ConfirmDialog>
      );
    default:
      return null;
  }
}
