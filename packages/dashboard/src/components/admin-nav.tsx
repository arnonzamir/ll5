"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  Users,
  Wrench,
  ScrollText,
  ClipboardList,
  ArrowLeft,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const adminLinks = [
  { href: "/admin", label: "System Health", icon: Activity },
  { href: "/admin/logs", label: "App Logs", icon: ScrollText },
  { href: "/admin/audit", label: "Audit Log", icon: ClipboardList },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/tools", label: "MCP Tools", icon: Wrench },
];

export function AdminNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <Link
                href="/dashboard"
                className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <span className="text-lg font-bold text-admin">LL5 Admin</span>
            </div>
            <div className="hidden md:flex items-center gap-1">
              {adminLinks.map((link) => {
                const Icon = link.icon;
                const active =
                  link.href === "/admin"
                    ? pathname === "/admin"
                    : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-admin/10 text-admin-700"
                        : "text-gray-600 hover:bg-amber-100 hover:text-gray-900"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>

          <button
            className="md:hidden p-2 rounded-md text-gray-600 hover:bg-amber-100"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="md:hidden pb-3 space-y-1">
            {adminLinks.map((link) => {
              const Icon = link.icon;
              const active =
                link.href === "/admin"
                  ? pathname === "/admin"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-admin/10 text-admin-700"
                      : "text-gray-600 hover:bg-amber-100 hover:text-gray-900"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
