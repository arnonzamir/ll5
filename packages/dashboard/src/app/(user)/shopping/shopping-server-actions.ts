"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

interface ShoppingItem {
  id: string;
  name: string;
  category?: string | null;
  checked?: boolean;
}

export async function fetchShoppingList(): Promise<ShoppingItem[]> {
  return mcpCallList<ShoppingItem>("gtd", "manage_shopping_list", { action: "list" });
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
