import { z } from 'zod';

// --- Zod schemas for webhook payload validation ---

const PushLocationItemSchema = z.object({
  type: z.literal('location'),
  timestamp: z.string().datetime(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().optional(),
  battery_pct: z.number().min(0).max(100).optional(),
});

const PushMessageItemSchema = z.object({
  type: z.literal('message'),
  timestamp: z.string().datetime(),
  sender: z.string().min(1),
  app: z.string().min(1),
  body: z.string(),
  is_group: z.boolean().optional(),
  group_name: z.string().nullable().optional(),
});

const PushCalendarItemSchema = z.object({
  type: z.literal('calendar_event'),
  timestamp: z.string().datetime(),
  title: z.string().min(1),
  start: z.string().min(1), // ISO datetime or date-only (YYYY-MM-DD) for all-day events
  end: z.string().min(1).nullish(), // Nullable — some all-day events have no end
  location: z.string().nullish(),
  all_day: z.boolean().nullish(),
});

const PushItemSchema = z.discriminatedUnion('type', [
  PushLocationItemSchema,
  PushMessageItemSchema,
  PushCalendarItemSchema,
]);

export const WebhookPayloadSchema = z.object({
  items: z.array(z.unknown()).min(1),
});

export { PushItemSchema };

// --- Inferred types ---

export type PushLocationItem = z.infer<typeof PushLocationItemSchema>;
export type PushMessageItem = z.infer<typeof PushMessageItemSchema>;
export type PushCalendarItem = z.infer<typeof PushCalendarItemSchema>;
export type PushItem = z.infer<typeof PushItemSchema>;
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// --- Processing result types ---

export interface ItemResult {
  index: number;
  type: string;
  status: 'ok' | 'error';
  error?: string;
}

export interface WebhookResponse {
  accepted: number;
  failed: number;
  results: ItemResult[];
}
