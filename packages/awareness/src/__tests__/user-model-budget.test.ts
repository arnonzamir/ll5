import { describe, it, expect } from 'vitest';
import { checkSectionBudget, sectionBytes, ACTIVE_CONTEXT_BUDGET_BYTES, SECTION_BUDGET_BYTES } from '../tools/user-model-budget.js';

describe('user-model section budgets (ISS-033)', () => {
  it('accepts a small section', () => {
    expect(checkSectionBudget('active_context', { hot_topics: ['strep', 'diving'] })).toBeNull();
    expect(checkSectionBudget('communication', { style: 'short' })).toBeNull();
  });

  it('refuses active_context over 8 KB with a trimming hint', () => {
    const big = { upcoming_grounded: Array.from({ length: 60 }, (_, i) => ({ when: `day ${i}`, item: 'x'.repeat(120), grounding: 'y'.repeat(60) })) };
    expect(sectionBytes(big)).toBeGreaterThan(ACTIVE_CONTEXT_BUDGET_BYTES);
    const msg = checkSectionBudget('active_context', big);
    expect(msg).toMatch(/^NOT SAVED — section "active_context" is [\d,]+ bytes, cap 8,000\./);
    expect(msg).toContain('upcoming_grounded');
  });

  it('gives other sections 12 KB and counts UTF-8 bytes, not characters', () => {
    const hebrew = { notes: 'א'.repeat(7_000) }; // 7,000 chars = 14,000 bytes + JSON overhead
    expect(sectionBytes(hebrew)).toBeGreaterThan(SECTION_BUDGET_BYTES);
    expect(checkSectionBudget('communication', hebrew)).toMatch(/cap 12,000/);
    expect(checkSectionBudget('communication', { notes: 'א'.repeat(5_000) })).toBeNull();
  });
});
