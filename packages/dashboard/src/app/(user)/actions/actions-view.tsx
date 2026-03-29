"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { ActionRow } from "@/components/action-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, RefreshCw, Search } from "lucide-react";
import {
  fetchActions,
  completeAction,
  createAction,
  updateAction,
} from "./action-server-actions";

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

export function ActionsView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState("active");
  const [energy, setEnergy] = useState("all");
  const [context, setContext] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editAction, setEditAction] = useState<Action | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());

  function loadActions() {
    startTransition(async () => {
      const filters: Record<string, string> = {};
      if (status !== "all") filters.status = status;
      if (energy !== "all") filters.energy = energy;
      const result = await fetchActions(filters);
      setActions(result);
    });
  }

  useEffect(() => {
    loadActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, energy]);

  const isFiltered = status === "active" || status !== "all";

  const handleToggle = useCallback((id: string, completed: boolean) => {
    if (!completed) return;

    // Optimistic: mark as completed immediately
    setJustCompleted((prev) => new Set(prev).add(id));

    // Fire server action
    void completeAction(id);

    if (isFiltered) {
      // In filtered view: show strikethrough, then fade out after 1.5s
      setTimeout(() => {
        setFadingOut((prev) => new Set(prev).add(id));
      }, 1500);
      // Remove from list after fade animation (0.5s)
      setTimeout(() => {
        setActions((prev) => prev.filter((a) => a.id !== id));
        setJustCompleted((prev) => { const s = new Set(prev); s.delete(id); return s; });
        setFadingOut((prev) => { const s = new Set(prev); s.delete(id); return s; });
      }, 2000);
    } else {
      // In "all" view: just update the status in place
      setActions((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "completed" } : a))
      );
    }
  }, [isFiltered]);

  const filteredActions = actions.filter((a) => {
    if (searchQuery && !a.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (context !== "all") {
      if (!a.contexts || !a.contexts.includes(context)) return false;
    }
    return true;
  });

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      await createAction(formData);
      setDialogOpen(false);
      loadActions();
    });
  }

  function handleEdit(formData: FormData) {
    if (!editAction) return;
    startTransition(async () => {
      await updateAction(editAction.id, formData);
      setEditDialogOpen(false);
      setEditAction(null);
      loadActions();
    });
  }

  function openEditDialog(action: Action) {
    setEditAction(action);
    setEditDialogOpen(true);
  }

  return (
    <div>
      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search actions..."
          className="pl-9"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Energy</Label>
          <Select value={energy} onValueChange={setEnergy}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Context</Label>
          <Select value={context} onValueChange={setContext}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="@home">@home</SelectItem>
              <SelectItem value="@office">@office</SelectItem>
              <SelectItem value="@computer">@computer</SelectItem>
              <SelectItem value="@phone">@phone</SelectItem>
              <SelectItem value="@errands">@errands</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={loadActions}
          disabled={isPending}
          aria-label="Refresh actions"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>

        <div className="ml-auto">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                New Action
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New Action</DialogTitle>
                <DialogDescription>
                  Create a new action to track.
                </DialogDescription>
              </DialogHeader>
              <form action={handleCreate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" name="title" required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="energy">Energy</Label>
                    <Select name="energy" defaultValue="medium">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="due_date">Due Date</Label>
                    <Input id="due_date" name="due_date" type="date" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contexts">Contexts (comma-separated)</Label>
                  <Input
                    id="contexts"
                    name="contexts"
                    placeholder="@home, @phone"
                  />
                </div>
                <Button type="submit" className="w-full">
                  Create Action
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Action list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {filteredActions.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "No actions found"}
          </p>
        ) : (
          filteredActions.map((action) => (
            <div
              key={action.id}
              className={`cursor-pointer transition-all duration-500 ${
                fadingOut.has(action.id)
                  ? "opacity-0 max-h-0 overflow-hidden"
                  : "opacity-100 max-h-24"
              }`}
              onClick={(e) => {
                // Don't open edit dialog if clicking on checkbox
                const target = e.target as HTMLElement;
                if (target.closest('button[role="checkbox"]')) return;
                openEditDialog(action);
              }}
            >
              <ActionRow
                id={action.id}
                title={action.title}
                contexts={action.contexts}
                energy={action.energy}
                dueDate={action.due_date}
                projectName={action.project_name}
                completed={action.status === "completed" || justCompleted.has(action.id)}
                onToggle={handleToggle}
              />
            </div>
          ))
        )}
      </div>

      {/* Edit Action Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
        setEditDialogOpen(open);
        if (!open) setEditAction(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Action</DialogTitle>
            <DialogDescription>
              Update this action&apos;s details.
            </DialogDescription>
          </DialogHeader>
          {editAction && (
            <EditActionForm action={editAction} onSubmit={handleEdit} isPending={isPending} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditActionForm({
  action,
  onSubmit,
  isPending,
}: {
  action: Action;
  onSubmit: (formData: FormData) => void;
  isPending: boolean;
}) {
  const [listType, setListType] = useState(action.list_type ?? "todo");

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="edit-title">Title</Label>
        <Input id="edit-title" name="title" defaultValue={action.title} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="edit-status">Status</Label>
          <Select name="status" defaultValue={action.status ?? "active"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="on_hold">On Hold</SelectItem>
              <SelectItem value="dropped">Dropped</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-energy">Energy</Label>
          <Select name="energy" defaultValue={action.energy ?? "medium"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-contexts">Context tags (comma-separated)</Label>
        <Input
          id="edit-contexts"
          name="contexts"
          defaultValue={action.contexts?.join(", ") ?? ""}
          placeholder="@home, @phone"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="edit-due-date">Due Date</Label>
          <Input
            id="edit-due-date"
            name="due_date"
            type="date"
            defaultValue={action.due_date ?? ""}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-list-type">List Type</Label>
          <Select
            name="list_type"
            defaultValue={listType}
            onValueChange={setListType}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todo">Todo</SelectItem>
              <SelectItem value="shopping">Shopping</SelectItem>
              <SelectItem value="waiting">Waiting</SelectItem>
              <SelectItem value="someday">Someday</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {listType === "waiting" && (
        <div className="space-y-2">
          <Label htmlFor="edit-waiting-for">Waiting For</Label>
          <Input
            id="edit-waiting-for"
            name="waiting_for"
            defaultValue={action.waiting_for ?? ""}
            placeholder="Person or event"
          />
        </div>
      )}
      <Button type="submit" className="w-full" disabled={isPending}>
        Save Changes
      </Button>
    </form>
  );
}
