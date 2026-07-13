"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
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
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, RefreshCw, Search } from "lucide-react";
import { fetchProjects, createProject } from "./projects-server-actions";

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
  const [status, setStatus] = useState("active");
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);

  function loadProjects() {
    startTransition(async () => {
      const result = await fetchProjects(status);
      setProjects(result);
    });
  }

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const filteredProjects = projects.filter((p) => {
    if (searchQuery && !p.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    return true;
  });

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      await createProject(formData);
      setDialogOpen(false);
      const result = await fetchProjects(status);
      setProjects(result);
    });
  }

  return (
    <div>
      {/* Search, filter, create */}
      <div className="flex items-end gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search projects..."
            className="pl-9"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-32">
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

        <Button
          variant="ghost"
          size="icon"
          onClick={loadProjects}
          disabled={isPending}
          aria-label="Refresh projects"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Project</DialogTitle>
              <DialogDescription>
                A multi-step outcome you are committed to.
              </DialogDescription>
            </DialogHeader>
            <form action={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-title">Title</Label>
                <Input id="project-title" name="title" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <textarea
                  id="project-description"
                  name="description"
                  rows={3}
                  className="flex w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="project-category">Category</Label>
                  <Input id="project-category" name="category" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-due-date">Due Date</Label>
                  <Input id="project-due-date" name="due_date" type="date" />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={isPending}>
                Create Project
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Project grid */}
      {filteredProjects.length === 0 ? (
        <p className="text-sm text-gray-500">
          {isPending ? "Loading..." : "No projects found"}
        </p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="block">
              <ProjectCard
                title={p.title}
                actionCount={
                  p.activeActionCount ?? p.active_action_count ?? p.action_count ?? 0
                }
                category={p.category}
                status={p.status}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
