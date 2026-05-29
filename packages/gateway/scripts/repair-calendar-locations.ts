/**
 * One-time data repair: fix calendar events whose `location` was corrupted by
 * the old merge bug (processors/calendar.ts wrote the PREVIOUS title into the
 * location field, e.g. "Sprint Planning" @ "(no title)").
 *
 * Guarded and conservative:
 *   - DRY-RUN by default. Pass `--apply` to actually write.
 *   - ALWAYS scoped by --user-id (required) so we never touch another tenant.
 *   - Only repairs docs where location is provably corrupted:
 *       (a) location === title (the bug's classic signature), OR
 *       (b) location is one of the generic placeholder titles that only ever
 *           come from the title field, never a real location.
 *   - The repair simply REMOVES the bogus location (sets it to null). We cannot
 *     recover the real location from ES alone; clearing it is strictly safer
 *     than leaving a title masquerading as a place.
 *
 * Usage:
 *   ELASTICSEARCH_URL=... npx tsx scripts/repair-calendar-locations.ts --user-id <uid> [--apply] [--batch 500]
 *
 * NOTE: This script is intentionally NOT wired into any scheduler or startup
 * path. It must be run manually and reviewed via its dry-run output first.
 */
import { Client } from '@elastic/elasticsearch';

const INDEX = 'll5_awareness_calendar_events';

// Generic placeholder "titles" that should never legitimately appear as a
// location. If we see one of these in `location`, it leaked from `title`.
const GENERIC_TITLES = new Set<string>([
  '(no title)',
  'busy',
  'Busy',
  'BUSY',
  '(No title)',
  '',
]);

interface CalendarSource {
  user_id?: string;
  title?: string;
  location?: string;
}

interface Args {
  userId: string;
  apply: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  let userId = '';
  let apply = false;
  let batch = 500;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--user-id') userId = argv[++i] ?? '';
    else if (a.startsWith('--user-id=')) userId = a.slice('--user-id='.length);
    else if (a === '--batch') batch = parseInt(argv[++i] ?? '500', 10);
    else if (a.startsWith('--batch=')) batch = parseInt(a.slice('--batch='.length), 10);
  }
  if (!userId) {
    throw new Error('--user-id <uid> is required (repair is always tenant-scoped)');
  }
  if (!Number.isFinite(batch) || batch <= 0) batch = 500;
  return { userId, apply, batch };
}

/** True if this doc's location is the corruption signature and should be fixed. */
function isCorrupted(src: CalendarSource): boolean {
  const loc = src.location;
  if (loc == null) return false;
  if (src.title != null && loc === src.title) return true; // location == title
  if (GENERIC_TITLES.has(loc)) return true; // a generic title leaked into location
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const node = process.env.ELASTICSEARCH_URL;
  if (!node) throw new Error('ELASTICSEARCH_URL environment variable is required');

  const es = new Client({ node });
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[repair-calendar-locations] mode=${mode} user_id=${args.userId} batch=${args.batch} index=${INDEX}`);

  // Scroll all events for this user, tenant-scoped.
  let scrollId: string | undefined;
  let scanned = 0;
  let corrupted = 0;
  let repaired = 0;
  const samples: Array<{ id: string; title?: string; location?: string }> = [];

  const first = await es.search<CalendarSource>({
    index: INDEX,
    scroll: '2m',
    size: args.batch,
    query: { bool: { filter: [{ term: { user_id: args.userId } }] } },
    _source: ['user_id', 'title', 'location'],
  });

  let hits = first.hits.hits;
  scrollId = first._scroll_id;

  while (hits.length > 0) {
    const ops: Array<Record<string, unknown>> = [];
    for (const hit of hits) {
      scanned++;
      const src = (hit._source ?? {}) as CalendarSource;
      // Defense-in-depth: never act on a doc that isn't this user's.
      if (src.user_id !== args.userId) continue;
      if (!isCorrupted(src)) continue;
      corrupted++;
      if (samples.length < 20) {
        samples.push({ id: hit._id as string, title: src.title, location: src.location });
      }
      if (args.apply) {
        // Remove the bogus location via a partial update (don't touch anything else).
        ops.push({ update: { _index: INDEX, _id: hit._id } });
        ops.push({ doc: { location: null, updated_at: new Date().toISOString() } });
      }
    }

    if (args.apply && ops.length > 0) {
      const res = await es.bulk({ operations: ops, refresh: false });
      const errored = res.items.filter((it) => (it.update?.error ?? null) !== null).length;
      repaired += (ops.length / 2) - errored;
      if (errored > 0) {
        console.warn(`[repair-calendar-locations] ${errored} bulk update errors in this batch`);
      }
    }

    if (!scrollId) break;
    const next = await es.scroll<CalendarSource>({ scroll_id: scrollId, scroll: '2m' });
    hits = next.hits.hits;
    scrollId = next._scroll_id;
  }

  if (scrollId) {
    await es.clearScroll({ scroll_id: scrollId }).catch(() => undefined);
  }

  console.log('[repair-calendar-locations] sample corrupted docs:');
  for (const s of samples) {
    console.log(`  ${s.id}: title=${JSON.stringify(s.title)} location=${JSON.stringify(s.location)}`);
  }
  console.log(`[repair-calendar-locations] done. scanned=${scanned} corrupted=${corrupted} repaired=${repaired} (${mode})`);
  if (!args.apply && corrupted > 0) {
    console.log('[repair-calendar-locations] DRY-RUN only — re-run with --apply to write these fixes.');
  }
}

main().catch((err) => {
  console.error('[repair-calendar-locations] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
