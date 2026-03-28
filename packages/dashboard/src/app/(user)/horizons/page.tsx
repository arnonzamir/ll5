import { Card, CardContent } from "@/components/ui/card";
import { Mountain } from "lucide-react";

export const metadata = { title: "Horizons - LL5" };

export default function HorizonsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Horizons</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Mountain className="h-12 w-12 mb-3" />
          <p className="text-sm">Horizons view coming soon</p>
          <p className="text-xs mt-1">
            Will show purpose, vision, goals, areas, and projects hierarchy
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
