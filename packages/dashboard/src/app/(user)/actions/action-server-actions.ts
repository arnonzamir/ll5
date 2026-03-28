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
}

export async function fetchActions(
  filters: Record<string, string>
): Promise<Action[]> {
  return mcpCallList<Action>("gtd", "list_actions", filters);
}

export async function completeAction(id: string): Promise<void> {
  await mcpCall("gtd", "update_action", {
    action_id: id,
    status: "completed",
  });
}

export async function createAction(formData: FormData): Promise<void> {
  const title = formData.get("title") as string;
  const energy = formData.get("energy") as string;
  const dueDate = formData.get("due_date") as string;
  const contextsRaw = formData.get("contexts") as string;

  const args: Record<string, unknown> = { title };
  if (energy) args.energy = energy;
  if (dueDate) args.due_date = dueDate;
  if (contextsRaw) {
    args.contexts = contextsRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  await mcpCall("gtd", "create_action", args);
}
