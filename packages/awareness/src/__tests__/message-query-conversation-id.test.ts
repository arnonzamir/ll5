import { describe, it, expect, vi } from 'vitest';
import { ElasticsearchMessageRepository } from '../repositories/elasticsearch/message.repository.js';

/**
 * DECISION-025 live-replay fix. `conversation_id` is mapped `text` + `.keyword`,
 * so a `term` on the analyzed BASE field never matches a real id — WhatsApp JIDs
 * (`…@g.us`) and hyphenated ids get tokenized on `@ . -`. query_im_messages must
 * therefore filter on the exact `.keyword` subfield, or it returns ZERO for every
 * real thread — which silently broke the reconcile worker's grounding read (the
 * worker saw candidates via the selector's `.keyword` agg, then read an empty
 * thread and kept every loop open). Caught by the seeded live worker replay.
 */
describe('MessageRepository.query — conversation_id filter', () => {
  function repoWithCapture() {
    const search = vi.fn(async () => ({ hits: { hits: [] } }));
    const repo = new ElasticsearchMessageRepository({ search } as never);
    return { repo, search };
  }

  it('filters conversation_id on the exact .keyword subfield, not the analyzed text field', async () => {
    const { repo, search } = repoWithCapture();
    await repo.query('user1', { conversation_id: '120363022789267569@g.us' });

    expect(search).toHaveBeenCalledOnce();
    const body = JSON.stringify(search.mock.calls[0][0]);
    // exact keyword match (survives special chars the analyzer would split)
    expect(body).toContain('"conversation_id.keyword":"120363022789267569@g.us"');
    // NOT the analyzed base field (a bare {term:{conversation_id:…}} would 0-match real ids)
    expect(body).not.toMatch(/"term":\s*\{\s*"conversation_id":/);
  });

  it('stays user_id-scoped alongside the conversation filter', async () => {
    const { repo, search } = repoWithCapture();
    await repo.query('userB', { conversation_id: 'test025-resolve' });
    const body = JSON.stringify(search.mock.calls[0][0]);
    expect(body).toContain('"user_id":"userB"');
    expect(body).toContain('"conversation_id.keyword":"test025-resolve"');
  });
});
