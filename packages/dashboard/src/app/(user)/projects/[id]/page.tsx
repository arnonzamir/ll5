import { notFound } from "next/navigation";
import { fetchProject } from "../projects-server-actions";
import { ProjectDetailView } from "./project-detail-view";

export const metadata = { title: "Project - LL5" };

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await fetchProject(id);

  if (!project) notFound();

  return <ProjectDetailView project={project} />;
}
