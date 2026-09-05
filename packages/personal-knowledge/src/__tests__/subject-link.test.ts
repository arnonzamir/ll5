import { describe, it, expect } from 'vitest';
import { chooseLinkedNarrative, significantWords } from '../tools/subject-link.js';
import type { Narrative } from '../types/narrative.js';

const n = (ref: string, title: string, status = 'active'): Narrative =>
  ({ id: ref, subject: { kind: 'topic', ref }, title, summary: '', status } as unknown as Narrative);

describe('subject-link (ISS-032): a new topic slug reuses the narrative it belongs to', () => {
  it('drops stopwords and household names, keeps the signal', () => {
    expect(significantWords("arnon-saturday-mornings-with-kids")).toEqual(['saturday', 'mornings', 'kids']);
    expect(significantWords("Arnon's Saturday Home-Dad Arc")).toEqual(['saturday', 'home', 'dad']);
  });

  it('links when ≥2 words are shared and they cover at least half the slug', () => {
    const cands = [
      n('ritalin-routine', 'Ritalin daily routine — 3-dose schedule'),
      n('megalim-mudpasim-wine-tasting-2026', "Wine tasting with Me'agalim Mudpasim at Rami's"),
    ];
    const d = chooseLinkedNarrative('megalim-mudpasim-wine-tasting', cands);
    expect(d?.narrative.subject.ref).toBe('megalim-mudpasim-wine-tasting-2026');
    expect(d?.shared).toEqual(['megalim', 'mudpasim', 'wine', 'tasting']);
  });

  it('does NOT link on one shared word, on a single-word slug, on a tie, or to a dormant narrative', () => {
    expect(chooseLinkedNarrative('arnon-saturday-mornings-with-kids', [n('arnon-saturday-home-dad-mode', "Arnon's Saturday Home-Dad Arc")])).toBeNull(); // only "saturday"
    expect(chooseLinkedNarrative('scuba-diving', [n('diving-interest', "Arnon's Diving Interest")])).toBeNull(); // "scuba diving" shares 1 of 2
    expect(chooseLinkedNarrative('diving', [n('diving-interest', "Arnon's Diving Interest")])).toBeNull();
    const tie = [n('a', 'Ritalin routine morning'), n('b', 'Ritalin routine evening')];
    expect(chooseLinkedNarrative('ritalin-routine-schedule', tie)).toBeNull();
    expect(chooseLinkedNarrative('ritalin-routine-schedule', [n('ritalin-routine', 'Ritalin daily routine', 'dormant')])).toBeNull();
  });

  it('prefers the candidate with more shared words', () => {
    const cands = [n('ritalin-routine', 'Ritalin daily routine'), n('ritalin-routine-schedule-carry-on', 'Ritalin routine schedule + carry-on')];
    expect(chooseLinkedNarrative('ritalin-routine-schedule-2026', cands)?.narrative.subject.ref).toBe('ritalin-routine-schedule-carry-on');
  });
});
