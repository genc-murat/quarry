import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { errorMessage, ipc } from "@/lib/ipc";
import {
  downloadText,
  qualifiedName,
  serializeExport,
  type ExportFormat,
  type ObjectRef,
} from "@/lib/objects";
import { useWorkspace } from "@/stores/workspace";

interface Props {
  open: boolean;
  onClose: () => void;
  objectRef: ObjectRef;
  identifierQuote: string;
}

export function ExportDialog({ open, onClose, objectRef, identifierQuote }: Props) {
  const pushToast = useWorkspace((s) => s.pushToast);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [limit, setLimit] = useState("5000");
  const [header, setHeader] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFormat("csv");
      setLimit("5000");
      setHeader(true);
      setBusy(false);
    }
  }, [open]);

  async function run() {
    setBusy(true);
    try {
      const maxRows = Math.max(1, Math.min(50000, Number(limit) || 5000));
      // Run an explicit, quoted SELECT rather than a dedicated preview command.
      const table = qualifiedName(objectRef, identifierQuote || '"');
      const response = await ipc.executeQuery(objectRef.sessionId, {
        sql: `SELECT * FROM ${table} LIMIT ${maxRows} OFFSET 0;`,
        database: objectRef.database,
        maxRows,
      });
      const statement = response.results[0];
      if (!statement || statement.error) {
        throw new Error(statement?.error ?? "no data returned");
      }
      const columns = statement.columns.map((column) => column.name);
      const text = serializeExport(
        format,
        columns,
        statement.rows,
        objectRef,
        identifierQuote || '"',
        header,
      );
      downloadText(`${objectRef.object}.${format === "sql" ? "sql" : format}`, text);
      pushToast({
        title: "Export ready",
        description: `${statement.rows.length} rows exported as ${format.toUpperCase()}`,
        variant: "success",
      });
      onClose();
    } catch (error) {
      pushToast({ title: "Export failed", description: errorMessage(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Export ${objectRef.object}`}
      description="Rows are fetched with a safe SELECT and serialized in the browser."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-2 block">Format</Label>
            <Select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="sql">SQL INSERT</option>
            </Select>
          </div>
          <div>
            <Label className="mb-2 block">Row limit</Label>
            <Input value={limit} onChange={(event) => setLimit(event.target.value)} />
          </div>
        </div>
        {format === "csv" ? (
          <Checkbox
            label="Include header row"
            checked={header}
            onChange={(event) => setHeader(event.target.checked)}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
