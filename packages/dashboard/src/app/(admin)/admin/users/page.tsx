"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, Users } from "lucide-react";
import { getCurrentUserInfo } from "./users-server-actions";

interface TokenInfo {
  sub?: string;
  user_id?: string;
  name?: string;
  role?: string;
  exp?: number;
  iat?: number;
}

export default function UsersPage() {
  const [payload, setPayload] = useState<TokenInfo | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const info = await getCurrentUserInfo();
      setPayload(info);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Current User
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : payload ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-500">User ID</dt>
              <dd className="font-mono text-xs">
                {payload.sub ?? payload.user_id ?? "unknown"}
              </dd>

              {payload.name && (
                <>
                  <dt className="text-gray-500">Name</dt>
                  <dd>{payload.name}</dd>
                </>
              )}

              <dt className="text-gray-500">Role</dt>
              <dd>
                <Badge
                  variant={payload.role === "admin" ? "default" : "secondary"}
                >
                  {payload.role ?? "user"}
                </Badge>
              </dd>

              {payload.exp && (
                <>
                  <dt className="text-gray-500">Token Expires</dt>
                  <dd className="text-xs">
                    {new Date(payload.exp * 1000).toLocaleString()}
                  </dd>
                </>
              )}

              {payload.iat && (
                <>
                  <dt className="text-gray-500">Token Issued</dt>
                  <dd className="text-xs">
                    {new Date(payload.iat * 1000).toLocaleString()}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-gray-500">
              Could not read token information.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Users className="h-12 w-12 mb-3" />
          <p className="text-sm">User management requires a gateway admin endpoint.</p>
          <p className="text-xs mt-1">
            This will be available once the gateway exposes user listing and creation APIs.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
