"use client";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface ActionRowProps {
  id: string;
  title: string;
  contexts?: string[];
  energy?: "low" | "medium" | "high";
  dueDate?: string | null;
  projectName?: string | null;
  listType?: string | null;
  waitingFor?: string | null;
  completed?: boolean;
  onToggle?: (id: string, completed: boolean) => void;
}

const energyColors: Record<string, string> = {
  low: "bg-green-500",
  medium: "bg-yellow-500",
  high: "bg-red-500",
};

export function ActionRow({
  id,
  title,
  contexts = [],
  energy,
  dueDate,
  projectName,
  listType,
  waitingFor,
  completed = false,
  onToggle,
}: ActionRowProps) {
  const isOverdue =
    dueDate && !completed && new Date(dueDate) < new Date();

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <Checkbox
        checked={completed}
        onCheckedChange={(checked) => onToggle?.(id, checked === true)}
        aria-label={`Mark "${title}" as ${completed ? "incomplete" : "complete"}`}
      />

      <div className="flex-1 min-w-0">
        <span className={cn("text-sm", completed && "line-through text-gray-400")}>
          {title}
        </span>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {contexts.map((ctx) => (
            <Badge key={ctx} variant="secondary" className="text-xs px-1.5 py-0">
              {ctx}
            </Badge>
          ))}
          {listType === "someday" && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-purple-100 text-purple-700">
              someday
            </Badge>
          )}
          {listType === "waiting" && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-amber-100 text-amber-700">
              {waitingFor ? `waiting: ${waitingFor}` : "waiting"}
            </Badge>
          )}
          {projectName && (
            <Badge variant="outline" className="text-xs px-1.5 py-0">
              {projectName}
            </Badge>
          )}
        </div>
      </div>

      {energy && (
        <span
          className={cn("h-2.5 w-2.5 rounded-full shrink-0", energyColors[energy])}
          title={`Energy: ${energy}`}
        />
      )}

      {dueDate && (
        <span
          className={cn(
            "text-xs whitespace-nowrap",
            isOverdue ? "text-red-600 font-medium" : "text-gray-500"
          )}
        >
          {new Date(dueDate).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}
