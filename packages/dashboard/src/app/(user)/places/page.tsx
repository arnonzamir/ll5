import { Card, CardContent } from "@/components/ui/card";
import { MapPin } from "lucide-react";

export const metadata = { title: "Places - LL5" };

export default function PlacesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Places</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <MapPin className="h-12 w-12 mb-3" />
          <p className="text-sm">Places directory coming soon</p>
          <p className="text-xs mt-1">
            Will show locations from personal-knowledge MCP
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
