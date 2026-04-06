"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Search, Users, MessageSquare, User, Camera, CameraOff } from "lucide-react";
import {
  fetchPeopleWithPlatforms,
  fetchGroupsWithSettings,
  upsertContactSetting,
  type PersonWithPlatforms,
  type GroupWithSettings,
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

type TabId = "people" | "groups";

function ToggleGroup({
  options,
  value,
  onChange,
  colors,
  disabled,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  colors: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => { if (!disabled) onChange(opt); }}
          disabled={disabled}
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

function PersonRow({
  person,
  onUpdate,
  isPending,
}: {
  person: PersonWithPlatforms;
  onUpdate: (targetId: string, field: string, value: unknown) => void;
  isPending: boolean;
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
              <span key={i} className="text-[10px] text-gray-400">
                {p.platform}: {p.display_name || p.platform_id.split("@")[0]}
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() => onUpdate(person.id, "download_media", !downloadMedia)}
        disabled={isPending}
        title={downloadMedia ? "Media: downloading" : "Media: not downloading"}
        className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
          downloadMedia ? "text-blue-500 bg-blue-50" : "text-gray-300 hover:text-gray-500"
        }`}
      >
        {downloadMedia ? <Camera className="h-3.5 w-3.5" /> : <CameraOff className="h-3.5 w-3.5" />}
      </button>

      <ToggleGroup
        options={PERMISSION_OPTIONS}
        value={permission}
        onChange={(v) => onUpdate(person.id, "permission", v)}
        colors={PERMISSION_COLORS}
        disabled={isPending}
      />

      <ToggleGroup
        options={ROUTING_OPTIONS}
        value={routing}
        onChange={(v) => onUpdate(person.id, "routing", v)}
        colors={ROUTING_COLORS}
        disabled={isPending}
      />
    </div>
  );
}

function GroupRow({
  group,
  onUpdate,
  isPending,
}: {
  group: GroupWithSettings;
  onUpdate: (targetId: string, field: string, value: unknown) => void;
  isPending: boolean;
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

      <button
        onClick={() => onUpdate(group.conversation_id, "download_media", !downloadMedia)}
        disabled={isPending}
        className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
          downloadMedia ? "text-blue-500 bg-blue-50" : "text-gray-300 hover:text-gray-500"
        }`}
      >
        {downloadMedia ? <Camera className="h-3.5 w-3.5" /> : <CameraOff className="h-3.5 w-3.5" />}
      </button>

      <ToggleGroup
        options={PERMISSION_OPTIONS}
        value={permission}
        onChange={(v) => onUpdate(group.conversation_id, "permission", v)}
        colors={PERMISSION_COLORS}
        disabled={isPending}
      />

      <ToggleGroup
        options={ROUTING_OPTIONS}
        value={routing}
        onChange={(v) => onUpdate(group.conversation_id, "routing", v)}
        colors={ROUTING_COLORS}
        disabled={isPending}
      />
    </div>
  );
}

export function ContactSettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>("people");
  const [people, setPeople] = useState<PersonWithPlatforms[]>([]);
  const [groups, setGroups] = useState<GroupWithSettings[]>([]);
  const [search, setSearch] = useState("");
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const [p, g] = await Promise.all([
        fetchPeopleWithPlatforms(),
        fetchGroupsWithSettings(),
      ]);
      setPeople(p);
      setGroups(g);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  function handlePersonUpdate(personId: string, field: string, value: unknown) {
    // Optimistic update
    setPeople((prev) => prev.map((p) => {
      if (p.id !== personId) return p;
      const current = p.settings ?? { id: "", target_type: "person" as const, target_id: personId, routing: "batch", permission: "input", download_media: false, display_name: p.name, platform: null, created_at: "", updated_at: "" };
      return { ...p, settings: { ...current, [field]: value } };
    }));

    startTransition(async () => {
      const person = people.find((p) => p.id === personId);
      await upsertContactSetting({
        target_type: "person",
        target_id: personId,
        [field]: value,
        display_name: person?.name,
      });
    });
  }

  function handleGroupUpdate(conversationId: string, field: string, value: unknown) {
    setGroups((prev) => prev.map((g) => {
      if (g.conversation_id !== conversationId) return g;
      const current = g.settings ?? { id: "", target_type: "group" as const, target_id: conversationId, routing: "batch", permission: "input", download_media: false, display_name: g.name, platform: g.platform, created_at: "", updated_at: "" };
      return { ...g, settings: { ...current, [field]: value } };
    }));

    startTransition(async () => {
      const group = groups.find((g) => g.conversation_id === conversationId);
      await upsertContactSetting({
        target_type: "group",
        target_id: conversationId,
        [field]: value,
        display_name: group?.name ?? undefined,
        platform: group?.platform,
      });
    });
  }

  const searchLower = search.toLowerCase();
  const filteredPeople = people.filter((p) =>
    !search || p.name.toLowerCase().includes(searchLower) ||
    p.platforms.some((pl) => pl.display_name?.toLowerCase().includes(searchLower))
  );
  const filteredGroups = groups.filter((g) =>
    !search || (g.name?.toLowerCase().includes(searchLower)) ||
    g.conversation_id.toLowerCase().includes(searchLower)
  );

  const tabs: { id: TabId; label: string; count: number; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "people", label: "People", count: people.length, icon: User },
    { id: "groups", label: "Groups", count: groups.length, icon: MessageSquare },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Contacts & Routing</h1>
          <p className="text-sm text-gray-500 mt-1">Control how messages are routed, who the agent can reply to, and media download</p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
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

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={activeTab === "people" ? "Search people..." : "Search groups..."}
          className="pl-9"
        />
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-2 mb-1 text-[10px] text-gray-400 uppercase tracking-wide">
        <div className="flex-1">Name</div>
        <div className="w-8 text-center">Media</div>
        <div className="w-[140px] text-center">Permission</div>
        <div className="w-[185px] text-center">Routing</div>
      </div>

      {/* Content */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        {activeTab === "people" && (
          filteredPeople.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">
              {isPending ? "Loading..." : people.length === 0 ? "No people in your knowledge base yet" : "No matches"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filteredPeople.map((p) => (
                <PersonRow key={p.id} person={p} onUpdate={handlePersonUpdate} isPending={isPending} />
              ))}
            </div>
          )
        )}

        {activeTab === "groups" && (
          filteredGroups.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">
              {isPending ? "Loading..." : groups.length === 0 ? "No groups found" : "No matches"}
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filteredGroups.map((g) => (
                <GroupRow key={g.conversation_id} group={g} onUpdate={handleGroupUpdate} isPending={isPending} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
