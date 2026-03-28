"use server";

import { mcpCall, mcpCallJsonSafe } from "@/lib/api";

interface ShoppingItem {
  id: string;
  name: string;
  category?: string | null;
  checked?: boolean;
}

export async function fetchShoppingList(): Promise<ShoppingItem[]> {
  const result = await mcpCallJsonSafe<ShoppingItem[]>(
    "gtd",
    "manage_shopping_list",
    { action: "list" }
  );
  return result ?? [];
}

export async function addShoppingItem(name: string): Promise<void> {
  await mcpCall("gtd", "manage_shopping_list", {
    action: "add",
    name,
  });
}

export async function checkOffItem(id: string): Promise<void> {
  await mcpCall("gtd", "manage_shopping_list", {
    action: "check_off",
    item_id: id,
  });
}
