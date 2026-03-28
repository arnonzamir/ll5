"use server";

import { mcpCall, mcpCallJson } from "@/lib/api";

export interface ShoppingItem {
  id: string;
  title: string;
  category?: string | null;
  status?: string;
}

export interface ShoppingGroup {
  category: string;
  items: ShoppingItem[];
}

export async function fetchShoppingList(): Promise<ShoppingGroup[]> {
  try {
    const raw = await mcpCallJson<Record<string, unknown>>("gtd", "manage_shopping_list", { action: "list" });
    // Response: {shopping_list: {groups: [{category, items}], total_items, checked_off}}
    const shoppingList = (raw?.shopping_list ?? raw) as Record<string, unknown>;
    const groups = (shoppingList?.groups ?? []) as ShoppingGroup[];
    return Array.isArray(groups) ? groups : [];
  } catch {
    return [];
  }
}

export async function addShoppingItem(title: string, category?: string): Promise<void> {
  await mcpCall("gtd", "manage_shopping_list", {
    action: "add",
    title,
    category,
  });
}

export async function checkOffItem(title: string): Promise<void> {
  await mcpCall("gtd", "manage_shopping_list", {
    action: "check_off",
    title,
  });
}
