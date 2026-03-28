import { Card, CardContent } from "@/components/ui/card";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export const metadata = { title: "Knowledge - LL5" };

export default function KnowledgePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Knowledge</h1>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search knowledge base..."
          className="pl-10"
          disabled
        />
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Search className="h-12 w-12 mb-3" />
          <p className="text-sm">Knowledge search coming soon</p>
          <p className="text-xs mt-1">
            Will search facts, people, and places from personal-knowledge MCP
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
