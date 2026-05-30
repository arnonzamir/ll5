import Link from "next/link";
import { env } from "@/lib/env";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AcceptInviteForm } from "./accept-form";

export const metadata = { title: "Accept Invite - LL5" };

async function validateInvite(
  token: string
): Promise<{ valid: boolean; email?: string }> {
  try {
    const res = await fetch(
      `${env.GATEWAY_URL}/invites/validate?token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return { valid: false };
    return (await res.json()) as { valid: boolean; email?: string };
  } catch (err) {
    console.error(
      "[accept-invite] validate error:",
      err instanceof Error ? err.message : String(err)
    );
    return { valid: false };
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">LL5</h1>
          <p className="mt-2 text-sm text-gray-500">Personal Assistant</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function InvalidInvite() {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-center">Invite invalid or expired</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            This invite link is invalid, has already been used, or has expired.
            Please ask an administrator for a new invite.
          </p>
          <Link
            href="/login"
            className="block text-center text-sm text-primary hover:underline"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </Shell>
  );
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) return <InvalidInvite />;

  const { valid, email } = await validateInvite(token);
  if (!valid) return <InvalidInvite />;

  return (
    <Shell>
      <AcceptInviteForm token={token} email={email ?? ""} />
    </Shell>
  );
}
