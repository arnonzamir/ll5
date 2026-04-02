"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/dialog";
import {
  RefreshCw,
  ImageIcon,
  LayoutGrid,
  List,
  ChevronLeft,
  ChevronRight,
  Search,
  ExternalLink,
  FileText,
  Film,
  Music,
  File,
} from "lucide-react";
import {
  fetchMedia,
  fetchMediaLinks,
  type MediaItem,
  type MediaLink,
} from "./media-server-actions";

const PAGE_SIZE = 30;

const SOURCE_OPTIONS = [
  { value: "all", label: "All Sources" },
  { value: "chat", label: "Chat" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "share", label: "Share" },
  { value: "upload", label: "Upload" },
  { value: "wa-export", label: "WA Export" },
];

function formatDate(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

function FileTypeIcon({ mime }: { mime: string }) {
  if (isImageMime(mime)) return <ImageIcon className="h-4 w-4" />;
  if (isVideoMime(mime)) return <Film className="h-4 w-4" />;
  if (isAudioMime(mime)) return <Music className="h-4 w-4" />;
  if (mime.startsWith("text/") || mime.includes("pdf"))
    return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function sourceVariant(
  source: string
): "default" | "secondary" | "success" | "warning" | "outline" {
  switch (source) {
    case "chat":
      return "default";
    case "whatsapp":
      return "success";
    case "share":
      return "warning";
    case "upload":
      return "secondary";
    case "wa-export":
      return "outline";
    default:
      return "secondary";
  }
}

function ThumbnailImage({
  item,
  className,
}: {
  item: MediaItem;
  className?: string;
}) {
  if (isImageMime(item.mime_type)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/uploads/${item.url}`}
        alt={item.filename}
        className={className}
        loading="lazy"
      />
    );
  }

  if (isVideoMime(item.mime_type)) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 ${className ?? ""}`}
      >
        <Film className="h-8 w-8 text-gray-400" />
      </div>
    );
  }

  if (isAudioMime(item.mime_type)) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 ${className ?? ""}`}
      >
        <Music className="h-8 w-8 text-gray-400" />
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-center bg-gray-100 ${className ?? ""}`}
    >
      <File className="h-8 w-8 text-gray-400" />
    </div>
  );
}

export function MediaView() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [viewMode, setViewMode] = useState<"gallery" | "list">("gallery");
  const [isPending, startTransition] = useTransition();

  // Detail dialog
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [selectedLinks, setSelectedLinks] = useState<MediaLink[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(
    (p: number, q: string, src: string) => {
      startTransition(async () => {
        const data = await fetchMedia({
          query: q || undefined,
          source: src === "all" ? undefined : src,
          limit: PAGE_SIZE,
          offset: p * PAGE_SIZE,
        });
        setMedia(data.media);
        setTotal(data.total);
      });
    },
    []
  );

  useEffect(() => {
    load(0, "", "all");
  }, [load]);

  function handleSearch() {
    setPage(0);
    load(0, query, source);
  }

  function handleSourceChange(val: string) {
    setSource(val);
    setPage(0);
    load(0, query, val);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    load(newPage, query, source);
  }

  function openDetail(item: MediaItem) {
    setSelectedItem(item);
    setSelectedLinks([]);
    setDialogOpen(true);
    startTransition(async () => {
      const data = await fetchMediaLinks(item.id);
      setSelectedLinks(data.links);
    });
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Media</h1>
          <p className="text-sm text-gray-500 mt-1">
            Photos, videos, and files
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "gallery" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("gallery")}
            aria-label="Gallery view"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("list")}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => load(page, query, source)}
            disabled={isPending}
            variant="outline"
            size="sm"
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSearch();
          }}
          className="flex items-center gap-2 flex-1"
        >
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search files..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={isPending}>
            Search
          </Button>
        </form>
        <Select value={source} onValueChange={handleSourceChange}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {media.length === 0 && !isPending ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
              <ImageIcon className="h-12 w-12 mb-3" />
              <p className="text-sm">No media files yet.</p>
            </CardContent>
          </Card>
        ) : viewMode === "gallery" ? (
          <GalleryGrid media={media} onSelect={openDetail} />
        ) : (
          <ListView media={media} onSelect={openDetail} />
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-4 mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => handlePageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm text-gray-500">
              {page * PAGE_SIZE + 1}-
              {Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => handlePageChange(page + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedItem && <FileTypeIcon mime={selectedItem.mime_type} />}
              <span className="truncate">{selectedItem?.filename}</span>
            </DialogTitle>
          </DialogHeader>
          {selectedItem && (
            <div className="flex-1 overflow-y-auto space-y-4 pt-2">
              {/* Preview */}
              {isImageMime(selectedItem.mime_type) && (
                <div className="flex justify-center bg-gray-50 rounded-lg p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/uploads/${selectedItem.url}`}
                    alt={selectedItem.filename}
                    className="max-h-96 rounded object-contain"
                  />
                </div>
              )}
              {isVideoMime(selectedItem.mime_type) && (
                <div className="flex justify-center bg-gray-50 rounded-lg p-2">
                  <video
                    src={`/api/uploads/${selectedItem.url}`}
                    controls
                    className="max-h-96 rounded"
                  />
                </div>
              )}
              {isAudioMime(selectedItem.mime_type) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <audio
                    src={`/api/uploads/${selectedItem.url}`}
                    controls
                    className="w-full"
                  />
                </div>
              )}

              {/* Details */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-500">Source</span>
                  <div className="mt-1">
                    <Badge variant={sourceVariant(selectedItem.source)}>
                      {selectedItem.source}
                    </Badge>
                  </div>
                </div>
                <div>
                  <span className="text-gray-500">Type</span>
                  <p className="mt-1 font-mono text-xs">
                    {selectedItem.mime_type}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Date</span>
                  <p className="mt-1">{formatDate(selectedItem.created_at)}</p>
                </div>
                {selectedItem.size_bytes && (
                  <div>
                    <span className="text-gray-500">Size</span>
                    <p className="mt-1">
                      {formatSize(selectedItem.size_bytes)}
                    </p>
                  </div>
                )}
                {selectedItem.description && (
                  <div className="col-span-2">
                    <span className="text-gray-500">Description</span>
                    <p className="mt-1">{selectedItem.description}</p>
                  </div>
                )}
                {selectedItem.tags && selectedItem.tags.length > 0 && (
                  <div className="col-span-2">
                    <span className="text-gray-500">Tags</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedItem.tags.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Links */}
              {selectedLinks.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">
                    Linked entities
                  </h3>
                  <div className="space-y-1">
                    {selectedLinks.map((link, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-sm text-gray-600"
                      >
                        <Badge variant="outline" className="text-xs">
                          {link.entity_type}
                        </Badge>
                        <span className="font-mono text-xs truncate">
                          {link.entity_id}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Open full size */}
              <div className="flex justify-end pt-2">
                <a
                  href={`/api/uploads/${selectedItem.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open original
                </a>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GalleryGrid({
  media,
  onSelect,
}: {
  media: MediaItem[];
  onSelect: (item: MediaItem) => void;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {media.map((item) => (
        <div
          key={item.id}
          className="group relative aspect-square rounded-lg overflow-hidden cursor-pointer border border-gray-200 hover:shadow-lg transition-shadow bg-gray-50"
          onClick={() => onSelect(item)}
        >
          <ThumbnailImage
            item={item}
            className="h-full w-full object-cover"
          />
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex flex-col justify-end p-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-white text-xs font-medium truncate">
              {item.filename}
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              <Badge
                variant={sourceVariant(item.source)}
                className="text-[10px] px-1.5 py-0"
              >
                {item.source}
              </Badge>
              <span className="text-white/70 text-[10px]">
                {formatDate(item.created_at)}
              </span>
            </div>
            {item.size_bytes && (
              <span className="text-white/60 text-[10px] mt-0.5">
                {formatSize(item.size_bytes)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ListView({
  media,
  onSelect,
}: {
  media: MediaItem[];
  onSelect: (item: MediaItem) => void;
}) {
  return (
    <div className="space-y-1">
      {/* Header row */}
      <div className="grid grid-cols-[48px_1fr_100px_80px_140px_80px] gap-3 px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
        <div />
        <div>Name</div>
        <div>Source</div>
        <div>Size</div>
        <div>Date</div>
        <div>Tags</div>
      </div>
      {media.map((item) => (
        <Card
          key={item.id}
          className="hover:shadow-md transition-shadow cursor-pointer"
          onClick={() => onSelect(item)}
        >
          <CardContent className="p-0">
            <div className="grid grid-cols-[48px_1fr_100px_80px_140px_80px] gap-3 items-center px-3 py-2">
              {/* Thumbnail */}
              <div className="h-10 w-10 rounded overflow-hidden flex-shrink-0">
                <ThumbnailImage
                  item={item}
                  className="h-full w-full object-cover"
                />
              </div>
              {/* Filename */}
              <div className="flex items-center gap-2 min-w-0">
                <FileTypeIcon mime={item.mime_type} />
                <span className="text-sm truncate">{item.filename}</span>
              </div>
              {/* Source */}
              <div>
                <Badge
                  variant={sourceVariant(item.source)}
                  className="text-xs"
                >
                  {item.source}
                </Badge>
              </div>
              {/* Size */}
              <span className="text-xs text-gray-500">
                {formatSize(item.size_bytes)}
              </span>
              {/* Date */}
              <span className="text-xs text-gray-500">
                {formatDate(item.created_at)}
              </span>
              {/* Tags */}
              <div className="flex flex-wrap gap-0.5">
                {item.tags?.slice(0, 2).map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="text-[10px] px-1 py-0"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
