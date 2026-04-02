"use server";

import { mcpCallList, mcpCall } from "@/lib/api";

interface Action {
  id: string;
  title: string;
  contexts?: string[];
  energy?: "low" | "medium" | "high";
  due_date?: string | null;
  project_name?: string | null;
  status?: string;
  list_type?: string | null;
  waiting_for?: string | null;
}

export async function fetchActions(
  filters: Record<string, string>
): Promise<Action[]> {
  return mcpCallList<Action>("gtd", "list_actions", filters);
}

export async function completeAction(id: string): Promise<void> {
  await mcpCall("gtd", "update_action", {
    id,
    status: "completed",
  });
}

export async function updateAction(
  id: string,
  formData: FormData
): Promise<void> {
  const title = formData.get("title") as string;
  const status = formData.get("status") as string;
  const energy = formData.get("energy") as string;
  const dueDate = formData.get("due_date") as string;
  const contextsRaw = formData.get("contexts") as string;
  const listType = formData.get("list_type") as string;
  const waitingFor = formData.get("waiting_for") as string;

  const args: Record<string, unknown> = { id };
  if (title) args.title = title;
  if (status) args.status = status;
  if (energy) args.energy = energy;
  if (dueDate) args.due_date = dueDate;
  if (listType) args.list_type = listType;
  if (waitingFor) args.waiting_for = waitingFor;
  if (contextsRaw !== undefined) {
    args.contexts = contextsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  await mcpCall("gtd", "update_action", args);
}

export async function createAction(formData: FormData): Promise<void> {
  const title = formData.get("title") as string;
  const energy = formData.get("energy") as string;
  const dueDate = formData.get("due_date") as string;
  const listType = formData.get("list_type") as string;
  const contextsRaw = formData.get("contexts") as string;

  const args: Record<string, unknown> = { title };
  if (energy) args.energy = energy;
  if (dueDate) args.due_date = dueDate;
  if (listType) args.list_type = listType;
  if (contextsRaw) {
    args.contexts = contextsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  await mcpCall("gtd", "create_action", args);
}
