import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ObjectRef } from "@/lib/objects";
import type { ColumnMeta } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

const inputHints: Record<string, string> = {
  blob: "Base64",
  boolean: "true or false",
  date: "Days since the Unix epoch",
  time: "Nanoseconds since midnight",
  timestamp: "Milliseconds since the Unix epoch",
};

export function PartitionDialog({ objectRef, onClose }: { objectRef: ObjectRef; onClose: () => void }) {
  const openPartition = useWorkspace((state) => state.openPartition);
  const [keys, setKeys] = useState<ColumnMeta[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { sessionId, database, object } = objectRef;

  useEffect(() => {
    let active = true;
    void ipc.partitionKeys(sessionId, database, object).then(
      (columns) => { if (active) setKeys(columns); },
      (error) => { if (active) setError(errorMessage(error)); },
    );
    return () => { active = false; };
  }, [sessionId, database, object]);

  const ready = !!keys?.length && keys.every(({ name }) => Object.hasOwn(values, name));
  return (
    <Dialog open onClose={onClose} title="Open partition" description={`${database}.${object}`}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !keys) return;
        openPartition(objectRef, keys.map(({ name }) => ({ column: name, value: values[name] })));
        onClose();
      }}>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {!keys && !error ? <p role="status" className="text-xs text-muted-foreground">Loading partition keys…</p> : null}
        {keys?.length === 0 ? <p className="text-xs text-muted-foreground">The table has no available partition key metadata.</p> : null}
        {keys?.map(({ name, dataType }, index) => (
          <label key={name} className="block space-y-1 text-xs">
            <span className="font-medium">{name}</span>
            {dataType ? <span className="ml-2 font-mono-app text-muted-foreground">{dataType}</span> : null}
            <Input autoFocus={index === 0} value={Object.hasOwn(values, name) ? values[name] : ""}
              placeholder={inputHints[dataType ?? ""]}
              onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!ready}>Read partition</Button>
        </div>
      </form>
    </Dialog>
  );
}
