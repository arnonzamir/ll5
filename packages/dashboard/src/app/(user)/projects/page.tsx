import { ProjectsView } from "./projects-view";

export const metadata = { title: "Projects - LL5" };

export default function ProjectsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Projects</h1>
      <ProjectsView />
    </div>
  );
}
