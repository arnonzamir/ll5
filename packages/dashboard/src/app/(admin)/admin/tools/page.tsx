"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";

interface ToolDef {
  name: string;
  description: string;
}

interface McpServerDef {
  name: string;
  label: string;
  tools: ToolDef[];
}

const MCP_TOOLS: McpServerDef[] = [
  {
    name: "personal-knowledge",
    label: "Personal Knowledge",
    tools: [
      { name: "get_profile", description: "Retrieve the user's profile" },
      { name: "update_profile", description: "Update profile fields" },
      { name: "search_knowledge", description: "Full-text fuzzy search across facts, people, and places" },
      { name: "list_facts", description: "List facts with optional filters" },
      { name: "get_fact", description: "Retrieve a single fact by ID" },
      { name: "upsert_fact", description: "Create or update a fact" },
      { name: "delete_fact", description: "Delete a fact by ID" },
      { name: "list_people", description: "List people in the user's network" },
      { name: "get_person", description: "Retrieve a single person by ID" },
      { name: "upsert_person", description: "Create or update a person record" },
      { name: "delete_person", description: "Delete a person by ID" },
      { name: "list_places", description: "List places with optional filters" },
      { name: "get_place", description: "Retrieve a single place by ID" },
      { name: "upsert_place", description: "Create or update a place" },
      { name: "delete_place", description: "Delete a place by ID" },
      { name: "list_data_gaps", description: "List known gaps in the knowledge base" },
      { name: "upsert_data_gap", description: "Create or update a data gap" },
    ],
  },
  {
    name: "gtd",
    label: "GTD",
    tools: [
      { name: "create_action", description: "Create a new GTD action" },
      { name: "update_action", description: "Update or complete an action" },
      { name: "list_actions", description: "List actions with flexible filtering" },
      { name: "create_project", description: "Create a new project" },
      { name: "update_project", description: "Update or complete a project" },
      { name: "list_projects", description: "List projects with action counts" },
      { name: "upsert_horizon", description: "Create or update a horizon item (h2-h5)" },
      { name: "list_horizons", description: "List horizon items by level" },
      { name: "capture_inbox", description: "Add a raw item to the inbox" },
      { name: "list_inbox", description: "List inbox items by status" },
      { name: "process_inbox_item", description: "Mark an inbox item as processed" },
      { name: "manage_shopping_list", description: "Add, remove, check off, or list shopping items" },
      { name: "recommend_actions", description: "Get ranked action recommendations" },
      { name: "get_gtd_health", description: "GTD system health metrics" },
    ],
  },
  {
    name: "awareness",
    label: "Awareness",
    tools: [
      { name: "get_current_location", description: "Latest GPS fix with place matching" },
      { name: "query_location_history", description: "GPS history over a time range" },
      { name: "query_im_messages", description: "Search IM notifications by sender, app, or keyword" },
      { name: "get_entity_statuses", description: "Current statuses of tracked entities" },
      { name: "get_calendar_events", description: "Upcoming or recent calendar events" },
      { name: "get_situation", description: "Combined situational context snapshot" },
      { name: "get_notable_events", description: "Unacknowledged notable events" },
      { name: "acknowledge_events", description: "Mark notable events as acknowledged" },
    ],
  },
];

export default function ToolsPage() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "personal-knowledge": true,
    gtd: true,
    awareness: true,
  });

  function toggle(name: string) {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">MCP Tools</h1>
      <p className="text-sm text-gray-500">
        Reference listing of all available MCP tools across servers.
      </p>

      <div className="space-y-4">
        {MCP_TOOLS.map((server) => (
          <Card key={server.name}>
            <CardHeader
              className="cursor-pointer select-none"
              onClick={() => toggle(server.name)}
            >
              <CardTitle className="text-base flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-gray-400" />
                  <span>{server.label}</span>
                  <Badge variant="secondary" className="text-xs">
                    {server.tools.length} tools
                  </Badge>
                </div>
                {expanded[server.name] ? (
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                )}
              </CardTitle>
            </CardHeader>
            {expanded[server.name] && (
              <CardContent>
                <div className="space-y-2">
                  {server.tools.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0"
                    >
                      <code className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded shrink-0">
                        {tool.name}
                      </code>
                      <span className="text-sm text-gray-600">
                        {tool.description}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
