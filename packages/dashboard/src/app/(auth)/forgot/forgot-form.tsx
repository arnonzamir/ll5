"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { forgotPasswordAction } from "../auth-actions";

export function ForgotForm() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await forgotPasswordAction(null, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.done) setDone(true);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Reset your password</CardTitle>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              If that email exists, a reset link has been sent. Check your inbox
              and follow the link to set a new password.
            </p>
            <Link
              href="/login"
              className="block text-center text-sm text-primary hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form action={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? "Sending..." : "Send reset link"}
            </Button>
            <Link
              href="/login"
              className="block text-center text-xs text-gray-500 hover:text-gray-700"
            >
              Back to sign in
            </Link>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
