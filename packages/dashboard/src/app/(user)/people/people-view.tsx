"use client";

import { useState, useTransition, useEffect, useMemo } from "react";
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
import { Plus, Search, Users, Trash2 } from "lucide-react";
import {
  fetchPeople,
  upsertPerson,
  deletePerson,
  type Person,
} from "./people-server-actions";

const RELATIONSHIP_GROUPS = ["family", "friend", "colleague", "acquaintance", "other"] as const;

/** Map a free-text relationship to a high-level group for filtering. */
function relationshipGroup(rel: string | null | undefined): string {
  if (!rel) return "other";
  const lower = rel.toLowerCase();
  if (lower.includes("family") || lower.includes("parent") || lower.includes("mother") || lower.includes("father") ||
      lower.includes("sister") || lower.includes("brother") || lower.includes("wife") || lower.includes("husband") ||
      lower.includes("son") || lower.includes("daughter") || lower.includes("aunt") || lower.includes("uncle") ||
      lower.includes("cousin") || lower.includes("grandpa") || lower.includes("grandma") || lower === "spouse") {
    return "family";
  }
  if (lower.includes("friend") || lower.includes("boyfriend") || lower.includes("girlfriend")) return "friend";
  if (lower.includes("colleague") || lower.includes("boss") || lower.includes("report") || lower.includes("director") ||
      lower.includes("manager") || lower.includes("coworker") || lower.includes("co-run")) {
    return "colleague";
  }
  if (lower.includes("acquaintance")) return "acquaintance";
  return "other";
}

const RELATIONSHIP_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "outline"
> = {
  family: "warning",
  friend: "success",
  colleague: "default",
  acquaintance: "secondary",
};

interface PersonFormData {
  name: string;
  aliases: string;
  relationship: string;
  phone: string;
  email: string;
  tags: string;
  notes: string;
}

const EMPTY_FORM: PersonFormData = {
  name: "",
  aliases: "",
  relationship: "",
  phone: "",
  email: "",
  tags: "",
  notes: "",
};

function personToForm(p: Person): PersonFormData {
  return {
    name: p.name,
    aliases: p.aliases?.join(", ") ?? "",
    relationship: p.relationship ?? "",
    phone: p.contact_info?.phone ?? "",
    email: p.contact_info?.email ?? "",
    tags: p.tags?.join(", ") ?? "",
    notes: p.notes ?? "",
  };
}

export function PeopleView() {
  const [people, setPeople] = useState<Person[]>([]);
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [filterRelationship, setFilterRelationship] = useState("all");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Person | null>(null);
  const [form, setForm] = useState<PersonFormData>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function load() {
    startTransition(async () => {
      const result = await fetchPeople();
      setPeople(result);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let list = people;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.aliases?.some((a) => a.toLowerCase().includes(q))
      );
    }
    if (filterRelationship !== "all") {
      list = list.filter(
        (p) => relationshipGroup(p.relationship) === filterRelationship
      );
    }
    return list;
  }, [people, search, filterRelationship]);

  function openAdd() {
    setEditingPerson(null);
    setForm(EMPTY_FORM);
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function openEdit(person: Person) {
    setEditingPerson(person);
    setForm(personToForm(person));
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function updateField(field: keyof PersonFormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave() {
    if (!form.name.trim()) return;
    const aliases = form.aliases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tags = form.tags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const contact_info: Record<string, string> = {};
    if (form.phone.trim()) contact_info.phone = form.phone.trim();
    if (form.email.trim()) contact_info.email = form.email.trim();

    const data: Record<string, unknown> = {
      name: form.name.trim(),
    };
    if (editingPerson) data.id = editingPerson.id;
    if (aliases.length > 0) data.aliases = aliases;
    if (form.relationship) data.relationship = form.relationship;
    if (Object.keys(contact_info).length > 0) data.contact_info = contact_info;
    if (tags.length > 0) data.tags = tags;
    if (form.notes.trim()) data.notes = form.notes.trim();

    setDialogOpen(false);
    startTransition(async () => {
      await upsertPerson(data as Parameters<typeof upsertPerson>[0]);
      load();
    });
  }

  function handleDelete() {
    if (!editingPerson) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const id = editingPerson.id;
    setDialogOpen(false);
    startTransition(async () => {
      await deletePerson(id);
      load();
    });
  }

  return (
    <div>
      {/* Search and filter bar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people..."
            className="pl-10"
          />
        </div>
        <Select value={filterRelationship} onValueChange={setFilterRelationship}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="All relationships" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All relationships</SelectItem>
            {RELATIONSHIP_GROUPS.map((r) => (
              <SelectItem key={r} value={r}>
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" />
          Add Person
        </Button>
      </div>

      {/* People grid */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <Users className="h-12 w-12 mb-3" />
            {people.length === 0 ? (
              <>
                <p className="text-sm">No people recorded yet.</p>
                <p className="text-xs mt-1">
                  Click &quot;Add Person&quot; to get started.
                </p>
              </>
            ) : (
              <p className="text-sm">No people match your search.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <Card
              key={p.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => openEdit(p)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-sm truncate">{p.name}</span>
                  {p.relationship && (
                    <Badge
                      variant={RELATIONSHIP_VARIANT[p.relationship.toLowerCase()] ?? "outline"}
                      className="shrink-0 text-xs"
                    >
                      {p.relationship}
                    </Badge>
                  )}
                </div>
                {p.aliases && p.aliases.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1 truncate">
                    {p.aliases.join(", ")}
                  </p>
                )}
                {p.notes && (
                  <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                    {p.notes}
                  </p>
                )}
                {p.tags && p.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {p.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingPerson ? "Edit Person" : "Add Person"}
            </DialogTitle>
            <DialogDescription>
              {editingPerson
                ? "Update this person's details."
                : "Add someone to your knowledge base."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="person-name">Name *</Label>
              <Input
                id="person-name"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Full name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="person-aliases">Aliases</Label>
              <Input
                id="person-aliases"
                value={form.aliases}
                onChange={(e) => updateField("aliases", e.target.value)}
                placeholder="Comma-separated nicknames"
              />
            </div>
            <div className="space-y-2">
              <Label>Relationship</Label>
              <Select
                value={form.relationship}
                onValueChange={(v) => updateField("relationship", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select relationship" />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIP_GROUPS.filter((r) => r !== "other").map((r) => (
                    <SelectItem key={r} value={r}>
                      {r.charAt(0).toUpperCase() + r.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="person-phone">Phone</Label>
                <Input
                  id="person-phone"
                  value={form.phone}
                  onChange={(e) => updateField("phone", e.target.value)}
                  placeholder="Phone number"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="person-email">Email</Label>
                <Input
                  id="person-email"
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                  placeholder="Email address"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="person-tags">Tags</Label>
              <Input
                id="person-tags"
                value={form.tags}
                onChange={(e) => updateField("tags", e.target.value)}
                placeholder="Comma-separated tags"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="person-notes">Notes</Label>
              <Textarea
                id="person-notes"
                value={form.notes}
                onChange={(e) => updateField("notes", e.target.value)}
                placeholder="Notes about this person..."
                rows={3}
              />
            </div>
          </div>
          <div className="flex justify-between mt-4">
            <div>
              {editingPerson && (
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
              <Button onClick={handleSave} disabled={!form.name.trim()}>
                {editingPerson ? "Update" : "Add"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
