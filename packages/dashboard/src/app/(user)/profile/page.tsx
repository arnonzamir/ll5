"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shield, LogOut, Check, Globe, Clock } from "lucide-react";
import { getUserInfo, getDisplayName, updateDisplayName, getUserSettings, updateUserSettings, logout, type UserSettings } from "./profile-server-actions";

interface UserInfo {
  userId: string;
  role: string;
  name: string;
  expiresAt: string | null;
}

export default function ProfilePage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [displayNameSaved, setDisplayNameSaved] = useState(false);
  const [settings, setSettings] = useState<UserSettings>({
    timezone: "Asia/Jerusalem",
    work_week: { start_day: 0, start_hour: "09:00", end_hour: "17:00" },
  });
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const [info, name, us] = await Promise.all([getUserInfo(), getDisplayName(), getUserSettings()]);
      setUser(info);
      setDisplayName(name);
      if (us.error) setSettingsError(us.error);
      else setSettings(us.settings);
    });
  }, []);

  function handleSaveDisplayName() {
    startTransition(async () => {
      const result = await updateDisplayName(displayName);
      if (result.success) {
        setDisplayNameSaved(true);
        setTimeout(() => setDisplayNameSaved(false), 2000);
      }
    });
  }

  function handleLogout() {
    startTransition(async () => {
      await logout();
    });
  }

  if (!user && isPending) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-gray-500">Unable to load profile.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Profile</h1>

      {/* User Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-gray-500">
            User Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm text-gray-600">User ID</Label>
            <span className="text-sm font-mono">{user.userId}</span>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm text-gray-600">Role</Label>
            <Badge variant={user.role === "admin" ? "default" : "secondary"}>
              {user.role}
            </Badge>
          </div>
          {user.expiresAt && (
            <div className="flex items-center justify-between">
              <Label className="text-sm text-gray-600">Token Expires</Label>
              <span className="text-sm text-gray-500">
                {new Date(user.expiresAt).toLocaleString()}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Display Name */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-gray-500">
            Display Name
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDisplayNameSaved(false);
              }}
              placeholder="Enter your display name"
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={handleSaveDisplayName}
              disabled={isPending}
            >
              {displayNameSaved ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  Saved
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
          <p className="text-xs text-gray-400">
            This name is shown in the navigation bar and used across the system.
          </p>
        </CardContent>
      </Card>

      {/* Time & Schedule */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            <Globe className="h-4 w-4" /> Time & Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Timezone</Label>
            <Select
              value={settings.timezone}
              onValueChange={(v) => {
                setSettings({ ...settings, timezone: v });
                setSettingsSaved(false);
                setSettingsError(null);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Asia/Jerusalem">Asia/Jerusalem</SelectItem>
                <SelectItem value="Europe/London">Europe/London</SelectItem>
                <SelectItem value="Europe/Berlin">Europe/Berlin</SelectItem>
                <SelectItem value="Europe/Paris">Europe/Paris</SelectItem>
                <SelectItem value="America/New_York">America/New_York</SelectItem>
                <SelectItem value="America/Chicago">America/Chicago</SelectItem>
                <SelectItem value="America/Los_Angeles">America/Los_Angeles</SelectItem>
                <SelectItem value="Asia/Tokyo">Asia/Tokyo</SelectItem>
                <SelectItem value="Asia/Shanghai">Asia/Shanghai</SelectItem>
                <SelectItem value="Australia/Sydney">Australia/Sydney</SelectItem>
                <SelectItem value="UTC">UTC</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Week starts on</Label>
            <Select
              value={String(settings.work_week.start_day)}
              onValueChange={(v) => {
                setSettings({ ...settings, work_week: { ...settings.work_week, start_day: parseInt(v) } });
                setSettingsSaved(false);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
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
                onChange={(e) => {
                  setSettings({ ...settings, work_week: { ...settings.work_week, start_hour: e.target.value } });
                  setSettingsSaved(false);
                }}
                className="h-9"
              />
            </div>
            <span className="text-sm text-gray-400 pb-2">to</span>
            <div className="space-y-1 flex-1">
              <Label className="text-xs text-gray-500">End</Label>
              <Input
                type="time"
                value={settings.work_week.end_hour}
                onChange={(e) => {
                  setSettings({ ...settings, work_week: { ...settings.work_week, end_hour: e.target.value } });
                  setSettingsSaved(false);
                }}
                className="h-9"
              />
            </div>
          </div>

          {settingsError && (
            <p className="text-xs text-red-600">{settingsError}</p>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setSettingsError(null);
                startTransition(async () => {
                  const result = await updateUserSettings(settings);
                  if (result.ok) {
                    setSettingsSaved(true);
                    setTimeout(() => setSettingsSaved(false), 2000);
                  } else {
                    setSettingsError(result.error ?? "Failed to save");
                  }
                });
              }}
              disabled={isPending}
            >
              {settingsSaved ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  Saved
                </>
              ) : (
                "Save"
              )}
            </Button>
            <p className="text-xs text-gray-400">
              Used for calendar, notifications, and agent context.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Admin link */}
      {user.role === "admin" && (
        <Card>
          <CardContent className="p-4">
            <Link href="/admin">
              <Button variant="outline" className="w-full">
                <Shield className="h-4 w-4 mr-2" />
                Admin Panel
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Logout */}
      <Button
        variant="destructive"
        onClick={handleLogout}
        disabled={isPending}
        className="w-full"
      >
        <LogOut className="h-4 w-4 mr-2" />
        Logout
      </Button>
    </div>
  );
}
