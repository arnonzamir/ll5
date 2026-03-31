"use client";

import { useState, useTransition, useEffect, useCallback, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Search,
  Users,
  User,
  Link as LinkIcon,
  Unlink,
  RefreshCw,
  BookUser,
  Phone,
} from "lucide-react";
import {
  fetchContacts,
  fetchPeople,
  linkContactToPerson,
  unlinkContact,
  type Contact,
  type Person,
} from "./contacts-server-actions";

// --- Helpers ---

const PLATFORM_COLORS: Record<string, { bg: string; text: string }> = {
  whatsapp: { bg: "bg-green-100", text: "text-green-800" },
  telegram: { bg: "bg-blue-100", text: "text-blue-800" },
  sms: { bg: "bg-orange-100", text: "text-orange-800" },
};

function PlatformBadge({ platform }: { platform: string }) {
  const colors = PLATFORM_COLORS[platform.toLowerCase()] ?? {
    bg: "bg-gray-100",
    text: "text-gray-700",
  };
  return (
    <Badge
      className={`${colors.bg} ${colors.text} border-transparent text-[10px] px-1.5 py-0`}
    >
      {platform}
    </Badge>
  );
}

function formatTime(ts: string | null): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/** Check if a contact's display name matches a person's name or aliases */
function isNameMatch(contact: Contact, person: Person): boolean {
  const contactName = (contact.display_name ?? "").toLowerCase().trim();
  if (!contactName) return false;

  // Exact match on person name
  if (contactName === person.name.toLowerCase()) return true;

  // Partial match (contact name contains person name or vice versa)
  if (
    contactName.includes(person.name.toLowerCase()) ||
    person.name.toLowerCase().includes(contactName)
  )
    return true;

  // Check aliases
  if (person.aliases) {
    for (const alias of person.aliases) {
      const a = alias.toLowerCase();
      if (contactName === a || contactName.includes(a) || a.includes(contactName))
        return true;
    }
  }

  return false;
}

// --- Link Modal ---

function LinkPersonModal({
  open,
  onOpenChange,
  contact,
  people,
  onLink,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  people: Person[];
  onLink: (contactId: string, personId: string) => void;
  isPending: boolean;
}) {
  const [search, setSearch] = useState("");

  // Reset search when modal opens
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const { suggested, others } = useMemo(() => {
    if (!contact) return { suggested: [], others: [] };

    const q = search.toLowerCase();
    const matchingPeople = people.filter((p) => {
      if (!q) return true;
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.relationship?.toLowerCase().includes(q)) return true;
      if (p.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    });

    const sugg: Person[] = [];
    const rest: Person[] = [];

    for (const p of matchingPeople) {
      if (isNameMatch(contact, p)) {
        sugg.push(p);
      } else {
        rest.push(p);
      }
    }

    return { suggested: sugg, others: rest };
  }, [contact, people, search]);

  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link to Person</DialogTitle>
          <DialogDescription>
            Link &quot;{contact.display_name || contact.phone_number || contact.platform_id}&quot; to a person in your knowledge base.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search people..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          <div className="mt-3 max-h-64 overflow-y-auto space-y-1">
            {suggested.length > 0 && (
              <>
                <div className="text-xs font-semibold uppercase tracking-wide text-green-700 px-2 py-1">
                  Suggested matches
                </div>
                {suggested.map((p) => (
                  <PersonOption
                    key={p.id}
                    person={p}
                    isSuggested
                    onClick={() => onLink(contact.id, p.id)}
                    disabled={isPending}
                  />
                ))}
              </>
            )}

            {others.length > 0 && (
              <>
                {suggested.length > 0 && (
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 px-2 py-1 mt-2">
                    All people
                  </div>
                )}
                {others.map((p) => (
                  <PersonOption
                    key={p.id}
                    person={p}
                    onClick={() => onLink(contact.id, p.id)}
                    disabled={isPending}
                  />
                ))}
              </>
            )}

            {suggested.length === 0 && others.length === 0 && (
              <div className="flex flex-col items-center justify-center py-6 text-gray-400">
                <Users className="h-6 w-6 mb-1" />
                <p className="text-sm">
                  {people.length === 0
                    ? "No people in knowledge base."
                    : "No people match your search."}
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PersonOption({
  person,
  isSuggested,
  onClick,
  disabled,
}: {
  person: Person;
  isSuggested?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors cursor-pointer ${
        isSuggested
          ? "bg-green-50 hover:bg-green-100 border border-green-200"
          : "hover:bg-gray-100"
      } disabled:opacity-50`}
    >
      <User className="h-4 w-4 text-gray-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{person.name}</span>
          {person.relationship && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
              {person.relationship}
            </Badge>
          )}
        </div>
        {person.aliases && person.aliases.length > 0 && (
          <p className="text-xs text-gray-400 truncate">
            {person.aliases.join(", ")}
          </p>
        )}
      </div>
      {isSuggested && (
        <Badge className="bg-green-100 text-green-700 border-transparent text-[10px] px-1.5 py-0 shrink-0">
          match
        </Badge>
      )}
    </button>
  );
}

// --- Contact Row ---

function ContactRow({
  contact,
  people,
  onLinkClick,
  onUnlink,
  isPending,
}: {
  contact: Contact;
  people: Person[];
  onLinkClick: (contact: Contact) => void;
  onUnlink: (contactId: string) => void;
  isPending: boolean;
}) {
  const linkedPerson = contact.person_id
    ? people.find((p) => p.id === contact.person_id) ?? null
    : null;

  const displayName = contact.display_name || contact.phone_number || contact.platform_id;

  return (
    <div className="flex items-center gap-3 py-2.5">
      {/* Icon */}
      {contact.is_group ? (
        <Users className="h-4 w-4 text-gray-400 shrink-0" />
      ) : (
        <User className="h-4 w-4 text-gray-400 shrink-0" />
      )}

      {/* Contact info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{displayName}</span>
          <PlatformBadge platform={contact.platform} />
          {contact.is_group && (
            <Badge className="bg-purple-100 text-purple-700 border-transparent text-[10px] px-1.5 py-0">
              group
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {contact.phone_number && contact.display_name && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {contact.phone_number}
            </span>
          )}
          {contact.last_seen_at && (
            <span className="text-xs text-gray-400">
              {formatTime(contact.last_seen_at)}
            </span>
          )}
        </div>
      </div>

      {/* Link status */}
      <div className="flex items-center gap-2 shrink-0">
        {linkedPerson ? (
          <>
            <div className="flex items-center gap-1.5 text-sm">
              <LinkIcon className="h-3.5 w-3.5 text-green-600" />
              <span className="text-green-700 font-medium">{linkedPerson.name}</span>
              {linkedPerson.relationship && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {linkedPerson.relationship}
                </Badge>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onUnlink(contact.id)}
              disabled={isPending}
              className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              <Unlink className="h-3 w-3 mr-1" />
              Unlink
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onLinkClick(contact)}
            disabled={isPending}
            className="h-7 text-xs"
          >
            <LinkIcon className="h-3 w-3 mr-1" />
            Link
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Stats Bar ---

function StatsBar({
  total,
  linked,
  unlinked,
}: {
  total: number;
  linked: number;
  unlinked: number;
}) {
  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="text-gray-500">
        <span className="font-semibold text-gray-700">{total}</span> contacts
      </span>
      <span className="text-gray-300">|</span>
      <span className="text-gray-500">
        <span className="font-semibold text-green-700">{linked}</span> linked
      </span>
      <span className="text-gray-300">|</span>
      <span className="text-gray-500">
        <span className="font-semibold text-amber-700">{unlinked}</span> unlinked
      </span>
    </div>
  );
}

// --- Filter Types ---

type PlatformFilter = "all" | "whatsapp" | "telegram" | "sms";
type LinkFilter = "all" | "linked" | "unlinked";

// --- Main View ---

export function ContactsView() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [isPending, startTransition] = useTransition();

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [linkFilter, setLinkFilter] = useState<LinkFilter>("all");

  // Link modal state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkingContact, setLinkingContact] = useState<Contact | null>(null);

  const loadData = useCallback(() => {
    startTransition(async () => {
      const [contactsData, peopleData] = await Promise.all([
        fetchContacts(),
        fetchPeople(),
      ]);
      setContacts(contactsData);
      setPeople(peopleData);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filtering logic
  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      // Platform filter
      if (platformFilter !== "all" && c.platform.toLowerCase() !== platformFilter)
        return false;

      // Link filter
      if (linkFilter === "linked" && !c.person_id) return false;
      if (linkFilter === "unlinked" && c.person_id) return false;

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const name = (c.display_name ?? "").toLowerCase();
        const phone = (c.phone_number ?? "").toLowerCase();
        const platformId = c.platform_id.toLowerCase();
        if (!name.includes(q) && !phone.includes(q) && !platformId.includes(q))
          return false;
      }

      return true;
    });
  }, [contacts, searchQuery, platformFilter, linkFilter]);

  // Stats
  const stats = useMemo(() => {
    const total = contacts.length;
    const linked = contacts.filter((c) => c.person_id).length;
    return { total, linked, unlinked: total - linked };
  }, [contacts]);

  // --- Actions ---

  function handleLinkClick(contact: Contact) {
    setLinkingContact(contact);
    setLinkModalOpen(true);
  }

  function handleLink(contactId: string, personId: string) {
    // Optimistic update
    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId ? { ...c, person_id: personId } : c
      )
    );
    setLinkModalOpen(false);
    setLinkingContact(null);

    startTransition(async () => {
      const success = await linkContactToPerson(contactId, personId);
      if (!success) {
        // Revert on failure
        const fresh = await fetchContacts();
        setContacts(fresh);
      }
    });
  }

  function handleUnlink(contactId: string) {
    // Optimistic update
    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId ? { ...c, person_id: null } : c
      )
    );

    startTransition(async () => {
      const success = await unlinkContact(contactId);
      if (!success) {
        const fresh = await fetchContacts();
        setContacts(fresh);
      }
    });
  }

  const platforms: { value: PlatformFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "whatsapp", label: "WhatsApp" },
    { value: "telegram", label: "Telegram" },
    { value: "sms", label: "SMS" },
  ];

  const linkFilters: { value: LinkFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "linked", label: "Linked" },
    { value: "unlinked", label: "Unlinked" },
  ];

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage messaging contacts and link them to people in your knowledge base.
          </p>
        </div>
        <Button
          onClick={loadData}
          disabled={isPending}
          variant="outline"
          size="sm"
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4 shrink-0">
        <div className="relative flex-1 w-full sm:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by name or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Platform filter */}
        <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
          {platforms.map((p) => (
            <button
              key={p.value}
              onClick={() => setPlatformFilter(p.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                platformFilter === p.value
                  ? "bg-gray-100 text-gray-800"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Link filter */}
        <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
          {linkFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setLinkFilter(f.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                linkFilter === f.value
                  ? "bg-gray-100 text-gray-800"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="mb-3 shrink-0">
        <StatsBar
          total={stats.total}
          linked={stats.linked}
          unlinked={stats.unlinked}
        />
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
              <BookUser className="h-12 w-12 mb-3" />
              {contacts.length === 0 ? (
                <>
                  <p className="text-sm">No contacts found.</p>
                  <p className="text-xs mt-1">
                    Contacts will appear here once your messaging accounts are synced.
                  </p>
                </>
              ) : (
                <p className="text-sm">No contacts match your filters.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4">
              <div className="divide-y divide-gray-100">
                {filtered.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    people={people}
                    onLinkClick={handleLinkClick}
                    onUnlink={handleUnlink}
                    isPending={isPending}
                  />
                ))}
              </div>

              {/* Show filtered count */}
              {filtered.length !== contacts.length && (
                <div className="text-xs text-gray-400 text-center mt-3 pt-3 border-t border-gray-100">
                  Showing {filtered.length} of {contacts.length} contacts
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Link modal */}
      <LinkPersonModal
        open={linkModalOpen}
        onOpenChange={(open) => {
          setLinkModalOpen(open);
          if (!open) setLinkingContact(null);
        }}
        contact={linkingContact}
        people={people}
        onLink={handleLink}
        isPending={isPending}
      />
    </div>
  );
}
