# LL5 Android — code review, 2026-09-05 (read-only, subagent)

Branch `feat/phone-activity-awareness`. Paths relative to `app/src/main/java/com/ll5/android/`.

## Bugs
1. **Critical-overrides-DND does not work.** `LL5Application.kt:226-228` (+207-209, 241-243) `setBypassDnd(true)` is ignored without DND policy access; the app never requests it (`ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS` never launched); channels are created once (`:291`) and are immutable, so a later grant changes nothing. `CriticalAlertService.kt:106-132` short-circuits at `:110`; ringer/volume calls throw `SecurityException` under DND (caught `:129`). Fix: DND-access request flow + a new channel id once granted.
2. **Alarm volume pinned to max.** `CriticalAlertService.kt:124-126` saves the volume unconditionally; a second alert saves "max" as the user's volume; `:95` `stopSelf()` without `startId` kills the second alert. Fix: save once when null; `stopSelf(startId)`.
3. **FCM unmanaged coroutine scopes.** `LL5FirebaseMessagingService.kt:45, :87` `CoroutineScope(Dispatchers.IO).launch` never cancelled. Use a service-scoped SupervisorJob (as `NotificationCaptureService.kt:38/182`).
4. **SSE never reconnects.** `ChatRepository.kt:442-444` `onFailure` only logs; flow never closed; `ChatViewModel.startSSE()` (`:567`) collects once. Live chat dies after any blip; the 30 s poll (`ChatViewModel.kt:650`) masks it. Fix: `close(t)` + retry with backoff.
5. **Unbounded 409 retry.** `ChatViewModel.kt:164-177` recursion with no attempt counter.
6. **State survives a dead token.** `ChatViewModel.kt:107-116` reads `isConfigured()` once; cached tail keeps rendering, composer enabled. Collect `SettingsRepository.isAuthenticated`; clear cached messages on `setAuthToken(null)`.
7. **Topics search races.** `NarrativesViewModel.kt:80-85, :88, :97` — every keystroke launches an uncancelled fetch. Debounce + `flatMapLatest` / single cancellable job.
8. **DraftCard: WhatsApp button falls to the chooser.** `DraftCard.kt:101-103` `setPackage("com.whatsapp")` with no `<queries>` in the manifest (targetSdk 34) → `ActivityNotFoundException` → chooser. Add `<queries>` for com.whatsapp / org.telegram.messenger. Also `:84/93` `copied` never resets.
9. **First-launch permission storm.** `MainActivity.kt:133-206` six launchers fire in `onCreate`; queued ones return denied — POST_NOTIFICATIONS (`:155`) can land as a silent deny → no pushes at all. Sequence through callbacks / onboarding.
10. **Silent-loss permissions marked optional.** `PermissionStatus.kt:90-94` (Notifications) and `:128-131` (Notification access) `required = false` → the banner never shows their loss. Make both required.
11. **Location FGS unguarded.** `LocationTrackingService.kt:76` `startForeground` without permission check/try-catch → `SecurityException` on Android 14 (started from `LL5Application.kt:303`, `BootReceiver.kt:47`).
12. **Main-thread blocking at start.** `LL5Application.kt:301, 332, 349, 367, 453` five `runBlocking { DataStore.first() }`; `WifiRepository.kt:139, :164` `GlobalScope`.
13. Minor: `LL5FirebaseMessagingService.kt:193` non-collapsing notification ids; `:59` / `LL5Application.kt:464` FCM token interpolated into JSON unescaped, stream not flushed; `ChatRepository.kt:373` bearer token as `?token=` query param (lands in logs); `ChatViewModel.kt:85` `pendingIdMap` never pruned.

## Misdesigns / inconsistencies
- Topics hard-scoped to `status=active` (`NarrativesApi.kt:27`, `NarrativesRepository.list`); dormant/closed unreachable; no status chip.
- Three sort defaults for one concept: gateway `relevance`, `NarrativesApi.kt:28` `relevance`, repository `recency`, ViewModel `NEWEST`.
- Draft delivery diverges from the dashboard (`wa.me/?text=` vs `ACTION_SEND`+package); `to=` is display-only on both.
- Two "new chat" paths (`ChatViewModel.newConversation()` `:232` vs `startNewChat()` `:477`) that clear different things.
- Deep-link navigation (`AppNavigation.kt:157-162`) bypasses `navigateToTab` (`:196-203`): a notification tap pushes Needs You on top of Today.
- Approvals naming drift (`LL5FirebaseMessagingService.kt:93-95` vs `MainActivity.kt:126`; `Routes.APPROVALS` history-only).
- Three error-handling conventions (`NarrativesResult`, `Result<T>`, `TrayFetchResult`); only Chat surfaces failures.
- Eight notification channels created every launch; four routed to.
- Naming: no "Coach" leak in the app — everything is "LL5".

## Improvements (ranked)
1. **Notification-listener liveness in the phone-status push (S).** `notification_listener_connected` in `PushPhoneStatusItemSchema` (`push-data.ts:70`) and `WebhookDtos.kt:57-67`, from `PermissionStatus.isNotificationListenerEnabled()` + listener connect/disconnect flag, stamped on the 1 h `DeviceHeartbeatWorker`. Ground truth for `channel.mirror`.
2. **Make critical override DND (M).** DND-access flow + fresh channel id.
3. **Required = true for POST_NOTIFICATIONS + notification access; sequence first-run requests (S).**
4. **SSE reconnect with backoff + auth-aware Chat state (M).**
5. **Debounce Topics search, cancel in-flight (S).**
6. **Status chip Active / Dormant / All on Topics (S).**
7. **Surface `why_now` on Today (M).**
8. **Move `runBlocking` DataStore reads off `Application.onCreate` (S).**

## Verdict
Above-average code health for a solo project: incident-aware comments, clean repository/DTO layer, consistent RTL handling, correct MessagingStyle parsing. Most important fix: the DND path — `setBypassDnd(true)` is a no-op today, so "critical overrides DND" is unmet except on an audible-ringer phone. Most valuable improvement: the `notification_listener_connected` heartbeat, paired with making notification access a required permission — it closes the silent-outage class that has already cost real downtime.
