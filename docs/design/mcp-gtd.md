# MCP: gtd

**Domain:** Getting Things Done -- actions, projects, horizons 0-5, inbox, shopping list, review sessions.
**Storage:** PostgreSQL (relational queries, ACID, precise state transitions)
**Transport:** HTTP+SSE (remote deployment)

## Purpose

The full GTD system. Actions (h=0) link to projects (h=1) which link to areas (h=2). Higher horizons (h=3 goals, h=4 vision, h=5 purpose) provide strategic context. The inbox captures raw input for later processing. Reviews are tracked to maintain system health. Shopping list is a convenience layer over actions with `list_type=shopping`.

This MCP is self-contained. It does not call other MCPs.

---

## Data Model Overview

```
h=5  Purpose / Principles
h=4  Vision
h=3  Goals (3-5 year)
h=2  Areas of Focus & Responsibility
h=1  Projects (multi-step outcomes)       <- area_id -> h=2
h=0  Actions (single next-actions)        <- project_id -> h=1
```

All horizons 0-5 live in a single `gtd_horizons` table. `project_id` links h=0 to h=1. `area_id` links h=1 to h=2. Both are self-referential foreign keys.

---

## Tools

### Actions (Horizon 0)

#### create_action

Create a new action (h=0 item).

| Parameter     | Type     | Required | Description                                                  |
|---------------|----------|----------|--------------------------------------------------------------|
| title         | string   | yes      | Action title                                                 |
| description   | string   | no       | Detailed description                                         |
| energy        | string   | no       | Required energy: `low`, `medium`, `high`. Default: `medium`. |
| context       | string[] | no       | Context tags (e.g. `["@home", "@computer", "@phone"]`)       |
| list_type     | string   | no       | `todo`, `shopping`, `waiting`, `someday`. Default: `todo`.   |
| due_date      | string   | no       | ISO 8601 date (YYYY-MM-DD)                                   |
| start_date    | string   | no       | ISO 8601 date -- don't show before this date                 |
| project_id    | string   | no       | Link to parent project (h=1 horizon ID)                      |
| waiting_for   | string   | no       | Who/what we're waiting on (when list_type=waiting)            |
| time_estimate | number   | no       | Estimated minutes to complete                                 |
| category      | string   | no       | Free-text category (e.g. "errands", "work", "health")        |

**Returns:**

```json
{
  "action": {
    "id": "string (UUID)",
    "user_id": "string",
    "horizon": 0,
    "title": "string",
    "description": "string | null",
    "status": "active",
    "energy": "low | medium | high",
    "context": "string[]",
    "list_type": "todo | shopping | waiting | someday",
    "due_date": "string | null",
    "start_date": "string | null",
    "project_id": "string | null",
    "waiting_for": "string | null",
    "time_estimate": "number | null",
    "category": "string | null",
    "completed_at": "null",
    "created_at": "string (ISO 8601)",
    "updated_at": "string (ISO 8601)"
  }
}
```

#### update_action

Update an existing action. Can modify any field or mark it complete. Lookup by ID or title search.

| Parameter     | Type     | Required | Description                                                  |
|---------------|----------|----------|--------------------------------------------------------------|
| id            | string   | no       | Action ID. Required if title_search not provided.            |
| title_search  | string   | no       | Find action by title substring (must match exactly one). Required if id not provided. |
| title         | string   | no       | New title                                                    |
| description   | string   | no       | New description                                              |
| status        | string   | no       | `active`, `completed`, `dropped`                             |
| energy        | string   | no       | `low`, `medium`, `high`                                      |
| context       | string[] | no       | Replace context tags                                         |
| list_type     | string   | no       | `todo`, `shopping`, `waiting`, `someday`                     |
| due_date      | string   | no       | ISO 8601 date or `null` to clear                             |
| start_date    | string   | no       | ISO 8601 date or `null` to clear                             |
| project_id    | string   | no       | Link to project or `null` to unlink                          |
| waiting_for   | string   | no       | Who/what or `null` to clear                                  |
| time_estimate | number   | no       | Minutes or `null` to clear                                   |
| category      | string   | no       | Category or `null` to clear                                  |

**Returns:**

```json
{
  "action": { "...updated action object" }
}
```

#### list_actions

List actions with flexible filtering. Returns actions with their linked project title.

| Parameter   | Type     | Required | Description                                                    |
|-------------|----------|----------|----------------------------------------------------------------|
| status      | string   | no       | `active`, `completed`, `dropped`. Default: `active`.           |
| list_type   | string   | no       | `todo`, `shopping`, `waiting`, `someday`                       |
| energy      | string   | no       | `low`, `medium`, `high`                                        |
| context     | string[] | no       | Filter actions that have ANY of these context tags             |
| category    | string   | no       | Filter by category                                             |
| project_id  | string   | no       | Filter by linked project                                       |
| due_before  | string   | no       | ISO 8601 date -- actions due on or before this date            |
| due_after   | string   | no       | ISO 8601 date -- actions due on or after this date             |
| overdue     | boolean  | no       | If true, only return actions past due_date and still active    |
| query       | string   | no       | Free-text search in title and description                      |
| limit       | number   | no       | Max results. Default: 50. Max: 200.                            |
| offset      | number   | no       | Pagination offset. Default: 0.                                 |

**Returns:**

```json
{
  "actions": [
    {
      "...action object",
      "project_title": "string | null"
    }
  ],
  "total": "number"
}
```

---

### Projects (Horizon 1)

#### create_project

Create a new project (h=1 item).

| Parameter   | Type   | Required | Description                                          |
|-------------|--------|----------|------------------------------------------------------|
| title       | string | yes      | Project title (desired outcome)                      |
| description | string | no       | Project description and notes                        |
| category    | string | no       | Free-text category                                   |
| area_id     | string | no       | Link to parent area (h=2 horizon ID)                 |
| due_date    | string | no       | ISO 8601 date target completion                      |
| status      | string | no       | `active`, `completed`, `on_hold`, `dropped`. Default: `active`. |

**Returns:**

```json
{
  "project": {
    "id": "string (UUID)",
    "user_id": "string",
    "horizon": 1,
    "title": "string",
    "description": "string | null",
    "category": "string | null",
    "area_id": "string | null",
    "due_date": "string | null",
    "status": "active | completed | on_hold | dropped",
    "completed_at": "string | null",
    "created_at": "string (ISO 8601)",
    "updated_at": "string (ISO 8601)"
  }
}
```

#### update_project

Update or complete a project.

| Parameter   | Type   | Required | Description                                              |
|-------------|--------|----------|----------------------------------------------------------|
| id          | string | yes      | Project ID                                               |
| title       | string | no       | New title                                                |
| description | string | no       | New description                                          |
| category    | string | no       | New category or `null` to clear                          |
| area_id     | string | no       | Link to area or `null` to unlink                         |
| due_date    | string | no       | ISO 8601 date or `null` to clear                         |
| status      | string | no       | `active`, `completed`, `on_hold`, `dropped`              |

**Returns:**

```json
{
  "project": { "...updated project object" }
}
```

#### list_projects

List projects. Includes count of active actions per project. Flags projects with zero active actions.

| Parameter | Type   | Required | Description                                                          |
|-----------|--------|----------|----------------------------------------------------------------------|
| status    | string | no       | `active`, `completed`, `on_hold`, `dropped`. Default: `active`.      |
| category  | string | no       | Filter by category                                                   |
| area_id   | string | no       | Filter by parent area                                                |
| query     | string | no       | Free-text search in title and description                            |
| limit     | number | no       | Max results. Default: 50. Max: 200.                                  |
| offset    | number | no       | Pagination offset. Default: 0.                                       |

**Returns:**

```json
{
  "projects": [
    {
      "...project object",
      "active_action_count": "number",
      "has_no_actions": "boolean (true if active_action_count == 0 and status == active)"
    }
  ],
  "total": "number"
}
```

---

### Horizons 2-5

#### upsert_horizon

Create or update a horizon item (h=2 areas, h=3 goals, h=4 vision, h=5 purpose).

| Parameter   | Type   | Required        | Description                                          |
|-------------|--------|-----------------|------------------------------------------------------|
| id          | string | no              | Horizon ID to update. Omit to create new.            |
| horizon     | number | yes (on create) | Horizon level: `2`, `3`, `4`, or `5`                 |
| title       | string | yes (on create) | Title                                                |
| description | string | no              | Detailed description                                 |
| status      | string | no              | `active`, `completed`, `on_hold`, `dropped`. Default: `active`. |

**Returns:**

```json
{
  "horizon_item": {
    "id": "string (UUID)",
    "user_id": "string",
    "horizon": "number (2-5)",
    "title": "string",
    "description": "string | null",
    "status": "string",
    "created_at": "string (ISO 8601)",
    "updated_at": "string (ISO 8601)"
  },
  "created": "boolean"
}
```

#### list_horizons

List horizon items filtered by level and status. For h=2 (areas), includes linked project counts.

| Parameter | Type   | Required | Description                                                    |
|-----------|--------|----------|----------------------------------------------------------------|
| horizon   | number | yes      | Horizon level: `2`, `3`, `4`, or `5`                           |
| status    | string | no       | `active`, `completed`, `on_hold`, `dropped`. Default: `active`.|
| query     | string | no       | Free-text search in title and description                      |
| limit     | number | no       | Max results. Default: 50.                                      |
| offset    | number | no       | Pagination offset. Default: 0.                                 |

**Returns:**

```json
{
  "horizons": [
    {
      "...horizon_item object",
      "active_project_count": "number (only for h=2)"
    }
  ],
  "total": "number"
}
```

---

### Inbox

#### capture_inbox

Add a raw item to the inbox for later processing.

| Parameter   | Type   | Required | Description                                       |
|-------------|--------|----------|---------------------------------------------------|
| content     | string | yes      | Raw captured content                              |
| source      | string | no       | Where this came from (e.g. "conversation", "email", "voice") |
| source_link | string | no       | URL or reference to the source                    |

**Returns:**

```json
{
  "inbox_item": {
    "id": "string (UUID)",
    "user_id": "string",
    "content": "string",
    "source": "string | null",
    "source_link": "string | null",
    "status": "captured",
    "outcome_type": "null",
    "created_at": "string (ISO 8601)",
    "updated_at": "string (ISO 8601)"
  }
}
```

#### list_inbox

List inbox items filtered by processing status.

| Parameter | Type   | Required | Description                                                      |
|-----------|--------|----------|------------------------------------------------------------------|
| status    | string | no       | `captured`, `reviewed`, `processed`. Default: `captured`.        |
| limit     | number | no       | Max results. Default: 50.                                        |
| offset    | number | no       | Pagination offset. Default: 0.                                   |

**Returns:**

```json
{
  "inbox_items": [
    { "...inbox_item object" }
  ],
  "total": "number"
}
```

#### process_inbox_item

Mark an inbox item as processed with an outcome.

| Parameter    | Type   | Required | Description                                               |
|--------------|--------|----------|-----------------------------------------------------------|
| id           | string | yes      | Inbox item ID                                             |
| outcome_type | string | yes      | `action`, `project`, `someday`, `reference`, `trash`      |
| outcome_id   | string | no       | ID of the created action/project, if applicable           |
| notes        | string | no       | Processing notes                                          |

**Returns:**

```json
{
  "inbox_item": {
    "...inbox_item object",
    "status": "processed",
    "outcome_type": "string",
    "outcome_id": "string | null",
    "notes": "string | null",
    "processed_at": "string (ISO 8601)"
  }
}
```

---

### Shopping List

#### manage_shopping_list

Convenience tool for managing shopping items (actions with `list_type=shopping`). Supports multiple operations.

| Parameter | Type   | Required | Description                                                |
|-----------|--------|----------|------------------------------------------------------------|
| action    | string | yes      | Operation: `add`, `remove`, `check_off`, `list`           |
| title     | string | conditional | Item name. Required for `add`, `remove`, `check_off`.  |
| category  | string | no       | Item category (e.g. "produce", "dairy", "household"). Used by `add` and `list`. |
| quantity  | string | no       | Quantity note (e.g. "2 bags", "500g"). Used by `add`.      |

**Returns (for `list`):**

```json
{
  "shopping_list": {
    "groups": [
      {
        "category": "string",
        "items": [
          {
            "id": "string",
            "title": "string",
            "quantity": "string | null",
            "status": "active | completed"
          }
        ]
      }
    ],
    "total_items": "number",
    "checked_off": "number"
  }
}
```

**Returns (for `add`, `remove`, `check_off`):**

```json
{
  "success": true,
  "item": { "...action object" }
}
```

---

### Smart Recommendations

#### recommend_actions

Given current conditions, return ranked action recommendations grouped by depth.

| Parameter      | Type     | Required | Description                                            |
|----------------|----------|----------|--------------------------------------------------------|
| energy         | string   | no       | Current energy level: `low`, `medium`, `high`          |
| time_available | number   | no       | Available minutes                                      |
| context_tags   | string[] | no       | Current context tags (e.g. `["@home", "@computer"]`)   |
| limit          | number   | no       | Max actions per group. Default: 5.                     |

**Returns:**

```json
{
  "recommendations": {
    "quick": [
      {
        "...action object",
        "project_title": "string | null",
        "score": "number (relevance score)"
      }
    ],
    "medium": [ "...same structure" ],
    "deep": [ "...same structure" ]
  },
  "criteria_used": {
    "energy": "string | null",
    "time_available": "number | null",
    "context_tags": "string[]"
  }
}
```

Ranking logic:
- **quick**: `time_estimate <= 15` or `null` with `energy=low`
- **medium**: `time_estimate` between 15 and 60
- **deep**: `time_estimate > 60` or `energy=high` tasks
- Within each group, prioritize: overdue > has due_date > context match > no due_date
- Filter out actions with `start_date` in the future
- Filter by energy if provided (allow equal or lower energy)
- Filter by context if provided (action must match at least one tag)

---

### System Health

#### get_gtd_health

Return a summary of GTD system health metrics for review.

| Parameter | Type | Required | Description          |
|-----------|------|----------|----------------------|
| -         | -    | -        | No parameters needed |

**Returns:**

```json
{
  "health": {
    "inbox_count": "number (unprocessed items)",
    "projects_without_actions": "number (active projects with 0 active actions)",
    "overdue_count": "number (active actions past due_date)",
    "stale_waiting_count": "number (waiting items not updated in 7+ days)",
    "days_since_last_review": "number | null (null if no reviews recorded)",
    "active_project_count": "number",
    "active_action_count": "number",
    "someday_count": "number (list_type=someday items)",
    "completed_this_week": "number (actions completed in last 7 days)"
  }
}
```

---

## Storage

### Tables

#### gtd_horizons

Unified table for all GTD levels (h=0 through h=5).

```sql
CREATE TABLE gtd_horizons (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    horizon         SMALLINT NOT NULL CHECK (horizon BETWEEN 0 AND 5),
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'on_hold', 'dropped')),

    -- h=0 (actions) specific
    energy          TEXT CHECK (energy IN ('low', 'medium', 'high')),
    context         TEXT[] DEFAULT '{}',
    list_type       TEXT CHECK (list_type IN ('todo', 'shopping', 'waiting', 'someday')),
    due_date        DATE,
    start_date      DATE,
    project_id      UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
    area_id         UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
    waiting_for     TEXT,
    time_estimate   INTEGER,
    category        TEXT,

    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### gtd_inbox

```sql
CREATE TABLE gtd_inbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    content         TEXT NOT NULL,
    source          TEXT,
    source_link     TEXT,
    status          TEXT NOT NULL DEFAULT 'captured'
                      CHECK (status IN ('captured', 'reviewed', 'processed')),
    outcome_type    TEXT CHECK (outcome_type IN ('action', 'project', 'someday', 'reference', 'trash')),
    outcome_id      UUID,
    notes           TEXT,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### gtd_review_sessions

```sql
CREATE TABLE gtd_review_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    review_type     TEXT NOT NULL CHECK (review_type IN ('weekly', 'monthly', 'annual')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    notes           TEXT,
    health_snapshot JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Indices

```sql
-- gtd_horizons
CREATE INDEX idx_horizons_user_status ON gtd_horizons(user_id, status);
CREATE INDEX idx_horizons_user_horizon ON gtd_horizons(user_id, horizon);
CREATE INDEX idx_horizons_project ON gtd_horizons(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_horizons_area ON gtd_horizons(area_id) WHERE area_id IS NOT NULL;
CREATE INDEX idx_horizons_due_date ON gtd_horizons(user_id, due_date) WHERE due_date IS NOT NULL AND status = 'active';
CREATE INDEX idx_horizons_list_type ON gtd_horizons(user_id, list_type) WHERE horizon = 0;
CREATE INDEX idx_horizons_context ON gtd_horizons USING GIN(context) WHERE horizon = 0;

-- gtd_inbox
CREATE INDEX idx_inbox_user_status ON gtd_inbox(user_id, status);

-- gtd_review_sessions
CREATE INDEX idx_reviews_user ON gtd_review_sessions(user_id, started_at DESC);
```

---

## Repository Interfaces

```typescript
interface PaginationParams {
  limit?: number;
  offset?: number;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
}

interface HorizonRepository {
  // Actions (h=0)
  createAction(userId: string, data: CreateActionInput): Promise<Action>;
  updateAction(userId: string, id: string, data: UpdateActionInput): Promise<Action>;
  findActionByTitle(userId: string, titleSearch: string): Promise<Action | null>;
  listActions(userId: string, filters: ActionFilters & PaginationParams): Promise<PaginatedResult<ActionWithProject>>;

  // Projects (h=1)
  createProject(userId: string, data: CreateProjectInput): Promise<Project>;
  updateProject(userId: string, id: string, data: UpdateProjectInput): Promise<Project>;
  listProjects(userId: string, filters: ProjectFilters & PaginationParams): Promise<PaginatedResult<ProjectWithCounts>>;

  // Horizons 2-5
  upsertHorizon(userId: string, data: UpsertHorizonInput): Promise<{ item: HorizonItem; created: boolean }>;
  listHorizons(userId: string, filters: HorizonFilters & PaginationParams): Promise<PaginatedResult<HorizonItemWithCounts>>;

  // Health
  getHealth(userId: string): Promise<GtdHealth>;

  // Recommendations
  recommendActions(userId: string, criteria: RecommendCriteria): Promise<RecommendResult>;
}

interface InboxRepository {
  capture(userId: string, data: CaptureInboxInput): Promise<InboxItem>;
  list(userId: string, filters: InboxFilters & PaginationParams): Promise<PaginatedResult<InboxItem>>;
  process(userId: string, id: string, data: ProcessInboxInput): Promise<InboxItem>;
}

interface ReviewSessionRepository {
  create(userId: string, data: CreateReviewInput): Promise<ReviewSession>;
  getLatest(userId: string, reviewType?: ReviewType): Promise<ReviewSession | null>;
  complete(userId: string, id: string, notes?: string): Promise<ReviewSession>;
}
```

### Filter Types

```typescript
interface ActionFilters {
  status?: 'active' | 'completed' | 'dropped';
  listType?: 'todo' | 'shopping' | 'waiting' | 'someday';
  energy?: 'low' | 'medium' | 'high';
  context?: string[];
  category?: string;
  projectId?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  query?: string;
}

interface ProjectFilters {
  status?: 'active' | 'completed' | 'on_hold' | 'dropped';
  category?: string;
  areaId?: string;
  query?: string;
}

interface HorizonFilters {
  horizon: 2 | 3 | 4 | 5;
  status?: 'active' | 'completed' | 'on_hold' | 'dropped';
  query?: string;
}

interface InboxFilters {
  status?: 'captured' | 'reviewed' | 'processed';
}

interface RecommendCriteria {
  energy?: 'low' | 'medium' | 'high';
  timeAvailable?: number;
  contextTags?: string[];
  limit?: number;
}
```

---

## Multi-Tenancy

- **Row-level isolation:** Every table has a `user_id TEXT NOT NULL` column.
- **Query-level enforcement:** All queries include `WHERE user_id = $1`. This is enforced at the repository layer.
- **Repository contract:** Every repository method takes `userId` as its first parameter.
- **RLS defense-in-depth (optional):**

```sql
ALTER TABLE gtd_horizons ENABLE ROW LEVEL SECURITY;
CREATE POLICY gtd_horizons_user_isolation ON gtd_horizons
  USING (user_id = current_setting('app.current_user_id'))
  WITH CHECK (user_id = current_setting('app.current_user_id'));

ALTER TABLE gtd_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY gtd_inbox_user_isolation ON gtd_inbox
  USING (user_id = current_setting('app.current_user_id'))
  WITH CHECK (user_id = current_setting('app.current_user_id'));

ALTER TABLE gtd_review_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY gtd_reviews_user_isolation ON gtd_review_sessions
  USING (user_id = current_setting('app.current_user_id'))
  WITH CHECK (user_id = current_setting('app.current_user_id'));
```

- **Session variable:** The MCP server sets `app.current_user_id` on each connection via `SET LOCAL app.current_user_id = '<userId>'` before executing queries. This activates the RLS policies as a second layer of defense.
- **Validation:** The MCP server extracts `userId` from the authenticated session and passes it to every repository call. Tools never accept `userId` as a parameter from the caller.
