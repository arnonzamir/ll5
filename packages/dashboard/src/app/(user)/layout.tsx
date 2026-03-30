import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { getToken, decodeTokenPayload } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";

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
  } catch {
    // Fall back to short UUID
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Nav username={displayName} isAdmin={isAdmin} />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-4 min-h-0">{children}</main>
      <footer className="shrink-0 text-left text-[10px] text-black py-1 px-4">
        build {process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"}
      </footer>
    </div>
  );
}
