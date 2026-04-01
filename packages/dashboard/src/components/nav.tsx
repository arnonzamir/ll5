"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import {
  LayoutDashboard,
  CalendarDays,
  CheckSquare,
  FolderKanban,
  Inbox,
  ShoppingCart,
  Users,
  MapPin,
  Navigation,
  BookUser,
  Smartphone,
  UserCircle,
  Menu,
  X,
  ChevronDown,
  Settings,
  KeyRound,
  Mail,
  Bell,
  MessageSquare,
  Shield,
  LogOut,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/(user)/logout-action";

interface NavLink {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const topLevelLinks: NavLink[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/actions", label: "Actions", icon: CheckSquare },
];

interface NavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavLink[];
}

const navGroups: NavGroup[] = [
  {
    label: "Organize",
    icon: FolderKanban,
    items: [
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/shopping", label: "Shopping", icon: ShoppingCart },
    ],
  },
  {
    label: "People & Places",
    icon: Users,
    items: [
      { href: "/people", label: "People", icon: Users },
      { href: "/contacts", label: "Contacts", icon: BookUser },
      { href: "/locations", label: "Locations", icon: Navigation },
      { href: "/places", label: "Places", icon: MapPin },
    ],
  },
  {
    label: "Data",
    icon: Database,
    items: [
      { href: "/phone-data", label: "Phone", icon: Smartphone },
    ],
  },
];

// All links flattened for mobile menu
const allLinks: NavLink[] = [
  ...topLevelLinks,
  ...navGroups.flatMap((g) => g.items),
];

interface NavProps {
  username?: string;
  isAdmin?: boolean;
}

export function Nav({ username = "User", isAdmin = false }: NavProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setProfileOpen(false);
      }

      // Check if click is outside all group dropdowns
      if (openGroup) {
        const ref = groupRefs.current[openGroup];
        if (ref && !ref.contains(event.target as Node)) {
          setOpenGroup(null);
        }
      }
    }
    if (profileOpen || openGroup) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [profileOpen, openGroup]);

  function isGroupActive(group: NavGroup): boolean {
    return group.items.some((item) => pathname === item.href);
  }

  function toggleGroup(label: string) {
    setOpenGroup((prev) => (prev === label ? null : label));
    setProfileOpen(false);
  }

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="text-lg font-bold text-primary">
              LL5
            </Link>
            <div className="hidden md:flex items-center gap-1">
              {/* Top-level links */}
              {topLevelLinks.map((link) => {
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

              {/* Grouped dropdowns */}
              {navGroups.map((group) => {
                const GroupIcon = group.icon;
                const active = isGroupActive(group);
                const isOpen = openGroup === group.label;

                return (
                  <div
                    key={group.label}
                    className="relative"
                    ref={(el) => {
                      groupRefs.current[group.label] = el;
                    }}
                  >
                    <button
                      onClick={() => toggleGroup(group.label)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        active || isOpen
                          ? "bg-primary/10 text-primary"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                      )}
                    >
                      <GroupIcon className="h-4 w-4" />
                      {group.label}
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          isOpen && "rotate-180"
                        )}
                      />
                    </button>

                    {isOpen && (
                      <div className="absolute left-0 mt-1 w-48 rounded-md border border-gray-200 bg-white shadow-lg z-50">
                        <div className="py-1">
                          {group.items.map((item) => {
                            const ItemIcon = item.icon;
                            const itemActive = pathname === item.href;
                            return (
                              <Link
                                key={item.href}
                                href={item.href}
                                onClick={() => setOpenGroup(null)}
                                className={cn(
                                  "flex items-center gap-2 px-4 py-2 text-sm transition-colors",
                                  itemActive
                                    ? "bg-primary/10 text-primary font-medium"
                                    : "text-gray-700 hover:bg-gray-100"
                                )}
                              >
                                <ItemIcon className="h-4 w-4" />
                                {item.label}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Profile dropdown — desktop */}
            <div className="hidden md:block relative" ref={dropdownRef}>
              <button
                onClick={() => {
                  setProfileOpen(!profileOpen);
                  setOpenGroup(null);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  profileOpen
                    ? "bg-primary/10 text-primary"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                )}
              >
                <UserCircle className="h-4 w-4" />
                {username}
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    profileOpen && "rotate-180"
                  )}
                />
              </button>

              {profileOpen && (
                <div className="absolute right-0 mt-1 w-48 rounded-md border border-gray-200 bg-white shadow-lg z-50">
                  <div className="py-1">
                    <Link
                      href="/profile"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <Settings className="h-4 w-4" />
                      Edit Profile
                    </Link>
                    <Link
                      href="/profile"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <KeyRound className="h-4 w-4" />
                      Change PIN
                    </Link>
                    <Link
                      href="/profile"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <Mail className="h-4 w-4" />
                      Email Settings
                    </Link>
                    <Link
                      href="/settings/notifications"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <Bell className="h-4 w-4" />
                      Message Rules
                    </Link>
                    <Link
                      href="/sessions"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <MessageSquare className="h-4 w-4" />
                      Sessions
                    </Link>

                    <div className="my-1 border-t border-gray-200" />

                    {isAdmin && (
                      <>
                        <Link
                          href="/admin"
                          onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                          <Shield className="h-4 w-4" />
                          Admin
                        </Link>
                        <div className="my-1 border-t border-gray-200" />
                      </>
                    )}

                    <form action={logoutAction}>
                      <button
                        type="submit"
                        className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                      >
                        <LogOut className="h-4 w-4" />
                        Log Out
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </div>

            {/* Mobile menu toggle */}
            <button
              className="md:hidden p-2 rounded-md text-gray-600 hover:bg-gray-100"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            >
              {mobileOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden pb-3 space-y-1">
            {allLinks.map((link) => {
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

            <div className="my-1 border-t border-gray-200" />

            <Link
              href="/profile"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              <UserCircle className="h-4 w-4" />
              {username}
            </Link>

            {isAdmin && (
              <Link
                href="/admin"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                <Shield className="h-4 w-4" />
                Admin
              </Link>
            )}

            <form action={logoutAction}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <LogOut className="h-4 w-4" />
                Log Out
              </button>
            </form>
          </div>
        )}
      </div>
    </nav>
  );
}
