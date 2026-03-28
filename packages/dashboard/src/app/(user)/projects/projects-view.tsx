"use client";

import { useState, useTransition, useEffect } from "react";
import { ProjectCard } from "@/components/project-card";
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
  DialogDescription,
} from "@/components/ui/dialog";
import { RefreshCw, Search } from "lucide-react";
import { fetchProjects, updateProject } from "./projects-server-actions";

interface Project {
  id: string;
  title: string;
  description?: string | null;
  action_count?: number;
  active_action_count?: number;
  activeActionCount?: number;
  category?: string | null;
  status?: string;
}

export function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  function loadProjects() {
    startTransition(async () => {
      const result = await fetchProjects();
      setProjects(result);
    });
  }

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredProjects = projects.filter((p) => {
    if (searchQuery && !p.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    return true;
  });

  function openEditDialog(project: Project) {
    setEditProject(project);
    setEditDialogOpen(true);
  }

  function handleEdit(formData: FormData) {
    if (!editProject) return;
    startTransition(async () => {
      await updateProject(editProject.id, formData);
      setEditDialogOpen(false);
      setEditProject(null);
      loadProjects();
    });
  }

  return (
    <div>
      {/* Search and refresh */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search projects..."
            className="pl-9"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={loadProjects}
          disabled={isPending}
          aria-label="Refresh projects"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Project grid */}
      {filteredProjects.length === 0 ? (
        <p className="text-sm text-gray-500">
          {isPending ? "Loading..." : "No projects found"}
        </p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((p) => (
            <div
              key={p.id}
              className="cursor-pointer"
              onClick={() => openEditDialog(p)}
            >
              <ProjectCard
                title={p.title}
                actionCount={
                  p.activeActionCount ?? p.active_action_count ?? p.action_count ?? 0
                }
                category={p.category}
                status={p.status}
              />
            </div>
          ))}
        </div>
      )}

      {/* Edit Project Dialog */}
      <Dialog
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) setEditProject(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>
              Update this project&apos;s details.
            </DialogDescription>
          </DialogHeader>
          {editProject && (
            <form action={handleEdit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-project-title">Title</Label>
                <Input
                  id="edit-project-title"
                  name="title"
                  defaultValue={editProject.title}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-project-description">Description</Label>
                <textarea
                  id="edit-project-description"
                  name="description"
                  defaultValue={editProject.description ?? ""}
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
                    defaultValue={editProject.category ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-project-status">Status</Label>
                  <Select
                    name="status"
                    defaultValue={editProject.status ?? "active"}
                  >
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
              </div>
              <Button type="submit" className="w-full" disabled={isPending}>
                Save Changes
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
