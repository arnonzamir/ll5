"use client";

import { useEffect, useState, useTransition } from "react";
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
import { Check, User, Globe, Calendar, Smartphone, PartyPopper, ChevronRight, SkipForward, RefreshCw, ExternalLink } from "lucide-react";
import {
  fetchOnboardingState,
  completeOnboardingStep,
  completeOnboarding,
  updateTimezone,
  updateDisplayName,
  getGoogleAuthUrl,
  checkGoogleConnection,
  type OnboardingData,
  type OnboardingSteps,
} from "./onboarding-server-actions";

const STEPS = [
  { key: "profile" as const, label: "Profile", icon: User },
  { key: "timezone" as const, label: "Timezone", icon: Globe },
  { key: "google" as const, label: "Google Calendar", icon: Calendar, optional: true },
  { key: "android" as const, label: "Android App", icon: Smartphone, optional: true },
  { key: "complete" as const, label: "Done", icon: PartyPopper },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

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

export function OnboardingView() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [currentStep, setCurrentStep] = useState<StepKey>("profile");
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Load onboarding state
  useEffect(() => {
    startTransition(async () => {
      const state = await fetchOnboardingState();
      setData(state);
      setDisplayName(state.displayName);
      setGoogleConnected(state.googleConnected);

      // Detect timezone from browser if not set
      if (state.timezone) {
        setTimezone(state.timezone);
      } else {
        try {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setTimezone(detected);
        } catch {
          setTimezone("UTC");
        }
      }

      // Find the first incomplete step to start on
      const firstIncomplete = findFirstIncompleteStep(state.onboarding.steps);
      setCurrentStep(firstIncomplete);
    });
  }, []);

  function findFirstIncompleteStep(steps: OnboardingSteps): StepKey {
    if (!steps.profile_set) return "profile";
    if (!steps.timezone_configured) return "timezone";
    if (!steps.google_connected) return "google";
    if (!steps.android_installed) return "android";
    return "complete";
  }

  function isStepComplete(step: StepKey): boolean {
    if (!data) return false;
    const s = data.onboarding.steps;
    switch (step) {
      case "profile": return s.profile_set;
      case "timezone": return s.timezone_configured;
      case "google": return s.google_connected;
      case "android": return s.android_installed;
      case "complete": return data.onboarding.completed;
    }
  }

  function getStepIndex(step: StepKey): number {
    return STEPS.findIndex((s) => s.key === step);
  }

  function goToNext() {
    const idx = getStepIndex(currentStep);
    if (idx < STEPS.length - 1) {
      setCurrentStep(STEPS[idx + 1].key);
    }
  }

  // Step 1: Save profile
  function handleSaveProfile() {
    if (!displayName.trim()) {
      setError("Please enter a display name.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateDisplayName(displayName.trim());
      if (result.ok) {
        await completeOnboardingStep("profile_set");
        setData((prev) =>
          prev ? { ...prev, displayName: result.name, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, profile_set: true } } } : prev
        );
        goToNext();
      } else {
        setError("Failed to save display name. Please try again.");
      }
    });
  }

  // Step 2: Save timezone
  function handleSaveTimezone() {
    if (!timezone) {
      setError("Please select a timezone.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateTimezone(timezone);
      if (result.ok) {
        await completeOnboardingStep("timezone_configured");
        setData((prev) =>
          prev ? { ...prev, timezone, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, timezone_configured: true } } } : prev
        );
        goToNext();
      } else {
        setError("Failed to save timezone. Please try again.");
      }
    });
  }

  // Step 3: Connect Google
  function handleConnectGoogle() {
    setConnectError(null);
    // Pre-open synchronously under the user gesture; navigating after `await`
    // is otherwise silently blocked by popup blockers.
    const popup = window.open("about:blank", "_blank");
    startTransition(async () => {
      const result = await getGoogleAuthUrl();
      if (result.auth_url) {
        if (popup && !popup.closed) {
          popup.location.href = result.auth_url;
        } else {
          window.location.href = result.auth_url;
        }
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
      setGoogleConnected(result.connected);
      if (result.connected) {
        await completeOnboardingStep("google_connected");
        setData((prev) =>
          prev ? { ...prev, googleConnected: true, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, google_connected: true } } } : prev
        );
      } else {
        setConnectError("Not connected yet. Complete the Google sign-in and try again.");
      }
    });
  }

  function handleSkipGoogle() {
    startTransition(async () => {
      await completeOnboardingStep("google_connected");
      setData((prev) =>
        prev ? { ...prev, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, google_connected: true } } } : prev
      );
      goToNext();
    });
  }

  // Step 4: Skip Android
  function handleSkipAndroid() {
    startTransition(async () => {
      await completeOnboardingStep("android_installed");
      setData((prev) =>
        prev ? { ...prev, onboarding: { ...prev.onboarding, steps: { ...prev.onboarding.steps, android_installed: true } } } : prev
      );
      goToNext();
    });
  }

  // Step 5: Complete
  function handleFinish() {
    startTransition(async () => {
      await completeOnboarding();
      router.push("/dashboard");
    });
  }

  // Loading state
  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-primary mx-auto mb-3" />
          <p className="text-sm text-gray-500">Loading setup...</p>
        </div>
      </div>
    );
  }

  const completedCount = Object.values(data.onboarding.steps).filter(Boolean).length;
  const totalSteps = 4; // profile, timezone, google, android

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Welcome to LL5</h1>
          <p className="mt-2 text-sm text-gray-500">
            Let&apos;s get you set up. This will only take a minute.
          </p>
        </div>

        {/* Step indicators */}
        <div className="mb-6 flex items-center justify-center gap-1.5">
          {STEPS.map((step, idx) => {
            const isActive = step.key === currentStep;
            const done = isStepComplete(step.key);
            return (
              <button
                key={step.key}
                onClick={() => setCurrentStep(step.key)}
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all cursor-pointer ${
                  done
                    ? "bg-green-500 text-white"
                    : isActive
                      ? "bg-primary text-white ring-2 ring-primary/30"
                      : "bg-gray-100 text-gray-400"
                }`}
                title={step.label}
              >
                {done ? <Check className="h-4 w-4" /> : idx + 1}
              </button>
            );
          })}
        </div>

        <p className="mb-4 text-center text-xs text-gray-400">
          {completedCount}/{totalSteps} steps completed
        </p>

        {/* Step content */}
        {currentStep === "profile" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <User className="h-5 w-5 text-primary" />
                Your Name
              </CardTitle>
              <CardDescription>
                What should LL5 call you?
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setError(null);
                  }}
                  placeholder="Enter your name"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveProfile(); }}
                />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <Button onClick={handleSaveProfile} disabled={isPending} className="w-full">
                {isPending ? "Saving..." : "Continue"}
                {!isPending && <ChevronRight className="h-4 w-4 ml-1" />}
              </Button>
            </CardContent>
          </Card>
        )}

        {currentStep === "timezone" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Globe className="h-5 w-5 text-primary" />
                Your Timezone
              </CardTitle>
              <CardDescription>
                Used for calendar, notifications, and scheduling.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select value={timezone} onValueChange={(v) => { setTimezone(v); setError(null); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select timezone..." />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {timezone && !TIMEZONES.includes(timezone) && (
                  <p className="text-xs text-gray-500">
                    Detected: {timezone}
                  </p>
                )}
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <Button onClick={handleSaveTimezone} disabled={isPending} className="w-full">
                {isPending ? "Saving..." : "Continue"}
                {!isPending && <ChevronRight className="h-4 w-4 ml-1" />}
              </Button>
            </CardContent>
          </Card>
        )}

        {currentStep === "google" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Calendar className="h-5 w-5 text-primary" />
                Google Calendar
              </CardTitle>
              <CardDescription>
                Connect your Google account for calendar and email integration.
                This step is optional.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${googleConnected ? "bg-green-500" : "bg-gray-300"}`} />
                <span className="text-sm">
                  {googleConnected ? "Connected" : "Not connected"}
                </span>
              </div>

              {!googleConnected && (
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

              {googleConnected && (
                <Button onClick={goToNext} className="w-full">
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}

              {connectError && <p className="text-xs text-red-600">{connectError}</p>}

              {!googleConnected && (
                <button
                  onClick={handleSkipGoogle}
                  disabled={isPending}
                  className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors cursor-pointer py-1"
                >
                  <SkipForward className="h-3 w-3 inline mr-1" />
                  Skip for now
                </button>
              )}
            </CardContent>
          </Card>
        )}

        {currentStep === "android" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Smartphone className="h-5 w-5 text-primary" />
                Android App
              </CardTitle>
              <CardDescription>
                Install the LL5 Android app for GPS tracking, notification
                capture, and health data. This step is optional.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md bg-gray-50 p-4 text-sm space-y-2">
                <p className="font-medium text-gray-700">Setup instructions:</p>
                <ol className="list-decimal list-inside space-y-1 text-gray-600 text-xs">
                  <li>Install the LL5 app on your Android device</li>
                  <li>Open the app and go to Settings</li>
                  <li>
                    Enter the gateway URL:{" "}
                    <code className="bg-white border px-1.5 py-0.5 rounded text-xs font-mono select-all">
                      https://gateway.noninoni.click
                    </code>
                  </li>
                  <li>Log in with your credentials</li>
                </ol>
              </div>

              <button
                onClick={handleSkipAndroid}
                disabled={isPending}
                className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors cursor-pointer py-1"
              >
                <SkipForward className="h-3 w-3 inline mr-1" />
                Skip for now
              </button>

              <Button onClick={handleSkipAndroid} disabled={isPending} className="w-full">
                {isPending ? "..." : "Continue"}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </CardContent>
          </Card>
        )}

        {currentStep === "complete" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <PartyPopper className="h-6 w-6 text-green-600" />
              </div>
              <CardTitle className="text-lg">You&apos;re all set!</CardTitle>
              <CardDescription>
                Your LL5 assistant is ready to go.
                {displayName && (
                  <> Welcome, <span className="font-medium text-gray-700">{displayName}</span>.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Summary of what was configured */}
              <div className="space-y-2">
                {data.onboarding.steps.profile_set && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Profile: {displayName}</span>
                  </div>
                )}
                {data.onboarding.steps.timezone_configured && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Timezone: {timezone.replace(/_/g, " ")}</span>
                  </div>
                )}
                {googleConnected && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Check className="h-4 w-4 text-green-500" />
                    <span>Google Calendar connected</span>
                  </div>
                )}
              </div>

              <Button onClick={handleFinish} disabled={isPending} className="w-full" size="lg">
                {isPending ? "Finishing..." : "Go to Dashboard"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
