/**
 * Repair orphaned ll5_health_daily_stats docs (bug #6).
 *
 * Background: writeStressToES() previously upserted ONLY stress fields with
 * doc_as_upsert. When stress synced before daily_stats existed, ES inserted a
 * doc with NO user_id / date / source. Those orphans are invisible to every
 * user_id-scoped read (daily-stats.ts, trends.ts filter on term user_id).
 *
 * This script finds daily_stats docs missing user_id and backfills user_id +
 * date + source by parsing the doc _id, whose shape is:
 *     garmin-daily-<user_id(uuid)>-<YYYY-MM-DD>
 *
 * Idempotent: re-running only touches docs still missing user_id.
 *
 * Usage (author only — do NOT run against production ES without intent):
 *     # dry run (default) — lists what WOULD change, writes nothing
 *     ELASTICSEARCH_URL=... [ELASTICSEARCH_API_KEY=...] \
 *       npx tsx packages/health/scripts/repair-orphan-daily-stats.ts
 *
 *     # apply
 *     ... npx tsx packages/health/scripts/repair-orphan-daily-stats.ts --apply
 */
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';

const INDEX = 'll5_health_daily_stats';

// garmin-daily-<uuid>-<YYYY-MM-DD>
// source = leading token(s) before "-daily-"; user_id = uuid; date = trailing YYYY-MM-DD
const ID_PATTERN =
  /^(?<source>.+)-daily-(?<userId>[0-9a-fA-F-]{8,})-(?<date>\d{4}-\d{2}-\d{2})$/;

interface ParsedId {
  source: string;
  userId: string;
  date: string;
}

export function parseDailyStatsId(id: string): ParsedId | null {
  const m = ID_PATTERN.exec(id);
  if (!m?.groups) return null;
  const { source, userId, date } = m.groups;
  if (!source || !userId || !date) return null;
  return { source, userId, date };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const node = process.env.ELASTICSEARCH_URL;
  if (!node) {
    throw new Error('ELASTICSEARCH_URL environment variable is required');
  }
  const apiKey = process.env.ELASTICSEARCH_API_KEY;

  const es = new ElasticsearchClient({
    node,
    ...(apiKey ? { auth: { apiKey } } : {}),
  });

  // Scoped to the bug class: docs in the daily_stats index missing user_id.
  const result = await es.search<Record<string, unknown>>({
    index: INDEX,
    size: 1000,
    query: {
      bool: {
        must_not: [{ exists: { field: 'user_id' } }],
      },
    },
    _source: false,
  });

  const hits = result.hits.hits;
  console.log(
    `[repair-orphan-daily-stats] mode=${apply ? 'APPLY' : 'DRY-RUN'} ` +
      `found ${hits.length} doc(s) in ${INDEX} missing user_id`,
  );

  let repaired = 0;
  let skipped = 0;

  for (const hit of hits) {
    const id = hit._id as string;
    const parsed = parseDailyStatsId(id);
    if (!parsed) {
      console.warn(`[repair-orphan-daily-stats] SKIP unparseable _id: ${id}`);
      skipped += 1;
      continue;
    }

    console.log(
      `[repair-orphan-daily-stats] ${apply ? 'repair' : 'would-repair'} ${id} ` +
        `-> user_id=${parsed.userId} date=${parsed.date} source=${parsed.source}`,
    );

    if (apply) {
      await es.update({
        index: INDEX,
        id,
        doc: {
          user_id: parsed.userId,
          date: parsed.date,
          source: parsed.source,
        },
      });
      repaired += 1;
    }
  }

  console.log(
    `[repair-orphan-daily-stats] done. ${apply ? `repaired=${repaired}` : `would-repair=${hits.length - skipped}`} skipped=${skipped}`,
  );

  if (!apply && hits.length - skipped > 0) {
    console.log('[repair-orphan-daily-stats] re-run with --apply to write these changes.');
  }
}

main().catch((err) => {
  console.error('[repair-orphan-daily-stats] failed', err);
  process.exit(1);
});
