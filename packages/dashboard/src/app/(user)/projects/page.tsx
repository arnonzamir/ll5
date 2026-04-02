import { ProjectsView } from "./projects-view";

export const metadata = { title: "Projects - LL5" };

export default function ProjectsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="text-sm text-gray-500 mt-1">Multi-step outcomes you are committed to</p>
      </div>
      <ProjectsView />
    </div>
  );
}
