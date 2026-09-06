"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { verifyIdentityAction } from "./actions";

export function VerifyForm({ ttlMinutes }: { ttlMinutes: number }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await verifyIdentityAction(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4 text-gray-500" aria-hidden />
          Confirm it is you
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-gray-500">
          This page shows sensitive data. Enter your password to continue; the confirmation lasts {ttlMinutes} minutes.
        </p>
        <form action={handleSubmit} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Your password"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Checking..." : "Confirm"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
