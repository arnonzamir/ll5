# Testing Standard

This document defines what counts as a real test in LL5, and what counts as theater. Every new test must be real. Existing theater is being rewritten in Phase 0 of the hardening plan.

## The single rule

**A test must import and invoke the code it claims to test.**

If the test file does not `import` the symbol under test, the test is theater. If the test sets up mocks and then calls the mocks directly instead of calling the real code, the test is theater.

## Boundary rules — what to mock

Mock at the *external* boundary, not at the code-under-test boundary.

| Code under test | Mock at | Do NOT mock |
|-----------------|---------|-------------|
| Repository method | `pg.Pool` or `@elastic/elasticsearch.Client` | the repository class itself |
| Tool handler | the repository (via its TypeScript interface) | the tool registration function |
| Route handler | `pg.Pool`, downstream HTTP via `fetch` mock | the Express handler |
| Pure helper | nothing — just call it | n/a |
| State machine (retry loops, transactions) | nothing — use testcontainers Postgres | the state machine |

## Test shapes by category

### Repository tests
- Import the real repository class.
- Construct it with a mock `pg.Pool` / `Client` (use a helper like `makeMockPool([rows])`).
- Call the repo method.
- Assert on (a) the SQL/query DSL the mock received, AND (b) the return value the method produced from the mocked response.

**Reference:** `packages/gateway/src/__tests__/notification-rules.test.ts`. It imports `NotificationRuleMatcher`, builds it with a mock pool, calls `matcher.match()`, and asserts on the result.

### Tool handler tests
- Import the real `registerXxxTools` function from the package.
- Capture the registered handler with a stub `McpServer` that records `tool()` calls.
- Pass a stub repository (implement only the methods the test exercises).
- Invoke the captured handler with real input.
- Assert on the MCP response envelope (`{ content: [{ type: 'text', text: ... }], isError? }`).

**Helper pattern** (lives in each MCP's `__tests__/_helpers.ts`):

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolHandler = (params: unknown) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

export function captureTools(
  register: (s: McpServer) => void,
): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: ToolHandler,
    ) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  register(fakeServer);
  return tools;
}
```

### Route handler tests
- Import the real route module (`createChatRouter`, `createAdminRouter`, etc.).
- Mount it on a real `express()` app.
- Drive it with `supertest` or by extracting the handler and calling it with mocked `req`/`res`.
- Mock at `pg.Pool` and outbound `fetch` only.

**Reference:** `packages/gateway/src/__tests__/chat-conversations.test.ts`.

### Pure helper tests
- Import the helper. Call it. Assert on the return value.
- No mocks needed.

### State machine / race condition tests
- Use `testcontainers` to spin up a real Postgres for the test file.
- One container per `describe` block, reused across tests via `beforeAll`.
- Test the actual concurrent behavior — don't mock the conflict.
- Expected runtime: a few seconds per file. Acceptable.

## What disqualifies a test

These shapes are theater regardless of intent. Reject them in review.

### 1. The test calls the mock directly
```ts
// THEATER
await pool.query('INSERT INTO ...', [USER_ID, 'New Action']);
expect(pool.query).toHaveBeenCalledWith('INSERT INTO ...', [USER_ID, 'New Action']);
```
The test set up the mock, called the mock itself, and asserted the mock was called. The real handler was never touched.

### 2. The test re-derives logic inline
```ts
// THEATER
const energy = (data as Record<string, unknown>).energy ?? 'medium';
expect(energy).toBe('medium');
```
This tests JavaScript's `??` operator, not the system.

### 3. The test inlines a copy of the code under test
```ts
// THEATER — even though it looks like a unit test
function docToPerson(doc) { /* copy of the real implementation */ }

it('maps doc to person', () => {
  expect(docToPerson(doc)).toEqual(...);
});
```
If the real `docToPerson` changes, this test stays green. The inlined copy is what's tested. If you can't import the real one, fix the build before writing the test.

### 4. The test asserts on an object literal it just constructed
```ts
// THEATER
const stats = { stress: 5, energy: 7 };
expect(stats.stress).toBe(5);
```

## When to use each test layer

- **Default to repository + tool-handler tests.** These cover the contract that matters.
- **Add integration (testcontainers) tests** for: retry loops, transactions, anything where the bug class is "two requests at the same time."
- **Pure helper tests** only for genuinely pure helpers — date math, string normalization, mapping functions.

## Multi-tenancy assertion (mandatory)

Every repository method test MUST include at least one assertion that proves `user_id` scoping:

```ts
// In a repo list test
expect(pool.query).toHaveBeenCalledWith(
  expect.stringMatching(/WHERE.*user_id = \$\d/),
  expect.arrayContaining([USER_ID]),
);
```

This is the single most important property of LL5 and the easiest to silently break. No `user_id` assertion → not a passing review.

## Reference implementations

Use these as templates when writing new tests. Do NOT use `person-repository.test.ts` as a template — it inlines `docToPerson` and bypasses the real repository class, which is the exact pattern this doc disallows. It is on the list to be rewritten.

| Layer | Reference file |
|-------|---------------|
| Repository (class + real mock) | `packages/gateway/src/__tests__/notification-rules.test.ts` |
| Function with side effects | `packages/gateway/src/__tests__/message-processor.test.ts` |
| Webhook processor | `packages/gateway/src/__tests__/whatsapp-webhook.test.ts` |
| Route handler with Express | `packages/gateway/src/__tests__/chat-conversations.test.ts` |
| Pure helper | `packages/messaging/src/__tests__/encryption.test.ts` |
| Auth primitive | `packages/shared/src/__tests__/auth.test.ts` |

## Running tests

```bash
npm test                     # all packages
npm test -w packages/gtd     # one package
npx vitest run               # inside a package, single run
npx vitest                   # inside a package, watch mode
```

Tests must pass before commit. The pre-commit hook is being extended to enforce `npm test`.
