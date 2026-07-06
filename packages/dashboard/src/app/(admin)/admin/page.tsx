import { HealthDashboard } from "./health-dashboard";
import { QueueMonitor } from "./queue-monitor";

export const metadata = { title: "System Health - LL5 Admin" };

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Health</h1>
      <HealthDashboard />
      <QueueMonitor />
    </div>
  );
}
