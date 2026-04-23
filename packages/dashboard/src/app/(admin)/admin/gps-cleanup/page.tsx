import { GpsCleanupView } from "./gps-cleanup-view";

export const metadata = { title: "GPS Cleanup - LL5 Admin" };

export default function GpsCleanupPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">GPS Cleanup</h1>
        <p className="mt-1 text-sm text-gray-600">
          Prune location points that pre-2026-04-23 bugs let through the gateway filters.
        </p>
      </div>
      <GpsCleanupView />
    </div>
  );
}
