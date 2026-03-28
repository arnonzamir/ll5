"use client";

import { useState, useTransition, useEffect } from "react";
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
import { InboxItem } from "@/components/inbox-item";
import {
  Plus,
  RefreshCw,
  CheckSquare,
  FolderKanban,
  Clock,
  Trash2,
} from "lucide-react";
import {
  fetchInbox,
  captureInbox,
  processInboxItem,
} from "./inbox-server-actions";

interface InboxEntry {
  id: string;
  title: string;
  content?: string;
  source?: string | null;
  captured_at?: string | null;
}

export function InboxView() {
  const [items, setItems] = useState<InboxEntry[]>([]);
  const [isPending, startTransition] = useTransition();
  const [captureText, setCaptureText] = useState("");
  const [processItem, setProcessItem] = useState<InboxEntry | null>(null);
  const [processDialogOpen, setProcessDialogOpen] = useState(false);
  const [processMode, setProcessMode] = useState<
    "choose" | "action" | "project"
  >("choose");

  function loadInbox() {
    startTransition(async () => {
      const result = await fetchInbox();
      setItems(result);
    });
  }

  useEffect(() => {
    loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!captureText.trim()) return;
    const text = captureText;
    setCaptureText("");
    startTransition(async () => {
      await captureInbox(text);
      loadInbox();
    });
  }

  function openProcessDialog(item: InboxEntry) {
    setProcessItem(item);
    setProcessMode("choose");
    setProcessDialogOpen(true);
  }

  function handleProcess(outcomeType: string, fields?: Record<string, unknown>) {
    if (!processItem) return;
    startTransition(async () => {
      await processInboxItem(processItem.id, outcomeType, fields);
      setProcessDialogOpen(false);
      setProcessItem(null);
      loadInbox();
    });
  }

  function handleCreateAction(formData: FormData) {
    const title = formData.get("title") as string;
    const energy = formData.get("energy") as string;
    const contextsRaw = formData.get("contexts") as string;
    const fields: Record<string, unknown> = {};
    if (title) fields.title = title;
    if (energy) fields.energy = energy;
    if (contextsRaw) {
      fields.contexts = contextsRaw
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    handleProcess("action", fields);
  }

  function handleCreateProject(formData: FormData) {
    const title = formData.get("title") as string;
    const fields: Record<string, unknown> = {};
    if (title) fields.title = title;
    handleProcess("project", fields);
  }

  return (
    <div>
      {/* Quick capture */}
      <form onSubmit={handleCapture} className="flex gap-2 mb-4">
        <Input
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          placeholder="Quick capture..."
          className="flex-1"
        />
        <Button type="submit" disabled={isPending || !captureText.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          Capture
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={loadInbox}
          disabled={isPending}
          aria-label="Refresh inbox"
        >
          <RefreshCw
            className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`}
          />
        </Button>
      </form>

      {/* Inbox list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "Inbox empty"}
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="cursor-pointer"
              onClick={() => openProcessDialog(item)}
            >
              <InboxItem
                title={item.title ?? item.content ?? ""}
                source={item.source}
                capturedAt={item.captured_at}
              />
            </div>
          ))
        )}
      </div>

      {/* Process Inbox Dialog */}
      <Dialog
        open={processDialogOpen}
        onOpenChange={(open) => {
          setProcessDialogOpen(open);
          if (!open) {
            setProcessItem(null);
            setProcessMode("choose");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Process Inbox Item</DialogTitle>
            <DialogDescription>
              Decide what to do with this item.
            </DialogDescription>
          </DialogHeader>

          {processItem && (
            <div className="space-y-4">
              {/* Item content */}
              <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700">
                {processItem.title ?? processItem.content}
              </div>

              {processMode === "choose" && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setProcessMode("action")}
                  >
                    <CheckSquare className="h-4 w-4 mr-2" />
                    Create Action
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setProcessMode("project")}
                  >
                    <FolderKanban className="h-4 w-4 mr-2" />
                    Create Project
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleProcess("someday")}
                    disabled={isPending}
                  >
                    <Clock className="h-4 w-4 mr-2" />
                    Someday
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleProcess("trash")}
                    disabled={isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Trash
                  </Button>
                </div>
              )}

              {processMode === "action" && (
                <form action={handleCreateAction} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="inbox-action-title">Title</Label>
                    <Input
                      id="inbox-action-title"
                      name="title"
                      defaultValue={processItem.title ?? processItem.content ?? ""}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="inbox-action-energy">Energy</Label>
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
                      <Label htmlFor="inbox-action-contexts">Contexts</Label>
                      <Input
                        id="inbox-action-contexts"
                        name="contexts"
                        placeholder="@home, @phone"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setProcessMode("choose")}
                    >
                      Back
                    </Button>
                    <Button type="submit" className="flex-1" disabled={isPending}>
                      Create Action
                    </Button>
                  </div>
                </form>
              )}

              {processMode === "project" && (
                <form action={handleCreateProject} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="inbox-project-title">Title</Label>
                    <Input
                      id="inbox-project-title"
                      name="title"
                      defaultValue={processItem.title ?? processItem.content ?? ""}
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setProcessMode("choose")}
                    >
                      Back
                    </Button>
                    <Button type="submit" className="flex-1" disabled={isPending}>
                      Create Project
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
