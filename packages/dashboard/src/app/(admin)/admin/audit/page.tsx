import { LogExplorer } from "../logs/log-explorer";
import { TraceView } from "./trace-view";

export const metadata = { title: "Audit Log - LL5 Admin" };

export default function AuditLogPage() {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold">Trace a concern end to end</h2>
        <p className="mb-3 text-sm text-gray-500">
          Paste a correlation id (or click one in any row) to follow every step it touched —
          app-log lines and the full tool-call ledger (args + result), across services, in
          order. request_id = one request; session_id = one agent session; trace_id = one
          trigger/turn.
        </p>
        <TraceView />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Audit log</h2>
        <LogExplorer
          index="ll5_audit_log"
          title="Audit Log"
          subtitle="Mutations + tool-call ledger across MCPs"
          columns={[
            { field: "timestamp", label: "Time", width: "w-24" },
            { field: "kind", label: "Kind", width: "w-20" },
            { field: "service", label: "Svc", width: "w-24" },
            { field: "tool_name", label: "Tool", width: "w-36" },
            { field: "action", label: "Action", width: "w-24" },
            { field: "entity_type", label: "Entity", width: "w-28" },
            { field: "summary", label: "Summary" },
          ]}
          facetFields={["kind", "tool_name", "source", "action", "entity_type"]}
        />
      </section>
    </div>
  );
}
