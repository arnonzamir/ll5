import { LogExplorer } from "./log-explorer";

export const metadata = { title: "App Logs - LL5 Admin" };

export default function AppLogsPage() {
  return (
    <LogExplorer
      index="ll5_app_log"
      title="Application Logs"
      subtitle="Tool calls, webhooks, and errors"
      columns={[
        { field: "timestamp", label: "Time", width: "w-24" },
        { field: "service", label: "Service", width: "w-28" },
        { field: "level", label: "Level", width: "w-20" },
        { field: "tool_name", label: "Tool", width: "w-36" },
        { field: "message", label: "Message" },
        { field: "duration_ms", label: "Duration", width: "w-20" },
      ]}
      facetFields={["level", "service", "action", "tool_name"]}
    />
  );
}
