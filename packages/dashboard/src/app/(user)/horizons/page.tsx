import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { mcpCallList } from "@/lib/api";
import { Mountain, FolderKanban, AlertTriangle } from "lucide-react";

export const metadata = { title: "Horizons - LL5" };

interface HorizonItem {
  id: string;
  title: string;
  description?: string | null;
  status?: string;
  horizon: number;
  active_project_count?: number;
}

interface Project {
  id: string;
  title: string;
  description?: string | null;
  status?: string;
  category?: string | null;
  active_action_count?: number;
  activeActionCount?: number;
  has_no_actions?: boolean;
}

const LEVELS = [
  { horizon: 5, label: "Purpose", color: "bg-purple-50 border-purple-200", headerColor: "text-purple-700", badgeClass: "bg-purple-100 text-purple-800 border-transparent" },
  { horizon: 4, label: "Vision", color: "bg-blue-50 border-blue-200", headerColor: "text-blue-700", badgeClass: "bg-blue-100 text-blue-800 border-transparent" },
  { horizon: 3, label: "Goals", color: "bg-green-50 border-green-200", headerColor: "text-green-700", badgeClass: "bg-green-100 text-green-800 border-transparent" },
  { horizon: 2, label: "Areas of Focus", color: "bg-amber-50 border-amber-200", headerColor: "text-amber-700", badgeClass: "bg-amber-100 text-amber-800 border-transparent" },
] as const;

export default async function HorizonsPage() {
  const [h5, h4, h3, h2, projects] = await Promise.all([
    mcpCallList<HorizonItem>("gtd", "list_horizons", { horizon: 5 }),
    mcpCallList<HorizonItem>("gtd", "list_horizons", { horizon: 4 }),
    mcpCallList<HorizonItem>("gtd", "list_horizons", { horizon: 3 }),
    mcpCallList<HorizonItem>("gtd", "list_horizons", { horizon: 2 }),
    mcpCallList<Project>("gtd", "list_projects"),
  ]);

  const itemsByLevel: Record<number, HorizonItem[]> = {
    5: h5,
    4: h4,
    3: h3,
    2: h2,
  };

  const isEmpty =
    h5.length === 0 &&
    h4.length === 0 &&
    h3.length === 0 &&
    h2.length === 0 &&
    projects.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Horizons</h1>
        <p className="text-sm text-gray-500 mt-1">Purpose, vision, goals, and areas of focus</p>
      </div>

      {isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <Mountain className="h-12 w-12 mb-3" />
            <p className="text-sm">No horizons defined yet.</p>
            <p className="text-xs mt-1">
              Tell Claude about your purpose, vision, goals, and areas of focus.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {LEVELS.map((level) => {
            const items = itemsByLevel[level.horizon];
            if (items.length === 0) return null;
            return (
              <section key={level.horizon}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className={`text-sm font-semibold uppercase tracking-wide ${level.headerColor}`}>
                    {level.label}
                  </h2>
                  <span className="text-xs text-gray-400">H{level.horizon}</span>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {items.map((item) => (
                    <Card
                      key={item.id}
                      className={`${level.color} hover:shadow-md transition-shadow`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-sm">
                            {item.title}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {item.status && item.status !== "active" && (
                              <Badge variant="outline" className="text-xs">
                                {item.status}
                              </Badge>
                            )}
                            {level.horizon === 2 &&
                              item.active_project_count != null && (
                                <Badge
                                  className={`text-xs ${level.badgeClass}`}
                                >
                                  {item.active_project_count} project
                                  {item.active_project_count !== 1 ? "s" : ""}
                                </Badge>
                              )}
                          </div>
                        </div>
                        {item.description && (
                          <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                            {item.description}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            );
          })}

          {/* Projects (Horizon 1) */}
          {projects.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                  Projects
                </h2>
                <span className="text-xs text-gray-400">H1</span>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {projects.map((p) => {
                  const actionCount =
                    p.activeActionCount ?? p.active_action_count ?? 0;
                  const noActions =
                    actionCount === 0 && (p.status ?? "active") === "active";
                  return (
                    <Card
                      key={p.id}
                      className="bg-gray-50 border-gray-200 hover:shadow-md transition-shadow"
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <FolderKanban className="h-4 w-4 text-gray-400 shrink-0" />
                            <span className="font-medium text-sm truncate">
                              {p.title}
                            </span>
                          </div>
                          <Badge
                            variant={noActions ? "destructive" : actionCount > 0 ? "default" : "secondary"}
                            className="shrink-0"
                          >
                            {actionCount}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          {p.category && (
                            <Badge variant="outline" className="text-xs">
                              {p.category}
                            </Badge>
                          )}
                          {p.status && p.status !== "active" && (
                            <Badge variant="outline" className="text-xs">
                              {p.status}
                            </Badge>
                          )}
                          {noActions && (
                            <div className="flex items-center gap-1 text-xs text-amber-600">
                              <AlertTriangle className="h-3 w-3" />
                              No next action
                            </div>
                          )}
                        </div>
                        {p.description && (
                          <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                            {p.description}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
