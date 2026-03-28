import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";

interface StatusCardProps {
  title: string;
  value: number | string;
  icon: LucideIcon;
  variant?: "default" | "warning" | "danger";
  className?: string;
}

export function StatusCard({
  title,
  value,
  icon: Icon,
  variant = "default",
  className,
}: StatusCardProps) {
  return (
    <Card className={cn("relative overflow-hidden", className)}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-500">{title}</p>
            <p
              className={cn(
                "text-2xl font-bold mt-1",
                variant === "danger" && "text-red-600",
                variant === "warning" && "text-amber-600",
                variant === "default" && "text-gray-900"
              )}
            >
              {value}
            </p>
          </div>
          <div
            className={cn(
              "rounded-full p-2.5",
              variant === "danger" && "bg-red-100 text-red-600",
              variant === "warning" && "bg-amber-100 text-amber-600",
              variant === "default" && "bg-primary/10 text-primary"
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
