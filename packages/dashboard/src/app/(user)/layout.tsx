import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Nav } from "@/components/nav";
import { getToken, decodeTokenPayload } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";
import { env } from "@/lib/env";

interface KnowledgeProfile {
  profile: {
    name?: string;
    display_name?: string;
  } | null;
}

export default async function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const token = await getToken();
  if (!token) {
    redirect("/login");
  }

  const payload = decodeTokenPayload(token);
  const uid = (payload?.uid as string) ?? "User";
  const isAdmin = payload?.role === "admin";

  // Detect current path to avoid infinite redirect on /onboarding
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") ?? "";
  const isOnOnboarding = pathname.startsWith("/onboarding");

  // Check onboarding status (only redirect if not already on /onboarding)
  if (!isOnOnboarding) {
    try {
      const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const settings = (await res.json()) as Record<string, unknown>;
        const onboarding = settings.onboarding as { completed?: boolean } | undefined;
        // Only redirect if onboarding key exists AND completed is false
        if (onboarding && onboarding.completed === false) {
          redirect("/onboarding");
        }
      }
    } catch (err) {
      console.error("[layout] Failed to check onboarding:", err instanceof Error ? err.message : String(err));
    }
  }

  // Fetch display name from personal-knowledge MCP
  let displayName = uid.length > 8 ? uid.slice(0, 8) : uid;
  try {
    const data = await mcpCallJsonSafe<KnowledgeProfile>("knowledge", "get_profile");
    const profile = data?.profile;
    if (profile?.name) {
      displayName = profile.name;
    } else if (profile?.display_name) {
      displayName = profile.display_name;
    }
  } catch (err) {
    console.error("[layout] Failed to fetch display name:", err instanceof Error ? err.message : String(err));
  }

  // `/chat` is a full-bleed view — it manages its own max-width, padding,
  // and scroll container. Every other page keeps the centered 7xl wrapper.
  const isImmersive = pathname.startsWith("/chat");

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Nav username={displayName} isAdmin={isAdmin} />
      {isImmersive ? (
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-4 min-h-0 overflow-y-auto">
          {children}
        </main>
      )}
      <footer className="shrink-0 text-left text-[10px] text-black py-1 px-4">
        build {process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"}
      </footer>
    </div>
  );
}
