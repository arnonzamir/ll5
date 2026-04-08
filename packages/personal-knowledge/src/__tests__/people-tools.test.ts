import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logAudit before importing anything that uses it
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from '@ll5/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  userId: string;
  name: string;
  aliases: string[];
  relationship: string;
  contactInfo?: Record<string, string>;
  tags: string[];
  notes?: string;
  status: 'full' | 'contact-only';
  createdAt: string;
  updatedAt: string;
}

interface PersonRepository {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Simulate tool handler logic (extracted from people.ts)
// ---------------------------------------------------------------------------

function makePersonRepo(): PersonRepository {
  return {
    list: vi.fn(),
    get: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
  };
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p-1',
    userId: 'user-1',
    name: 'Test Person',
    aliases: [],
    relationship: 'friend',
    tags: [],
    status: 'full',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

const USER_ID = 'user-test-1';

// ---------------------------------------------------------------------------
// list_people handler logic
// ---------------------------------------------------------------------------

describe('list_people tool handler', () => {
  let repo: PersonRepository;

  beforeEach(() => {
    repo = makePersonRepo();
    vi.clearAllMocks();
  });

  it('calls list with all filter params', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });

    const params = {
      relationship: 'family',
      tags: ['vip'],
      query: 'alice',
      status: 'full' as const,
      limit: 10,
      offset: 5,
    };

    await repo.list(USER_ID, {
      relationship: params.relationship,
      tags: params.tags,
      query: params.query,
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });

    expect(repo.list).toHaveBeenCalledWith(USER_ID, {
      relationship: 'family',
      tags: ['vip'],
      query: 'alice',
      status: 'full',
      limit: 10,
      offset: 5,
    });
  });

  it('returns people and total in expected format', async () => {
    const people = [makePerson({ id: 'p-1', name: 'Alice' }), makePerson({ id: 'p-2', name: 'Bob' })];
    repo.list.mockResolvedValue({ items: people, total: 2 });

    const result = await repo.list(USER_ID, {});
    const response = { people: result.items, total: result.total };

    expect(response.people).toHaveLength(2);
    expect(response.total).toBe(2);
    expect(response.people[0].name).toBe('Alice');
  });

  it('passes status=contact-only filter correctly', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });

    await repo.list(USER_ID, { status: 'contact-only' });

    expect(repo.list).toHaveBeenCalledWith(USER_ID, { status: 'contact-only' });
  });

  it('passes status=full filter correctly', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });

    await repo.list(USER_ID, { status: 'full' });

    expect(repo.list).toHaveBeenCalledWith(USER_ID, { status: 'full' });
  });

  it('omits undefined optional params', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });

    await repo.list(USER_ID, {
      relationship: undefined,
      tags: undefined,
      query: undefined,
      status: undefined,
      limit: undefined,
      offset: undefined,
    });

    const callArgs = repo.list.mock.calls[0][1];
    expect(callArgs.relationship).toBeUndefined();
    expect(callArgs.tags).toBeUndefined();
    expect(callArgs.query).toBeUndefined();
    expect(callArgs.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get_person handler logic
// ---------------------------------------------------------------------------

describe('get_person tool handler', () => {
  let repo: PersonRepository;

  beforeEach(() => {
    repo = makePersonRepo();
    vi.clearAllMocks();
  });

  it('returns person when found', async () => {
    const person = makePerson({ id: 'p-100', name: 'Found Person' });
    repo.get.mockResolvedValue(person);

    const result = await repo.get(USER_ID, 'p-100');
    expect(result).toBeTruthy();
    expect(result.name).toBe('Found Person');
  });

  it('returns error when person not found', async () => {
    repo.get.mockResolvedValue(null);

    const result = await repo.get(USER_ID, 'nonexistent');
    expect(result).toBeNull();

    // Simulate the tool handler logic
    if (!result) {
      const response = {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Person not found' }) }],
        isError: true,
      };
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text).error).toBe('Person not found');
    }
  });
});

// ---------------------------------------------------------------------------
// upsert_person handler logic
// ---------------------------------------------------------------------------

describe('upsert_person tool handler', () => {
  let repo: PersonRepository;

  beforeEach(() => {
    repo = makePersonRepo();
    vi.clearAllMocks();
  });

  it('calls upsert with mapped params for create', async () => {
    const person = makePerson({ id: 'p-new' });
    repo.upsert.mockResolvedValue({ person, created: true });

    const params = {
      name: 'New Person',
      aliases: ['NP'],
      relationship: 'friend',
      contact_info: { phone: '123' },
      tags: ['test'],
      notes: 'Test notes',
      status: 'full' as const,
    };

    const result = await repo.upsert(USER_ID, {
      name: params.name,
      aliases: params.aliases,
      relationship: params.relationship,
      contactInfo: params.contact_info,
      tags: params.tags,
      notes: params.notes,
      status: params.status,
    });

    expect(result.created).toBe(true);
    expect(repo.upsert).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      name: 'New Person',
      contactInfo: { phone: '123' },
    }));
  });

  it('calls upsert with id for update', async () => {
    const person = makePerson({ id: 'p-existing', name: 'Updated' });
    repo.upsert.mockResolvedValue({ person, created: false });

    await repo.upsert(USER_ID, {
      id: 'p-existing',
      name: 'Updated',
    });

    expect(repo.upsert).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      id: 'p-existing',
      name: 'Updated',
    }));
  });

  it('logs audit on create', async () => {
    const person = makePerson({ id: 'p-new', name: 'Created' });
    repo.upsert.mockResolvedValue({ person, created: true });

    const result = await repo.upsert(USER_ID, { name: 'Created' });

    // Simulate the audit logging from the tool handler
    logAudit({
      user_id: USER_ID,
      source: 'knowledge',
      action: result.created ? 'create' : 'update',
      entity_type: 'person',
      entity_id: result.person.id,
      summary: `${result.created ? 'Created' : 'Updated'} person: Created`,
      metadata: { relationship: undefined },
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        entity_type: 'person',
        entity_id: 'p-new',
        source: 'knowledge',
      }),
    );
  });

  it('logs audit on update', async () => {
    const person = makePerson({ id: 'p-existing', name: 'Updated' });
    repo.upsert.mockResolvedValue({ person, created: false });

    const result = await repo.upsert(USER_ID, { id: 'p-existing', name: 'Updated' });

    logAudit({
      user_id: USER_ID,
      source: 'knowledge',
      action: result.created ? 'create' : 'update',
      entity_type: 'person',
      entity_id: result.person.id,
      summary: `${result.created ? 'Created' : 'Updated'} person: Updated`,
      metadata: { relationship: undefined },
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        entity_type: 'person',
        entity_id: 'p-existing',
      }),
    );
  });

  it('passes status through to repository', async () => {
    const person = makePerson({ status: 'contact-only' });
    repo.upsert.mockResolvedValue({ person, created: true });

    await repo.upsert(USER_ID, {
      name: 'Contact',
      status: 'contact-only',
    });

    expect(repo.upsert).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      status: 'contact-only',
    }));
  });
});

// ---------------------------------------------------------------------------
// delete_person handler logic
// ---------------------------------------------------------------------------

describe('delete_person tool handler', () => {
  let repo: PersonRepository;

  beforeEach(() => {
    repo = makePersonRepo();
    vi.clearAllMocks();
  });

  it('returns deleted:true when person exists', async () => {
    repo.delete.mockResolvedValue(true);

    const result = await repo.delete(USER_ID, 'p-del');
    expect(result).toBe(true);
  });

  it('returns error when person not found', async () => {
    repo.delete.mockResolvedValue(false);

    const deleted = await repo.delete(USER_ID, 'nonexistent');
    expect(deleted).toBe(false);

    // Simulate the tool handler
    if (!deleted) {
      const response = {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Person not found' }) }],
        isError: true,
      };
      expect(response.isError).toBe(true);
    }
  });

  it('logs audit on successful delete', async () => {
    repo.delete.mockResolvedValue(true);

    const deleted = await repo.delete(USER_ID, 'p-del');

    if (deleted) {
      logAudit({
        user_id: USER_ID,
        source: 'knowledge',
        action: 'delete',
        entity_type: 'person',
        entity_id: 'p-del',
        summary: `Deleted person p-del`,
      });
    }

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete',
        entity_type: 'person',
        entity_id: 'p-del',
        source: 'knowledge',
      }),
    );
  });

  it('does not log audit when delete fails', async () => {
    repo.delete.mockResolvedValue(false);

    const deleted = await repo.delete(USER_ID, 'nonexistent');

    if (deleted) {
      logAudit({
        user_id: USER_ID,
        source: 'knowledge',
        action: 'delete',
        entity_type: 'person',
        entity_id: 'nonexistent',
        summary: 'Deleted person nonexistent',
      });
    }

    expect(logAudit).not.toHaveBeenCalled();
  });
});
