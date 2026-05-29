import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { getToken, decodeTokenPayload } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // DEFENSE-IN-DEPTH ONLY. This checks the `role` claim from an *unverified*
  // JWT payload (decodeTokenPayload does not check the signature), so it can be
  // forged by a determined client. The AUTHORITATIVE boundary is the gateway:
  // every /admin/* API call carries the Bearer token, and the gateway verifies
  // the HMAC signature and enforces the admin role before doing anything. This
  // local gate exists purely to redirect non-admins away from admin UI (UX) and
  // to avoid rendering admin pages that would only 401 on their data fetches.
  const token = await getToken();
  if (!token) {
    redirect("/login?next=/admin");
  }

  const payload = decodeTokenPayload(token);
  if (payload?.role !== "admin") {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen">
      <AdminNav />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
