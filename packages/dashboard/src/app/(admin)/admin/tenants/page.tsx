import { redirect } from "next/navigation";
import { getToken, decodeTokenPayload } from "@/lib/auth";
import { TenantsView } from "./tenants-view";

export const metadata = { title: "Tenants - LL5 Admin" };

export default async function TenantsPage() {
  // DEFENSE-IN-DEPTH ONLY. The `role` claim comes from an *unverified* JWT
  // payload (decodeTokenPayload does not check the signature). The gateway is
  // the AUTHORITATIVE boundary — GET /admin/tenants is superadmin-gated there.
  // This local check just redirects non-superadmins away from the UI.
  const token = await getToken();
  if (!token) {
    redirect("/login?next=/admin/tenants");
  }
  const payload = decodeTokenPayload(token);
  if (payload?.role !== "superadmin") {
    redirect("/dashboard");
  }

  return <TenantsView />;
}
