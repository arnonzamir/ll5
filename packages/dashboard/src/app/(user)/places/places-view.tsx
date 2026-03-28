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
import { Plus, Search, MapPin, Trash2 } from "lucide-react";
import {
  fetchPlaces,
  upsertPlace,
  deletePlace,
  type Place,
} from "./places-server-actions";

const PLACE_TYPES = [
  "home",
  "office",
  "gym",
  "restaurant",
  "store",
  "medical",
  "school",
  "other",
] as const;

const TYPE_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "outline"
> = {
  home: "warning",
  work: "default",
  office: "default",
  gym: "success",
  restaurant: "secondary",
  store: "outline",
  medical: "default",
  school: "default",
};

interface PlaceFormData {
  name: string;
  type: string;
  address: string;
  lat: string;
  lon: string;
  tags: string;
}

const EMPTY_FORM: PlaceFormData = {
  name: "",
  type: "",
  address: "",
  lat: "",
  lon: "",
  tags: "",
};

function placeToForm(p: Place): PlaceFormData {
  return {
    name: p.name,
    type: p.type ?? "",
    address: p.address ?? "",
    lat: p.geo?.lat != null ? String(p.geo.lat) : "",
    lon: p.geo?.lon != null ? String(p.geo.lon) : "",
    tags: p.tags?.join(", ") ?? "",
  };
}

export function PlacesView() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlace, setEditingPlace] = useState<Place | null>(null);
  const [form, setForm] = useState<PlaceFormData>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function load() {
    startTransition(async () => {
      const result = await fetchPlaces();
      setPlaces(result);
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let list = places;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.address && p.address.toLowerCase().includes(q))
      );
    }
    if (filterType !== "all") {
      list = list.filter((p) => p.type === filterType);
    }
    return list;
  }, [places, search, filterType]);

  function openAdd() {
    setEditingPlace(null);
    setForm(EMPTY_FORM);
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function openEdit(place: Place) {
    setEditingPlace(place);
    setForm(placeToForm(place));
    setConfirmDelete(false);
    setDialogOpen(true);
  }

  function updateField(field: keyof PlaceFormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave() {
    if (!form.name.trim()) return;
    const tags = form.tags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const data: Record<string, unknown> = {
      name: form.name.trim(),
    };
    if (editingPlace) data.id = editingPlace.id;
    if (form.type) data.type = form.type;
    if (form.address.trim()) data.address = form.address.trim();
    if (form.lat.trim() && !isNaN(Number(form.lat)))
      data.lat = Number(form.lat);
    if (form.lon.trim() && !isNaN(Number(form.lon)))
      data.lon = Number(form.lon);
    if (tags.length > 0) data.tags = tags;

    setDialogOpen(false);
    startTransition(async () => {
      await upsertPlace(data as Parameters<typeof upsertPlace>[0]);
      load();
    });
  }

  function handleDelete() {
    if (!editingPlace) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const id = editingPlace.id;
    setDialogOpen(false);
    startTransition(async () => {
      await deletePlace(id);
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
            placeholder="Search places..."
            className="pl-10"
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {PLACE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" />
          Add Place
        </Button>
      </div>

      {/* Places grid */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <MapPin className="h-12 w-12 mb-3" />
            {places.length === 0 ? (
              <>
                <p className="text-sm">No places saved yet.</p>
                <p className="text-xs mt-1">
                  Click &quot;Add Place&quot; to get started.
                </p>
              </>
            ) : (
              <p className="text-sm">No places match your search.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((place) => (
            <Card
              key={place.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => openEdit(place)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <MapPin className="h-4 w-4 text-gray-400 shrink-0" />
                    <span className="font-medium text-sm truncate">
                      {place.name}
                    </span>
                  </div>
                  {place.type && (
                    <Badge
                      variant={TYPE_VARIANT[place.type] ?? "outline"}
                      className="shrink-0 text-xs"
                    >
                      {place.type}
                    </Badge>
                  )}
                </div>
                {place.address && (
                  <p className="text-xs text-gray-500 mt-2 truncate">
                    {place.address}
                  </p>
                )}
                {place.geo && (
                  <p className="text-xs text-gray-400 mt-1">
                    {place.geo.lat.toFixed(4)}, {place.geo.lon.toFixed(4)}
                  </p>
                )}
                {place.tags && place.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {place.tags.map((tag) => (
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
              {editingPlace ? "Edit Place" : "Add Place"}
            </DialogTitle>
            <DialogDescription>
              {editingPlace
                ? "Update this place's details."
                : "Add a location to your knowledge base."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="place-name">Name *</Label>
              <Input
                id="place-name"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Place name"
              />
            </div>
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
                  {PLACE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="place-address">Address</Label>
              <Input
                id="place-address"
                value={form.address}
                onChange={(e) => updateField("address", e.target.value)}
                placeholder="Street address"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="place-lat">Latitude</Label>
                <Input
                  id="place-lat"
                  type="number"
                  step="any"
                  value={form.lat}
                  onChange={(e) => updateField("lat", e.target.value)}
                  placeholder="e.g. 32.0853"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="place-lon">Longitude</Label>
                <Input
                  id="place-lon"
                  type="number"
                  step="any"
                  value={form.lon}
                  onChange={(e) => updateField("lon", e.target.value)}
                  placeholder="e.g. 34.7818"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="place-tags">Tags</Label>
              <Input
                id="place-tags"
                value={form.tags}
                onChange={(e) => updateField("tags", e.target.value)}
                placeholder="Comma-separated tags"
              />
            </div>
          </div>
          <div className="flex justify-between mt-4">
            <div>
              {editingPlace && (
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
                {editingPlace ? "Update" : "Add"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
