/**
 * Subject reuse for topic observations (ISS-032, 2026-09-05).
 *
 * The agent tags observations with topic slugs it invents on the spot
 * ("arnon-saturday-mornings-with-kids") while the narrative for that life
 * thread already exists under another slug ("arnon-saturday-home-dad-mode").
 * Nothing refreshes, everything queues as a "new subject", and the Topics list
 * freezes. Rather than hope the prompt makes the agent look first, the tool
 * links: when a topic slug has no narrative, find an active narrative whose
 * title/subject shares the slug's significant words, and ALSO tag the
 * observation with that narrative's subject. Conservative on purpose — a wrong
 * link pollutes a narrative, a missed link only delays one.
 */
import type { Narrative } from '../types/narrative.js';

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'vs',
  'arnon', 'arnons', 'rotem', // the household names appear in most slugs — no signal
  'thread', 'topic', 'arc', 'life', 'mode', 'circle', 'group', 'chat', 'update', 'updates', 'sep', 'aug', 'jul',
  '2025', '2026',
]);

/** Significant words of a slug or title: lowercase, split on non-letters, drop stopwords and short tokens. */
export function significantWords(s: string): string[] {
  return [...new Set(
    s.toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)),
  )];
}

export interface LinkDecision { narrative: Narrative; shared: string[] }

/**
 * Pick the narrative a new topic slug should link to, or null. Rules:
 *  - the slug must have ≥ 2 significant words (one word is too ambiguous);
 *  - a candidate must share ≥ 2 of them with its title + subject ref, AND at
 *    least half of the slug's words;
 *  - the best candidate must beat the runner-up (no tie → no link).
 */
export function chooseLinkedNarrative(slug: string, candidates: Narrative[]): LinkDecision | null {
  const words = significantWords(slug);
  if (words.length < 2) return null;
  const scored = candidates
    .filter((n) => n.status === 'active' && n.subject?.kind === 'topic')
    .map((n) => {
      const hay = new Set(significantWords(`${n.title ?? ''} ${n.subject?.ref ?? ''}`));
      const shared = words.filter((w) => hay.has(w));
      return { narrative: n, shared };
    })
    .filter((c) => c.shared.length >= 2 && c.shared.length * 2 >= words.length)
    .sort((a, b) => b.shared.length - a.shared.length);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].shared.length === scored[1].shared.length) return null;
  return scored[0];
}
