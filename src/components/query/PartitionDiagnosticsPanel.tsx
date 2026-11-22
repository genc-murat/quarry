import { ChevronRight, Network } from "lucide-react";

import type { PartitionDiagnostics, PartitionNode } from "@/lib/types";

function nodeLocation({ datacenter, rack, shard }: PartitionNode) {
  return [datacenter, rack, shard == null ? null : `Shard ${shard}`].filter(Boolean).join(" · ");
}

export function PartitionDiagnosticsPanel({ diagnostics }: { diagnostics: PartitionDiagnostics }) {
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
        <dl className="grid min-w-0 content-start gap-3 sm:border-r sm:border-border sm:pr-4">
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
      </div>
    </details>
  );
}
