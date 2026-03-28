import { Card, CardContent } from "@/components/ui/card";
import { Users } from "lucide-react";

export const metadata = { title: "People - LL5" };

export default function PeoplePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">People</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Users className="h-12 w-12 mb-3" />
          <p className="text-sm">People directory coming soon</p>
          <p className="text-xs mt-1">
            Will show contacts from personal-knowledge MCP
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
