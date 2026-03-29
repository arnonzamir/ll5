"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, RefreshCw } from "lucide-react";
import {
  fetchShoppingList,
  addShoppingItem,
  checkOffItem,
} from "./shopping-server-actions";
import type { ShoppingGroup } from "./shopping-server-actions";

export function ShoppingView() {
  const [groups, setGroups] = useState<ShoppingGroup[]>([]);
  const [isPending, startTransition] = useTransition();
  const [newItem, setNewItem] = useState("");
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [fadingItems, setFadingItems] = useState<Set<string>>(new Set());

  function load() {
    startTransition(async () => {
      const result = await fetchShoppingList();
      setGroups(result);
      setCheckedItems(new Set());
      setFadingItems(new Set());
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newItem.trim()) return;
    const text = newItem;
    setNewItem("");
    startTransition(async () => {
      await addShoppingItem(text);
      load();
    });
  }

  const handleCheck = useCallback((itemId: string, title: string) => {
    // Optimistic: mark as checked immediately
    setCheckedItems((prev) => new Set(prev).add(itemId));

    // Fire server action
    void checkOffItem(title);

    // Strikethrough for 1.5s, then fade out
    setTimeout(() => {
      setFadingItems((prev) => new Set(prev).add(itemId));
    }, 1500);

    // Remove from local state after fade
    setTimeout(() => {
      setGroups((prev) =>
        prev
          .map((g) => ({
            ...g,
            items: g.items.filter((i) => i.id !== itemId),
          }))
          .filter((g) => g.items.length > 0)
      );
      setCheckedItems((prev) => { const s = new Set(prev); s.delete(itemId); return s; });
      setFadingItems((prev) => { const s = new Set(prev); s.delete(itemId); return s; });
    }, 2000);
  }, []);

  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div>
      <form onSubmit={handleAdd} className="flex gap-2 mb-4">
        <Input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder="Add item..."
          className="flex-1"
        />
        <Button type="submit" disabled={isPending || !newItem.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={load}
          disabled={isPending}
          aria-label="Refresh list"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </form>

      <div className="rounded-lg border border-gray-200 bg-white">
        {totalItems === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "Shopping list empty"}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.category}>
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {group.category}
                </span>
              </div>
              {group.items.map((item) => {
                const isChecked = item.status === "completed" || checkedItems.has(item.id);
                const isFading = fadingItems.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 transition-all duration-500 ${
                      isFading ? "opacity-0 max-h-0 overflow-hidden py-0" : "opacity-100 max-h-16"
                    }`}
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => handleCheck(item.id, item.title)}
                      aria-label={`Check off ${item.title}`}
                    />
                    <span
                      className={
                        isChecked
                          ? "text-sm text-gray-400 line-through"
                          : "text-sm"
                      }
                    >
                      {item.title}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
