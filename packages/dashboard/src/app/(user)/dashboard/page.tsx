import {
  Inbox,
  CalendarClock,
  AlertCircle,
  Clock,
} from "lucide-react";
import { StatusCard } from "@/components/status-card";
import { ProjectCard } from "@/components/project-card";
import { InboxItem } from "@/components/inbox-item";
import { ChatWidget } from "@/components/chat-widget";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { mcpCallJsonSafe } from "@/lib/api";

export const metadata = { title: "Dashboard - LL5" };

interface GtdHealth {
  inbox_count?: number;
  inboxCount?: number;
  due_today_count?: number;
  overdue_count?: number;
  overdueActionCount?: number;
  waiting_for_count?: number;
  staleWaitingCount?: number;
  active_project_count?: number;
  activeProjectCount?: number;
  active_action_count?: number;
  activeActionCount?: number;
  [key: string]: unknown;
}

interface Project {
  id: string;
  title: string;
  action_count?: number;
  active_action_count?: number;
  activeActionCount?: number;
  category?: string | null;
  status?: string;
  [key: string]: unknown;
}

interface InboxEntry {
  id: string;
  title?: string;
  content?: string;
  source?: string | null;
  captured_at?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
}

export default async function DashboardPage() {
  const [healthRaw, projectsRaw, inboxRaw] = await Promise.all([
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "get_gtd_health"),
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "list_projects", { status: "active" }),
    mcpCallJsonSafe<Record<string, unknown>>("gtd", "list_inbox", { limit: 5 }),
  ]);

  // MCP tools return wrapped objects — extract the data
  const health = (healthRaw?.health ?? healthRaw ?? {}) as GtdHealth;
  const projectsList = (projectsRaw?.projects ?? projectsRaw ?? []) as Project[];
  const inboxList = (inboxRaw?.items ?? inboxRaw?.inbox ?? inboxRaw ?? []) as InboxEntry[];

  const inboxCount = health?.inbox_count ?? health?.inboxCount ?? 0;
  const dueToday = health?.due_today_count ?? health?.overdueActionCount ?? 0;
  const overdue = health?.overdue_count ?? health?.overdueActionCount ?? 0;
  const waitingFor = health?.waiting_for_count ?? health?.staleWaitingCount ?? 0;

  const topProjects = Array.isArray(projectsList) ? projectsList.slice(0, 5) : [];
  const recentInbox = Array.isArray(inboxList) ? inboxList.slice(0, 5) : [];

  return (
    <div className="flex gap-6 h-[calc(100vh-4rem)]">
      {/* Left panel — GTD summary */}
      <div className="w-full lg:w-[45%] overflow-y-auto space-y-6 pb-6">
        {/* Status cards */}
        <div className="grid grid-cols-2 gap-3">
          <StatusCard title="Inbox" value={inboxCount} icon={Inbox} />
          <StatusCard
            title="Due Today"
            value={dueToday}
            icon={CalendarClock}
            variant={dueToday > 0 ? "warning" : "default"}
          />
          <StatusCard
            title="Overdue"
            value={overdue}
            icon={AlertCircle}
            variant={overdue > 0 ? "danger" : "default"}
          />
          <StatusCard title="Waiting For" value={waitingFor} icon={Clock} />
        </div>

        {/* Active Projects */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-500">Active Projects</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topProjects.length === 0 ? (
              <p className="text-sm text-gray-400">No active projects</p>
            ) : (
              topProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  title={p.title}
                  actionCount={p.activeActionCount ?? p.active_action_count ?? p.action_count ?? 0}
                  category={p.category}
                  status={p.status}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Recent Inbox */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-500">Recent Inbox</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {recentInbox.length === 0 ? (
              <p className="text-sm text-gray-400 px-6 pb-4">Inbox empty</p>
            ) : (
              recentInbox.map((item) => (
                <InboxItem
                  key={item.id}
                  title={item.title ?? item.content ?? ""}
                  source={item.source}
                  capturedAt={item.captured_at ?? item.createdAt}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right panel — Chat (hidden on mobile, shown on lg+) */}
      <div className="hidden lg:flex lg:w-[55%] lg:flex-col">
        <ChatWidget />
      </div>
    </div>
  );
}
