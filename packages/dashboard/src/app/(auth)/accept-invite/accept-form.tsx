"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { acceptInviteAction } from "../auth-actions";

export function AcceptInviteForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      // On success the action redirects to /onboarding and never returns.
      const result = await acceptInviteAction(null, formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Accept your invite</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              readOnly
              disabled
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="display_name">Display name</Label>
            <Input
              id="display_name"
              name="display_name"
              type="text"
              placeholder="How should we address you?"
              autoComplete="name"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">
              Username <span className="text-gray-400">(optional)</span>
            </Label>
            <Input
              id="username"
              name="username"
              type="text"
              placeholder="For phone quick-unlock"
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
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
            {isPending ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
