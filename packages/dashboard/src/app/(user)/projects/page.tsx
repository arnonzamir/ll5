import { ProjectCard } from "@/components/project-card";
import { mcpCallList } from "@/lib/api";

export const metadata = { title: "Projects - LL5" };

interface Project {
  id: string;
  title: string;
  action_count?: number;
  active_action_count?: number;
  activeActionCount?: number;
  category?: string | null;
  status?: string;
}

export default async function ProjectsPage() {
  const items = await mcpCallList<Project>("gtd", "list_projects");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Projects</h1>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No projects found</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((p) => (
            <ProjectCard
              key={p.id}
              title={p.title}
              actionCount={p.activeActionCount ?? p.active_action_count ?? p.action_count ?? 0}
              category={p.category}
              status={p.status}
            />
          ))}
        </div>
      )}
    </div>
  );
}
