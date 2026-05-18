import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountRepository, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import { captureTools, parseToolResponse } from './_helpers.js';

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: EvolutionClient — both instance methods and static createInstance.
// These are vi.fn so individual tests can mockResolvedValue / mockRejectedValue.
// ---------------------------------------------------------------------------
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockCreateInstance = vi.fn();

vi.mock('../clients/evolution.client.js', () => {
  class MockEvolutionClient {
    constructor(public baseUrl: string, public instanceName: string, public apiKey: string) {}
    connect = mockConnect;
    logout = mockLogout;
    static createInstance = mockCreateInstance;
  }
  return { EvolutionClient: MockEvolutionClient };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'test-user-id';
const getUserId = () => USER_ID;
// 32-byte hex (64 chars) is required by the real encrypt() helper.
const ENCRYPTION_KEY = 'a'.repeat(64);

function makeWhatsAppAccount(overrides: Partial<WhatsAppAccountRecord> = {}): WhatsAppAccountRecord {
  return {
    id: 'account-1',
    user_id: USER_ID,
    instance_name: 'll5',
    instance_id: 'inst-1',
    api_url: 'https://evo.example.com',
    api_key: 'decrypted-api-key',
    phone_number: '+972501111111',
    status: 'connected',
    last_error: null,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeAccountRepo(overrides: Partial<AccountRepository> = {}): AccountRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`AccountRepository.${name} not stubbed for this test`);
  });
  return {
    listWhatsApp: unimpl('listWhatsApp'),
    listTelegram: unimpl('listTelegram'),
    getWhatsApp: unimpl('getWhatsApp'),
    getTelegram: unimpl('getTelegram'),
    findAccountPlatform: unimpl('findAccountPlatform'),
    updateStatus: unimpl('updateStatus'),
    touchLastSeen: unimpl('touchLastSeen'),
    getMessageCountToday: unimpl('getMessageCountToday'),
    logSentMessage: unimpl('logSentMessage'),
    createWhatsApp: unimpl('createWhatsApp'),
    ...overrides,
  } as AccountRepository;
}

// ===========================================================================
// get_pairing_qr
// ===========================================================================

describe('get_pairing_qr tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ACCOUNT_NOT_FOUND when repo returns null; scoped to user_id', async () => {
    const getWhatsApp = vi.fn(async () => null);
    const repo = makeAccountRepo({ getWhatsApp });

    const { registerGetPairingQrTool } = await import('../tools/get-pairing-qr.js');
    const tools = captureTools((s) => registerGetPairingQrTool(s, repo, getUserId));

    const response = await tools.get('get_pairing_qr')!({ account_id: 'missing' });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'missing');
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns QR base64 + pairing code from Evolution; flips status to qr_pending', async () => {
    const account = makeWhatsAppAccount();
    const getWhatsApp = vi.fn(async () => account);
    const updateStatus = vi.fn(async () => undefined);
    const repo = makeAccountRepo({ getWhatsApp, updateStatus });

    mockConnect.mockResolvedValue({ base64: 'data:image/png;base64,FAKEQR', pairingCode: 'ABCD-1234' });

    const { registerGetPairingQrTool } = await import('../tools/get-pairing-qr.js');
    const tools = captureTools((s) => registerGetPairingQrTool(s, repo, getUserId));

    const response = await tools.get('get_pairing_qr')!({ account_id: 'account-1' });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(USER_ID, 'account-1', 'whatsapp', 'qr_pending', null);

    const parsed = parseToolResponse<{ qr: { base64: string; pairing_code: string }; account_id: string }>(response);
    expect(parsed.qr.base64).toBe('data:image/png;base64,FAKEQR');
    expect(parsed.qr.pairing_code).toBe('ABCD-1234');
    expect(parsed.account_id).toBe('account-1');
  });

  it('returns PAIRING_QR_FAILED when Evolution throws', async () => {
    const account = makeWhatsAppAccount();
    const repo = makeAccountRepo({
      getWhatsApp: vi.fn(async () => account),
      updateStatus: vi.fn(async () => undefined),
    });

    mockConnect.mockRejectedValue(new Error('Evolution API error 404'));

    const { registerGetPairingQrTool } = await import('../tools/get-pairing-qr.js');
    const tools = captureTools((s) => registerGetPairingQrTool(s, repo, getUserId));

    const response = await tools.get('get_pairing_qr')!({ account_id: 'account-1' });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string; message: string }>(response);
    expect(parsed.error).toBe('PAIRING_QR_FAILED');
    expect(parsed.message).toContain('404');
  });
});

// ===========================================================================
// disconnect_whatsapp_account
// ===========================================================================

describe('disconnect_whatsapp_account tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ACCOUNT_NOT_FOUND when account missing; scoped to user_id', async () => {
    const getWhatsApp = vi.fn(async () => null);
    const repo = makeAccountRepo({ getWhatsApp });

    const { registerDisconnectWhatsAppAccountTool } = await import('../tools/disconnect-whatsapp-account.js');
    const tools = captureTools((s) => registerDisconnectWhatsAppAccountTool(s, repo, getUserId));

    const response = await tools.get('disconnect_whatsapp_account')!({ account_id: 'missing' });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'missing');
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('calls Evolution logout and marks status disconnected', async () => {
    const account = makeWhatsAppAccount();
    const getWhatsApp = vi.fn(async () => account);
    const updateStatus = vi.fn(async () => undefined);
    const repo = makeAccountRepo({ getWhatsApp, updateStatus });

    mockLogout.mockResolvedValue({ success: true });

    const { registerDisconnectWhatsAppAccountTool } = await import('../tools/disconnect-whatsapp-account.js');
    const tools = captureTools((s) => registerDisconnectWhatsAppAccountTool(s, repo, getUserId));

    const response = await tools.get('disconnect_whatsapp_account')!({ account_id: 'account-1' });

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(USER_ID, 'account-1', 'whatsapp', 'disconnected', null);

    const parsed = parseToolResponse<{ success: boolean; status: string }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe('disconnected');
  });

  it('returns LOGOUT_FAILED + message when Evolution throws', async () => {
    const account = makeWhatsAppAccount();
    const repo = makeAccountRepo({
      getWhatsApp: vi.fn(async () => account),
      updateStatus: vi.fn(async () => undefined),
    });

    mockLogout.mockRejectedValue(new Error('Evolution API error 500: server down'));

    const { registerDisconnectWhatsAppAccountTool } = await import('../tools/disconnect-whatsapp-account.js');
    const tools = captureTools((s) => registerDisconnectWhatsAppAccountTool(s, repo, getUserId));

    const response = await tools.get('disconnect_whatsapp_account')!({ account_id: 'account-1' });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string; message: string }>(response);
    expect(parsed.error).toBe('LOGOUT_FAILED');
    expect(parsed.message).toContain('500');
  });
});

// ===========================================================================
// provision_whatsapp_account
// ===========================================================================

describe('provision_whatsapp_account tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  const provisionConfig = {
    evolutionApiUrl: 'https://evo.example.com',
    evolutionGlobalApiKey: 'global-api-key',
    gatewayUrl: 'https://gateway.example.com',
    whatsappWebhookSecret: 'x'.repeat(40),
    encryptionKey: ENCRYPTION_KEY,
  };

  it('rejects with config error when EVOLUTION_API_URL not configured', async () => {
    const repo = makeAccountRepo();
    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, {
      ...provisionConfig, evolutionApiUrl: null,
    }, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('EVOLUTION_API_URL');
  });

  it('rejects with config error when EVOLUTION_GLOBAL_API_KEY not configured', async () => {
    const repo = makeAccountRepo();
    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, {
      ...provisionConfig, evolutionGlobalApiKey: null,
    }, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('EVOLUTION_GLOBAL_API_KEY');
  });

  it('rejects with config error when GATEWAY_URL not configured', async () => {
    const repo = makeAccountRepo();
    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, {
      ...provisionConfig, gatewayUrl: null,
    }, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('GATEWAY_URL');
  });

  it('rejects with config error when WHATSAPP_WEBHOOK_SECRET not configured', async () => {
    const repo = makeAccountRepo();
    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, {
      ...provisionConfig, whatsappWebhookSecret: null,
    }, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toContain('WHATSAPP_WEBHOOK_SECRET');
  });

  it('creates Evolution instance with prefilled webhook, persists encrypted api_key, returns QR', async () => {
    const createWhatsApp = vi.fn(async () => makeWhatsAppAccount({
      id: 'new-account-1',
      instance_name: 'll5_test',
      instance_id: 'inst-new',
      status: 'disconnected',
    }));
    const updateStatus = vi.fn(async () => undefined);
    const repo = makeAccountRepo({ createWhatsApp, updateStatus });

    mockCreateInstance.mockResolvedValue({
      instanceId: 'inst-new',
      instanceName: 'll5_test',
      apiKey: 'evolution-per-instance-key',
      qrBase64: 'data:image/png;base64,QQRR',
      pairingCode: 'WXYZ-9999',
    });

    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, provisionConfig, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5_test' });

    // Webhook URL was assembled from gatewayUrl + /webhook/whatsapp
    expect(mockCreateInstance).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateInstance.mock.calls[0];
    expect(callArgs[0]).toBe(provisionConfig.evolutionApiUrl);
    expect(callArgs[1]).toBe(provisionConfig.evolutionGlobalApiKey);
    expect(callArgs[2]).toMatchObject({
      instanceName: 'll5_test',
      webhookUrl: 'https://gateway.example.com/webhook/whatsapp',
      webhookSecret: provisionConfig.whatsappWebhookSecret,
    });

    // Repo: createWhatsApp got user_id + an *encrypted* api_key (not plaintext)
    expect(createWhatsApp).toHaveBeenCalledTimes(1);
    const createCall = createWhatsApp.mock.calls[0];
    expect(createCall[0]).toBe(USER_ID);
    expect(createCall[1].api_key_encrypted).not.toBe('evolution-per-instance-key');
    expect(createCall[1].api_key_encrypted).toMatch(/^[0-9a-f]+$/);
    expect(createCall[1].instance_id).toBe('inst-new');
    expect(createCall[1].instance_name).toBe('ll5_test');

    // Status flipped to qr_pending after creation
    expect(updateStatus).toHaveBeenCalledWith(USER_ID, 'new-account-1', 'whatsapp', 'qr_pending', null);

    // Response envelope
    const parsed = parseToolResponse<{ success: boolean; qr: { base64: string; pairing_code: string }; account: { id: string; status: string } }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.qr.base64).toBe('data:image/png;base64,QQRR');
    expect(parsed.qr.pairing_code).toBe('WXYZ-9999');
    expect(parsed.account.id).toBe('new-account-1');
    expect(parsed.account.status).toBe('qr_pending');
  });

  it('strips trailing slash from gatewayUrl when building webhook URL', async () => {
    const repo = makeAccountRepo({
      createWhatsApp: vi.fn(async () => makeWhatsAppAccount({ id: 'a' })),
      updateStatus: vi.fn(async () => undefined),
    });
    mockCreateInstance.mockResolvedValue({
      instanceId: 'i', instanceName: 'll5', apiKey: 'k', qrBase64: null, pairingCode: null,
    });

    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, {
      ...provisionConfig, gatewayUrl: 'https://gateway.example.com/',
    }, getUserId));

    await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });

    expect(mockCreateInstance.mock.calls[0][2].webhookUrl).toBe('https://gateway.example.com/webhook/whatsapp');
  });

  it('returns PROVISION_FAILED when Evolution createInstance throws', async () => {
    const repo = makeAccountRepo();
    mockCreateInstance.mockRejectedValue(new Error('Evolution createInstance 409: instance exists'));

    const { registerProvisionWhatsAppAccountTool } = await import('../tools/provision-whatsapp-account.js');
    const tools = captureTools((s) => registerProvisionWhatsAppAccountTool(s, repo, provisionConfig, getUserId));

    const response = await tools.get('provision_whatsapp_account')!({ instance_name: 'll5' });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string; message: string }>(response);
    expect(parsed.error).toBe('PROVISION_FAILED');
    expect(parsed.message).toContain('409');
  });
});
