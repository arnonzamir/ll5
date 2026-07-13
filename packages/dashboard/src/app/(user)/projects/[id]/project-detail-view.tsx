"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionRow } from "@/components/action-row";
import { Badge } from "@/components/ui/badge";
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
import { ArrowLeft, Link2, Pencil, Plus, RefreshCw } from "lucide-react";
import {
  fetchProject,
  fetchProjectActions,
  createProjectAction,
  assignActionToProject,
  updateProject,
} from "../projects-server-actions";
import { fetchActions, completeAction } from "../../actions/action-server-actions";

interface Project {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  status?: string;
}

interface Action {
  id: string;
  title: string;
  context?: string[];
  energy?: "low" | "medium" | "high";
  dueDate?: string | null;
  status?: string;
  listType?: string | null;
  waitingFor?: string | null;
  projectId?: string | null;
}

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  completed: "bg-gray-100 text-gray-600",
  on_hold: "bg-amber-100 text-amber-700",
  dropped: "bg-red-100 text-red-700",
};

export function ProjectDetailView({ project: initial }: { project: Project }) {
  const router = useRouter();
  const [project, setProject] = useState(initial);
  const [actions, setActions] = useState<Action[]>([]);
  const [unassigned, setUnassigned] = useState<Action[]>([]);
  const [status, setStatus] = useState("active");
  const [isPending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());

  function loadActions() {
    startTransition(async () => {
      const result = await fetchProjectActions(project.id, status);
      setActions(result);
    });
  }

  useEffect(() => {
    loadActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, project.id]);

  // Candidates for "link existing": active actions with no project yet.
  function loadUnassigned() {
    fetchActions({ status: "active" }).then((result) =>
      setUnassigned(result.filter((a) => !a.projectId))
    );
  }

  const handleToggle = useCallback((id: string, completed: boolean) => {
    if (!completed) return;
    setJustCompleted((prev) => new Set(prev).add(id));
    startTransition(async () => {
      await completeAction(id);
      const result = await fetchProjectActions(project.id, status);
      setActions(result);
      setJustCompleted((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    });
  }, [project.id, status]);

  function handleAdd(formData: FormData) {
    startTransition(async () => {
      await createProjectAction(project.id, formData);
      setAddOpen(false);
      const result = await fetchProjectActions(project.id, status);
      setActions(result);
    });
  }

  function handleLink(formData: FormData) {
    const actionId = formData.get("action_id") as string;
    if (!actionId || actionId === "none") return;
    startTransition(async () => {
      await assignActionToProject(actionId, project.id);
      setLinkOpen(false);
      const result = await fetchProjectActions(project.id, status);
      setActions(result);
    });
  }

  function handleUnlink(actionId: string) {
    startTransition(async () => {
      await assignActionToProject(actionId, null);
      const result = await fetchProjectActions(project.id, status);
      setActions(result);
    });
  }

  function handleEdit(formData: FormData) {
    startTransition(async () => {
      await updateProject(project.id, formData);
      setEditOpen(false);
      const updated = await fetchProject(project.id);
      if (updated) setProject(updated);
      router.refresh();
    });
  }

  const openCount = actions.filter((a) => a.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Projects
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">{project.title}</h1>
              <Badge
                variant="secondary"
                className={statusColors[project.status ?? "active"]}
              >
                {project.status ?? "active"}
              </Badge>
              {project.category && (
                <Badge variant="outline">{project.category}</Badge>
              )}
            </div>
            {project.description && (
              <p className="text-sm text-gray-500 mt-1 whitespace-pre-wrap">
                {project.description}
              </p>
            )}
          </div>

          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0">
                <Pencil className="h-4 w-4 mr-1" />
                Edit
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit Project</DialogTitle>
                <DialogDescription>
                  Update this project&apos;s details.
                </DialogDescription>
              </DialogHeader>
              <form action={handleEdit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-project-title">Title</Label>
                  <Input
                    id="edit-project-title"
                    name="title"
                    defaultValue={project.title}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-project-description">Description</Label>
                  <textarea
                    id="edit-project-description"
                    name="description"
                    defaultValue={project.description ?? ""}
                    rows={3}
                    className="flex w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="edit-project-category">Category</Label>
                    <Input
                      id="edit-project-category"
                      name="category"
                      defaultValue={project.category ?? ""}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-project-status">Status</Label>
                    <Select
                      name="status"
                      defaultValue={project.status ?? "active"}
                    >
                      <SelectTrigger id="edit-project-status">
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
                </div>
                <Button type="submit" className="w-full" disabled={isPending}>
                  Save Changes
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Actions toolbar */}
      <div className="flex items-end gap-3">
        <h2 className="text-sm font-medium text-gray-700 mr-auto">
          Actions
          <span className="ml-2 text-gray-400 font-normal">
            {openCount} open
          </span>
        </h2>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-32" aria-label="Filter actions by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          onClick={loadActions}
          disabled={isPending}
          aria-label="Refresh actions"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>

        {/* Link an existing unassigned action */}
        <Dialog
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open);
            if (open) loadUnassigned();
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Link2 className="h-4 w-4 mr-1" />
              Link Existing
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link Existing Action</DialogTitle>
              <DialogDescription>
                Move an unassigned action into {project.title}.
              </DialogDescription>
            </DialogHeader>
            <form action={handleLink} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="link-action">Action</Label>
                <Select name="action_id" defaultValue="none">
                  <SelectTrigger id="link-action">
                    <SelectValue placeholder="Pick an action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select an action...</SelectItem>
                    {unassigned.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {unassigned.length === 0 && (
                  <p className="text-xs text-gray-500">
                    No unassigned active actions.
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={isPending}>
                Link Action
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        {/* Create a new action inside this project */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
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
                Added directly to {project.title}.
              </DialogDescription>
            </DialogHeader>
            <form action={handleAdd} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="pa-title">Title</Label>
                <Input id="pa-title" name="title" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="pa-energy">Energy</Label>
                  <Select name="energy" defaultValue="medium">
                    <SelectTrigger id="pa-energy">
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
                  <Label htmlFor="pa-due-date">Due Date</Label>
                  <Input id="pa-due-date" name="due_date" type="date" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="pa-list-type">List Type</Label>
                  <Select name="list_type" defaultValue="todo">
                    <SelectTrigger id="pa-list-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todo">Todo</SelectItem>
                      <SelectItem value="waiting">Waiting</SelectItem>
                      <SelectItem value="someday">Someday</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pa-contexts">Contexts</Label>
                  <Input
                    id="pa-contexts"
                    name="contexts"
                    placeholder="@home, @phone"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={isPending}>
                Create Action
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Action list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {actions.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "No actions in this project yet"}
          </p>
        ) : (
          actions.map((action) => (
            <div key={action.id} className="flex items-center group">
              <div className="flex-1 min-w-0">
                <ActionRow
                  id={action.id}
                  title={action.title}
                  contexts={action.context}
                  energy={action.energy}
                  dueDate={action.dueDate}
                  listType={action.listType}
                  waitingFor={action.waitingFor}
                  completed={
                    action.status === "completed" || justCompleted.has(action.id)
                  }
                  onToggle={handleToggle}
                />
              </div>
              <button
                type="button"
                onClick={() => handleUnlink(action.id)}
                disabled={isPending}
                className="px-3 text-xs text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-600 transition-opacity"
                aria-label={`Remove "${action.title}" from this project`}
              >
                Unlink
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
