"use server";

import { mcpCallList } from "@/lib/api";

export interface Lesson {
  id: string;
  scope: string;
  claim: string;
  trigger: string;
  durability: "durable" | "provisional";
  status: "active" | "retired";
  falsification_test: string | null;
  depends_on: string | null;
  expires: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  source: string | null;
  author_user_id: string;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export async function fetchLessons(
  status: "active" | "retired" | "all" = "active",
): Promise<Lesson[]> {
  return mcpCallList<Lesson>("awareness", "list_lessons", { status, limit: 200 });
}
