import { LogViewer } from "./log-viewer";

export const metadata = { title: "Logs - LL5 Admin" };

export default function LogsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Logs</h1>
      <LogViewer />
    </div>
  );
}
