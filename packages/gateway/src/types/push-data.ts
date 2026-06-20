import { z } from 'zod';

// --- Zod schemas for webhook payload validation ---

const PushLocationItemSchema = z.object({
  type: z.literal('location'),
  timestamp: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().optional(),
  battery_pct: z.number().min(0).max(100).optional(),
  // Device-reported motion (G3). The phone already collects these; accepting
  // them lets the deviation logic trust real fast travel instead of guessing
  // from successive GPS fixes alone.
  // nullable: the app sends an explicit null when speed is unknown (never a fake 0).
  speed_mps: z.number().nonnegative().nullable().optional(),
  // Alias: older app builds send `speed` (m/s) instead of `speed_mps`. Accept both.
  speed: z.number().nonnegative().nullable().optional(),
  // Provenance: where the device's speed came from ('gnss' = GNSS Doppler, trustworthy;
  // 'derived' = differenced from successive fixes on-device). null/absent = unknown.
  speed_source: z.enum(['gnss', 'derived']).nullable().optional(),
  // Formal motion label from the Android Activity Recognition / Transition API, and
  // its source. Far more reliable than inferring motion from (often-zero) speed.
  motion: z.enum(['in_vehicle', 'on_bicycle', 'walking', 'running', 'still']).nullable().optional(),
  motion_source: z.enum(['activity_recognition']).nullable().optional(),
  bearing_deg: z.number().min(0).max(360).optional(),
  altitude_m: z.number().optional(),
});

const PushMessageItemSchema = z.object({
  type: z.literal('message'),
  timestamp: z.string().datetime({ offset: true }),
  sender: z.string().min(1),
  app: z.string().min(1),
  body: z.string(),
  is_group: z.boolean().optional(),
  group_name: z.string().nullable().optional(),
  from_me: z.boolean().optional(), // true = the user sent this (outbound capture)
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

const PushCameraPhotoSchema = z.object({
  type: z.literal('camera_photo'),
  timestamp: z.string().datetime({ offset: true }), // when the photo was taken (EXIF/date-taken)
  url: z.string(),                                   // uploaded image URL (gateway /uploads or /public)
  mime_type: z.string().optional(),
  filename: z.string().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bucket: z.string().optional(),                     // album/folder (e.g. "Camera", "Screenshots")
});

// Tracked device — current location of a device or Bluetooth tag from the
// Google Find Hub (Find My Device) network, pushed by the findhub-poller
// sidecar. Unlike a `location` item (the USER's GPS), this is "where a THING
// is": phones/tablets/watches on the account and registered trackers. Upserted
// as current-state per device, NOT appended to the user's location stream.
const PushTrackedDeviceSchema = z.object({
  type: z.literal('tracked_device'),
  // Stable Google canonic id for the device — the upsert key. Required so we
  // never create duplicate docs for the same physical device.
  device_id: z.string().min(1),
  name: z.string().min(1),
  device_type: z.enum(['phone', 'tablet', 'watch', 'tracker', 'unknown']).optional(),
  // When the Find Hub network last located the device (network freshness).
  timestamp: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().nonnegative().optional(),
  battery_pct: z.number().min(0).max(100).optional(),
  // Google's own semantic location label for the fix, when the network gives one.
  semantic_name: z.string().nullable().optional(),
});

// Device activity — battery-light rollup of phone interactivity + app usage for
// one sync window, derived on-device from a single UsageStatsManager poll. One
// item per window. We state facts (first interaction, screen-on time, top apps);
// the agent deduces wake/active/idle.
const PushTopAppSchema = z.object({
  package: z.string(),
  app_name: z.string().optional(),
  category: z.string().optional(),
  foreground_ms: z.number().nonnegative().optional(),
  opens: z.number().int().nonnegative().optional(),
});
const PushDeviceActivityItemSchema = z.object({
  type: z.literal('device_activity'),
  timestamp: z.string().datetime({ offset: true }), // = window_end
  window_start: z.string().datetime({ offset: true }),
  window_end: z.string().datetime({ offset: true }),
  screen_on_ms: z.number().nonnegative().optional(),
  unlock_count: z.number().int().nonnegative().optional(),
  first_interaction: z.string().datetime({ offset: true }).nullable().optional(),
  last_interaction: z.string().datetime({ offset: true }).nullable().optional(),
  interactive_now: z.boolean().optional(),
  top_apps: z.array(PushTopAppSchema).optional(),
});

// Bluetooth connect/disconnect event (cheap event-driven receiver).
const PushBluetoothItemSchema = z.object({
  type: z.literal('bluetooth'),
  timestamp: z.string().datetime({ offset: true }),
  connected: z.boolean(),
  device_name: z.string().nullable().optional(),
  device_address: z.string().nullable().optional(),
  device_class: z
    .enum(['car', 'headset', 'wearable', 'phone', 'computer', 'other'])
    .optional(),
});

const PushItemSchema = z.discriminatedUnion('type', [
  PushLocationItemSchema,
  PushMessageItemSchema,
  PushCalendarItemSchema,
  PushDeviceCalendarSchema,
  PushPhoneContactSchema,
  PushPhoneStatusItemSchema,
  PushWifiItemSchema,
  PushCameraPhotoSchema,
  PushTrackedDeviceSchema,
  PushDeviceActivityItemSchema,
  PushBluetoothItemSchema,
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
export type PushCameraPhotoItem = z.infer<typeof PushCameraPhotoSchema>;
export type PushTrackedDeviceItem = z.infer<typeof PushTrackedDeviceSchema>;
export type PushDeviceActivityItem = z.infer<typeof PushDeviceActivityItemSchema>;
export type PushBluetoothItem = z.infer<typeof PushBluetoothItemSchema>;
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
