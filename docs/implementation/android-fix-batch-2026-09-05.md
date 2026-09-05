# Android fix batch — 2026-09-05 (parallel subagents)

Source: `docs/reviews/2026-09-05/android-review.md`. Base branch: `ll5-android` `feat/phone-activity-awareness` (the branch the installed app runs from). Each package works in its own git worktree on its own branch; the coordinator merges into the base branch, builds one APK, reviews every diff, pushes, and hands the APK over. Rule: a package touches ONLY the files it owns; anything else goes in the report as a follow-up.

| Pkg | Scope | Owns (ll5-android unless noted) | Branch |
|---|---|---|---|
| A1 | Critical-overrides-DND for real; critical service correctness; FCM service hygiene; startup `runBlocking` off `Application.onCreate` | `LL5Application.kt`, `CriticalAlertService.kt`, `LL5FirebaseMessagingService.kt`, `WifiRepository.kt` (GlobalScope) | `fix/dnd-critical` |
| A2 | Permissions: notifications + notification access `required`; sequenced first-run requests; DND-access row in Settings | `PermissionStatus.kt`, `PermissionBanner.kt`, `MainActivity.kt`, `ui/settings/*` (DND row only) | `fix/permissions` |
| B | Chat robustness: SSE reconnect with backoff, 409 retry cap, auth-aware state, cache cleared on sign-out, pendingIdMap pruning, one "new chat" path | `ChatRepository.kt`, `ChatViewModel.kt`, `SettingsRepository.kt` (clear cache on `setAuthToken(null)` only) | `fix/chat-robustness` |
| C | Topics + DraftCard + nav/FGS: debounced search with cancellation; Active/Dormant/All status chip; one sort default; `<queries>` for WhatsApp/Telegram + `copied` reset; location FGS guard; deep-link uses `navigateToTab` | `ui/narratives/*`, `data/remote/NarrativesApi.kt`, `data/repository/NarrativesRepository.kt`, `ui/chat/DraftCard.kt`, `AndroidManifest.xml`, `LocationTrackingService.kt`, `BootReceiver.kt`, `AppNavigation.kt` | `fix/topics-draft-nav` |
| D | Listener liveness: `notification_listener_connected` in the phone-status push (app) → gateway schema + storage → `channel.mirror` uses it (alert on `false`, stand down on `true`) | app: `WebhookDtos.kt`, `DeviceHeartbeatWorker*`, `NotificationCaptureService.kt` (connect/disconnect flag only), `PermissionStatus.kt` read-only use; ll5: `packages/gateway/src/types/push-data.ts`, the phone-status processor, `scheduler/metrics-monitor.ts`, a test | app `fix/listener-liveness`; ll5 `fix/listener-liveness` |

Deferred (backlog): `why_now` on Today; unify the three error-handling conventions; prune legacy notification channels beyond what A1 needs.

Acceptance per package: `./gradlew :app:compileDebugKotlin` clean (JAVA_HOME 17); ll5 side `npx tsc --noEmit` + vitest for touched packages; every change carries a comment saying why (the review finding); no emojis; commits on the package branch with the standard trailers; no push. Report: files changed, what each change does, what was verified and how, anything left out and why.
