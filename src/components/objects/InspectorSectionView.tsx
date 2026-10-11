import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ObjectRef } from "@/lib/objects";
import { createSectionLoader } from "@/lib/sectionLoader";
import {
  EMPTY_CELL,
  actionParam,
  cellText,
  cellTone,
  chipText,
  formatCell,
} from "@/lib/sections";
import type {
  InspectorSection,
  SectionAction,
  SectionBlock,
  SectionTone,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<SectionTone, string> = {
  neutral: "",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

/**
 * Renders one driver-declared inspector section. Nothing here knows which engine
 * produced it: the blocks decide the layout, and the driver supplies the labels,
 * formats, tones and actions.
 */
export function InspectorSectionView({
  section,
  objectRef,
  onAction,
}: {
  section: InspectorSection;
  objectRef: ObjectRef;
  onAction: (section: InspectorSection, action: SectionAction, param?: string) => void;
}) {
  const live = section.source === "live";
  // One loader per component instance. It owns the request sequencing, so
  // switching objects mid-fetch cannot leave another object's body on screen.
  const [loader] = useState(() => createSectionLoader<InspectorSection>({ errorMessage }));
  const { data, loading, error } = useSyncExternalStore(loader.subscribe, loader.getState);
  const identity = [
    objectRef.sessionId,
    objectRef.namespace ?? "",
    objectRef.database,
    objectRef.object,
    section.id,
  ].join("|");
  const request = useCallback(
    () =>
      ipc.objectSection({
        connectionId: objectRef.sessionId,
        database: objectRef.database,
        namespace: objectRef.namespace,
        object: objectRef.object,
        section: section.id,
      }),
    [objectRef.sessionId, objectRef.database, objectRef.namespace, objectRef.object, section.id],
  );

  useEffect(() => {
    if (!live) return;
    void loader.load(identity, request);
  }, [loader, live, identity, request]);

  // A live section with nothing to show yet is loading, even on the first render
  // before the effect has started the request.
  const busy = loading || (live && !data && !error);
  const current = data ?? section;
  const run = (action: SectionAction, param?: string) => onAction(current, action, param);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold">{current.label}</span>
        {current.hint ? (
          <span className="text-[10px] text-muted-foreground">{current.hint}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {current.actions.map((action) => (
            <Button
              key={action.id}
              size="xs"
              variant={action.danger ? "destructive" : "outline"}
              onClick={() => run(action)}
            >
              {action.label}
            </Button>
          ))}
          {live ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void loader.refresh()}>
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="m-3 flex items-center gap-2 rounded border border-warning/40 p-3 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span>
            {error}
            {section.errorHint ? `. ${section.errorHint}` : ""}
          </span>
        </div>
      ) : null}

      {!error && current.blocks.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">
          {busy ? "Loading…" : "This section has nothing to show."}
        </p>
      ) : null}

      {!error ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {current.blocks.map((block, index) => (
            <Block key={index} block={block} onAction={run} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Block({
  block,
  onAction,
}: {
  block: SectionBlock;
  onAction: (action: SectionAction, param?: string) => void;
}) {
  const counted = block.type !== "fields" && block.rows.length > 0;
  const title = block.title ? (
    <h3 className="font-semibold">
      {block.title}
      {counted ? ` · ${block.rows.length}` : ""}
    </h3>
  ) : null;

  if (block.type === "fields") {
    return (
      <section className="space-y-2 p-3 text-xs">
        {title}
        <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1">
          {block.fields.map((field) => (
            <div className="contents" key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="break-all font-mono">{field.value || EMPTY_CELL}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  if (block.type === "table") {
    return (
      <section className="space-y-2 p-3 text-xs">
        {title}
        {block.rows.length === 0 ? (
          <p className="text-muted-foreground">{block.emptyText ?? "No rows."}</p>
        ) : (
          <div className="overflow-auto rounded border border-border">
            <table className="w-full text-left font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border">
                  {block.columns.map((column) => (
                    <th key={column.key} className="px-2 py-1">
                      {column.label}
                    </th>
                  ))}
                  {block.actions.length ? <th className="px-2 py-1">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, index) => (
                  <tr key={index} className="border-b border-border/40">
                    {block.columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          "px-2 py-1",
                          TONE_CLASS[cellTone(column, row[column.key])],
                        )}
                      >
                        {cellText(column, row[column.key])}
                      </td>
                    ))}
                    {block.actions.length ? (
                      <td className="px-2 py-1">
                        <span className="flex gap-1">
                          {block.actions.map((action) => {
                            const param = actionParam(action, row);
                            return (
                              <Button
                                key={action.id}
                                size="xs"
                                variant={action.danger ? "destructive" : "outline"}
                                // A row without the parameter (an unpartitioned
                                // table reports no id) must not fire a no-op.
                                disabled={action.param ? param == null : false}
                                onClick={() => onAction(action, param ?? undefined)}
                              >
                                {action.label}
                              </Button>
                            );
                          })}
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  const meta = block.columns.filter((column) => column.role === "meta");
  const body = block.columns.filter((column) => column.role === "body");
  return (
    <section className="space-y-2 p-3 text-xs">
      {title}
      {block.rows.length === 0 ? (
        <p className="text-muted-foreground">{block.emptyText ?? "No rows."}</p>
      ) : (
        <div className="divide-y divide-border/50">
          {block.rows.map((row, index) => (
            <article key={index} className="space-y-1 py-2 first:pt-0">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                {meta.map((column) => (
                  <span
                    key={column.key}
                    className={cn(
                      column.format === "text" ? "font-mono" : "",
                      TONE_CLASS[cellTone(column, row[column.key])],
                    )}
                  >
                    {chipText(column, row[column.key])}
                  </span>
                ))}
              </div>
              {body.map((column) => {
                const value = formatCell(column, row[column.key]);
                // A body is only worth a line of its own when it has content.
                if (value === EMPTY_CELL) return null;
                return (
                  <pre
                    key={column.key}
                    className={cn(
                      "whitespace-pre-wrap break-all font-mono text-[11px]",
                      TONE_CLASS[cellTone(column, row[column.key])],
                    )}
                  >
                    {value}
                  </pre>
                );
              })}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
