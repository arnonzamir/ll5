"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MapPin,
  Navigation,
  Clock,
  Calendar,
  Filter,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  fetchLocations,
  fetchCurrentLocation,
  type LocationPoint,
} from "./locations-server-actions";

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------
function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLon *
      sinLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------
interface Cluster {
  center: { lat: number; lon: number };
  count: number;
  first_seen: string;
  last_seen: string;
  address?: string;
  place_name?: string;
  points: LocationPoint[];
}

function clusterLocations(points: LocationPoint[]): Cluster[] {
  const clusters: Cluster[] = [];
  let current: LocationPoint[] = [];

  for (const point of points) {
    if (current.length === 0) {
      current.push(point);
      continue;
    }
    const last = current[current.length - 1];
    const dist = haversine(last.location, point.location);
    if (dist < 0.1) {
      // 100m
      current.push(point);
    } else {
      clusters.push(makeCluster(current));
      current = [point];
    }
  }
  if (current.length > 0) clusters.push(makeCluster(current));
  return clusters;
}

function makeCluster(points: LocationPoint[]): Cluster {
  const latSum = points.reduce((s, p) => s + p.location.lat, 0);
  const lonSum = points.reduce((s, p) => s + p.location.lon, 0);
  const sorted = [...points].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  return {
    center: { lat: latSum / points.length, lon: lonSum / points.length },
    count: points.length,
    first_seen: sorted[0].timestamp,
    last_seen: sorted[sorted.length - 1].timestamp,
    address: sorted[sorted.length - 1].address,
    place_name:
      points.find((p) => p.matched_place)?.matched_place ?? undefined,
    points: sorted,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Date range presets
// ---------------------------------------------------------------------------
type RangePreset = "today" | "7d" | "30d" | "custom";

function getDateRange(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case "7d": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString(), to };
    }
    case "30d": {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: start.toISOString(), to };
    }
    default:
      return { from: new Date(now.getTime() - 86400000).toISOString(), to };
  }
}

// ---------------------------------------------------------------------------
// Trail color gradient from blue (oldest) to red (newest)
// ---------------------------------------------------------------------------
function trailColor(index: number, total: number): string {
  if (total <= 1) return "#3b82f6";
  const ratio = index / (total - 1);
  // Blue (220) -> Red (0)
  const hue = Math.round(220 * (1 - ratio));
  return `hsl(${hue}, 80%, 50%)`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function LocationsView() {
  // State
  const [points, setPoints] = useState<LocationPoint[]>([]);
  const [currentLoc, setCurrentLoc] = useState<LocationPoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangePreset, setRangePreset] = useState<RangePreset>("today");
  const [customFrom, setCustomFrom] = useState(isoDate(new Date()));
  const [customTo, setCustomTo] = useState(isoDate(new Date()));
  const [placeFilter, setPlaceFilter] = useState<string>("");
  const [timelineIndex, setTimelineIndex] = useState<number | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Refs for Leaflet objects (to avoid SSR)
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const trailRef = useRef<L.LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true);
    setSelectedCluster(null);
    setTimelineIndex(null);

    const range =
      rangePreset === "custom"
        ? {
            from: new Date(customFrom).toISOString(),
            to: new Date(customTo + "T23:59:59").toISOString(),
          }
        : getDateRange(rangePreset);

    const [locData, curLoc] = await Promise.all([
      fetchLocations({ ...range, limit: 5000 }),
      fetchCurrentLocation(),
    ]);

    setPoints(locData);
    setCurrentLoc(curLoc);
    setLoading(false);
  }, [rangePreset, customFrom, customTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Compute clusters and unique place names
  const filteredPoints = useMemo(() => {
    if (!placeFilter) return points;
    return points.filter(
      (p) =>
        p.matched_place &&
        p.matched_place.toLowerCase().includes(placeFilter.toLowerCase())
    );
  }, [points, placeFilter]);

  const clusters = useMemo(
    () => clusterLocations(filteredPoints),
    [filteredPoints]
  );

  const placeNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of points) {
      if (p.matched_place) names.add(p.matched_place);
    }
    return Array.from(names).sort();
  }, [points]);

  // Timeline-aware subset: show points up to timelineIndex
  const visiblePoints = useMemo(() => {
    if (timelineIndex === null) return filteredPoints;
    return filteredPoints.slice(0, timelineIndex + 1);
  }, [filteredPoints, timelineIndex]);

  const visibleClusters = useMemo(
    () => clusterLocations(visiblePoints),
    [visiblePoints]
  );

  // Initialize Leaflet map (dynamic import, SSR-safe)
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (mapRef.current) return; // already initialized
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

      const map = L.map(container).setView([32.08, 34.78], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;
      markersRef.current = L.layerGroup().addTo(map);
      trailRef.current = L.layerGroup().addTo(map);
      setMapReady(true);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Render markers and trail whenever visible data changes
  useEffect(() => {
    if (!mapReady) return;
    const L = leafletRef.current;
    const map = mapRef.current;
    const markersGroup = markersRef.current;
    const trailGroup = trailRef.current;
    if (!L || !map || !markersGroup || !trailGroup) return;

    markersGroup.clearLayers();
    trailGroup.clearLayers();

    if (visibleClusters.length === 0 && !currentLoc) return;

    const allLatLngs: L.LatLngExpression[] = [];

    // Draw clusters
    for (const cluster of visibleClusters) {
      const pos: L.LatLngExpression = [
        cluster.center.lat,
        cluster.center.lon,
      ];
      allLatLngs.push(pos);

      if (cluster.count === 1) {
        // Single point marker
        const point = cluster.points[0];
        const marker = L.circleMarker(pos, {
          radius: 6,
          fillColor: "#3b82f6",
          color: "#1d4ed8",
          weight: 2,
          fillOpacity: 0.8,
        });
        marker.bindPopup(buildPointPopup(point));
        markersGroup.addLayer(marker);
      } else {
        // Cluster marker with count badge
        const duration = formatDuration(
          cluster.first_seen,
          cluster.last_seen
        );
        const icon = L.divIcon({
          html: `<div style="
            background: #6366f1;
            color: white;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 600;
            border: 2px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          ">${cluster.count}</div>`,
          className: "",
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });

        const marker = L.marker(pos, { icon });
        const placeLine = cluster.place_name
          ? `<div style="font-weight:600;color:#6366f1">${cluster.place_name}</div>`
          : "";
        const addressLine = cluster.address
          ? `<div style="font-size:12px;color:#666;max-width:250px;word-wrap:break-word">${cluster.address}</div>`
          : "";

        marker.bindPopup(`
          <div style="min-width:180px">
            ${placeLine}
            ${addressLine}
            <div style="margin-top:6px;font-size:12px">
              <div><strong>${cluster.count}</strong> points</div>
              <div>${formatTime(cluster.first_seen)} - ${formatTime(cluster.last_seen)}</div>
              <div>Duration: ${duration}</div>
            </div>
          </div>
        `);

        marker.on("click", () => {
          setSelectedCluster(cluster);
        });

        markersGroup.addLayer(marker);
      }
    }

    // Draw trail line connecting cluster centers chronologically
    if (visibleClusters.length > 1) {
      const latlngs: L.LatLngExpression[] = visibleClusters.map((c) => [
        c.center.lat,
        c.center.lon,
      ]);

      // Gradient segments
      for (let i = 0; i < latlngs.length - 1; i++) {
        const color = trailColor(i, latlngs.length);
        const segment = L.polyline([latlngs[i], latlngs[i + 1]], {
          color,
          weight: 3,
          opacity: 0.7,
          dashArray: "6 4",
        });
        trailGroup.addLayer(segment);
      }
    }

    // Current location marker (different style)
    if (currentLoc) {
      const curPos: L.LatLngExpression = [
        currentLoc.location.lat,
        currentLoc.location.lon,
      ];
      allLatLngs.push(curPos);

      const pulseIcon = L.divIcon({
        html: `<div style="position:relative">
          <div style="
            position:absolute;
            width:20px;height:20px;
            background:#22c55e;
            border-radius:50%;
            border:3px solid white;
            box-shadow:0 0 0 4px rgba(34,197,94,0.3);
            top:-10px;left:-10px;
          "></div>
        </div>`,
        className: "",
        iconSize: [20, 20],
        iconAnchor: [0, 0],
      });
      const curMarker = L.marker(curPos, { icon: pulseIcon, zIndexOffset: 1000 });
      curMarker.bindPopup(
        `<div style="min-width:150px">
          <div style="font-weight:600;color:#22c55e">Current Location</div>
          ${currentLoc.address ? `<div style="font-size:12px;color:#666">${currentLoc.address}</div>` : ""}
          ${currentLoc.matched_place ? `<div style="font-size:12px;color:#6366f1">${currentLoc.matched_place}</div>` : ""}
          <div style="font-size:11px;color:#999;margin-top:4px">${formatDateTime(currentLoc.timestamp)}</div>
        </div>`
      );
      markersGroup.addLayer(curMarker);
    }

    // Fit bounds
    if (allLatLngs.length > 0) {
      const bounds = L.latLngBounds(allLatLngs);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  }, [visibleClusters, currentLoc, mapReady]);

  // When a cluster is selected, zoom in and show individual points
  useEffect(() => {
    if (!mapReady || !selectedCluster) return;
    const L = leafletRef.current;
    const map = mapRef.current;
    const markersGroup = markersRef.current;
    if (!L || !map || !markersGroup) return;

    // Zoom to the cluster area
    const bounds = L.latLngBounds(
      selectedCluster.points.map(
        (p) => [p.location.lat, p.location.lon] as L.LatLngExpression
      )
    );
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 });

    // Add individual point markers
    for (const point of selectedCluster.points) {
      const pos: L.LatLngExpression = [point.location.lat, point.location.lon];
      const marker = L.circleMarker(pos, {
        radius: 5,
        fillColor: "#f59e0b",
        color: "#d97706",
        weight: 2,
        fillOpacity: 0.9,
      });
      marker.bindPopup(buildPointPopup(point));
      markersGroup.addLayer(marker);
    }
  }, [selectedCluster, mapReady]);

  function buildPointPopup(point: LocationPoint): string {
    const lines: string[] = [];
    if (point.matched_place) {
      lines.push(
        `<div style="font-weight:600;color:#6366f1">${point.matched_place}</div>`
      );
    }
    if (point.address) {
      lines.push(
        `<div style="font-size:12px;color:#666;max-width:250px;word-wrap:break-word">${point.address}</div>`
      );
    }
    lines.push(
      `<div style="font-size:11px;color:#999;margin-top:4px">${formatDateTime(point.timestamp)}</div>`
    );
    if (point.accuracy) {
      lines.push(
        `<div style="font-size:11px;color:#999">Accuracy: ${Math.round(point.accuracy)}m</div>`
      );
    }
    if (point.speed !== undefined && point.speed > 0) {
      lines.push(
        `<div style="font-size:11px;color:#999">Speed: ${Math.round(point.speed * 3.6)} km/h</div>`
      );
    }
    return `<div style="min-width:150px">${lines.join("")}</div>`;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] -my-6 -mx-4">
      {/* Leaflet CSS */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      />

      {/* Top controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-white border-b border-gray-200 z-10">
        {/* Date range presets */}
        <div className="flex items-center gap-1">
          <Calendar className="h-4 w-4 text-gray-400 mr-1" />
          {(["today", "7d", "30d", "custom"] as const).map((preset) => (
            <Button
              key={preset}
              variant={rangePreset === preset ? "default" : "outline"}
              size="sm"
              onClick={() => setRangePreset(preset)}
            >
              {preset === "today"
                ? "Today"
                : preset === "7d"
                  ? "7 Days"
                  : preset === "30d"
                    ? "30 Days"
                    : "Custom"}
            </Button>
          ))}
        </div>

        {/* Custom date inputs */}
        {rangePreset === "custom" && (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="w-36 h-8 text-sm"
            />
            <span className="text-gray-400 text-sm">to</span>
            <Input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="w-36 h-8 text-sm"
            />
            <Button size="sm" onClick={loadData}>
              Apply
            </Button>
          </div>
        )}

        {/* Place filter */}
        {placeNames.length > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <Filter className="h-4 w-4 text-gray-400" />
            <select
              value={placeFilter}
              onChange={(e) => setPlaceFilter(e.target.value)}
              className="h-8 text-sm border rounded-md px-2 bg-white"
            >
              <option value="">All places</option>
              {placeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {placeFilter && (
              <button
                onClick={() => setPlaceFilter("")}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* Stats badge */}
        <div className="flex items-center gap-3 ml-auto text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {filteredPoints.length} points
          </span>
          <span className="flex items-center gap-1">
            <Navigation className="h-3 w-3" />
            {clusters.length} stops
          </span>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 bg-white/80 z-20 flex items-center justify-center">
            <div className="flex items-center gap-2 text-gray-500">
              <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
              Loading locations...
            </div>
          </div>
        )}
        <div ref={mapContainerRef} className="h-full w-full" />
      </div>

      {/* Timeline slider */}
      {filteredPoints.length > 1 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-white border-t border-gray-200">
          <Clock className="h-4 w-4 text-gray-400 shrink-0" />
          <button
            onClick={() =>
              setTimelineIndex((prev) =>
                prev === null ? 0 : Math.max(0, prev - 1)
              )
            }
            className="text-gray-400 hover:text-gray-600"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={0}
            max={filteredPoints.length - 1}
            value={timelineIndex ?? filteredPoints.length - 1}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              setTimelineIndex(
                val === filteredPoints.length - 1 ? null : val
              );
            }}
            className="flex-1 accent-primary"
          />
          <button
            onClick={() =>
              setTimelineIndex((prev) => {
                if (prev === null) return null;
                const next = prev + 1;
                return next >= filteredPoints.length - 1 ? null : next;
              })
            }
            className="text-gray-400 hover:text-gray-600"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span className="text-xs text-gray-500 w-28 text-right shrink-0">
            {timelineIndex !== null
              ? formatDateTime(filteredPoints[timelineIndex].timestamp)
              : "All points"}
          </span>
          {timelineIndex !== null && (
            <button
              onClick={() => setTimelineIndex(null)}
              className="text-xs text-primary hover:underline shrink-0"
            >
              Reset
            </button>
          )}
        </div>
      )}

      {/* Selected cluster detail panel */}
      {selectedCluster && (
        <div className="absolute bottom-16 right-4 z-20 w-72">
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-medium">
                {selectedCluster.place_name || "Location Cluster"}
              </CardTitle>
              <button
                onClick={() => setSelectedCluster(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </CardHeader>
            <CardContent className="text-xs space-y-1">
              {selectedCluster.address && (
                <p className="text-gray-600">{selectedCluster.address}</p>
              )}
              <p>
                <strong>{selectedCluster.count}</strong> data points
              </p>
              <p>
                {formatTime(selectedCluster.first_seen)} -{" "}
                {formatTime(selectedCluster.last_seen)}
              </p>
              <p>
                Duration:{" "}
                {formatDuration(
                  selectedCluster.first_seen,
                  selectedCluster.last_seen
                )}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
