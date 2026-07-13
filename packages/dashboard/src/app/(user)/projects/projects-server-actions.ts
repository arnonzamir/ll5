"use server";

import { mcpCall, mcpCallJsonSafe, mcpCallList } from "@/lib/api";

interface Project {
  id: string;
  title: string;
  description?: string | null;
  action_count?: number;
  active_action_count?: number;
  activeActionCount?: number;
  category?: string | null;
  status?: string;
  dueDate?: string | null;
}

interface ProjectAction {
  id: string;
  title: string;
  context?: string[];
  energy?: "low" | "medium" | "high";
  dueDate?: string | null;
  status?: string;
  listType?: string | null;
  waitingFor?: string | null;
}

export async function fetchProjects(status?: string): Promise<Project[]> {
  const args: Record<string, unknown> = {};
  if (status && status !== "all") args.status = status;
  return mcpCallList<Project>("gtd", "list_projects", args);
}

export async function fetchProject(id: string): Promise<Project | null> {
  const result = await mcpCallJsonSafe<{ project?: Project }>(
    "gtd",
    "get_project",
    { id }
  );
  return result?.project ?? null;
}

export async function fetchProjectActions(
  projectId: string,
  status?: string
): Promise<ProjectAction[]> {
  const args: Record<string, unknown> = { project_id: projectId };
  if (status && status !== "all") args.status = status;
  return mcpCallList<ProjectAction>("gtd", "list_actions", args);
}

export async function createProject(formData: FormData): Promise<void> {
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const category = formData.get("category") as string;
  const dueDate = formData.get("due_date") as string;

  const args: Record<string, unknown> = { title };
  if (description) args.description = description;
  if (category) args.category = category;
  if (dueDate) args.due_date = dueDate;

  await mcpCall("gtd", "create_project", args);
}

export async function updateProject(
  id: string,
  formData: FormData
): Promise<void> {
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const category = formData.get("category") as string;
  const status = formData.get("status") as string;

  const args: Record<string, unknown> = { id };
  if (title) args.title = title;
  if (description !== null) args.description = description || null;
  if (category !== null) args.category = category || null;
  if (status) args.status = status;

  await mcpCall("gtd", "update_project", args);
}

/**
 * Create an action already linked to a project.
 */
export async function createProjectAction(
  projectId: string,
  formData: FormData
): Promise<void> {
  const title = formData.get("title") as string;
  const energy = formData.get("energy") as string;
  const dueDate = formData.get("due_date") as string;
  const listType = formData.get("list_type") as string;
  const contextsRaw = formData.get("contexts") as string;

  const args: Record<string, unknown> = { title, project_id: projectId };
  if (energy) args.energy = energy;
  if (dueDate) args.due_date = dueDate;
  if (listType) args.list_type = listType;
  if (contextsRaw) {
    args.context = contextsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  await mcpCall("gtd", "create_action", args);
}

/**
 * Link an existing (unassigned) action to this project.
 */
export async function assignActionToProject(
  actionId: string,
  projectId: string | null
): Promise<void> {
  await mcpCall("gtd", "update_action", {
    id: actionId,
    project_id: projectId,
  });
}
