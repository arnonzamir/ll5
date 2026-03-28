import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FolderKanban, AlertTriangle } from "lucide-react";

interface ProjectCardProps {
  title: string;
  actionCount: number;
  category?: string | null;
  status?: string;
  className?: string;
}

export function ProjectCard({
  title,
  actionCount,
  category,
  status = "active",
  className,
}: ProjectCardProps) {
  const noActions = actionCount === 0 && status === "active";

  return (
    <Card className={cn("hover:shadow-md transition-shadow", className)}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FolderKanban className="h-4 w-4 text-gray-400 shrink-0" />
            <span className="font-medium text-sm truncate">{title}</span>
          </div>
          <Badge
            variant={noActions ? "destructive" : actionCount > 0 ? "default" : "secondary"}
            className="ml-2 shrink-0"
          >
            {actionCount}
          </Badge>
        </div>
        <div className="flex items-center gap-2 mt-2">
          {category && (
            <Badge variant="outline" className="text-xs">
              {category}
            </Badge>
          )}
          {noActions && (
            <div className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              No next action
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
