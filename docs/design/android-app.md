# Android App Design

LL5 companion app for Android. Pushes device data (GPS, notifications, calendar) and provides a chat interface.

---

## Screens

### 1. Chat (Main / Home)
The primary screen. Full-screen chat connected to the gateway's chat message queue.
- Send messages, see Claude's responses
- Polls `/chat/messages` or uses SSE `/chat/listen` for real-time updates
- Same conversation persistence as the web dashboard

### 2. Status
Dashboard showing push service health:
- Location tracking: on/off toggle, last push time, unsynced count
- Notification capture: on/off toggle, last push time, unsynced count
- Calendar sync: on/off toggle, last sync time
- Sync now button (manual trigger)
- Battery optimization status

### 3. Settings
- Gateway URL (default: https://gateway.noninoni.click)
- Auth token (login with user_id + PIN, or paste token)
- GPS interval (default: 60s)
- Push batch delay (default: 2 min)
- Monitored apps for notification capture
- Location tracking enable/disable
- Notification capture enable/disable
- Calendar sync enable/disable

### 4. Data (Debug)
Browse locally cached push data:
- Pending notifications
- Pending GPS points
- Sync errors and retry counts

## Architecture

Same as ll4-android but adapted for ll5:

### Push Data
- **Single endpoint**: `POST /webhook/:token` on the gateway
- **Token**: obtained via `POST /auth/token` (user_id + PIN)
- **Payload format**: matches gateway's existing webhook schema

### Background Services
- **LocationTrackingService**: Foreground service, FusedLocationProviderClient
- **NotificationCaptureService**: NotificationListenerService
- **CalendarSyncWorker**: Periodic WorkManager task
- **PushSyncWorker**: Batches and pushes all pending data

### Local Storage
- **Room DB**: pending_notifications, pending_location_points (with sync status)
- **DataStore**: settings (non-sensitive)
- **EncryptedSharedPreferences**: auth token

### Key Differences from ll4

| Aspect | ll4 | ll5 |
|--------|-----|-----|
| Auth | JWT + refresh + 3 webhook tokens | Single signed token (ll5 format) |
| Push endpoint | 2 endpoints (push-inbox, push-calendar) | 1 endpoint (/webhook/:token) |
| Setup | Login + create inboxes + create calendar | Login with user_id + PIN |
| Chat | Secondary screen | Primary screen |
| Backend | NestJS monolith | Gateway + MCP servers |

## Tech Stack

Same as ll4 (proven, working):
- Kotlin 2.1, Jetpack Compose, Material 3
- Retrofit + OkHttp + Moshi
- Room + DataStore + EncryptedSharedPreferences
- WorkManager for background sync
- Hilt for DI
- Play Services Location
- Android Calendar API (ContentResolver)
