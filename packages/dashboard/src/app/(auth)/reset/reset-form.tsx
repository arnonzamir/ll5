"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resetPasswordAction } from "../auth-actions";

export function ResetForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      // On success the action redirects to /login and never returns.
      const result = await resetPasswordAction(null, formData);
      if (result?.error) setError(result.error);
    });
  }

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center">Reset link invalid</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            This password reset link is missing or invalid. Request a new one.
          </p>
          <Link
            href="/forgot"
            className="block text-center text-sm text-primary hover:underline"
          >
            Request a new reset link
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Set a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="At least 8 characters"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input
              id="confirm"
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              placeholder="Re-enter password"
            />
          </div>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Saving..." : "Set new password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
