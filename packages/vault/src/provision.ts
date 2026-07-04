/**
 * Tenant provisioning library (DECISION-022 tenant-scoping addendum).
 *
 * Everything the operator once did by hand (org create, invite, owner-confirm)
 * as a reusable library, extracted from scripts/bootstrap.ts. The MACHINE
 * ACCOUNT is the single Bitwarden identity this module acts as: it creates one
 * Organization PER TENANT (named "LL5 <first-8-of-userId>", one "agent"
 * collection each) and remains Owner of every tenant org — that is what lets
 * the bw sidecar read items across tenants while the mapping in gateway PG
 * (vault_tenants) decides which org a given user's requests may touch.
 *
 * Secrets: the machine master password comes from env (BW_PASSWORD/BW_EMAIL),
 * is used in-process for the Bitwarden client-side KDF, and is never logged or
 * returned. No credential ITEM content is ever read here — provisioning only
 * touches org/collection/membership objects.
 *
 * Crypto notes (all node:crypto, mirrors the official clients):
 * - master key   = PBKDF2-SHA256(password, lower(email), iterations, 32B)
 * - auth hash    = PBKDF2-SHA256(masterKey, password, 1, 32B) b64
 * - stretched    = HKDF-EXPAND(masterKey, "enc"/"mac", 32B each)
 * - EncString 2  = AES-256-CBC + HMAC-SHA256 ("2.iv|ct|mac")
 * - EncString 4  = RSA-2048-OAEP-SHA1 ("4.<b64>")
 */
import crypto from 'node:crypto';
import { logger } from './utils/logger.js';

export const DEFAULT_KDF_ITERATIONS = 600_000;

// ---------------------------------------------------------------------------
// Bitwarden client-side crypto primitives (shared with scripts/bootstrap.ts)
// ---------------------------------------------------------------------------

/** Master key: PBKDF2-SHA256(password, lowercased email, iterations, 32B). */
export function masterKey(password: string, email: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, email, iterations, 32, 'sha256');
}

/** Server-side auth hash: PBKDF2-SHA256(masterKey, password, 1, 32B) b64. */
export function masterPasswordHash(mk: Buffer, password: string): string {
  return crypto.pbkdf2Sync(mk, password, 1, 32, 'sha256').toString('base64');
}

/** HKDF-EXPAND only (Bitwarden treats the master key as the PRK). */
export function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(blocks).length < length) {
    prev = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([prev, Buffer.from(info, 'utf8'), Buffer.from([counter])]))
      .digest();
    blocks.push(prev);
    counter += 1;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** Stretched master key: 32B enc + 32B mac. */
export function stretchKey(mk: Buffer): { enc: Buffer; mac: Buffer } {
  return { enc: hkdfExpand(mk, 'enc', 32), mac: hkdfExpand(mk, 'mac', 32) };
}

/** EncString type 2 (AesCbc256_HmacSha256_B64): "2.iv|ct|mac". */
export function encryptType2(data: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

export function decryptType2(encString: string, encKey: Buffer, macKey: Buffer): Buffer {
  const [type, rest] = [encString.slice(0, encString.indexOf('.')), encString.slice(encString.indexOf('.') + 1)];
  if (type !== '2') throw new Error(`unsupported enc string type ${type}`);
  const [ivB64, ctB64, macB64] = rest.split('|');
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const expectedMac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ct])).digest();
  if (!crypto.timingSafeEqual(expectedMac, Buffer.from(macB64, 'base64'))) {
    throw new Error('enc string MAC mismatch (wrong key?)');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** EncString type 4 (Rsa2048_OaepSha1_B64): "4.<b64>". */
export function rsaEncryptType4(data: Buffer, publicKeyDer: Buffer): string {
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const ct = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    data,
  );
  return `4.${ct.toString('base64')}`;
}

export function rsaDecryptType4(encString: string, privateKeyDer: Buffer): Buffer {
  const b64 = encString.replace(/^4\./, '');
  const key = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  return crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(b64, 'base64'),
  );
}

// ---------------------------------------------------------------------------
// Tenant org naming
// ---------------------------------------------------------------------------

/** Per-tenant org name: "LL5 <first-8-of-userId>" (uuid prefix, no dashes in
 *  the first 8 chars of a v4 uuid). The mapping row is authoritative — the
 *  name is only for human recognition in the Vaultwarden UI. */
export function tenantOrgName(userId: string, prefix = 'LL5'): string {
  return `${prefix} ${userId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

export interface ProvisionerConfig {
  vaultUrl: string;
  /** Machine account credentials (same identity the bw sidecar uses). */
  machineEmail: string;
  machinePassword: string;
  /** Org name prefix (default "LL5") and per-org collection name ("agent"). */
  orgNamePrefix: string;
  collectionName: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface TenantOrgResult {
  orgId: string;
  collectionId: string;
  orgCreated: boolean;
  /** false when the user email was already a member (invite skipped). */
  invited: boolean;
}

export type MemberConfirmResult =
  | { status: 'confirmed'; email: string }
  | { status: 'already_confirmed'; email: string }
  | { status: 'not_accepted_yet'; email: string | null };

interface SyncProfile {
  id: string;
  key: string;
  privateKey: string;
  organizations: Array<{ id: string; name: string; key: string }>;
}

interface Session {
  token: string;
  profile: SyncProfile;
  privateKeyDer: Buffer;
  publicKeyDer: Buffer;
}

/** Bitwarden OrganizationUserStatusType. */
const MEMBER_INVITED = 0;
const MEMBER_ACCEPTED = 1;
const MEMBER_CONFIRMED = 2;

export class TenantProvisioner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ProvisionerConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** True when the machine-account credentials needed to provision are set. */
  get configured(): boolean {
    return Boolean(this.config.vaultUrl && this.config.machineEmail && this.config.machinePassword);
  }

  private async api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    return this.fetchImpl(`${this.config.vaultUrl}${path}`, { ...init, headers });
  }

  private async fail(step: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => '');
    // Response bodies here are Vaultwarden error envelopes — no secrets.
    throw new Error(`${step} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  /** Password-grant login as the machine account + profile sync + key unwrap. */
  private async login(): Promise<Session> {
    if (!this.configured) {
      throw new Error('vault provisioning is not configured (BW_EMAIL / BW_PASSWORD missing on the vault MCP)');
    }
    const email = this.config.machineEmail.trim().toLowerCase();

    // KDF params — Vaultwarden answers /prelogin for unknown emails too, so a
    // failure here is non-fatal; fall back to the registration default.
    let iterations = DEFAULT_KDF_ITERATIONS;
    const pre = await this.api('/api/accounts/prelogin', { method: 'POST', body: JSON.stringify({ email }) });
    if (pre.ok) {
      const body = (await pre.json()) as { kdf?: number; Kdf?: number; kdfIterations?: number; KdfIterations?: number };
      const kdf = body.kdf ?? body.Kdf ?? 0;
      if (kdf !== 0) throw new Error(`machine account uses KDF ${kdf} (argon2?) — only PBKDF2 is supported`);
      iterations = body.kdfIterations ?? body.KdfIterations ?? DEFAULT_KDF_ITERATIONS;
    }

    const mk = masterKey(this.config.machinePassword, email, iterations);
    const hash = masterPasswordHash(mk, this.config.machinePassword);
    const form = new URLSearchParams({
      grant_type: 'password',
      username: email,
      password: hash,
      scope: 'api offline_access',
      client_id: 'cli',
      deviceType: '8',
      deviceIdentifier: crypto.randomUUID(),
      deviceName: 'll5-vault-provisioner',
    });
    const res = await this.fetchImpl(`${this.config.vaultUrl}/identity/connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Vaultwarden requires the auth-email header on password grants.
        'auth-email': Buffer.from(email, 'utf8').toString('base64url'),
      },
      body: form.toString(),
    });
    if (!res.ok) await this.fail('machine-account login', res);
    const { access_token: token } = (await res.json()) as { access_token: string };

    const profile = await this.syncProfile(token);
    const stretched = stretchKey(mk);
    const symKey = decryptType2(profile.key, stretched.enc, stretched.mac);
    const privateKeyDer = decryptType2(profile.privateKey, symKey.subarray(0, 32), symKey.subarray(32, 64));
    const publicKeyDer = Buffer.from(
      crypto.createPublicKey(crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }))
        .export({ type: 'spki', format: 'der' }),
    );
    return { token, profile, privateKeyDer, publicKeyDer };
  }

  private async syncProfile(token: string): Promise<SyncProfile> {
    const res = await this.api('/api/sync?excludeDomains=true', { token });
    if (!res.ok) await this.fail('sync', res);
    const body = (await res.json()) as { profile?: SyncProfile; Profile?: SyncProfile };
    const profile = body.profile ?? body.Profile;
    if (!profile) throw new Error('sync returned no profile');
    return profile;
  }

  /**
   * Idempotently ensure the tenant org + "agent" collection exist and that
   * `userEmail` has an Owner invite (SMTP delivers the invite email).
   * Each step is skipped when already done, so retries are safe.
   */
  async createTenantOrg(userId: string, userEmail: string): Promise<TenantOrgResult> {
    const orgName = tenantOrgName(userId, this.config.orgNamePrefix);
    const email = userEmail.trim().toLowerCase();
    const session = await this.login();

    // 1. Org (default collection created with it).
    let org = session.profile.organizations?.find((o) => o.name === orgName);
    let orgKey: Buffer;
    let orgCreated = false;
    if (!org) {
      orgKey = crypto.randomBytes(64);
      const orgRsa = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      });
      const res = await this.api('/api/organizations', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({
          name: orgName,
          billingEmail: this.config.machineEmail,
          planType: 0, // Free
          key: rsaEncryptType4(orgKey, session.publicKeyDer),
          collectionName: encryptType2(Buffer.from(this.config.collectionName, 'utf8'), orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
          keys: {
            publicKey: orgRsa.publicKey.toString('base64'),
            encryptedPrivateKey: encryptType2(orgRsa.privateKey, orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
          },
        }),
      });
      if (!res.ok) await this.fail('create tenant organization', res);
      const created = (await res.json()) as { id?: string; Id?: string };
      const orgId = created.id ?? created.Id ?? '';
      if (!orgId) throw new Error('create tenant organization returned no id');
      org = { id: orgId, name: orgName, key: '' };
      orgCreated = true;
      logger.info('[TenantProvisioner][createTenantOrg] org created', { orgName });
    } else {
      orgKey = rsaDecryptType4(org.key, session.privateKeyDer);
    }

    // 2. Collection (covers pre-existing orgs / partial runs).
    const collectionId = await this.ensureCollection(session, org.id, orgKey);

    // 3. Owner invite for the tenant's human (skip if already a member).
    const members = await this.listMembers(session.token, org.id);
    const existing = members.find((m) => m.email.toLowerCase() === email);
    let invited = false;
    if (!existing) {
      const invite = await this.api(`/api/organizations/${org.id}/users/invite`, {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({
          emails: [email],
          type: 0, // Owner — the human fully controls their own tenant org
          accessAll: true,
          collections: [{ id: collectionId, readOnly: false, hidePasswords: false, manage: true }],
          groups: [],
          permissions: {},
        }),
      });
      if (!invite.ok) await this.fail('invite tenant user', invite);
      invited = true;
      logger.info('[TenantProvisioner][createTenantOrg] owner invite sent', { orgName });
    }

    return { orgId: org.id, collectionId, orgCreated, invited };
  }

  private async ensureCollection(session: Session, orgId: string, orgKey: Buffer): Promise<string> {
    const colRes = await this.api(`/api/organizations/${orgId}/collections`, { token: session.token });
    if (!colRes.ok) await this.fail('list collections', colRes);
    const colBody = (await colRes.json()) as { data?: Array<Record<string, string>>; Data?: Array<Record<string, string>> };
    const collections = (colBody.data ?? colBody.Data ?? []).map((c) => ({
      id: c.id ?? c.Id ?? '',
      name: c.name ?? c.Name ?? '',
    }));
    const decryptedName = (enc: string): string => {
      try { return decryptType2(enc, orgKey.subarray(0, 32), orgKey.subarray(32, 64)).toString('utf8'); }
      catch { return ''; }
    };
    const existing = collections.find((c) => decryptedName(c.name) === this.config.collectionName);
    if (existing) return existing.id;

    const createCol = await this.api(`/api/organizations/${orgId}/collections`, {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({
        name: encryptType2(Buffer.from(this.config.collectionName, 'utf8'), orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
        groups: [],
        users: [],
      }),
    });
    if (!createCol.ok) await this.fail('create collection', createCol);
    const created = (await createCol.json()) as { id?: string; Id?: string };
    const id = created.id ?? created.Id ?? '';
    if (!id) throw new Error('create collection returned no id');
    return id;
  }

  private async listMembers(token: string, orgId: string): Promise<Array<{ id: string; userId: string | null; email: string; status: number }>> {
    const res = await this.api(`/api/organizations/${orgId}/users`, { token });
    if (!res.ok) await this.fail('list org members', res);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>>; Data?: Array<Record<string, unknown>> };
    return (body.data ?? body.Data ?? []).map((m) => ({
      id: String(m.id ?? m.Id ?? ''),
      userId: (m.userId ?? m.UserId) ? String(m.userId ?? m.UserId) : null,
      email: String(m.email ?? m.Email ?? ''),
      status: Number(m.status ?? m.Status ?? MEMBER_INVITED),
    }));
  }

  /**
   * Owner-confirm step: after the tenant's human accepted the emailed invite,
   * re-encrypt the org key to their public key and confirm the membership
   * (what `bw confirm org-member` does). Confirms the first non-machine member
   * in "accepted" state — a tenant org only ever has the machine account plus
   * its one human.
   */
  async confirmMember(orgId: string): Promise<MemberConfirmResult> {
    const session = await this.login();
    const org = session.profile.organizations?.find((o) => o.id === orgId);
    if (!org) throw new Error(`machine account is not a member of org ${orgId} — cannot confirm`);
    const orgKey = rsaDecryptType4(org.key, session.privateKeyDer);

    const machineEmail = this.config.machineEmail.trim().toLowerCase();
    const members = (await this.listMembers(session.token, orgId))
      .filter((m) => m.email.toLowerCase() !== machineEmail);

    const confirmed = members.find((m) => m.status === MEMBER_CONFIRMED);
    if (confirmed) return { status: 'already_confirmed', email: confirmed.email };

    const accepted = members.find((m) => m.status === MEMBER_ACCEPTED && m.userId);
    if (!accepted) {
      const invited = members.find((m) => m.status === MEMBER_INVITED);
      return { status: 'not_accepted_yet', email: invited?.email ?? null };
    }

    // Member's public key → org key encrypted to them → confirm.
    const pkRes = await this.api(`/api/users/${accepted.userId}/public-key`, { token: session.token });
    if (!pkRes.ok) await this.fail('fetch member public key', pkRes);
    const pkBody = (await pkRes.json()) as { publicKey?: string; PublicKey?: string };
    const publicKeyB64 = pkBody.publicKey ?? pkBody.PublicKey;
    if (!publicKeyB64) throw new Error('member public key response was empty');

    const confirmRes = await this.api(`/api/organizations/${orgId}/users/${accepted.id}/confirm`, {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({ key: rsaEncryptType4(orgKey, Buffer.from(publicKeyB64, 'base64')) }),
    });
    if (!confirmRes.ok) await this.fail('confirm org member', confirmRes);
    logger.info('[TenantProvisioner][confirmMember] member confirmed', { orgId });
    return { status: 'confirmed', email: accepted.email };
  }
}
