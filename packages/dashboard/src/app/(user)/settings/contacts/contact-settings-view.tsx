"use client";

import { useState, useTransition, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Search, Users, MessageSquare, User, Camera, CameraOff, ArrowUp, UserPlus, Link, X, Wand2, Check, SkipForward, Loader2 } from "lucide-react";
import {
  fetchPeopleWithPlatforms,
  fetchGroupsWithSettings,
  fetchContactsForTab,
  upsertContactSetting,
  createStubAndSaveSetting,
  promoteContact,
  searchPeopleForLink,
  linkContactToPerson,
  unlinkContactFromPerson,
  fetchMatchSuggestions,
  type PersonWithPlatforms,
  type GroupWithSettings,
  type ContactEntry,
  type MatchSuggestion,
} from "./contact-settings-server-actions";

const ROUTING_OPTIONS = ["ignore", "batch", "immediate", "agent"] as const;
const PERMISSION_OPTIONS = ["ignore", "input", "agent"] as const;

const ROUTING_COLORS: Record<string, string> = {
  ignore: "text-gray-400",
  batch: "text-gray-600",
  immediate: "text-amber-600",
  agent: "text-green-600",
};

const PERMISSION_COLORS: Record<string, string> = {
  ignore: "text-gray-400",
  input: "text-blue-600",
  agent: "text-green-600",
};

type TabId = "people" | "contacts" | "groups";

const CACHE_KEY = "ll5_contacts_cache";
const CACHE_TTL = 5 * 60 * 1000; // 5 min — background refresh if stale

interface CachedData {
  people: PersonWithPlatforms[];
  contacts: ContactEntry[];
  groups: GroupWithSettings[];
  ts: number;
}

function saveCache(data: Omit<CachedData, "ts">) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, ts: Date.now() }));
  } catch { /* quota exceeded — ignore */ }
}

function loadCache(): CachedData | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedData;
  } catch { return null; }
}

function ToggleGroup({
  options,
  value,
  onChange,
  colors,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  colors: Record<string, string>;
}) {
  return (
    <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
            value === opt ? `bg-gray-100 ${colors[opt]}` : "text-gray-400 hover:text-gray-600"
          }`}
        >
          {opt.charAt(0).toUpperCase() + opt.slice(1)}
        </button>
      ))}
    </div>
  );
}

function MediaButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? "Media: downloading" : "Media: not downloading"}
      className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
        active ? "text-blue-500 bg-blue-50" : "text-gray-300 hover:text-gray-500"
      }`}
    >
      {active ? <Camera className="h-3.5 w-3.5" /> : <CameraOff className="h-3.5 w-3.5" />}
    </button>
  );
}

function LinkPopover({
  contactId,
  onLinked,
}: {
  contactId: string;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string; relationship?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function handleSearch(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchPeopleForLink(value.trim());
        setResults(r);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  async function handleLink(personId: string) {
    setLinking(true);
    try {
      const ok = await linkContactToPerson(contactId, personId);
      if (ok) {
        setOpen(false);
        onLinked();
      }
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="Link to KB person"
        className="p-1 rounded text-gray-300 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer shrink-0"
      >
        <Link className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-8 z-50 w-72 bg-white border border-gray-200 rounded-lg shadow-lg p-3"
        >
          <div className="text-xs font-medium text-gray-500 mb-2">Link to KB person</div>
          <Input
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search people..."
            className="text-sm mb-2"
            autoFocus
          />
          {searching && (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching...
            </div>
          )}
          {!searching && results.length > 0 && (
            <div className="max-h-48 overflow-y-auto divide-y divide-gray-50">
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleLink(p.id)}
                  disabled={linking}
                  className="flex items-center gap-2 w-full text-left px-2 py-1.5 hover:bg-gray-50 rounded transition-colors cursor-pointer disabled:opacity-50"
                >
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  {p.relationship && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{p.relationship}</Badge>
                  )}
                </button>
              ))}
            </div>
          )}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-xs text-gray-400 py-2 text-center">No people found</p>
          )}
        </div>
      )}
    </div>
  );
}

function AutoMatchPanel({
  onDone,
}: {
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [actionPending, setActionPending] = useState(false);

  async function handleOpen() {
    setOpen(true);
    setLoading(true);
    setCurrentIndex(0);
    try {
      const s = await fetchMatchSuggestions();
      setSuggestions(s);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setSuggestions([]);
    setCurrentIndex(0);
    onDone();
  }

  function advance() {
    if (currentIndex < suggestions.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      handleClose();
    }
  }

  async function handleLink(contactId: string, personId: string) {
    setActionPending(true);
    try {
      await linkContactToPerson(contactId, personId);
      advance();
    } finally {
      setActionPending(false);
    }
  }

  const current = suggestions[currentIndex];

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen} className="gap-1.5">
        <Wand2 className="h-3.5 w-3.5" />
        Auto-match
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 relative">
            <button
              onClick={handleClose}
              className="absolute top-3 right-3 p-1 rounded text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>

            <h3 className="text-lg font-semibold mb-1">Auto-match Contacts</h3>
            <p className="text-sm text-gray-500 mb-4">For each person, pick the matching contact</p>

            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Finding matches...</span>
              </div>
            )}

            {!loading && suggestions.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-gray-400">No match suggestions found</p>
                <Button variant="ghost" size="sm" onClick={handleClose} className="mt-3">
                  Close
                </Button>
              </div>
            )}

            {!loading && current && (
              <div>
                <div className="text-xs text-gray-400 mb-3">
                  {currentIndex + 1} of {suggestions.length}
                </div>

                {/* Person card */}
                <div className="p-3 bg-blue-50 rounded-lg mb-3">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-blue-500 shrink-0" />
                    <span className="text-sm font-semibold text-blue-900">{current.personName}</span>
                    {current.relationship && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{current.relationship}</Badge>
                    )}
                  </div>
                  {current.notes && (
                    <div className="text-[11px] text-blue-700/70 mt-1 pl-6 line-clamp-2">{current.notes}</div>
                  )}
                </div>

                <div className="text-xs text-gray-500 mb-2">Link to which contact?</div>
                <div className="space-y-1.5 mb-4 max-h-64 overflow-y-auto">
                  {current.candidates.map((c) => (
                    <div
                      key={c.contactId}
                      className="p-2 border border-gray-200 rounded-lg hover:border-green-300 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <UserPlus className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        <span className="text-sm font-medium flex-1 truncate">{c.contactName}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{c.platform}</Badge>
                        <span className="text-[10px] text-gray-300 tabular-nums shrink-0">{c.score}%</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleLink(c.contactId, current.personId)}
                          disabled={actionPending}
                          className="h-7 px-2 gap-1 text-green-600 hover:text-green-700 hover:bg-green-50"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Link
                        </Button>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5 pl-5.5">
                        {c.contactPlatformId.split("@")[0]}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={advance}
                    disabled={actionPending}
                    className="gap-1.5 text-gray-500"
                  >
                    <X className="h-3.5 w-3.5" />
                    Don&apos;t link
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function PersonRow({
  person,
  onUpdate,
  onUnlink,
}: {
  person: PersonWithPlatforms;
  onUpdate: (targetId: string, field: string, value: unknown) => void;
  onUnlink: (contactId: string) => void;
}) {
  const routing = person.settings?.routing ?? "batch";
  const permission = person.settings?.permission ?? "input";
  const downloadMedia = person.settings?.download_media ?? false;

  return (
    <div className="flex items-center gap-3 py-2.5 hover:bg-gray-50 px-2 -mx-2 rounded transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <span className="text-sm font-medium truncate">{person.name}</span>
          {person.relationship && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{person.relationship}</Badge>
          )}
        </div>
        {person.platforms.length > 0 && (
          <div className="flex gap-1.5 mt-0.5 pl-5.5">
            {person.platforms.map((p, i) => (
              <span key={i} className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
                {p.platform}: {p.display_name || p.platform_id.split("@")[0]}
                <button
                  onClick={() => onUnlink(p.contactId)}
                  title="Unlink this contact"
                  className="p-0.5 rounded hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <MediaButton active={downloadMedia} onClick={() => onUpdate(person.id, "download_media", !downloadMedia)} />

      <ToggleGroup
        options={PERMISSION_OPTIONS}
        value={permission}
        onChange={(v) => onUpdate(person.id, "permission", v)}
        colors={PERMISSION_COLORS}
      />

      <ToggleGroup
        options={ROUTING_OPTIONS}
        value={routing}
        onChange={(v) => onUpdate(person.id, "routing", v)}
        colors={ROUTING_COLORS}
      />
    </div>
  );
}

function ContactRow({
  contact,
  onUpdate,
  onPromote,
  onLinked,
}: {
  contact: ContactEntry;
  onUpdate: (contactId: string, field: string, value: unknown) => void;
  onPromote: (contactId: string) => void;
  onLinked: () => void;
}) {
  const routing = contact.settings?.routing ?? "batch";
  const permission = contact.settings?.permission ?? "input";
  const downloadMedia = contact.settings?.download_media ?? false;
  const displayName = contact.displayName || contact.phoneNumber || contact.platformId.split("@")[0];

  return (
    <div className="flex items-center gap-3 py-2.5 hover:bg-gray-50 px-2 -mx-2 rounded transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <UserPlus className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <span className="text-sm font-medium truncate">{displayName}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{contact.platform}</Badge>
        </div>
        {contact.displayName && contact.phoneNumber && (
          <div className="flex gap-1.5 mt-0.5 pl-5.5">
            <span className="text-[10px] text-gray-400">{contact.phoneNumber}</span>
          </div>
        )}
      </div>

      <LinkPopover contactId={contact.contactId} onLinked={onLinked} />

      <button
        onClick={() => onPromote(contact.contactId)}
        title="Promote to full person"
        className="p-1 rounded text-gray-300 hover:text-green-600 hover:bg-green-50 transition-colors cursor-pointer shrink-0"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>

      <MediaButton active={downloadMedia} onClick={() => onUpdate(contact.contactId, "download_media", !downloadMedia)} />

      <ToggleGroup
        options={PERMISSION_OPTIONS}
        value={permission}
        onChange={(v) => onUpdate(contact.contactId, "permission", v)}
        colors={PERMISSION_COLORS}
      />

      <ToggleGroup
        options={ROUTING_OPTIONS}
        value={routing}
        onChange={(v) => onUpdate(contact.contactId, "routing", v)}
        colors={ROUTING_COLORS}
      />
    </div>
  );
}

function GroupRow({
  group,
  onUpdate,
}: {
  group: GroupWithSettings;
  onUpdate: (targetId: string, field: string, value: unknown) => void;
}) {
  const routing = group.settings?.routing ?? "batch";
  const permission = group.settings?.permission ?? "input";
  const downloadMedia = group.settings?.download_media ?? false;
  const displayName = group.name && !group.name.includes("@") ? group.name : group.conversation_id.split("@")[0];

  return (
    <div className={`flex items-center gap-3 py-2.5 hover:bg-gray-50 px-2 -mx-2 rounded transition-colors ${group.is_archived ? "opacity-50" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <span className="text-sm font-medium truncate">{displayName}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{group.platform}</Badge>
          {group.is_archived && <span className="text-[10px] text-gray-400 italic">archived</span>}
        </div>
      </div>

      <MediaButton active={downloadMedia} onClick={() => onUpdate(group.conversation_id, "download_media", !downloadMedia)} />

      <ToggleGroup
        options={PERMISSION_OPTIONS}
        value={permission}
        onChange={(v) => onUpdate(group.conversation_id, "permission", v)}
        colors={PERMISSION_COLORS}
      />

      <ToggleGroup
        options={ROUTING_OPTIONS}
        value={routing}
        onChange={(v) => onUpdate(group.conversation_id, "routing", v)}
        colors={ROUTING_COLORS}
      />
    </div>
  );
}

export function ContactSettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>("people");
  const [people, setPeople] = useState<PersonWithPlatforms[]>([]);
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [groups, setGroups] = useState<GroupWithSettings[]>([]);
  const [search, setSearch] = useState("");
  const [namedOnly, setNamedOnly] = useState(false);
  const [contactPage, setContactPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Track if we've ever loaded from server (vs just cache)
  const serverLoaded = useRef(false);

  // Persist to sessionStorage whenever data changes
  useEffect(() => {
    if (people.length > 0 || contacts.length > 0 || groups.length > 0) {
      saveCache({ people, contacts, groups });
    }
  }, [people, contacts, groups]);

  const refreshFromServer = useCallback(async () => {
    const [p, c, g] = await Promise.all([
      fetchPeopleWithPlatforms(),
      fetchContactsForTab(),
      fetchGroupsWithSettings(),
    ]);
    setPeople(p);
    setContacts(c);
    setGroups(g);
    serverLoaded.current = true;
    setLoading(false);
  }, []);

  // On mount: load from cache instantly, then background refresh
  useEffect(() => {
    const cached = loadCache();
    if (cached && cached.people.length + cached.contacts.length + cached.groups.length > 0) {
      setPeople(cached.people);
      setContacts(cached.contacts);
      setGroups(cached.groups);
      setLoading(false);
      // Background refresh if stale
      if (Date.now() - cached.ts > CACHE_TTL) {
        refreshFromServer();
      } else {
        serverLoaded.current = true;
      }
    } else {
      refreshFromServer();
    }
  }, [refreshFromServer]);

  // Fire-and-forget: update server without blocking UI
  function fireAndForget(fn: () => Promise<unknown>) {
    fn().catch((err) => console.error("[contacts] background save failed:", err));
  }

  function handlePersonUpdate(personId: string, field: string, value: unknown) {
    // Instant optimistic update
    setPeople((prev) => prev.map((p) => {
      if (p.id !== personId) return p;
      const current = p.settings ?? { id: "", target_type: "person" as const, target_id: personId, routing: "batch", permission: "input", download_media: false, display_name: p.name, platform: null, created_at: "", updated_at: "" };
      return { ...p, settings: { ...current, [field]: value } };
    }));

    // Fire and forget server update
    const person = people.find((p) => p.id === personId);
    fireAndForget(() => upsertContactSetting({
      target_type: "person",
      target_id: personId,
      [field]: value,
      display_name: person?.name,
    }));
  }

  function handleContactUpdate(contactId: string, field: string, value: unknown) {
    // Instant optimistic update
    setContacts((prev) => prev.map((c) => {
      if (c.contactId !== contactId) return c;
      const current = c.settings ?? { id: "", target_type: "person" as const, target_id: c.personId ?? "", routing: "batch", permission: "input", download_media: false, display_name: c.displayName, platform: c.platform, created_at: "", updated_at: "" };
      return { ...c, settings: { ...current, [field]: value } };
    }));

    const contact = contacts.find((c) => c.contactId === contactId);
    if (!contact) return;

    if (contact.personId) {
      fireAndForget(() => upsertContactSetting({
        target_type: "person",
        target_id: contact.personId!,
        [field]: value,
        display_name: contact.displayName ?? undefined,
        platform: contact.platform,
      }));
    } else {
      // No person yet — create stub (this one we need to await for the personId)
      const name = contact.displayName || contact.phoneNumber || contact.platformId.split("@")[0];
      fireAndForget(async () => {
        const newPersonId = await createStubAndSaveSetting(contactId, name, contact.platform, field, value);
        if (newPersonId) {
          setContacts((prev) => prev.map((c) =>
            c.contactId === contactId ? { ...c, personId: newPersonId } : c
          ));
        }
      });
    }
  }

  function handleUnlink(contactId: string) {
    // Optimistic: remove the platform from the person
    setPeople((prev) => prev.map((p) => ({
      ...p,
      platforms: p.platforms.filter((pl) => pl.contactId !== contactId),
    })).filter((p) => p.platforms.length > 0));

    fireAndForget(async () => {
      await unlinkContactFromPerson(contactId);
      // Background refresh to get the contact back in Contacts tab
      refreshFromServer();
    });
  }

  function handlePromote(contactId: string) {
    const contact = contacts.find((c) => c.contactId === contactId);
    if (!contact) return;

    // Optimistic: remove from contacts list immediately
    setContacts((prev) => prev.filter((c) => c.contactId !== contactId));

    fireAndForget(async () => {
      let personId = contact.personId;
      if (!personId) {
        const name = contact.displayName || contact.phoneNumber || contact.platformId.split("@")[0];
        personId = await createStubAndSaveSetting(contactId, name, contact.platform, "routing", "batch");
      }
      if (personId) {
        const name = contact.displayName || contact.phoneNumber || contact.platformId.split("@")[0];
        await promoteContact(personId, name);
        // Background refresh to get the person in People tab
        refreshFromServer();
      }
    });
  }

  function handleGroupUpdate(conversationId: string, field: string, value: unknown) {
    setGroups((prev) => prev.map((g) => {
      if (g.conversation_id !== conversationId) return g;
      const current = g.settings ?? { id: "", target_type: "group" as const, target_id: conversationId, routing: "batch", permission: "input", download_media: false, display_name: g.name, platform: g.platform, created_at: "", updated_at: "" };
      return { ...g, settings: { ...current, [field]: value } };
    }));

    const group = groups.find((g) => g.conversation_id === conversationId);
    fireAndForget(() => upsertContactSetting({
      target_type: "group",
      target_id: conversationId,
      [field]: value,
      display_name: group?.name ?? undefined,
      platform: group?.platform,
    }));
  }

  function handleLinked() {
    // After linking, refresh to move contact to People tab
    refreshFromServer();
  }

  const searchLower = search.toLowerCase();
  const filteredPeople = people.filter((p) =>
    !search || p.name.toLowerCase().includes(searchLower) ||
    p.platforms.some((pl) => pl.display_name?.toLowerCase().includes(searchLower))
  );
  const filteredContacts = contacts.filter((c) => {
    if (namedOnly) {
      if (!c.displayName) return false;
      // Exclude names that are just phone numbers, WhatsApp JIDs, or platform IDs
      if (/^[\d+\s()-]+$/.test(c.displayName)) return false;
      if (c.displayName.includes("@s.whatsapp.net") || c.displayName.includes("@lid") || c.displayName.includes("@g.us")) return false;
    }
    if (!search) return true;
    return c.displayName?.toLowerCase().includes(searchLower) ||
      c.phoneNumber?.toLowerCase().includes(searchLower) ||
      c.platformId.toLowerCase().includes(searchLower);
  });
  const CONTACTS_PAGE_SIZE = 50;
  const contactTotalPages = Math.max(1, Math.ceil(filteredContacts.length / CONTACTS_PAGE_SIZE));
  const pagedContacts = filteredContacts.slice((contactPage - 1) * CONTACTS_PAGE_SIZE, contactPage * CONTACTS_PAGE_SIZE);
  const filteredGroups = groups.filter((g) =>
    !search || (g.name?.toLowerCase().includes(searchLower)) ||
    g.conversation_id.toLowerCase().includes(searchLower)
  );

  const tabs: { id: TabId; label: string; count: number; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "people", label: "People", count: people.length, icon: User },
    { id: "contacts", label: "Contacts", count: filteredContacts.length, icon: UserPlus },
    { id: "groups", label: "Groups", count: groups.length, icon: MessageSquare },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Contacts & Routing</h1>
          <p className="text-sm text-gray-500 mt-1">Control how messages are routed, who the agent can reply to, and media download</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => { setLoading(true); refreshFromServer(); }} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-4">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              <span className="text-xs text-gray-400">({tab.count})</span>
            </button>
          );
        })}
      </div>

      {/* Search + Auto-match */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setContactPage(1); }}
            placeholder={
              activeTab === "people" ? "Search people..." :
              activeTab === "contacts" ? "Search contacts..." :
              "Search groups..."
            }
            className="pl-9"
          />
        </div>
        {activeTab === "contacts" && (
          <>
            <button
              onClick={() => { setNamedOnly(!namedOnly); setContactPage(1); }}
              className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors cursor-pointer shrink-0 ${
                namedOnly
                  ? "bg-gray-100 text-gray-800 border-gray-300"
                  : "text-gray-400 hover:text-gray-600 border-gray-200"
              }`}
            >
              Named only
            </button>
            <AutoMatchPanel onDone={refreshFromServer} />
          </>
        )}
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-2 mb-1 text-[10px] text-gray-400 uppercase tracking-wide">
        <div className="flex-1">Name</div>
        {activeTab === "contacts" && <div className="w-8 text-center" title="Link to KB person">Link</div>}
        {activeTab === "contacts" && <div className="w-8 text-center" title="Promote to full person">Up</div>}
        <div className="w-8 text-center">Media</div>
        <div className="w-[140px] text-center">Permission</div>
        <div className="w-[185px] text-center">Routing</div>
      </div>

      {/* Content */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        {activeTab === "people" && (
          filteredPeople.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">
              {loading ? "Loading..." : people.length === 0 ? "No people with linked contacts" : "No matches"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filteredPeople.map((p) => (
                <PersonRow key={p.id} person={p} onUpdate={handlePersonUpdate} onUnlink={handleUnlink} />
              ))}
            </div>
          )
        )}

        {activeTab === "contacts" && (
          filteredContacts.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">
              {loading ? "Loading..." : contacts.length === 0 ? "No unlinked contacts" : "No matches"}
            </p>
          ) : (
            <>
              <div className="divide-y divide-gray-50">
                {pagedContacts.map((c) => (
                  <ContactRow key={c.contactId} contact={c} onUpdate={handleContactUpdate} onPromote={handlePromote} onLinked={handleLinked} />
                ))}
              </div>
              {contactTotalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
                  <span className="text-xs text-gray-400">
                    {(contactPage - 1) * CONTACTS_PAGE_SIZE + 1}–{Math.min(contactPage * CONTACTS_PAGE_SIZE, filteredContacts.length)} of {filteredContacts.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => setContactPage((p) => Math.max(1, p - 1))} disabled={contactPage <= 1} className="h-7 w-7 p-0">
                      &lt;
                    </Button>
                    <span className="text-xs text-gray-500 px-2">Page {contactPage} of {contactTotalPages}</span>
                    <Button variant="outline" size="sm" onClick={() => setContactPage((p) => Math.min(contactTotalPages, p + 1))} disabled={contactPage >= contactTotalPages} className="h-7 w-7 p-0">
                      &gt;
                    </Button>
                  </div>
                </div>
              )}
            </>
          )
        )}

        {activeTab === "groups" && (
          filteredGroups.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">
              {loading ? "Loading..." : groups.length === 0 ? "No groups found" : "No matches"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filteredGroups.map((g) => (
                <GroupRow key={g.conversation_id} group={g} onUpdate={handleGroupUpdate} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
