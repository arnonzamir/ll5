# UI Design

Two web interfaces for the LL5 system: a user dashboard for daily GTD use, and an admin panel for system management.

---

## Tech Stack

| Choice | What | Why |
|--------|------|-----|
| Framework | Next.js 15 (App Router) | The mcp-dashboard already uses this, proven pattern |
| Styling | Tailwind CSS 4 | Same as existing dashboard |
| Components | shadcn/ui (Radix primitives) | Pre-built, accessible, Tailwind-native |
| State | TanStack React Query | Data fetching + cache + optimistic updates |
| Icons | Lucide React | Consistent with existing projects |
| Auth | Token-based (LL5 auth tokens) | Stored in cookie, validated per request |

Single Next.js app with two route groups: `/(user)` and `/(admin)`.

---

## Architecture

The UI does NOT call MCPs directly. MCPs use the MCP protocol (StreamableHTTP), not REST. The UI needs a thin API layer.

### Option A: Next.js API routes as MCP client

```
Browser → Next.js API route → MCP SDK client → MCP server
```

Each API route creates an MCP client, calls the tool, returns JSON. The Next.js server acts as a proxy that speaks MCP protocol to the backends and REST to the browser.

### Option B: Add REST endpoints to each MCP alongside the MCP endpoint

Each MCP already has Express. Add REST routes that call the same repository layer.

### Recommendation: Option A

Keep MCPs pure (MCP protocol only). The UI's API layer is a thin adapter — if the MCP tools change, only the API routes change, not the MCP servers. And the UI can call multiple MCPs in a single API route (e.g., dashboard page needs data from gtd + awareness + personal-knowledge).

---

## Auth in the UI

1. User visits the app → login page
2. Enters user_id + PIN → calls gateway's `/auth/token`
3. Token stored in httpOnly cookie
4. Every API route reads the cookie, includes token in MCP calls
5. Token expiry → redirect to login

Admin users: same flow, but the `auth_users` table gets a `role` column (`user` | `admin`). Token payload includes role. Admin routes check `role === 'admin'`.

---

## User Dashboard

### Layout

```
┌─────────────────────────────────────────────────┐
│  LL5  [Dashboard] [Actions] [Projects] [Inbox]  │
│       [People] [Places] [Shopping]     [avatar] │
├─────────────────────────────────────────────────┤
│                                                  │
│                  Page Content                    │
│                                                  │
└─────────────────────────────────────────────────┘
```

Top nav bar, no sidebar (simpler than the mcp-dashboard). Mobile-responsive — collapses to hamburger.

### Pages

#### Dashboard (`/`)

The daily snapshot. Quick glance, not information overload.

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Inbox: 4    │  Due Today:3 │  Overdue: 1  │  Waiting: 5  │
│  items       │  actions     │  action      │  items       │
└──────────────┴──────────────┴──────────────┴──────────────┘

┌─── Today's Schedule ──────────────────────────────────────┐
│  09:00  Team standup (Zoom)                               │
│  12:00  Lunch with Dana                                   │
│  15:00  Dentist appointment                               │
└───────────────────────────────────────────────────────────┘

┌─── Active Projects ──────────────────────────────────────┐
│  Kitchen renovation    3 actions    ●                     │
│  Q3 planning          1 action     ●                     │
│  Learn piano          0 actions    ⚠ no next action      │
└───────────────────────────────────────────────────────────┘

┌─── Recent Inbox ─────────────────────────────────────────┐
│  "Call plumber about leak"          [whatsapp] 2h ago     │
│  "Buy birthday present for Dana"   [direct]   5h ago     │
└───────────────────────────────────────────────────────────┘
```

Data sources: `get_gtd_health`, `list_actions` (due today + overdue), `list_projects`, `list_inbox`, `get_calendar_events`

#### Actions (`/actions`)

Filterable list of all actions.

**Filters (top bar):**
- Status: active (default) / completed / all
- List type: todo / shopping / waiting / someday
- Energy: low / medium / high
- Context: @home / @phone / @computer / @office / @errands
- Project: dropdown of active projects

**Table columns:**
- Title (clickable to edit)
- Context tags (badges)
- Energy (dot: green/yellow/red)
- Due date (red if overdue)
- Project (linked)
- Status (checkbox to complete)

**Actions:** + New Action button → inline form or dialog

Data source: `list_actions` with filters

#### Projects (`/projects`)

**List view:**
- Project title
- Active action count (red badge if 0)
- Category
- Status
- Created date

Click → project detail page showing linked actions, with "Add Action" button.

Data source: `list_projects`, `list_actions(project_id=X)`

#### Inbox (`/inbox`)

**Two modes:**

**Capture mode** (default): simple text input at top to quickly capture items. List of captured items below.

**Process mode** (triggered by "Process Inbox" button): one-at-a-time clarify flow, like the /clarify skill but in UI:
- Shows one item
- Buttons: Action / Project / Someday / Reference / Trash
- If Action → inline form for title, context, energy
- If Project → form for project name + first action
- Next item automatically

Data source: `capture_inbox`, `list_inbox`, `process_inbox_item`

#### People (`/people`)

Card grid or list:
- Name + aliases
- Relationship badge (family / friend / colleague)
- Latest entity status (if from awareness MCP)
- Click → detail with facts about this person, contact info

Data source: `list_people`, `get_entity_statuses`

#### Places (`/places`)

List + optional map view:
- Place name, type, address
- Map pin for places with coordinates
- Current location indicator (from awareness)

Data source: `list_places`, `get_current_location`

#### Shopping (`/shopping`)

Simplified view — just the shopping list grouped by category:
- Category headers (produce, dairy, household, etc.)
- Items with checkbox to check off
- Quick add input at top

Data source: `manage_shopping_list(list)`, `manage_shopping_list(add/check_off)`

#### Knowledge (`/knowledge`)

Search-first view. Big search bar at top, results below showing facts, people, places mixed together ranked by relevance.

Data source: `search_knowledge`

#### Horizons (`/horizons`)

Visual hierarchy:
```
PURPOSE (h=5)
  └── VISION (h=4)
       └── GOALS (h=3)
            └── AREAS (h=2)
                 └── PROJECTS (h=1) with action counts
```

Expandable tree or accordion. Each item editable inline.

Data source: `list_horizons` for each level, `list_projects`

---

## Admin Panel

### Layout

Same top nav but with admin-specific links. Different color accent (amber/gold) to visually distinguish from user dashboard.

### Pages

#### System Health (`/admin`)

Real-time health of all services:

```
┌──────────────────┬──────────┬──────────────────┐
│ Service          │ Status   │ Response Time    │
├──────────────────┼──────────┼──────────────────┤
│ personal-knowl.  │ ● healthy│ 45ms             │
│ gtd              │ ● healthy│ 32ms             │
│ awareness        │ ● healthy│ 38ms             │
│ gateway          │ ● healthy│ 28ms             │
│ google           │ ○ not deployed              │
│ messaging        │ ○ not deployed              │
│ elasticsearch    │ ● healthy│ (internal)       │
│ postgresql       │ ● healthy│ (internal)       │
└──────────────────┴──────────┴──────────────────┘
```

Polls `/health` endpoints every 30 seconds.

#### Users (`/admin/users`)

- List all users (from auth_users table)
- Create user: name, user_id (auto-generate), PIN
- Edit: reset PIN, change token TTL, enable/disable
- View: last login, token expiry, active sessions

#### MCP Tools (`/admin/tools`)

List all available tools across all MCPs. Test any tool with a form:
- Select MCP → select tool
- Auto-generated form from tool's input schema
- Execute and show result

Useful for debugging and verifying MCP behavior.

#### Push Data (`/admin/push-data`)

View incoming push data from the gateway:
- Recent GPS locations on a map
- Recent IM messages
- Calendar events
- Entity status extractions
- Notable events

#### Triggers (`/admin/triggers`)

Manage scheduled triggers:
- List current triggers (morning review, weekly review, proactive checks)
- Create/edit/delete triggers
- View trigger execution history

#### Audit Log (`/admin/audit`)

Searchable log of system events:
- Token generations (login events)
- MCP tool calls (which user, which tool, when)
- Errors and failures

---

## Mobile Considerations

The UI should be responsive (Tailwind breakpoints), not a separate mobile app. Key mobile-optimized views:

- **Dashboard**: stacked cards instead of grid
- **Actions**: swipe to complete
- **Inbox capture**: large input at top, one-thumb operation
- **Shopping list**: optimized for supermarket use (large checkboxes, category headers)

The ll4-android app (Kotlin/Compose) handled mobile-specific features like background location tracking and notification capture. In ll5, those run on the phone via Tasker/Shortcuts pushing to the gateway — no native app needed. The web UI just needs to be mobile-friendly.

---

## Deployment

Single Docker container (Next.js standalone build). Added to the Coolify compose:

```yaml
dashboard:
  image: ghcr.io/arnonzamir/ll5-dashboard:latest
  environment:
    MCP_KNOWLEDGE_URL: http://personal-knowledge-xkkcc...:3000
    MCP_GTD_URL: http://gtd-xkkcc...:3000
    MCP_AWARENESS_URL: http://awareness-xkkcc...:3000
    GATEWAY_URL: http://gateway-xkkcc...:3000
    AUTH_SECRET: <shared secret for token validation>
  labels:
    - traefik.http.routers.ll5-dashboard.rule=Host(`ll5.noninoni.click`)
  networks:
    - xkkcc0g4o48kkcows8488so4
    - coolify
```

The dashboard connects to MCPs on the internal network (no public MCP URLs needed from the browser). The browser only talks to the dashboard's Next.js server.

---

## Implementation Order

1. **Scaffold** — Next.js app with Tailwind + shadcn/ui, auth flow (login page + token cookie)
2. **MCP client layer** — API routes that proxy to MCPs
3. **Dashboard page** — GTD health + today's schedule + inbox preview
4. **Actions + Projects** — core GTD views with CRUD
5. **Inbox** — capture + process flow
6. **Admin: System Health** — service monitoring
7. **Admin: Users** — user management
8. **Remaining pages** — people, places, shopping, knowledge, horizons
9. **Admin: Tools, Push Data, Triggers** — operational tools
