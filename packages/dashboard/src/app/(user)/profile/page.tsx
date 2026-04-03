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
import { Shield, LogOut, Check, Globe } from "lucide-react";
import { getUserInfo, getDisplayName, updateDisplayName, getTimezone, updateTimezone, logout } from "./profile-server-actions";

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
  const [timezone, setTimezone] = useState("Asia/Jerusalem");
  const [timezoneSaved, setTimezoneSaved] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const [info, name, tz] = await Promise.all([getUserInfo(), getDisplayName(), getTimezone()]);
      setUser(info);
      setDisplayName(name);
      if (tz.error) setTimezoneError(tz.error);
      else setTimezone(tz.timezone);
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

      {/* Timezone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            <Globe className="h-4 w-4" /> Timezone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Select
              value={timezone}
              onValueChange={(v) => {
                setTimezone(v);
                setTimezoneSaved(false);
                setTimezoneError(null);
              }}
            >
              <SelectTrigger className="flex-1">
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
            <Button
              size="sm"
              onClick={() => {
                setTimezoneError(null);
                startTransition(async () => {
                  const result = await updateTimezone(timezone);
                  if (result.ok) {
                    setTimezoneSaved(true);
                    setTimeout(() => setTimezoneSaved(false), 2000);
                  } else {
                    setTimezoneError(result.error ?? "Failed to save");
                  }
                });
              }}
              disabled={isPending}
            >
              {timezoneSaved ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  Saved
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
          {timezoneError && (
            <p className="text-xs text-red-600">{timezoneError}</p>
          )}
          <p className="text-xs text-gray-400">
            Used for calendar, notifications, quiet hours, and all time-based features.
          </p>
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
