"use client";

import { useState, useTransition, useEffect } from "react";
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

  function load() {
    startTransition(async () => {
      const result = await fetchShoppingList();
      setGroups(result);
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

  function handleCheck(title: string) {
    startTransition(async () => {
      await checkOffItem(title);
      load();
    });
  }

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
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100"
                >
                  <Checkbox
                    checked={item.status === "completed"}
                    onCheckedChange={() => handleCheck(item.title)}
                    aria-label={`Check off ${item.title}`}
                  />
                  <span
                    className={
                      item.status === "completed"
                        ? "text-sm text-gray-400 line-through"
                        : "text-sm"
                    }
                  >
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
