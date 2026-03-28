"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

interface Project {
  id: string;
  title: string;
  description?: string | null;
  action_count?: number;
  active_action_count?: number;
  activeActionCount?: number;
  category?: string | null;
  status?: string;
}

export async function fetchProjects(): Promise<Project[]> {
  return mcpCallList<Project>("gtd", "list_projects");
}

export async function updateProject(
  id: string,
  formData: FormData
): Promise<void> {
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const category = formData.get("category") as string;
  const status = formData.get("status") as string;

  const args: Record<string, unknown> = { project_id: id };
  if (title) args.title = title;
  if (description !== undefined) args.description = description;
  if (category !== undefined) args.category = category;
  if (status) args.status = status;

  await mcpCall("gtd", "update_project", args);
}
