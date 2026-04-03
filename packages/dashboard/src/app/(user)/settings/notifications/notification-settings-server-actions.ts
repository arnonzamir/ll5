"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";

// --- Types ---

export interface NotificationRule {
  id: string;
  user_id: string;
  rule_type: "sender" | "app" | "keyword" | "group" | "app_direct" | "app_group" | "wildcard" | "conversation";
  match_value: string;
  priority: "immediate" | "batch" | "ignore" | "agent";
  platform?: string;
  download_images?: boolean;
  created_at: string;
}

export interface ConversationInfo {
  conversation_id: string;
  platform: string;
  name: string | null;
  is_group: boolean;
  last_message_at: string | null;
}

export type SenderCategory = "family" | "friends" | "work" | "other";

export interface KnownSender {
  sender: string;
  app: string;
  messageCount: number;
  lastSeen: string;
  category: SenderCategory;
  relationship?: string;
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
  } catch (err) {
    console.error("[notifications] fetchRules failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function createRule(
  rule_type: NotificationRule["rule_type"],
  match_value: string,
  priority: NotificationRule["priority"],
  platform?: string,
  download_images?: boolean
): Promise<NotificationRule | null> {
  try {
    const body: Record<string, unknown> = { rule_type, match_value, priority };
    if (platform) body.platform = platform;
    if (download_images !== undefined) body.download_images = download_images;
    const res = await gatewayFetch("/notification-rules", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as NotificationRule;
  } catch (err) {
    console.error("[notifications] createRule failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fetchConversations(params?: {
  query?: string;
  offset?: number;
  limit?: number;
}): Promise<{ conversations: ConversationInfo[]; total: number }> {
  const args: Record<string, unknown> = { limit: params?.limit ?? 50 };
  if (params?.query) args.query = params.query;
  if (params?.offset !== undefined) args.offset = params.offset;

  const raw = await mcpCallJsonSafe<Record<string, unknown>>(
    "messaging",
    "list_conversations",
    args
  );
  if (!raw || typeof raw !== "object") return { conversations: [], total: 0 };
  const conversations = Array.isArray(raw.conversations) ? (raw.conversations as ConversationInfo[]) : [];
  const total = typeof raw.total === "number" ? raw.total : conversations.length;
  return { conversations, total };
}

export async function deleteRule(id: string): Promise<boolean> {
  try {
    const res = await gatewayFetch(`/notification-rules/${id}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch (err) {
    console.error("[notifications] deleteRule failed:", err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.error("[notifications] Token decode failed:", err instanceof Error ? err.message : String(err));
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
              terms: { field: "sender.keyword", size: 1000 },
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
          category: "other",
        });
      }
    }

    // Cross-reference with knowledge MCP for relationships
    const peopleRaw = await mcpCallJsonSafe<Record<string, unknown>>("knowledge", "list_people");
    const people = (
      peopleRaw && typeof peopleRaw === "object"
        ? (Array.isArray(peopleRaw)
            ? peopleRaw
            : (peopleRaw as Record<string, unknown>).people ?? [])
        : []
    ) as Array<{ name?: string; aliases?: string[]; relationship?: string }>;

    // Build a name→category map
    const FAMILY_TERMS = ["family", "parent", "mother", "father", "mom", "dad", "sister", "brother", "wife", "husband", "spouse", "son", "daughter", "child", "aunt", "uncle", "cousin", "grandmother", "grandfather", "משפחה"];
    const WORK_TERMS = ["work", "colleague", "coworker", "boss", "manager", "employee", "client", "partner", "business", "עבודה"];
    const FRIEND_TERMS = ["friend", "חבר", "חברה"];

    function categorize(rel?: string): SenderCategory {
      if (!rel) return "other";
      const lower = rel.toLowerCase();
      if (FAMILY_TERMS.some((t) => lower.includes(t))) return "family";
      if (WORK_TERMS.some((t) => lower.includes(t))) return "work";
      if (FRIEND_TERMS.some((t) => lower.includes(t))) return "friends";
      return "other";
    }

    // Map person names+aliases to their category
    const nameToCategory = new Map<string, { category: SenderCategory; relationship?: string }>();
    for (const person of people) {
      const cat = categorize(person.relationship);
      if (person.name) {
        nameToCategory.set(person.name.toLowerCase(), { category: cat, relationship: person.relationship });
      }
      for (const alias of person.aliases ?? []) {
        nameToCategory.set(alias.toLowerCase(), { category: cat, relationship: person.relationship });
      }
    }

    // Assign categories to senders
    for (const sender of results) {
      const match = nameToCategory.get(sender.sender.toLowerCase());
      if (match) {
        sender.category = match.category;
        sender.relationship = match.relationship;
      }
    }

    // Sort: family first, then friends, then work, then other. Within each, by message count desc.
    const ORDER: Record<SenderCategory, number> = { family: 0, friends: 1, work: 2, other: 3 };
    results.sort((a, b) => {
      const catDiff = ORDER[a.category] - ORDER[b.category];
      if (catDiff !== 0) return catDiff;
      return b.messageCount - a.messageCount;
    });

    return results;
  } catch (err) {
    console.error("[notifications] fetchKnownSenders failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
