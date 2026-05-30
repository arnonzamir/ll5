"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loginAction } from "./actions";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [usePin, setUsePin] = useState(false);
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const flash = searchParams.get("flash");

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await loginAction(formData);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Sign In</CardTitle>
      </CardHeader>
      <CardContent>
        {flash === "reset-success" && (
          <p
            className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
            role="status"
          >
            Your password has been reset. Please sign in.
          </p>
        )}
        <form action={handleSubmit} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="mode" value={usePin ? "pin" : "email"} />

          {usePin ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="user_id">Username</Label>
                <Input
                  id="user_id"
                  name="user_id"
                  type="text"
                  required
                  autoComplete="username"
                  placeholder="Username or user ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pin">PIN</Label>
                <Input
                  id="pin"
                  name="pin"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Enter your PIN"
                  inputMode="numeric"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/forgot"
                    className="text-xs text-primary hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                />
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Signing in..." : "Sign In"}
          </Button>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setUsePin((v) => !v);
            }}
            className="w-full text-center text-xs text-gray-500 hover:text-gray-700"
          >
            {usePin
              ? "Use email & password instead"
              : "Use username & PIN instead"}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
