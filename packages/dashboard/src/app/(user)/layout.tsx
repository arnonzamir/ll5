import { Nav } from "@/components/nav";

export default function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Nav />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-4 min-h-0">{children}</main>
    </div>
  );
}
