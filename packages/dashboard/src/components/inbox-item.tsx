import { Badge } from "@/components/ui/badge";

interface InboxItemProps {
  title: string;
  source?: string | null;
  capturedAt?: string | null;
}

const sourceBadgeVariant: Record<string, "default" | "secondary" | "warning"> = {
  whatsapp: "default",
  telegram: "default",
  direct: "secondary",
  email: "warning",
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

export function InboxItem({ title, source, capturedAt }: InboxItemProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <span className="text-sm text-gray-900 truncate">{title}</span>
      <div className="flex items-center gap-2 shrink-0 ml-3">
        {source && (
          <Badge variant={sourceBadgeVariant[source] ?? "secondary"} className="text-xs">
            {source}
          </Badge>
        )}
        {capturedAt && (
          <span className="text-xs text-gray-400">{timeAgo(capturedAt)}</span>
        )}
      </div>
    </div>
  );
}
