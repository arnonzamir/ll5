import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { getToken } from "@/lib/auth";

export default async function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const token = await getToken();
  if (!token) {
    redirect("/login");
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Nav />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-4 min-h-0">{children}</main>
      <footer className="shrink-0 text-center text-[10px] text-gray-300 py-1">
        build {process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"}
      </footer>
    </div>
  );
}
