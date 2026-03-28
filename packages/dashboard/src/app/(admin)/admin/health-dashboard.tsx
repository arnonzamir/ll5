"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pollHealth } from "./health-actions";

interface ServiceHealth {
  name: string;
  healthy: boolean;
  responseTime: number;
}

const SERVICE_NAMES = ["gtd", "knowledge", "awareness", "gateway"] as const;
const DISPLAY_NAMES: Record<string, string> = {
  gtd: "GTD",
  knowledge: "Personal Knowledge",
  awareness: "Awareness",
  gateway: "Gateway",
};

export function HealthDashboard() {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await pollHealth();
    setServices(results);
    setLastChecked(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {lastChecked
            ? `Last checked: ${lastChecked.toLocaleTimeString()}`
            : "Checking..."}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {SERVICE_NAMES.map((name) => {
          const svc = services.find((s) => s.name === name);
          return (
            <Card key={name}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    {DISPLAY_NAMES[name]}
                  </span>
                  {svc ? (
                    <Badge variant={svc.healthy ? "success" : "destructive"}>
                      {svc.healthy ? "Healthy" : "Down"}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Checking</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`h-3 w-3 rounded-full ${
                      svc
                        ? svc.healthy
                          ? "bg-green-500"
                          : "bg-red-500"
                        : "bg-gray-300"
                    }`}
                  />
                  <span className="text-xs text-gray-500">
                    {svc ? `${svc.responseTime}ms` : "--"}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
