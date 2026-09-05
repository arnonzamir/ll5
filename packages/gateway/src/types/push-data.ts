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
  // Notification-listener liveness (android review 2026-09-05, improvement 1).
  // Slack/Gmail/SMS reach us ONLY through the phone's notification-mirror
  // listener; channel.mirror used to infer a dead listener from 24h of silence
  // and could not tell that apart from a quiet weekend. The app now rides the
  // truth along on every phone_status push. Optional on purpose: an older app
  // build omits them and channel.mirror falls back to the silence rule.
  notification_listener_enabled: z.boolean().optional(),   // the Settings toggle
  notification_listener_connected: z.boolean().optional(), // the service is bound now
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

// WiFi scan — the top networks by RSSI the phone could SEE (not necessarily
// join), from the OS-cached WifiManager scan results (DECISION-021). NOTE the
// frozen contract nests the payload under `data` (unlike the flat legacy items).
const PushWifiScanNetworkSchema = z.object({
  // Android's Moshi OMITS null keys — a hidden network arrives with no ssid
  // key at all (and connected_bssid is absent when disconnected). Treat
  // missing as null.
  ssid: z.string().nullable().optional().default(null),
  bssid: z.string().min(1),
  rssi: z.number().int(),
  frequency_mhz: z.number().int().optional(),
});
const PushWifiScanItemSchema = z.object({
  type: z.literal('wifi_scan'),
  data: z.object({
    timestamp: z.string().datetime({ offset: true }),
    // Contract says top 12 — accept a little slack, reject unbounded blobs.
    networks: z.array(PushWifiScanNetworkSchema).max(32),
    connected_bssid: z.string().nullable().optional(),
  }),
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

// Geofence transition — a hardware/Play-Services geofence crossing for a KNOWN
// place (synced from ll5_knowledge_places via GET /geofences). `dwell` is the
// authoritative arrival signal: the on-device 60s loiter already filtered out
// drive-pasts, so a dwell means the user genuinely stopped at the place. `enter`
// is suppressed (a drive-through fires enter→exit without dwell), `exit` is the
// departure. This replaces fragile GPS-reconstruction of arrivals.
const PushGeofenceTransitionSchema = z.object({
  type: z.literal('geofence_transition'),
  // The ES _id of the ll5_knowledge_places doc this geofence was built from.
  place_id: z.string().min(1),
  place_name: z.string().nullable().optional(),
  transition: z.enum(['enter', 'dwell', 'exit']),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  timestamp: z.string().datetime({ offset: true }),
});

// Sleep segment — a completed sleep interval detected by the Sleep API on-device.
// status SUCCESS = a real, confident segment; MISSING_DATA / NOT_DETECTED carry no
// usable interval but are stored for completeness. Throttled on-device.
const PushSleepSegmentSchema = z.object({
  type: z.literal('sleep_segment'),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  duration_min: z.number().int().nonnegative(),
  status: z.enum(['SUCCESS', 'MISSING_DATA', 'NOT_DETECTED']),
  timestamp: z.string().datetime({ offset: true }),
});

// Sleep classify — an instantaneous "how asleep are you right now" reading from the
// Sleep API (light level + motion + a confidence). NOTE the key is `motion_level`.
const PushSleepClassifySchema = z.object({
  type: z.literal('sleep_classify'),
  confidence: z.number().int().min(0).max(100),
  light: z.number().int(),
  motion_level: z.number().int(),
  timestamp: z.string().datetime({ offset: true }),
});

// Current place — the on-device Places "current place" candidates (likelihood-ranked).
// Pure enrichment: stored as-is, no agent wake. The agent can read the top candidate
// for "what kind of place am I at" context.
const PushCurrentPlaceCandidateSchema = z.object({
  name: z.string(),
  types: z.array(z.string()),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  likelihood: z.number().min(0).max(1),
});
const PushCurrentPlaceSchema = z.object({
  type: z.literal('current_place'),
  candidates: z.array(PushCurrentPlaceCandidateSchema),
  timestamp: z.string().datetime({ offset: true }),
});

const PushItemSchema = z.discriminatedUnion('type', [
  PushLocationItemSchema,
  PushMessageItemSchema,
  PushCalendarItemSchema,
  PushDeviceCalendarSchema,
  PushPhoneContactSchema,
  PushPhoneStatusItemSchema,
  PushWifiItemSchema,
  PushWifiScanItemSchema,
  PushCameraPhotoSchema,
  PushTrackedDeviceSchema,
  PushDeviceActivityItemSchema,
  PushBluetoothItemSchema,
  PushGeofenceTransitionSchema,
  PushSleepSegmentSchema,
  PushSleepClassifySchema,
  PushCurrentPlaceSchema,
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
export type PushWifiScanItem = z.infer<typeof PushWifiScanItemSchema>;
export type PushCameraPhotoItem = z.infer<typeof PushCameraPhotoSchema>;
export type PushTrackedDeviceItem = z.infer<typeof PushTrackedDeviceSchema>;
export type PushDeviceActivityItem = z.infer<typeof PushDeviceActivityItemSchema>;
export type PushBluetoothItem = z.infer<typeof PushBluetoothItemSchema>;
export type PushGeofenceTransitionItem = z.infer<typeof PushGeofenceTransitionSchema>;
export type PushSleepSegmentItem = z.infer<typeof PushSleepSegmentSchema>;
export type PushSleepClassifyItem = z.infer<typeof PushSleepClassifySchema>;
export type PushCurrentPlaceItem = z.infer<typeof PushCurrentPlaceSchema>;
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
