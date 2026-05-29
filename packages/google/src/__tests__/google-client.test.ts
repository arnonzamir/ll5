import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthTokenRepository, OAuthTokenRecord } from '../repositories/interfaces/oauth-token.repository.js';
import type { GoogleClientConfig } from '../utils/google-client.js';

// ---------------------------------------------------------------------------
// Mock: logger (capture log lines for the deterministic-logging assertion)
// ---------------------------------------------------------------------------
const loggerInfo = vi.fn();
const loggerError = vi.fn();
vi.mock('../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: loggerError, debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: googleapis — the OAuth2 client is the external boundary. We control
// what refreshAccessToken() returns so we can simulate Google rotating the
// refresh token.
// ---------------------------------------------------------------------------
const { mockSetCredentials, mockRefreshAccessToken } = vi.hoisted(() => ({
  mockSetCredentials: vi.fn(),
  mockRefreshAccessToken: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = mockSetCredentials;
        refreshAccessToken = mockRefreshAccessToken;
      },
    },
  },
}));

const USER_ID = 'user-refresh-test-1';
const OTHER_USER_ID = 'user-refresh-test-2';

const GOOGLE_CONFIG: GoogleClientConfig = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://example.com/cb',
};

function makeTokenRecord(overrides: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord {
  return {
    user_id: USER_ID,
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    token_type: 'Bearer',
    // expired so the refresh path runs
    expires_at: new Date(Date.now() - 10_000),
    scopes: ['calendar.readonly'],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTokenRepo(record: OAuthTokenRecord, overrides: Partial<OAuthTokenRepository> = {}): OAuthTokenRepository {
  return {
    store: vi.fn(),
    get: vi.fn().mockResolvedValue(record),
    updateAccessToken: vi.fn(),
    updateRefreshToken: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as OAuthTokenRepository;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAuthenticatedClient — refresh token rotation', () => {
  it('persists a rotated refresh_token when Google returns a new one', async () => {
    const record = makeTokenRecord();
    const repo = makeTokenRepo(record);
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'new-access',
        refresh_token: 'ROTATED-refresh',
        expiry_date: Date.now() + 3600_000,
      },
    });

    const { getAuthenticatedClient } = await import('../utils/google-client.js');
    await getAuthenticatedClient(GOOGLE_CONFIG, repo, USER_ID);

    // access token still persisted
    expect(repo.updateAccessToken).toHaveBeenCalledWith(USER_ID, 'new-access', expect.any(Date));
    // the rotated refresh token MUST be persisted, scoped to the user
    expect((repo as unknown as { updateRefreshToken: ReturnType<typeof vi.fn> }).updateRefreshToken)
      .toHaveBeenCalledWith(USER_ID, 'ROTATED-refresh');
    // deterministic log line
    expect(loggerInfo).toHaveBeenCalledWith(
      'google_refresh_token_rotated',
      expect.objectContaining({ user_id: USER_ID }),
    );
  });

  it('does NOT persist a refresh_token when Google returns the same one', async () => {
    const record = makeTokenRecord({ refresh_token: 'same-refresh' });
    const repo = makeTokenRepo(record);
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'new-access',
        refresh_token: 'same-refresh',
        expiry_date: Date.now() + 3600_000,
      },
    });

    const { getAuthenticatedClient } = await import('../utils/google-client.js');
    await getAuthenticatedClient(GOOGLE_CONFIG, repo, USER_ID);

    expect((repo as unknown as { updateRefreshToken: ReturnType<typeof vi.fn> }).updateRefreshToken)
      .not.toHaveBeenCalled();
  });

  it('does NOT persist a refresh_token when Google omits it (common case)', async () => {
    const record = makeTokenRecord();
    const repo = makeTokenRepo(record);
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'new-access',
        expiry_date: Date.now() + 3600_000,
      },
    });

    const { getAuthenticatedClient } = await import('../utils/google-client.js');
    await getAuthenticatedClient(GOOGLE_CONFIG, repo, USER_ID);

    expect((repo as unknown as { updateRefreshToken: ReturnType<typeof vi.fn> }).updateRefreshToken)
      .not.toHaveBeenCalled();
  });

  it('scopes the rotated refresh token to the correct user', async () => {
    const record = makeTokenRecord({ user_id: OTHER_USER_ID, refresh_token: 'old-other' });
    const repo = makeTokenRepo(record);
    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'new-access',
        refresh_token: 'rotated-other',
        expiry_date: Date.now() + 3600_000,
      },
    });

    const { getAuthenticatedClient } = await import('../utils/google-client.js');
    await getAuthenticatedClient(GOOGLE_CONFIG, repo, OTHER_USER_ID);

    expect((repo as unknown as { updateRefreshToken: ReturnType<typeof vi.fn> }).updateRefreshToken)
      .toHaveBeenCalledWith(OTHER_USER_ID, 'rotated-other');
  });
});
