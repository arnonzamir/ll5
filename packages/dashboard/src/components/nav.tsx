"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  CheckSquare,
  FolderKanban,
  Inbox,
  ShoppingCart,
  Users,
  MapPin,
  UserCircle,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const userLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/actions", label: "Actions", icon: CheckSquare },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/shopping", label: "Shopping", icon: ShoppingCart },
  { href: "/people", label: "People", icon: Users },
  { href: "/places", label: "Places", icon: MapPin },
  { href: "/profile", label: "Profile", icon: UserCircle },
];

export function Nav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="text-lg font-bold text-primary">
              LL5
            </Link>
            <div className="hidden md:flex items-center gap-1">
              {userLinks.map((link) => {
                const Icon = link.icon;
                const active = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
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
            className="md:hidden p-2 rounded-md text-gray-600 hover:bg-gray-100"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="md:hidden pb-3 space-y-1">
            {userLinks.map((link) => {
              const Icon = link.icon;
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
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
