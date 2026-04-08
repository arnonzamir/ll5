import { LogExplorer } from "../logs/log-explorer";

export const metadata = { title: "Audit Log - LL5 Admin" };

export default function AuditLogPage() {
  return (
    <LogExplorer
      index="ll5_audit_log"
      title="Audit Log"
      subtitle="All data mutations across MCPs"
      columns={[
        { field: "timestamp", label: "Time", width: "w-24" },
        { field: "source", label: "Source", width: "w-28" },
        { field: "action", label: "Action", width: "w-24" },
        { field: "entity_type", label: "Entity", width: "w-28" },
        { field: "entity_id", label: "ID", width: "w-24" },
        { field: "summary", label: "Summary" },
      ]}
      facetFields={["source", "action", "entity_type"]}
    />
  );
}
