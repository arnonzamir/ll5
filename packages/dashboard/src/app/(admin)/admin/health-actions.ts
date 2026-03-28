"use server";

import { checkHealth } from "@/lib/api";

interface ServiceHealth {
  name: string;
  healthy: boolean;
  responseTime: number;
}

export async function pollHealth(): Promise<ServiceHealth[]> {
  const servers = ["gtd", "knowledge", "awareness", "gateway"] as const;

  const results = await Promise.all(
    servers.map(async (name) => {
      const { healthy, responseTime } = await checkHealth(name);
      return { name, healthy, responseTime };
    })
  );

  return results;
}
