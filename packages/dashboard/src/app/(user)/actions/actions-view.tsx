"use client";

import { useState, useTransition, useEffect } from "react";
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
import { Plus, RefreshCw } from "lucide-react";
import {
  fetchActions,
  completeAction,
  createAction,
} from "./action-server-actions";

interface Action {
  id: string;
  title: string;
  contexts?: string[];
  energy?: "low" | "medium" | "high";
  due_date?: string | null;
  project_name?: string | null;
  status?: string;
}

export function ActionsView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState("active");
  const [energy, setEnergy] = useState("all");
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);

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

  function handleToggle(id: string, completed: boolean) {
    startTransition(async () => {
      if (completed) {
        await completeAction(id);
        loadActions();
      }
    });
  }

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      await createAction(formData);
      setDialogOpen(false);
      loadActions();
    });
  }

  return (
    <div>
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
        {actions.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "No actions found"}
          </p>
        ) : (
          actions.map((action) => (
            <ActionRow
              key={action.id}
              id={action.id}
              title={action.title}
              contexts={action.contexts}
              energy={action.energy}
              dueDate={action.due_date}
              projectName={action.project_name}
              completed={action.status === "completed"}
              onToggle={handleToggle}
            />
          ))
        )}
      </div>
    </div>
  );
}
