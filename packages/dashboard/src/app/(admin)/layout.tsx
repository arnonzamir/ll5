import { AdminNav } from "@/components/admin-nav";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <AdminNav />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
