import { describe, it, expect, vi } from 'vitest';
import { registerLessonTools } from '../tools/lessons.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';

const getUserId = () => 'user-1';

/** ES mock whose search returns the given hits (with scores) for the reconcile lookup. */
function esWithMatches(hits: { id: string; score: number; claim: string; durability?: string }[]) {
  return makeMockEsClient({
    search: vi.fn().mockResolvedValue({
      hits: {
        hits: hits.map((h) => ({
          _id: h.id,
          _score: h.score,
          _source: {
            scope: 'world',
            claim: h.claim,
            trigger: 't',
            durability: h.durability ?? 'durable',
            status: 'active',
          },
        })),
      },
    }),
  });
}

describe('upsert_lesson — reconcile-on-write', () => {
  it('inserts cleanly when there are no near matches', async () => {
    const es = esWithMatches([]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'create_tickler due_time is local effective tz',
      trigger: 'scheduling ticklers',
      durability: 'durable',
    });
    const out = parseToolResponse<{ ok: boolean; id: string }>(res);
    expect(out.ok).toBe(true);
    expect(es.index).toHaveBeenCalledTimes(1); // the new lesson only
  });

  it('BLOCKS a contradicting write and returns the conflict (no blind insert)', async () => {
    // A strong near-match (relevance 1.0 after normalization) and no supersede/force.
    const es = esWithMatches([{ id: 'L-old', score: 10, claim: 'create_tickler due_time is UTC' }]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'create_tickler due_time is local',
      trigger: 'scheduling ticklers',
      durability: 'durable',
    });
    const out = parseToolResponse<{ ok: boolean; needs_reconcile: boolean; conflicts: { id: string }[] }>(res);
    expect(out.ok).toBe(false);
    expect(out.needs_reconcile).toBe(true);
    expect(out.conflicts[0].id).toBe('L-old');
    expect(es.index).not.toHaveBeenCalled(); // nothing written while unresolved
  });

  it('supersede_id retires the old lesson and writes the new one', async () => {
    const es = esWithMatches([{ id: 'L-old', score: 10, claim: 'create_tickler due_time is UTC' }]);
    es.get = vi.fn().mockResolvedValue({ _id: 'L-old', _source: { claim: 'create_tickler due_time is UTC', scope: 'world', status: 'active' } });
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'create_tickler due_time is local',
      trigger: 'scheduling ticklers',
      durability: 'durable',
      supersede_id: 'L-old',
    });
    const out = parseToolResponse<{ ok: boolean; superseded: { id: string } }>(res);
    expect(out.ok).toBe(true);
    expect(out.superseded.id).toBe('L-old');
    // old lesson updated to retired + backlinked; new lesson indexed; history snapshot indexed
    expect(es.update).toHaveBeenCalled();
    expect(es.index).toHaveBeenCalled();
  });

  it('force=true inserts despite a real claim-overlap conflict', async () => {
    // Same significant tokens → genuine conflict; force inserts anyway.
    const es = esWithMatches([{ id: 'L-x', score: 10, claim: 'create_tickler due_time is UTC' }]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'create_tickler due_time is local',
      trigger: 'scheduling ticklers',
      durability: 'durable',
      force: true,
    });
    const out = parseToolResponse<{ ok: boolean; forced_over_conflicts: string[] }>(res);
    expect(out.ok).toBe(true);
    expect(out.forced_over_conflicts).toContain('L-x');
  });

  it('does NOT flag an unrelated lesson as a conflict (no false merge)', async () => {
    // This is the migration bug: "tickler timezone" vs "agent groups prefix" must not collide.
    const es = esWithMatches([{ id: 'L-unrel', score: 10, claim: 'agent groups use the ll5 prefix' }]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'create_tickler due_time is the local effective timezone',
      trigger: 'scheduling ticklers',
      durability: 'durable',
    });
    const out = parseToolResponse<{ ok: boolean; id?: string }>(res);
    expect(out.ok).toBe(true); // clean insert, no spurious conflict
  });

  it('rejects a provisional lesson with no falsification_test', async () => {
    const es = esWithMatches([]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('upsert_lesson')!({
      claim: 'workaround X',
      trigger: 'tool Y',
      durability: 'provisional',
    });
    const out = parseToolResponse<{ ok: boolean; error: string }>(res);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/falsification_test/);
  });
});

describe('ingest_memory — classify + route', () => {
  const worldMd = `---\nname: create_tickler is local\ndescription: scheduling ticklers and calendar events\nmetadata:\n  type: feedback\n---\ncreate_tickler due_time is the user's local effective timezone; never pre-shift to UTC.`;
  const userMd = `---\nname: no emojis\ndescription: how Arnon wants communication\nmetadata:\n  type: user\n---\nArnon prefers no emojis in any output.`;

  it('routes an operational memory to the world lessons store (created)', async () => {
    const es = esWithMatches([]); // no near matches
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('ingest_memory')!({ raw_content: worldMd, file_path: '/m/x.md' });
    const out = parseToolResponse<{ ok: boolean; scope: string; action: string }>(res);
    expect(out.scope).toBe('world');
    expect(out.action).toBe('created');
    expect(es.index).toHaveBeenCalled();
  });

  it('auto-merges a genuine restatement in place (high claim overlap)', async () => {
    // worldMd name is "create_tickler is local"; existing claim shares those tokens → overlap ≥ 0.6.
    const es = esWithMatches([{ id: 'L-tz', score: 10, claim: 'create_tickler is local timezone' }]);
    es.get = vi.fn().mockResolvedValue({ _id: 'L-tz', _source: { claim: 'create_tickler is local timezone', scope: 'world', status: 'active' } });
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('ingest_memory')!({ raw_content: worldMd });
    const out = parseToolResponse<{ scope: string; action: string; id: string }>(res);
    expect(out.action).toBe('updated_in_place');
    expect(out.id).toBe('L-tz');
    expect(es.update).toHaveBeenCalled(); // updated, not a second insert of a lesson doc
  });

  it('does NOT merge an unrelated world lesson (the migration corruption bug)', async () => {
    // "create_tickler is local" must NOT merge into "agent groups use the ll5 prefix".
    const es = esWithMatches([{ id: 'L-unrel', score: 10, claim: 'agent groups use the ll5 prefix' }]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('ingest_memory')!({ raw_content: worldMd });
    const out = parseToolResponse<{ scope: string; action: string }>(res);
    expect(out.action).toBe('created'); // fresh insert, NOT updated_in_place
  });

  it('routes a user memory to the user_model learned_notes section (appended)', async () => {
    const es = esWithMatches([]);
    es.get = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { meta: { statusCode: 404 } })); // first note
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('ingest_memory')!({ raw_content: userMd });
    const out = parseToolResponse<{ scope: string; action: string; section: string }>(res);
    expect(out.scope).toBe('user');
    expect(out.action).toBe('appended');
    expect(out.section).toBe('learned_notes');
  });
});

describe('recall_lessons', () => {
  it('flags provisional lessons with verify_before_trust', async () => {
    const es = esWithMatches([
      { id: 'L-prov', score: 10, claim: 'workaround', durability: 'provisional' },
    ]);
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const res = await tools.get('recall_lessons')!({ query: 'tool Y' });
    const out = parseToolResponse<{ lessons: { id: string; verify_before_trust: string | null }[] }>(res);
    expect(out.lessons[0].id).toBe('L-prov');
    // provisional → falsification_test surfaced (mock _source has none, so null, but field present)
    expect(out.lessons[0]).toHaveProperty('verify_before_trust');
  });
});
