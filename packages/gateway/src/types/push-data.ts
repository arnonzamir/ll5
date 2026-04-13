import { z } from 'zod';

// --- Zod schemas for webhook payload validation ---

const PushLocationItemSchema = z.object({
  type: z.literal('location'),
  timestamp: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().optional(),
  battery_pct: z.number().min(0).max(100).optional(),
});

const PushMessageItemSchema = z.object({
  type: z.literal('message'),
  timestamp: z.string().datetime({ offset: true }),
  sender: z.string().min(1),
  app: z.string().min(1),
  body: z.string(),
  is_group: z.boolean().optional(),
  group_name: z.string().nullable().optional(),
});

const PushCalendarItemSchema = z.object({
  type: z.literal('calendar_event'),
  timestamp: z.string().datetime({ offset: true }),
  title: z.string().min(1),
  start: z.string().min(1), // ISO datetime or date-only (YYYY-MM-DD) for all-day events
  end: z.string().min(1).nullish(), // Nullable — some all-day events have no end
  location: z.string().nullish(),
  all_day: z.boolean().nullish(),
  calendar_name: z.string().nullish(),
  attendees: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).nullish(),
  availability: z.enum(['busy', 'free', 'tentative']).nullish(),
});

// Device calendar list — metadata about available calendars on the phone (no-op, just accept)
const PushDeviceCalendarSchema = z.object({
  type: z.literal('device_calendar'),
}).passthrough();

// Phone contact — address book entry with name and phone number (for WhatsApp name enrichment)
const PushPhoneContactSchema = z.object({
  type: z.literal('phone_contact'),
  timestamp: z.string(),
  sender: z.string().min(1),  // display name from address book
  body: z.string().min(1),    // phone number (normalized: +digits or digits)
});

// Phone status — battery / charging / storage / ram snapshot from the phone
const PushPhoneStatusItemSchema = z.object({
  type: z.literal('phone_status'),
  timestamp: z.string().datetime({ offset: true }),
  battery_pct: z.number().min(0).max(100),
  is_charging: z.boolean(),
  plug_type: z.enum(['none', 'ac', 'usb', 'wireless', 'dock', 'unknown']).optional(),
  battery_temp_c: z.number().optional(),
  battery_health: z.string().optional(),
  low_power_mode: z.boolean().optional(),
  storage_used_bytes: z.number().nonnegative().optional(),
  storage_total_bytes: z.number().nonnegative().optional(),
  ram_used_bytes: z.number().nonnegative().optional(),
  ram_total_bytes: z.number().nonnegative().optional(),
  trigger: z.enum(['change', 'plug', 'low', 'heartbeat']).optional(),
});

// WiFi connection — current connected network (or disconnect event)
const PushWifiItemSchema = z.object({
  type: z.literal('wifi'),
  timestamp: z.string().datetime({ offset: true }),
  connected: z.boolean(),
  ssid: z.string().nullable().optional(),
  bssid: z.string().nullable().optional(),
  rssi_dbm: z.number().int().optional(),
  frequency_mhz: z.number().int().optional(),
  link_speed_mbps: z.number().int().optional(),
  ip_address: z.string().nullable().optional(),
  trigger: z.enum(['connect', 'disconnect', 'ssid_change', 'heartbeat']).optional(),
});

const PushItemSchema = z.discriminatedUnion('type', [
  PushLocationItemSchema,
  PushMessageItemSchema,
  PushCalendarItemSchema,
  PushDeviceCalendarSchema,
  PushPhoneContactSchema,
  PushPhoneStatusItemSchema,
  PushWifiItemSchema,
]);

export const WebhookPayloadSchema = z.object({
  items: z.array(z.unknown()).min(1),
});

export { PushItemSchema };

// --- Inferred types ---

export type PushLocationItem = z.infer<typeof PushLocationItemSchema>;
export type PushMessageItem = z.infer<typeof PushMessageItemSchema>;
export type PushCalendarItem = z.infer<typeof PushCalendarItemSchema>;
export type PushPhoneContactItem = z.infer<typeof PushPhoneContactSchema>;
export type PushPhoneStatusItem = z.infer<typeof PushPhoneStatusItemSchema>;
export type PushWifiItem = z.infer<typeof PushWifiItemSchema>;
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
