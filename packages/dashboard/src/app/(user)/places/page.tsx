import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { mcpCallList } from "@/lib/api";
import { MapPin } from "lucide-react";

export const metadata = { title: "Places - LL5" };

interface Place {
  id: string;
  name: string;
  type?: string;
  address?: string | null;
  geo?: { lat: number; lon: number } | null;
  tags?: string[];
}

const TYPE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  home: "warning",
  work: "default",
  office: "default",
  gym: "success",
  restaurant: "secondary",
  store: "outline",
  medical: "destructive" as "default",
  school: "default",
};

export default async function PlacesPage() {
  const items = await mcpCallList<Place>("knowledge", "list_places");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Places</h1>
      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <MapPin className="h-12 w-12 mb-3" />
            <p className="text-sm">No places saved yet.</p>
            <p className="text-xs mt-1">
              Tell Claude about your important locations.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((place) => (
            <Card key={place.id} className="hover:shadow-md transition-shadow">
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
    </div>
  );
}
