"use client";

import { useState, useTransition, useEffect, useMemo, useRef, useCallback } from "react";
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
import { Plus, Search, MapPin, Trash2, List, Map as MapIcon } from "lucide-react";
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

type ViewMode = "list" | "map";

export function PlacesView() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

  // Map refs (SSR-safe, following locations pattern)
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const listItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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

  // Places that have geo coordinates (for map markers)
  const geoPlaces = useMemo(
    () => filtered.filter((p) => p.geo?.lat != null && p.geo?.lon != null),
    [filtered]
  );

  // Initialize Leaflet map (dynamic import, SSR-safe)
  useEffect(() => {
    if (viewMode !== "map") return;
    let cancelled = false;

    async function init() {
      if (mapRef.current) return;
      const container = mapContainerRef.current;
      if (!container) return;

      const L = await import("leaflet");
      leafletRef.current = L;
      if (cancelled) return;

      // Fix default marker icons for webpack/next
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)["_getIconUrl"];
      L.Icon.Default.mergeOptions({
        iconRetinaUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      const map = L.map(container).setView([31.5, 34.8], 8);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;
      markersLayerRef.current = L.layerGroup().addTo(map);
      setMapReady(true);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [viewMode]);

  // Cleanup map when switching away from map view
  useEffect(() => {
    if (viewMode !== "map" && mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      markersRef.current.clear();
      setMapReady(false);
    }
  }, [viewMode]);

  // Render markers whenever filtered places or map readiness changes
  useEffect(() => {
    if (!mapReady || viewMode !== "map") return;
    const L = leafletRef.current;
    const map = mapRef.current;
    const markersLayer = markersLayerRef.current;
    if (!L || !map || !markersLayer) return;

    markersLayer.clearLayers();
    markersRef.current.clear();

    const allLatLngs: L.LatLngExpression[] = [];

    for (const place of geoPlaces) {
      const pos: L.LatLngExpression = [place.geo!.lat, place.geo!.lon];
      allLatLngs.push(pos);

      const isSelected = place.id === selectedPlaceId;
      const icon = L.divIcon({
        html: `<div style="
          background: ${isSelected ? "#6366f1" : "#3b82f6"};
          color: white;
          border-radius: 50%;
          width: ${isSelected ? "32px" : "26px"};
          height: ${isSelected ? "32px" : "26px"};
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid white;
          box-shadow: 0 2px 6px rgba(0,0,0,${isSelected ? "0.4" : "0.25"});
          transition: all 0.2s ease;
        "><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>`,
        className: "",
        iconSize: [isSelected ? 32 : 26, isSelected ? 32 : 26],
        iconAnchor: [isSelected ? 16 : 13, isSelected ? 16 : 13],
      });

      const marker = L.marker(pos, {
        icon,
        zIndexOffset: isSelected ? 1000 : 0,
      });

      const popupContent = `
        <div style="min-width:150px">
          <div style="font-weight:600">${place.name}</div>
          ${place.type ? `<div style="font-size:12px;color:#6366f1">${place.type}</div>` : ""}
          ${place.address ? `<div style="font-size:12px;color:#666;max-width:220px;word-wrap:break-word">${place.address}</div>` : ""}
        </div>
      `;
      marker.bindPopup(popupContent);

      marker.on("click", () => {
        setSelectedPlaceId(place.id);
        // Scroll list item into view
        const el = listItemRefs.current.get(place.id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });

      markersLayer.addLayer(marker);
      markersRef.current.set(place.id, marker);
    }

    // Fit bounds to show all markers
    if (allLatLngs.length > 1) {
      const bounds = L.latLngBounds(allLatLngs);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } else if (allLatLngs.length === 1) {
      map.setView(allLatLngs[0], 14);
    }
    // If no markers, keep default Israel center
  }, [geoPlaces, mapReady, viewMode, selectedPlaceId]);

  // Pan map to selected place
  const selectPlaceOnMap = useCallback(
    (placeId: string) => {
      setSelectedPlaceId(placeId);
      if (!mapReady) return;
      const map = mapRef.current;
      const marker = markersRef.current.get(placeId);
      if (map && marker) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), {
          animate: true,
        });
        marker.openPopup();
      }
    },
    [mapReady]
  );

  return (
    <div>
      {/* Leaflet CSS (only in map mode) */}
      {viewMode === "map" && (
        // eslint-disable-next-line @next/next/no-css-tags
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        />
      )}

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
        <div className="flex gap-1 border rounded-md p-0.5">
          <Button
            variant={viewMode === "list" ? "default" : "ghost"}
            size="sm"
            onClick={() => setViewMode("list")}
            className="px-2"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "map" ? "default" : "ghost"}
            size="sm"
            onClick={() => setViewMode("map")}
            className="px-2"
          >
            <MapIcon className="h-4 w-4" />
          </Button>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" />
          Add Place
        </Button>
      </div>

      {/* View content */}
      {viewMode === "list" ? (
        /* ---- LIST VIEW (original grid) ---- */
        filtered.length === 0 ? (
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
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="text-xs"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : (
        /* ---- MAP VIEW (split: list 1/3 + map 2/3) ---- */
        <div className="flex h-[calc(100vh-12rem)] border rounded-lg overflow-hidden">
          {/* Left panel: scrollable place list */}
          <div className="w-1/3 min-w-[260px] border-r overflow-y-auto bg-white dark:bg-gray-950">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4">
                <MapPin className="h-8 w-8 mb-2" />
                <p className="text-sm text-center">No places match.</p>
              </div>
            ) : (
              <div className="divide-y">
                {filtered.map((place) => (
                  <div
                    key={place.id}
                    ref={(el) => {
                      if (el) listItemRefs.current.set(place.id, el);
                      else listItemRefs.current.delete(place.id);
                    }}
                    className={`p-3 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-900 ${
                      selectedPlaceId === place.id
                        ? "bg-indigo-50 dark:bg-indigo-950 border-l-2 border-l-indigo-500"
                        : ""
                    }`}
                    onClick={() => {
                      if (place.geo) {
                        selectPlaceOnMap(place.id);
                      } else {
                        openEdit(place);
                      }
                    }}
                    onDoubleClick={() => openEdit(place)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">
                        {place.name}
                      </span>
                      {place.type && (
                        <Badge
                          variant={TYPE_VARIANT[place.type] ?? "outline"}
                          className="shrink-0 text-[10px] px-1.5 py-0"
                        >
                          {place.type}
                        </Badge>
                      )}
                    </div>
                    {place.address && (
                      <p className="text-xs text-gray-500 mt-1 truncate">
                        {place.address}
                      </p>
                    )}
                    {!place.geo && (
                      <p className="text-[10px] text-gray-400 mt-1 italic">
                        No coordinates
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right panel: Leaflet map */}
          <div className="flex-1 relative z-0">
            <div ref={mapContainerRef} className="h-full w-full" />
          </div>
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
