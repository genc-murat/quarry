import { ChevronRight, Network, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PartitionDiagnostics, PartitionNode, PartitionTrace } from "@/lib/types";

function nodeLocation({ datacenter, rack, shard }: PartitionNode) {
  return [datacenter, rack, shard == null ? null : `Shard ${shard}`].filter(Boolean).join(" · ");
}

interface Props {
  diagnostics: PartitionDiagnostics;
  trace?: PartitionTrace | null;
  tracing?: boolean;
  traceError?: string | null;
  traceDisabled: boolean;
  onTrace: () => void;
  onRetryTrace: () => void;
}

export function PartitionDiagnosticsPanel({ diagnostics, trace, tracing, traceError, traceDisabled, onTrace, onRetryTrace }: Props) {
  const { token, placement, coordinator, replicas } = diagnostics;
  const replicaLabel = placement === "tablets" ? "Known tablet replicas" : "Known replicas";

  return (
    <details className="group shrink-0 border-b border-border bg-surface/60 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-3 w-3 group-open:rotate-90" />
        <Network aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
        <span>Partition diagnostics</span>
      </summary>
      <div className="grid max-h-[min(15rem,35vh)] gap-x-6 gap-y-3 overflow-auto px-3 pb-3 sm:grid-cols-2">
        <div className="min-w-0 sm:border-r sm:border-border sm:pr-4">
          <dl className="grid content-start gap-3">
            <div>
              <dt className="text-muted-foreground">Partition token</dt>
              <dd className="mt-0.5 break-all font-mono-app font-medium">{token ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last page coordinator</dt>
              <dd className="mt-0.5 break-all font-mono-app font-medium" title={coordinator.hostId}>{coordinator.address}</dd>
              <dd className="break-words text-muted-foreground">{nodeLocation(coordinator) || "Location unavailable"}</dd>
            </div>
          </dl>
          <Button size="xs" variant="outline" className="mt-3" onClick={onTrace} disabled={traceDisabled}
            title="Read this page again with server tracing">
            <Timer aria-hidden="true" className="h-3 w-3" /> Trace this read
          </Button>
          {tracing ? <p className="mt-1 text-muted-foreground" role="status">Waiting for trace…</p> : null}
          {traceError ? <p className="mt-1 break-words text-destructive" role="alert">{traceError}</p> : null}
        </div>
        <section aria-label={replicaLabel} className="min-w-0">
          <h3 className="text-muted-foreground">{replicaLabel}{replicas.length > 0 ? ` (${replicas.length})` : ""}</h3>
          {replicas.length ? (
            <ul className="mt-1 divide-y divide-border">
              {replicas.map((replica) => (
                <li key={`${replica.hostId}/${replica.shard ?? ""}`} className="py-1 first:pt-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all font-mono-app" title={replica.hostId}>{replica.address}</span>
                    {replica.hostId === coordinator.hostId ? <span className="text-primary">Coordinator node</span> : null}
                  </div>
                  <div className="break-words text-muted-foreground">{nodeLocation(replica) || "Location unavailable"}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">{placement === "tablets" ? "Tablet placement is unavailable for this token." : "Replica placement is unavailable for this token."}</p>
          )}
        </section>
        {trace ? (
          <section aria-label="Server trace" className="min-w-0 border-t border-border pt-2 sm:col-span-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="font-medium">Server trace</h3>
              {trace.status === "available" && trace.durationMicros != null ? (
                <span className="font-mono-app text-primary">{trace.durationMicros.toLocaleString()} µs</span>
              ) : null}
              {trace.id ? <span className="break-all font-mono-app text-muted-foreground">{trace.id}</span> : null}
            </div>
            {trace.status === "available" ? (
              <>
                <ol aria-label="Trace events" className="mt-2 grid gap-2 border-l border-primary/35 pl-3">
                  {trace.events.map((event) => (
                    <li key={event.id} className="grid min-w-0 gap-x-3 sm:grid-cols-[minmax(5.5rem,auto)_1fr]">
                      <span className="font-mono-app text-muted-foreground" title="Elapsed time at source">
                        {event.sourceElapsedMicros == null ? "—" : `${event.sourceElapsedMicros.toLocaleString()} µs`}
                      </span>
                      <div className="min-w-0 break-words">
                        <div>{event.activity ?? "Activity unavailable"}</div>
                        <div className="font-mono-app text-muted-foreground">{[event.source, event.thread].filter(Boolean).join(" · ")}</div>
                      </div>
                    </li>
                  ))}
                </ol>
                {trace.truncated ? <p className="mt-2 text-muted-foreground">Showing the first {trace.events.length} events.</p> : null}
              </>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p role="status">Trace events are unavailable for this read.</p>
                {trace.id ? <Button size="xs" variant="outline" disabled={traceDisabled} onClick={onRetryTrace}>Retry trace events</Button> : null}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </details>
  );
}
