import { Card, CardContent } from "@/components/ui/card";
import { Wrench } from "lucide-react";

export const metadata = { title: "MCP Tools - LL5 Admin" };

export default function ToolsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">MCP Tool Tester</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Wrench className="h-12 w-12 mb-3" />
          <p className="text-sm">MCP tool tester coming soon</p>
          <p className="text-xs mt-1">
            Will list all tools across MCPs with auto-generated forms for testing
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
