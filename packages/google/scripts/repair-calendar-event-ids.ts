/**
 * repair-calendar-event-ids.ts
 *
 * One-time migration/repair for the calendar-event doc-id scheme change.
 *
 * BACKGROUND
 * ----------
 * Calendar events in the shared `ll5_awareness_calendar_events` ES index used
 * to be keyed by an UNSCOPED doc id:
 *     google-<event_id>      (regular events)
 *     tickler-<event_id>     (ticklers)
 * Two different users whose Google calendars contained the same event_id would
 * therefore collide on the SAME ES document — one user's upsert would overwrite
 * the other's, and delete_event for one user would delete the other's doc.
 *
 * The new scheme namespaces the doc id by user_id:
 *     <user_id>::google-<event_id>
 *     <user_id>::tickler-<event_id>
 *
 * Reads are unaffected during the transition: ESCalendarEventRepository.query()
 * filters by the `user_id` term in the document body and never relies on the
 * doc id, so old-id docs keep showing up correctly. This script migrates the
 * stored docs to the new id so that subsequent upserts/deletes (which DO use
 * the id) stay isolated per user.
 *
 * SAFETY
 * ------
 *  - DRY RUN BY DEFAULT. It only reports what it WOULD do unless --apply is
 *    passed.
 *  - It reindexes each legacy doc under its new scoped id (derived from the
 *    doc's own `user_id` field + `google_event_id`/`is_tickler`), then deletes
 *    the legacy doc only after the new doc is confirmed written.
 *  - Docs already on the new scheme (id contains '::') are skipped.
 *  - It does NOT run automatically anywhere. Invoke manually.
 *
 * USAGE
 * -----
 *   ELASTICSEARCH_URL=http://es:9200 \
 *     npx tsx packages/google/scripts/repair-calendar-event-ids.ts          # dry run
 *   ELASTICSEARCH_URL=http://es:9200 \
 *     npx tsx packages/google/scripts/repair-calendar-event-ids.ts --apply  # execute
 */

import { Client } from '@elastic/elasticsearch';

const INDEX = 'll5_awareness_calendar_events';

interface LegacyDoc {
  user_id?: string;
  google_event_id?: string | null;
  is_tickler?: boolean;
  source?: string;
}

function scopedDocId(userId: string, eventId: string, isTickler: boolean): string {
  const kind = isTickler ? 'tickler' : 'google';
  return `${userId}::${kind}-${eventId}`;
}

/** A doc id is "legacy" (unscoped) if it does not contain the user namespace separator. */
function isLegacyId(id: string): boolean {
  return !id.includes('::') && (id.startsWith('google-') || id.startsWith('tickler-'));
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const esUrl = process.env.ELASTICSEARCH_URL;
  if (!esUrl) {
    console.error('ELASTICSEARCH_URL is required');
    process.exit(1);
  }

  const es = new Client({ node: esUrl });
  console.log(`[repair] index=${INDEX} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  let migrated = 0;
  let skipped = 0;
  let unfixable = 0;

  // Scroll through every doc in the index.
  const pageSize = 500;
  let response = await es.search<LegacyDoc>({
    index: INDEX,
    scroll: '2m',
    size: pageSize,
    query: { match_all: {} },
  });

  while (response.hits.hits.length > 0) {
    for (const hit of response.hits.hits) {
      const id = hit._id as string;
      if (!isLegacyId(id)) {
        skipped += 1;
        continue;
      }

      const doc = hit._source;
      const userId = doc?.user_id;
      // event id: prefer the stored google_event_id; fall back to stripping the prefix
      const isTickler = doc?.is_tickler === true || id.startsWith('tickler-');
      const eventId =
        doc?.google_event_id ?? id.replace(/^google-/, '').replace(/^tickler-/, '');

      if (!userId || !eventId) {
        unfixable += 1;
        console.warn(`[repair] cannot derive scoped id for legacy doc id=${id} (missing user_id or event_id) — leaving as-is`);
        continue;
      }

      const newId = scopedDocId(userId, eventId, isTickler);
      console.log(`[repair] ${apply ? 'migrate' : 'would migrate'} ${id} -> ${newId} (user=${userId})`);

      if (apply) {
        // Write under the new id first, then remove the legacy doc.
        await es.index({ index: INDEX, id: newId, document: doc!, refresh: false });
        await es.delete({ index: INDEX, id, refresh: false });
      }
      migrated += 1;
    }

    const scrollId = response._scroll_id;
    if (!scrollId) break;
    response = await es.scroll<LegacyDoc>({ scroll_id: scrollId, scroll: '2m' });
  }

  if (apply) {
    await es.indices.refresh({ index: INDEX });
  }

  console.log(`[repair] done. migrated=${migrated} skipped(already-scoped)=${skipped} unfixable=${unfixable} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  if (!apply) {
    console.log('[repair] DRY RUN — no changes written. Re-run with --apply to execute.');
  }
}

main().catch((err) => {
  console.error('[repair] failed', err);
  process.exit(1);
});
