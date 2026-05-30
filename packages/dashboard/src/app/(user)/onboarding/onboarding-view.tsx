"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Check,
  User,
  Bell,
  Calendar,
  MessageSquare,
  Heart,
  Smartphone,
  Bot,
  PartyPopper,
  ChevronRight,
  ChevronLeft,
  SkipForward,
  RefreshCw,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  WIZARD_STEPS,
  firstIncompleteStepIndex,
  isStepComplete,
  stepProgress,
  type MeOnboarding,
  type StepKey,
} from "./onboarding-types";
import {
  fetchMeOnboarding,
  setOnboardingStep,
  completeOnboarding,
  getGoogleAuthUrl,
  checkGoogleConnection,
} from "./onboarding-server-actions";
import {
  updateDisplayName,
  updateUserSettings,
  type UserSettings,
} from "../profile/profile-server-actions";
import {
  fetchNotificationSettings,
  updateNotificationSettings,
  type NotificationSettings,
} from "../settings/notification-levels/notification-levels-server-actions";
import {
  provisionWhatsAppAccount,
  getPairingQr,
  getAccountStatus,
} from "../settings/messaging/messaging-server-actions";
import type { PairingQr } from "../settings/messaging/messaging-types";
import {
  fetchHealthSources,
  connectHealthSource,
  type HealthSource,
} from "../health/health-server-actions";
import { fetchLlmCredential } from "../settings/agent/agent-server-actions";
import { ClaudeKeyForm } from "../settings/agent/claude-key-form";
import type { LlmCredentialStatus } from "../settings/agent/agent-types";

const STEP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  profile: User,
  notifications: Bell,
  google: Calendar,
  channels: MessageSquare,
  phone: Smartphone,
  agent: Bot,
  done: PartyPopper,
};

const TIMEZONES = [
  "Asia/Jerusalem",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

const NOTIFICATION_LEVELS = ["silent", "notify", "alert", "critical"] as const;

const GATEWAY_HINT = "https://gateway.noninoni.click";

export function OnboardingView() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [me, setMe] = useState<MeOnboarding | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // --- Profile form ---
  const [displayName, setDisplayName] = useState("");
  const [settings, setSettings] = useState<UserSettings>({
    timezone: "Asia/Jerusalem",
    work_week: { start_day: 0, start_hour: "09:00", end_hour: "17:00" },
    self_names: [],
  });
  const [selfNamesText, setSelfNamesText] = useState("");

  // --- Notifications form ---
  const [notif, setNotif] = useState<NotificationSettings>({
    max_level: "critical",
    quiet_max_level: "silent",
    quiet_start: "23:00",
    quiet_end: "07:00",
  });

  // --- Google ---
  const [connectError, setConnectError] = useState<string | null>(null);

  // --- Channels: WhatsApp ---
  const [waQr, setWaQr] = useState<PairingQr | null>(null);
  const [waAccountId, setWaAccountId] = useState<string | null>(null);
  const [waStatus, setWaStatus] = useState<string>("");
  const [waError, setWaError] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);

  // --- Channels: Health ---
  const [healthSources, setHealthSources] = useState<HealthSource[]>([]);
  const [healthEmail, setHealthEmail] = useState("");
  const [healthPassword, setHealthPassword] = useState("");
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);

  // --- Agent: Claude credential ---
  const [llm, setLlm] = useState<LlmCredentialStatus>({ configured: false });

  const steps = me?.onboarding.steps ?? {};
  const completed = me?.onboarding.completed ?? false;
  const currentStep = WIZARD_STEPS[stepIdx];

  // ---- Initial load: pull /me/onboarding, hydrate forms, resume ----
  useEffect(() => {
    startTransition(async () => {
      const [snap, notifResult, sources, llmStatus] = await Promise.all([
        fetchMeOnboarding(),
        fetchNotificationSettings(),
        fetchHealthSources().catch(() => [] as HealthSource[]),
        fetchLlmCredential().catch(() => ({ configured: false }) as LlmCredentialStatus),
      ]);
      setMe(snap);
      setHealthSources(sources);
      setLlm(llmStatus);
      if (llmStatus.configured) markStep("agent_connected");
      if (notifResult.settings) setNotif(notifResult.settings);

      // Hydrate profile from /me/onboarding (falls back to defaults).
      if (snap.profile.display_name) setDisplayName(snap.profile.display_name);
      const ww = snap.profile.work_week as UserSettings["work_week"] | null;
      const selfNames = Array.isArray(snap.profile.self_names)
        ? (snap.profile.self_names as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      setSelfNamesText(selfNames.join(", "));
      setSettings((s) => ({
        timezone: snap.profile.timezone ?? detectTimezone(),
        work_week: ww ?? s.work_week,
        self_names: selfNames,
      }));

      setStepIdx(firstIncompleteStepIndex(snap.onboarding.steps));
    });
  }, []);

  function detectTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  // ---- Live re-fetch of /me/onboarding (channels + phone verification) ----
  const refreshMe = useCallback(async (): Promise<MeOnboarding> => {
    const snap = await fetchMeOnboarding();
    setMe(snap);
    return snap;
  }, []);

  // ---- Local step-state mutation + persisted write ----
  function markStep(key: StepKey, done = true) {
    setMe((prev) =>
      prev
        ? { ...prev, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, [key]: done } } }
        : prev,
    );
    void setOnboardingStep(key, done);
  }

  function goNext() {
    setError(null);
    setStepIdx((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  }
  function goBack() {
    setError(null);
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  // ---------- Step 1: Profile ----------
  function handleSaveProfile() {
    if (!displayName.trim()) {
      setError("Please enter a display name.");
      return;
    }
    setError(null);
    const names = selfNamesText.split(",").map((s) => s.trim()).filter(Boolean);
    startTransition(async () => {
      const [nameResult, settingsResult] = await Promise.all([
        updateDisplayName(displayName.trim()),
        updateUserSettings({
          timezone: settings.timezone,
          work_week: settings.work_week,
          self_names: names,
        }),
      ]);
      if (nameResult.success && settingsResult.ok) {
        setSettings((s) => ({ ...s, self_names: names }));
        markStep("profile_set");
        goNext();
      } else {
        setError(settingsResult.error ?? "Failed to save profile. Please try again.");
      }
    });
  }

  // ---------- Step 2: Notifications ----------
  function handleSaveNotifications() {
    setError(null);
    startTransition(async () => {
      const result = await updateNotificationSettings(notif);
      if (result.ok) {
        markStep("notifications_set");
        goNext();
      } else {
        setError(result.error ?? "Failed to save notification settings.");
      }
    });
  }

  // ---------- Step 3: Google ----------
  function handleConnectGoogle() {
    setConnectError(null);
    // Open synchronously under the gesture so popup blockers don't kill it.
    const popup = window.open("about:blank", "_blank");
    startTransition(async () => {
      const result = await getGoogleAuthUrl();
      if (result.auth_url) {
        if (popup && !popup.closed) popup.location.href = result.auth_url;
        else window.location.href = result.auth_url;
      } else {
        popup?.close();
        setConnectError(result.error ?? "Failed to get Google auth URL");
      }
    });
  }

  function handleCheckGoogle() {
    setConnectError(null);
    startTransition(async () => {
      const result = await checkGoogleConnection();
      if (result.connected) {
        markStep("google_connected");
        await refreshMe();
      } else {
        setConnectError("Not connected yet. Finish the Google sign-in and try again.");
      }
    });
  }

  function handleSkipGoogle() {
    markStep("google_connected");
    goNext();
  }

  // ---------- Step 4: Channels — WhatsApp ----------
  async function handleProvisionWhatsApp() {
    setWaBusy(true);
    setWaError(null);
    try {
      const result = await provisionWhatsAppAccount("ll5");
      if (!result.success || !result.account) {
        setWaError(result.message || result.error || "Provision failed");
        return;
      }
      setWaAccountId(result.account.id);
      setWaQr(result.qr ?? null);
      setWaStatus(result.account.status);
    } finally {
      setWaBusy(false);
    }
  }

  // Poll WhatsApp status + rotate QR while a pairing is in flight.
  useEffect(() => {
    if (currentStep.id !== "channels" || !waAccountId) return;
    if (steps.whatsapp_connected) return;
    const aid = waAccountId;
    const statusTimer = setInterval(async () => {
      const status = await getAccountStatus(aid);
      if (status) {
        setWaStatus(status.status);
        if (status.status === "connected" || status.status === "open") {
          markStep("whatsapp_connected");
          setWaQr(null);
          await refreshMe();
        }
      }
    }, 5_000);
    const qrTimer = setInterval(async () => {
      const qr = await getPairingQr(aid);
      if (qr) setWaQr(qr);
    }, 30_000);
    return () => {
      clearInterval(statusTimer);
      clearInterval(qrTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep.id, waAccountId, steps.whatsapp_connected]);

  // ---------- Step 4: Channels — Health (Garmin) ----------
  function handleConnectHealth(sourceId: string) {
    if (!healthEmail || !healthPassword) {
      setHealthError("Enter your Garmin email and password.");
      return;
    }
    setHealthBusy(true);
    setHealthError(null);
    startTransition(async () => {
      try {
        const result = await connectHealthSource(sourceId, {
          email: healthEmail,
          password: healthPassword,
        });
        if (result.success) {
          markStep("health_connected");
          setHealthEmail("");
          setHealthPassword("");
          setHealthSources(await fetchHealthSources().catch(() => healthSources));
          await refreshMe();
        } else {
          setHealthError(result.error ?? "Connection failed");
        }
      } finally {
        setHealthBusy(false);
      }
    });
  }

  function handleSkipChannels() {
    markStep("whatsapp_connected");
    markStep("health_connected");
    goNext();
  }

  // ---------- Step 5: Phone — poll /me/onboarding for phone.linked ----------
  const phoneLinked = me?.phone.linked ?? false;
  const phonePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (currentStep.id !== "phone") return;
    if (phoneLinked) {
      if (!steps.phone_linked) markStep("phone_linked");
      return;
    }
    phonePollRef.current = setInterval(async () => {
      const snap = await refreshMe();
      if (snap.phone.linked) markStep("phone_linked");
    }, 4_000);
    return () => {
      if (phonePollRef.current) clearInterval(phonePollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep.id, phoneLinked, steps.phone_linked]);

  function handleSkipPhone() {
    markStep("phone_linked");
    goNext();
  }

  // ---------- Step 6: Agent — capture Claude API key ----------
  function handleAgentStatusChange(next: LlmCredentialStatus) {
    setLlm(next);
    // `agent_connected` is true once a Claude credential is configured.
    markStep("agent_connected", next.configured);
  }

  function handleSkipAgent() {
    // Connecting the agent is optional; users can finish setup and do it later
    // from /settings/agent. Skipping does not mark agent_connected.
    goNext();
  }

  // ---------- Step 7: Done ----------
  function handleFinish() {
    startTransition(async () => {
      await completeOnboarding();
      router.push("/dashboard");
    });
  }

  // ---- Loading ----
  if (!me) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-primary mx-auto mb-3" />
          <p className="text-sm text-gray-500">Loading setup...</p>
        </div>
      </div>
    );
  }

  const progress = stepProgress(steps, completed);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Welcome to LL5</h1>
          <p className="mt-2 text-sm text-gray-500">
            Let&apos;s get you set up. You can skip optional steps and finish them later.
          </p>
        </div>

        {/* Stepper */}
        <div className="mb-4 flex items-center justify-center gap-1.5">
          {WIZARD_STEPS.map((step, idx) => {
            const Icon = STEP_ICONS[step.id] ?? Check;
            const isActive = idx === stepIdx;
            const done = isStepComplete(step, steps, completed);
            return (
              <button
                key={step.id}
                onClick={() => setStepIdx(idx)}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-all cursor-pointer ${
                  done
                    ? "bg-green-500 text-white"
                    : isActive
                      ? "bg-primary text-white ring-2 ring-primary/30"
                      : "bg-gray-100 text-gray-400"
                }`}
                title={step.label}
              >
                {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              </button>
            );
          })}
        </div>

        {/* Overall progress */}
        <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <p className="mb-4 text-center text-xs text-gray-400">
          {progress.done}/{progress.total} steps · {progress.percent}%
        </p>

        {/* Step content */}
        {currentStep.id === "profile" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <User className="h-5 w-5 text-primary" /> Profile
              </CardTitle>
              <CardDescription>Tell LL5 who you are and how you keep time.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => { setDisplayName(e.target.value); setError(null); }}
                  placeholder="Enter your name"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select value={settings.timezone} onValueChange={(v) => setSettings({ ...settings, timezone: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select timezone..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(TIMEZONES.includes(settings.timezone) ? TIMEZONES : [settings.timezone, ...TIMEZONES]).map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Week starts on</Label>
                <Select
                  value={String(settings.work_week.start_day)}
                  onValueChange={(v) => setSettings({ ...settings, work_week: { ...settings.work_week, start_day: parseInt(v) } })}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Sunday</SelectItem>
                    <SelectItem value="1">Monday</SelectItem>
                    <SelectItem value="6">Saturday</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-3">
                <div className="space-y-1 flex-1">
                  <Label className="text-xs text-gray-500">Work hours start</Label>
                  <Input
                    type="time"
                    value={settings.work_week.start_hour}
                    onChange={(e) => setSettings({ ...settings, work_week: { ...settings.work_week, start_hour: e.target.value } })}
                    className="h-9"
                  />
                </div>
                <span className="text-sm text-gray-400 pb-2">to</span>
                <div className="space-y-1 flex-1">
                  <Label className="text-xs text-gray-500">End</Label>
                  <Input
                    type="time"
                    value={settings.work_week.end_hour}
                    onChange={(e) => setSettings({ ...settings, work_week: { ...settings.work_week, end_hour: e.target.value } })}
                    className="h-9"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="selfNames">Your names (outbound detection)</Label>
                <Input
                  id="selfNames"
                  value={selfNamesText}
                  onChange={(e) => setSelfNamesText(e.target.value)}
                  placeholder="e.g. Arnon Zamir, Arnon"
                />
                <p className="text-xs text-gray-400">Comma-separated. Optional — helps flag your own messages as outbound.</p>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <Button onClick={handleSaveProfile} disabled={isPending} className="w-full">
                {isPending ? "Saving..." : "Continue"}
                {!isPending && <ChevronRight className="h-4 w-4 ml-1" />}
              </Button>
            </CardContent>
          </Card>
        )}

        {currentStep.id === "notifications" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Bell className="h-5 w-5 text-primary" /> Notifications
              </CardTitle>
              <CardDescription>Set the loudest the agent can get, and quieter hours.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <LevelRow
                label="Maximum level (normal hours)"
                value={notif.max_level}
                onChange={(v) => setNotif({ ...notif, max_level: v })}
              />
              <LevelRow
                label="Maximum level (quiet hours)"
                value={notif.quiet_max_level}
                onChange={(v) => setNotif({ ...notif, quiet_max_level: v })}
              />
              <div className="flex items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs text-gray-500">Quiet start</Label>
                  <Input type="time" value={notif.quiet_start} onChange={(e) => setNotif({ ...notif, quiet_start: e.target.value })} className="w-32 h-9" />
                </div>
                <span className="text-sm text-gray-400 pb-2">to</span>
                <div className="space-y-1">
                  <Label className="text-xs text-gray-500">Quiet end</Label>
                  <Input type="time" value={notif.quiet_end} onChange={(e) => setNotif({ ...notif, quiet_end: e.target.value })} className="w-32 h-9" />
                </div>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <Button onClick={handleSaveNotifications} disabled={isPending} className="w-full">
                {isPending ? "Saving..." : "Continue"}
                {!isPending && <ChevronRight className="h-4 w-4 ml-1" />}
              </Button>
            </CardContent>
          </Card>
        )}

        {currentStep.id === "google" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Calendar className="h-5 w-5 text-primary" /> Google
              </CardTitle>
              <CardDescription>Connect Google for calendar and email. Optional.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ConnectedRow connected={me.channels.google} label="Google" />
              {me.channels.google ? (
                <Button onClick={goNext} className="w-full">Continue <ChevronRight className="h-4 w-4 ml-1" /></Button>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={handleConnectGoogle} disabled={isPending} className="flex-1">
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {isPending ? "Loading..." : "Connect Google"}
                  </Button>
                  <Button variant="outline" onClick={handleCheckGoogle} disabled={isPending}>
                    <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              )}
              {connectError && <p className="text-xs text-red-600">{connectError}</p>}
              {!me.channels.google && <SkipLink onClick={handleSkipGoogle} />}
            </CardContent>
          </Card>
        )}

        {currentStep.id === "channels" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <MessageSquare className="h-5 w-5 text-primary" /> Channels
              </CardTitle>
              <CardDescription>Pair WhatsApp and connect Garmin health. Both optional.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* WhatsApp */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium flex items-center gap-2"><MessageSquare className="h-4 w-4" /> WhatsApp</span>
                  <ConnectedBadge connected={me.channels.whatsapp} />
                </div>
                {!me.channels.whatsapp && !waQr && (
                  <Button variant="outline" size="sm" onClick={handleProvisionWhatsApp} disabled={waBusy}>
                    {waBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                    Pair WhatsApp
                  </Button>
                )}
                {!me.channels.whatsapp && waQr && (
                  <div className="flex flex-col items-center rounded-md border border-gray-200 p-3">
                    {waQr.base64 ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={waQr.base64.startsWith("data:") ? waQr.base64 : `data:image/png;base64,${waQr.base64}`}
                        alt="WhatsApp pairing QR code"
                        className="w-48 h-48"
                      />
                    ) : (
                      <div className="w-48 h-48 flex items-center justify-center text-xs text-gray-400">QR loading…</div>
                    )}
                    <p className="mt-2 text-xs text-gray-500 text-center">
                      WhatsApp → Settings → Linked Devices → Link a Device, then scan. Status: {waStatus || "pairing"}
                    </p>
                  </div>
                )}
                {waError && <p className="text-xs text-red-600">{waError}</p>}
              </div>

              {/* Health */}
              <div className="space-y-3 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium flex items-center gap-2"><Heart className="h-4 w-4 text-red-500" /> Health (Garmin)</span>
                  <ConnectedBadge connected={me.channels.health} />
                </div>
                {!me.channels.health && (
                  <div className="space-y-2">
                    <Input type="email" placeholder="Garmin email" value={healthEmail} onChange={(e) => setHealthEmail(e.target.value)} className="h-9" />
                    <Input type="password" placeholder="Garmin password" value={healthPassword} onChange={(e) => setHealthPassword(e.target.value)} className="h-9" />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleConnectHealth(healthSources[0]?.sourceId ?? "garmin")}
                      disabled={healthBusy || !healthEmail || !healthPassword}
                    >
                      {healthBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                      Connect Garmin
                    </Button>
                    {healthError && <p className="text-xs text-red-600">{healthError}</p>}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button onClick={goNext} className="flex-1">Continue <ChevronRight className="h-4 w-4 ml-1" /></Button>
              </div>
              {(!me.channels.whatsapp || !me.channels.health) && <SkipLink onClick={handleSkipChannels} label="Skip both for now" />}
            </CardContent>
          </Card>
        )}

        {currentStep.id === "phone" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Smartphone className="h-5 w-5 text-primary" /> Phone
              </CardTitle>
              <CardDescription>Install the LL5 Android app for GPS, notification capture, and health.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md bg-gray-50 p-4 text-sm space-y-2">
                <p className="font-medium text-gray-700">Setup instructions:</p>
                <ol className="list-decimal list-inside space-y-1 text-gray-600 text-xs">
                  <li>Install the LL5 app on your Android device</li>
                  <li>Open the app and go to Settings</li>
                  <li>
                    Enter the gateway URL:{" "}
                    <code className="bg-white border px-1.5 py-0.5 rounded text-xs font-mono select-all">{GATEWAY_HINT}</code>
                  </li>
                  <li>Log in with your credentials</li>
                </ol>
              </div>
              {phoneLinked ? (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="h-4 w-4" /> Phone linked ✓
                  {me.phone.device_count > 0 && <span className="text-gray-400">({me.phone.device_count} device{me.phone.device_count !== 1 ? "s" : ""})</span>}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Waiting for your phone to log in…
                </div>
              )}
              {phoneLinked ? (
                <Button onClick={goNext} className="w-full">Continue <ChevronRight className="h-4 w-4 ml-1" /></Button>
              ) : (
                <SkipLink onClick={handleSkipPhone} />
              )}
            </CardContent>
          </Card>
        )}

        {currentStep.id === "agent" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Bot className="h-5 w-5 text-primary" /> Your agent
              </CardTitle>
              <CardDescription>
                Connect your Claude credential so your assistant can run. Optional — you can do this later.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ClaudeKeyForm status={llm} onStatusChange={handleAgentStatusChange} compact />
              {llm.configured ? (
                <Button onClick={goNext} className="w-full">
                  Continue <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              ) : (
                <SkipLink onClick={handleSkipAgent} />
              )}
            </CardContent>
          </Card>
        )}

        {currentStep.id === "done" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <PartyPopper className="h-6 w-6 text-green-600" />
              </div>
              <CardTitle className="text-lg">You&apos;re all set!</CardTitle>
              <CardDescription>
                Your LL5 assistant is ready.{displayName && <> Welcome, <span className="font-medium text-gray-700">{displayName}</span>.</>}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <SummaryRow done={!!steps.profile_set} label={`Profile${displayName ? `: ${displayName}` : ""}`} />
                <SummaryRow done={!!steps.notifications_set} label="Notifications configured" />
                <SummaryRow done={me.channels.google} label="Google connected" />
                <SummaryRow done={me.channels.whatsapp} label="WhatsApp paired" />
                <SummaryRow done={me.channels.health} label="Garmin connected" />
                <SummaryRow done={me.phone.linked} label="Phone linked" />
                <SummaryRow done={llm.configured} label="Agent connected" />
              </div>
              <Button onClick={handleFinish} disabled={isPending} className="w-full" size="lg">
                {isPending ? "Finishing..." : "Go to Dashboard"}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Back nav */}
        {stepIdx > 0 && (
          <button
            onClick={goBack}
            className="mt-4 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors cursor-pointer py-1"
          >
            <ChevronLeft className="h-3 w-3 inline mr-1" /> Back
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- small presentational helpers ---------- */

function LevelRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <div className="flex gap-1">
        {NOTIFICATION_LEVELS.map((lvl) => (
          <button
            key={lvl}
            onClick={() => onChange(lvl)}
            className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium capitalize transition-colors cursor-pointer ${
              value === lvl ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:text-gray-800"
            }`}
          >
            {lvl}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectedRow({ connected, label }: { connected: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-green-500" : "bg-gray-300"}`} />
      <span className="text-sm">{connected ? `${label} connected ✓` : `${label} not connected`}</span>
    </div>
  );
}

function ConnectedBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="flex items-center gap-1 text-xs text-green-600"><Check className="h-3.5 w-3.5" /> Connected ✓</span>
  ) : (
    <span className="text-xs text-gray-400">Not connected</span>
  );
}

function SummaryRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 text-sm ${done ? "text-gray-600" : "text-gray-300"}`}>
      <Check className={`h-4 w-4 ${done ? "text-green-500" : "text-gray-300"}`} />
      <span>{label}</span>
    </div>
  );
}

function SkipLink({ onClick, label = "Skip for now" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors cursor-pointer py-1"
    >
      <SkipForward className="h-3 w-3 inline mr-1" /> {label}
    </button>
  );
}
