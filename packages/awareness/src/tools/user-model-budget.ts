/**
 * Byte budgets for user-model sections (ISS-033, 2026-09-06).
 *
 * Every section is injected into the agent's context at session start and then
 * re-read on every assistant message. On 2026-09-06 `active_context` was 46 KB
 * (~12K tokens of a ~120K floor) because the nightly pass pre-stages 14 days of
 * groundings into it; `communication` was 11 KB. The cap is enforced here, at
 * the write, in the DECISION-030 style: the tool refuses and says what to cut,
 * instead of the persona asking nicely ("keep it tight" did not hold).
 */
export const ACTIVE_CONTEXT_BUDGET_BYTES = 8_000;
export const SECTION_BUDGET_BYTES = 12_000;

export function sectionBudget(section: string): number {
  return section === 'active_context' ? ACTIVE_CONTEXT_BUDGET_BYTES : SECTION_BUDGET_BYTES;
}

export function sectionBytes(content: unknown): number {
  return Buffer.byteLength(JSON.stringify(content ?? {}), 'utf8');
}

/** Null when the write fits; otherwise the refusal text for the tool result. */
export function checkSectionBudget(section: string, content: unknown): string | null {
  const bytes = sectionBytes(content);
  const cap = sectionBudget(section);
  if (bytes <= cap) return null;
  const hint = section === 'active_context'
    ? 'Keep only what the next 2-3 days need: ~8 upcoming_grounded items of 1-2 lines each, the hot topics, and the open commitments. Drop the rest — it is still in the journal and narratives.'
    : 'Merge overlapping claims, drop dated ones, keep one line per stable fact.';
  return `NOT SAVED — section "${section}" is ${bytes.toLocaleString('en-US')} bytes, cap ${cap.toLocaleString('en-US')}. ${hint} Then call write_user_model again.`;
}
