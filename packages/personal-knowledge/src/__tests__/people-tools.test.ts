import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared.logAudit before importing tool modules.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from '@ll5/shared';
import { registerPeopleTools } from '../tools/people.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import type { Person } from '../types/person.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Repository stub factory — every method throws "not stubbed" by default so
// tests cannot silently rely on a method they didn't intend to exercise.
// ---------------------------------------------------------------------------

function makePersonRepo(overrides: Partial<PersonRepository> = {}): PersonRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`PersonRepository.${name} not stubbed for this test`);
  });
  return {
    list: unimpl('list'),
    get: unimpl('get'),
    upsert: unimpl('upsert'),
    delete: unimpl('delete'),
    search: unimpl('search'),
    ...overrides,
  } as PersonRepository;
}

function fakePerson(over: Partial<Person> = {}): Person {
  return {
    id: 'p-stub',
    userId: USER_ID,
    name: 'Stub Person',
    aliases: [],
    relationship: 'friend',
    tags: [],
    status: 'full',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...over,
  };
}

// ===========================================================================
// list_people
// ===========================================================================

describe('list_people tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards user_id and every filter param to repo.list', async () => {
    const list = vi.fn(async () => ({ items: [], total: 0 }));
    const repo = makePersonRepo({ list });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('list_people')!({
      relationship: 'family',
      tags: ['vip'],
      query: 'alice',
      status: 'full',
      limit: 10,
      offset: 5,
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toBe(USER_ID);
    expect(list.mock.calls[0][1]).toEqual({
      relationship: 'family',
      tags: ['vip'],
      query: 'alice',
      status: 'full',
      limit: 10,
      offset: 5,
    });
  });

  it('omits missing keys as undefined (handler does not invent defaults)', async () => {
    const list = vi.fn(async () => ({ items: [], total: 0 }));
    const repo = makePersonRepo({ list });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('list_people')!({});

    expect(list.mock.calls[0][0]).toBe(USER_ID);
    const params = list.mock.calls[0][1] as Record<string, unknown>;
    expect(params.relationship).toBeUndefined();
    expect(params.tags).toBeUndefined();
    expect(params.query).toBeUndefined();
    expect(params.status).toBeUndefined();
    expect(params.limit).toBeUndefined();
    expect(params.offset).toBeUndefined();
  });

  it('forwards status=contact-only to the repository', async () => {
    const list = vi.fn(async () => ({ items: [], total: 0 }));
    const repo = makePersonRepo({ list });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('list_people')!({ status: 'contact-only' });

    expect(list.mock.calls[0][0]).toBe(USER_ID);
    expect((list.mock.calls[0][1] as Record<string, unknown>).status).toBe('contact-only');
  });

  it('returns people and total in the response envelope', async () => {
    const items = [fakePerson({ id: 'p-1', name: 'Alice' }), fakePerson({ id: 'p-2', name: 'Bob' })];
    const repo = makePersonRepo({
      list: vi.fn(async () => ({ items, total: 2 })),
    });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('list_people')!({});

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ people: Array<{ id: string; name: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.people.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(parsed.people[0].name).toBe('Alice');
  });
});

// ===========================================================================
// get_person
// ===========================================================================

describe('get_person tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls repo.get with user_id and id, returns the person', async () => {
    const get = vi.fn(async () => fakePerson({ id: 'p-100', name: 'Found' }));
    const repo = makePersonRepo({ get });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('get_person')!({ id: 'p-100' });

    expect(get).toHaveBeenCalledWith(USER_ID, 'p-100');
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ person: { id: string; name: string } }>(response);
    expect(parsed.person.id).toBe('p-100');
    expect(parsed.person.name).toBe('Found');
  });

  it('returns isError envelope when person not found (null)', async () => {
    const get = vi.fn(async () => null);
    const repo = makePersonRepo({ get });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('get_person')!({ id: 'nonexistent' });

    expect(get).toHaveBeenCalledWith(USER_ID, 'nonexistent');
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toBe('Person not found');
  });
});

// ===========================================================================
// upsert_person
// ===========================================================================

describe('upsert_person tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps snake_case contact_info to camelCase contactInfo on create', async () => {
    const upsert = vi.fn(async () => ({
      person: fakePerson({ id: 'p-new', name: 'New Person' }),
      created: true,
    }));
    const repo = makePersonRepo({ upsert });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('upsert_person')!({
      name: 'New Person',
      aliases: ['NP'],
      relationship: 'friend',
      contact_info: { phone: '123' },
      tags: ['test'],
      notes: 'Test notes',
      status: 'full',
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toBe(USER_ID);
    expect(upsert.mock.calls[0][1]).toEqual({
      id: undefined,
      name: 'New Person',
      aliases: ['NP'],
      relationship: 'friend',
      contactInfo: { phone: '123' },
      tags: ['test'],
      notes: 'Test notes',
      status: 'full',
    });

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ person: { id: string }; created: boolean }>(response);
    expect(parsed.person.id).toBe('p-new');
    expect(parsed.created).toBe(true);
  });

  it('forwards id for update (created=false)', async () => {
    const upsert = vi.fn(async () => ({
      person: fakePerson({ id: 'p-existing', name: 'Updated' }),
      created: false,
    }));
    const repo = makePersonRepo({ upsert });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('upsert_person')!({ id: 'p-existing', name: 'Updated' });

    expect(upsert.mock.calls[0][0]).toBe(USER_ID);
    const payload = upsert.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.id).toBe('p-existing');
    expect(payload.name).toBe('Updated');

    const parsed = parseToolResponse<{ created: boolean }>(response);
    expect(parsed.created).toBe(false);
  });

  it('emits audit action=create when repo signals created=true', async () => {
    const repo = makePersonRepo({
      upsert: vi.fn(async () => ({
        person: fakePerson({ id: 'p-99', name: 'Audited' }),
        created: true,
      })),
    });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('upsert_person')!({ name: 'Audited', relationship: 'friend' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'knowledge',
      action: 'create',
      entity_type: 'person',
      entity_id: 'p-99',
      summary: 'Created person: Audited',
      metadata: { relationship: 'friend' },
    }));
  });

  it('emits audit action=update when repo signals created=false', async () => {
    const repo = makePersonRepo({
      upsert: vi.fn(async () => ({
        person: fakePerson({ id: 'p-1', name: 'Renamed' }),
        created: false,
      })),
    });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('upsert_person')!({ id: 'p-1', name: 'Renamed' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'knowledge',
      action: 'update',
      entity_type: 'person',
      entity_id: 'p-1',
      summary: 'Updated person: Renamed',
    }));
  });

  it('forwards status=contact-only to the repository', async () => {
    const upsert = vi.fn(async () => ({
      person: fakePerson({ status: 'contact-only' }),
      created: true,
    }));
    const repo = makePersonRepo({ upsert });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await tools.get('upsert_person')!({ name: 'Contact', status: 'contact-only' });

    expect(upsert.mock.calls[0][0]).toBe(USER_ID);
    expect((upsert.mock.calls[0][1] as Record<string, unknown>).status).toBe('contact-only');
  });

  it('propagates repository errors (does not swallow on upsert)', async () => {
    const repo = makePersonRepo({
      upsert: vi.fn(async () => { throw new Error('es down'); }),
    });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    await expect(tools.get('upsert_person')!({ name: 'X' })).rejects.toThrow('es down');
    // Audit must not be emitted on failure
    expect(logAudit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// delete_person
// ===========================================================================

describe('delete_person tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns {deleted: true} and audits when repo.delete succeeds', async () => {
    const del = vi.fn(async () => true);
    const repo = makePersonRepo({ delete: del });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('delete_person')!({ id: 'p-del' });

    expect(del).toHaveBeenCalledWith(USER_ID, 'p-del');
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ deleted: boolean }>(response);
    expect(parsed.deleted).toBe(true);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'knowledge',
      action: 'delete',
      entity_type: 'person',
      entity_id: 'p-del',
      summary: 'Deleted person p-del',
    }));
  });

  it('returns isError envelope and does NOT audit when repo.delete returns false', async () => {
    const del = vi.fn(async () => false);
    const repo = makePersonRepo({ delete: del });
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));

    const response = await tools.get('delete_person')!({ id: 'nonexistent' });

    expect(del).toHaveBeenCalledWith(USER_ID, 'nonexistent');
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toBe('Person not found');
    expect(logAudit).not.toHaveBeenCalled();
  });
});
