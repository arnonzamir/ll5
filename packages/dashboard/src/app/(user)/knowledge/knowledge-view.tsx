"use client";

import { useState, useTransition, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Search, RefreshCw, Plus, Trash2 } from "lucide-react";
import {
  searchKnowledge,
  fetchRecentFacts,
  upsertFact,
  deleteFact,
  type KnowledgeResult,
  type Fact,
} from "./knowledge-server-actions";

const TYPE_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "outline"
> = {
  fact: "secondary",
  person: "success",
  place: "warning",
};

const FACT_TYPES = [
  "preference",
  "habit",
  "health",
  "biographical",
  "opinion",
] as const;

const PROVENANCE_OPTIONS = [
  "user-stated",
  "inferred",
  "observed",
] as const;

interface FactFormData {
  type: string;
  category: string;
  content: string;
  provenance: string;
  confidence: string;
  tags: string;
}

const EMPTY_FORM: FactFormData = {
  type: "",
  category: "",
  content: "",
  provenance: "user-stated",
  confidence: "1.0",
  tags: "",
};

function factToForm(f: Fact): FactFormData {
  return {
    type: f.type ?? "",
    category: f.category ?? "",
    content: f.content,
    provenance: f.provenance ?? "user-stated",
    confidence: f.confidence != null ? String(f.confidence) : "1.0",
    tags: f.tags?.join(", ") ?? "",
  };
}

function resultName(r: KnowledgeResult): string {
  const d = r.data ?? {};
  return (
    (d.name as string) ??
    (d.content as string) ??
    (d.title as string) ??
    r.summary ??
    r.entity_id
  );
}

function resultCategory(r: KnowledgeResult): string | undefined {
  const d = r.data ?? {};
  return (
    (d.category as string | undefined) ??
    (d.relationship as string | undefined) ??
    (d.type as string | undefined)
  );
}

export function KnowledgeView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [searched, setSearched] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [form, setForm] = useState<FactFormData>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function loadFacts() {
    startTransition(async () => {
      const recent = await fetchRecentFacts();
      setFacts(recent);
    });
  }

  useEffect(() => {
    loadFacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    startTransition(async () => {
      const r = await searchKnowledge(query.trim());
      setResults(r);
      setSearched(true);
    });
  }

  function handleClear() {
    setQuery("");
    setResults([]);
    setSearched(false);
  }

  function openAdd() {
    setEditingFact(null);
    setForm(EMPTY_FORM);
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function openEditFact(fact: Fact) {
    setEditingFact(fact);
    setForm(factToForm(fact));
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function updateField(field: keyof FactFormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave() {
    if (!form.content.trim()) return;
    const tags = form.tags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const confidence = parseFloat(form.confidence);
    const data: Record<string, unknown> = {
      content: form.content.trim(),
    };
    if (editingFact) data.id = editingFact.id;
    if (form.type) data.type = form.type;
    if (form.category.trim()) data.category = form.category.trim();
    if (form.provenance) data.provenance = form.provenance;
    if (!isNaN(confidence)) data.confidence = Math.min(1, Math.max(0, confidence));
    if (tags.length > 0) data.tags = tags;

    setDialogOpen(false);
    startTransition(async () => {
      await upsertFact(data as Parameters<typeof upsertFact>[0]);
      loadFacts();
    });
  }

  function handleDelete() {
    if (!editingFact) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const id = editingFact.id;
    setDialogOpen(false);
    startTransition(async () => {
      await deleteFact(id);
      loadFacts();
    });
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        <form onSubmit={handleSearch} className="flex gap-2 flex-1">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search knowledge base..."
              className="pl-10"
            />
          </div>
          <Button type="submit" disabled={isPending || !query.trim()}>
            {isPending ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              "Search"
            )}
          </Button>
          {searched && (
            <Button type="button" variant="ghost" onClick={handleClear}>
              Clear
            </Button>
          )}
        </form>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" />
          Add Fact
        </Button>
      </div>

      {searched ? (
        <div className="space-y-3">
          {results.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No results found for &quot;{query}&quot;
            </p>
          ) : (
            results.map((r) => (
              <Card key={`${r.entity_type}-${r.entity_id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant={TYPE_VARIANT[r.entity_type] ?? "outline"}
                        className="shrink-0 text-xs"
                      >
                        {r.entity_type}
                      </Badge>
                      <span className="font-medium text-sm truncate">
                        {resultName(r)}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">
                      {Math.round(r.score * 100)}%
                    </span>
                  </div>
                  {resultCategory(r) && (
                    <Badge variant="outline" className="text-xs mt-2">
                      {resultCategory(r)}
                    </Badge>
                  )}
                  {r.summary && (
                    <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                      {r.summary}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : (
        <div>
          <h2 className="text-sm font-medium text-gray-500 mb-3">
            Recent Facts
          </h2>
          {facts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
                <Search className="h-12 w-12 mb-3" />
                <p className="text-sm">No knowledge recorded yet.</p>
                <p className="text-xs mt-1">
                  Click &quot;Add Fact&quot; or tell Claude things about yourself.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {facts.map((f) => (
                <Card
                  key={f.id}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => openEditFact(f)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          {f.type ?? "fact"}
                        </Badge>
                        <span className="text-sm">{f.content}</span>
                      </div>
                      {f.confidence != null && (
                        <span className="text-xs text-gray-400 shrink-0">
                          {Math.round(f.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                      {f.category && (
                        <Badge variant="outline" className="text-xs">
                          {f.category}
                        </Badge>
                      )}
                      {f.tags?.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Fact dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingFact ? "Edit Fact" : "Add Fact"}
            </DialogTitle>
            <DialogDescription>
              {editingFact
                ? "Update this fact in your knowledge base."
                : "Add a new fact to your knowledge base."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="fact-content">Content *</Label>
              <Textarea
                id="fact-content"
                value={form.content}
                onChange={(e) => updateField("content", e.target.value)}
                placeholder="What do you want to record?"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => updateField("type", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {FACT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fact-category">Category</Label>
                <Input
                  id="fact-category"
                  value={form.category}
                  onChange={(e) => updateField("category", e.target.value)}
                  placeholder="e.g. dietary, sleep, work"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Provenance</Label>
                <Select
                  value={form.provenance}
                  onValueChange={(v) => updateField("provenance", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="How was this learned?" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVENANCE_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p
                          .split("-")
                          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                          .join(" ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fact-confidence">
                  Confidence ({form.confidence || "1.0"})
                </Label>
                <Input
                  id="fact-confidence"
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={form.confidence}
                  onChange={(e) => updateField("confidence", e.target.value)}
                  className="h-9 px-1"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fact-tags">Tags</Label>
              <Input
                id="fact-tags"
                value={form.tags}
                onChange={(e) => updateField("tags", e.target.value)}
                placeholder="Comma-separated tags"
              />
            </div>
          </div>
          <div className="flex justify-between mt-4">
            <div>
              {editingFact && (
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  size="sm"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {confirmDelete ? "Confirm Delete" : "Delete"}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!form.content.trim()}>
                {editingFact ? "Update" : "Add"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
