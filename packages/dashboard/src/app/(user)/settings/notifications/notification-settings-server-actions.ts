"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

// --- Types ---

export interface NotificationRule {
  id: string;
  user_id: string;
  rule_type: "sender" | "app" | "keyword" | "group" | "app_direct";
  match_value: string;
  priority: "immediate" | "batch" | "ignore";
  created_at: string;
}

export interface KnownSender {
  sender: string;
  app: string;
  messageCount: number;
  lastSeen: string;
}

// --- Gateway helpers ---

async function gatewayFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  return fetch(`${env.GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
}

// --- Server actions ---

export async function fetchRules(): Promise<NotificationRule[]> {
  try {
    const res = await gatewayFetch("/notification-rules");
    if (!res.ok) return [];
    const data = (await res.json()) as { rules: NotificationRule[] };
    return data.rules ?? [];
  } catch {
    return [];
  }
}

export async function createRule(
  rule_type: NotificationRule["rule_type"],
  match_value: string,
  priority: NotificationRule["priority"]
): Promise<NotificationRule | null> {
  try {
    const res = await gatewayFetch("/notification-rules", {
      method: "POST",
      body: JSON.stringify({ rule_type, match_value, priority }),
    });
    if (!res.ok) return null;
    return (await res.json()) as NotificationRule;
  } catch {
    return null;
  }
}

export async function deleteRule(id: string): Promise<boolean> {
  try {
    const res = await gatewayFetch(`/notification-rules/${id}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchKnownSenders(): Promise<KnownSender[]> {
  const baseUrl = env.ELASTICSEARCH_URL;

  // We need the user_id from the token for the ES query
  const token = await getToken();
  if (!token) return [];

  // Decode user_id from JWT
  let userId: string | undefined;
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf-8")
      ) as Record<string, unknown>;
      userId = payload.uid as string | undefined;
    }
  } catch {
    // ignore decode errors
  }

  const filters: Record<string, unknown>[] = [];
  if (userId) {
    filters.push({ term: { user_id: userId } });
  }

  try {
    const response = await fetch(
      `${baseUrl}/ll5_awareness_messages/_search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: 0,
          query:
            filters.length > 0
              ? { bool: { filter: filters } }
              : { match_all: {} },
          aggs: {
            senders: {
              terms: { field: "sender.keyword", size: 100 },
              aggs: {
                apps: { terms: { field: "app", size: 10 } },
                last_message: { max: { field: "timestamp" } },
              },
            },
          },
        }),
      }
    );

    if (!response.ok) return [];

    const data = (await response.json()) as {
      aggregations: {
        senders: {
          buckets: Array<{
            key: string;
            doc_count: number;
            apps: {
              buckets: Array<{ key: string; doc_count: number }>;
            };
            last_message: { value_as_string: string };
          }>;
        };
      };
    };

    const results: KnownSender[] = [];

    for (const senderBucket of data.aggregations.senders.buckets) {
      for (const appBucket of senderBucket.apps.buckets) {
        results.push({
          sender: senderBucket.key,
          app: appBucket.key,
          messageCount: appBucket.doc_count,
          lastSeen: senderBucket.last_message.value_as_string,
        });
      }
    }

    // Sort by message count descending
    results.sort((a, b) => b.messageCount - a.messageCount);

    return results;
  } catch {
    return [];
  }
}
