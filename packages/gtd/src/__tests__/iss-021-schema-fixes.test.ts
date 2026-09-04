import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { registerHabitTools } from '../tools/habits.js';
import { registerHorizonTools } from '../tools/horizons.js';
import { captureTools, parseToolResponse, type ToolHandler } from './_helpers.js';
import type { HabitRepository } from '../repositories/interfaces/habit.repository.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';
import type { Habit, HabitLogEntry } from '../types/index.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

function captureWithSchemas(register: (s: McpServer) => void) {
  const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: ToolHandler }>();
  const fake = {
    tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: ToolHandler) => {
      tools.set(name, { schema, handler });
    },
  } as unknown as McpServer;
  register(fake);
  return tools;
}
const validate = (t: { schema: Record<string, z.ZodTypeAny> }, input: unknown) => z.object(t.schema).safeParse(input);

// ---------------------------------------------------------------------------
// log_habit_outcome — "skipped" → skipped_deliberate
// ---------------------------------------------------------------------------
describe('log_habit_outcome — ISS-021 outcome spelling', () => {
  const habit: Habit = {
    id: '37d6f9b6-bbd5-4858-9d9d-1db3d25ea27f',
    userId: USER_ID,
    name: 'Ritalin',
    description: null,
    schedule: { days: 'daily', times: ['09:00'] },
    checkKind: 'user_confirm',
    checkConfig: {},
    escalation: [{ offset_minutes: 0, level: 'notify' }],
    status: 'active',
    timezone: 'UTC',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Habit;

  function makeRepo() {
    const logOutcome = vi.fn(async (_u: string, input: Record<string, unknown>) => ({
      id: 'occ-1', habitId: habit.id, userId: USER_ID, dueDate: input.dueDate, dueTime: input.dueTime, dueAt: null,
      outcome: input.outcome, closedAt: new Date(), note: input.note ?? null, stepsFired: [], createdAt: new Date(),
    }) as HabitLogEntry);
    const repo = { findById: vi.fn(async () => habit), logOutcome } as unknown as HabitRepository;
    return { repo, logOutcome };
  }

  it('the live payload (outcome:"skipped") validates and is stored as skipped_deliberate', async () => {
    const { repo, logOutcome } = makeRepo();
    const tools = captureWithSchemas((s) => registerHabitTools(s, repo, getUserId));
    const t = tools.get('log_habit_outcome')!;
    const live = { habit_id: habit.id, outcome: 'skipped', note: 'Sick day' };
    expect(validate(t, live).success).toBe(true);

    const out = parseToolResponse<{ occurrence: { outcome: string } }>(await t.handler(live));
    expect(out.occurrence.outcome).toBe('skipped_deliberate');
    expect(logOutcome.mock.calls[0][0]).toBe(USER_ID);
    expect(logOutcome.mock.calls[0][1]).toMatchObject({ habitId: habit.id, outcome: 'skipped_deliberate', note: 'Sick day' });
  });

  it('canonical outcomes pass through unchanged', async () => {
    const { repo, logOutcome } = makeRepo();
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));
    await tools.get('log_habit_outcome')!({ habit_id: habit.id, outcome: 'excused' });
    expect(logOutcome.mock.calls[0][1]).toMatchObject({ outcome: 'excused' });
  });
});

// ---------------------------------------------------------------------------
// list_horizons — bare call lists every level
// ---------------------------------------------------------------------------
describe('list_horizons — ISS-021 optional horizon', () => {
  function makeRepo() {
    const listHorizons = vi.fn(async (_u: string, f: { horizon: number }) => ({
      items: [{ id: `h${f.horizon}-a`, horizon: f.horizon, title: `level ${f.horizon}` }],
      total: 1,
    }));
    return { repo: { listHorizons } as unknown as HorizonRepository, listHorizons };
  }

  it('the live bare payload {} validates and returns all four levels merged, scoped to USER_ID', async () => {
    const { repo, listHorizons } = makeRepo();
    const tools = captureWithSchemas((s) => registerHorizonTools(s, repo, getUserId));
    const t = tools.get('list_horizons')!;
    expect(validate(t, {}).success).toBe(true);

    const out = parseToolResponse<{ horizons: Array<{ id: string }>; total: number; by_level: Record<string, number> }>(await t.handler({}));
    expect(listHorizons).toHaveBeenCalledTimes(4);
    expect(listHorizons.mock.calls.map((c) => c[1].horizon)).toEqual([2, 3, 4, 5]);
    for (const c of listHorizons.mock.calls) expect(c[0]).toBe(USER_ID);
    expect(out.horizons.map((h) => h.id)).toEqual(['h2-a', 'h3-a', 'h4-a', 'h5-a']);
    expect(out.total).toBe(4);
    expect(out.by_level).toEqual({ h2: 1, h3: 1, h4: 1, h5: 1 });
  });

  it('an explicit horizon still lists just that level (pre-existing shape)', async () => {
    const { repo, listHorizons } = makeRepo();
    const tools = captureTools((s) => registerHorizonTools(s, repo, getUserId));
    const out = parseToolResponse<{ horizons: unknown[]; total: number; by_level?: unknown }>(await tools.get('list_horizons')!({ horizon: 3, offset: 5 }));
    expect(listHorizons).toHaveBeenCalledTimes(1);
    expect(listHorizons.mock.calls[0][1]).toMatchObject({ horizon: 3, offset: 5 });
    expect(out.by_level).toBeUndefined();
    expect(out.total).toBe(1);
  });
});
