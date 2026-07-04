#!/usr/bin/env tsx
/**
 * One-time OPERATOR bootstrap for DECISION-022 (NOT an MCP tool).
 *
 * Run from the repo (or any machine that can reach the Vaultwarden URL):
 *
 *   VAULT_URL=https://vault.noninoni.click \
 *   BOOTSTRAP_EMAIL=ll5-agent@noninoni.click \
 *   BOOTSTRAP_MASTER_PASSWORD='<machine account master password>' \
 *   USER_EMAIL=<human's email> \
 *   npm run bootstrap --workspace=packages/vault
 *
 * What it does (idempotent-ish — each step is skipped when already done):
 *   1. Registers the MACHINE ACCOUNT against Vaultwarden
 *      (client-side Bitwarden KDF: PBKDF2-SHA256 master key → HKDF-expand
 *      stretched key → AES-CBC-HMAC protected symmetric key + RSA keypair).
 *   2. Logs in (password grant) and fetches/rotates nothing — read-only sync.
 *   3. Creates the "LL5" organization with default collection "agent"
 *      (org key RSA-OAEP-SHA1-encrypted to the machine account).
 *   4. Invites USER_EMAIL to the org as an OWNER (the human manages items).
 *   5. Prints the machine account's API key (BW_CLIENTID / BW_CLIENTSECRET)
 *      for the Coolify env of the vault MCP.
 *
 * Secrets: the master password is read from env, used in-process, and
 * printed NOWHERE. The API key IS printed — that is the operator handoff.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const VAULT_URL = (process.env.VAULT_URL ?? '').replace(/\/+$/, '');
const EMAIL = (process.env.BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
const PASSWORD = process.env.BOOTSTRAP_MASTER_PASSWORD ?? '';
const USER_EMAIL = (process.env.USER_EMAIL ?? '').trim().toLowerCase();
const ORG_NAME = process.env.VAULT_ORG_NAME || 'LL5';
const COLLECTION_NAME = process.env.VAULT_COLLECTION_NAME || 'agent';
const KDF_ITERATIONS = 600_000;

if (!VAULT_URL || !EMAIL || !PASSWORD || !USER_EMAIL) {
  console.error('Required env: VAULT_URL, BOOTSTRAP_EMAIL, BOOTSTRAP_MASTER_PASSWORD, USER_EMAIL');
  process.exit(1);
}

const did: string[] = [];
const todo: string[] = [];

// ---------------------------------------------------------------------------
// Bitwarden client-side crypto (node:crypto only)
// ---------------------------------------------------------------------------

/** Master key: PBKDF2-SHA256(password, lowercased email, iterations, 32B). */
function masterKey(password: string, email: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, email, iterations, 32, 'sha256');
}

/** Server-side auth hash: PBKDF2-SHA256(masterKey, password, 1, 32B) b64. */
function masterPasswordHash(mk: Buffer, password: string): string {
  return crypto.pbkdf2Sync(mk, password, 1, 32, 'sha256').toString('base64');
}

/** HKDF-EXPAND only (Bitwarden treats the master key as the PRK). */
function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
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
function stretchKey(mk: Buffer): { enc: Buffer; mac: Buffer } {
  return { enc: hkdfExpand(mk, 'enc', 32), mac: hkdfExpand(mk, 'mac', 32) };
}

/** EncString type 2 (AesCbc256_HmacSha256_B64): "2.iv|ct|mac". */
function encryptType2(data: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

function decryptType2(encString: string, encKey: Buffer, macKey: Buffer): Buffer {
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
function rsaEncryptType4(data: Buffer, publicKeyDer: Buffer): string {
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const ct = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    data,
  );
  return `4.${ct.toString('base64')}`;
}

function rsaDecryptType4(encString: string, privateKeyDer: Buffer): Buffer {
  const b64 = encString.replace(/^4\./, '');
  const key = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  return crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(b64, 'base64'),
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return fetch(`${VAULT_URL}${path}`, { ...init, headers });
}

async function fail(step: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new Error(`${step} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function preloginIterations(): Promise<number | null> {
  const res = await api('/api/accounts/prelogin', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
  if (!res.ok) return null;
  const body = (await res.json()) as { kdf?: number; Kdf?: number; kdfIterations?: number; KdfIterations?: number };
  const kdf = body.kdf ?? body.Kdf ?? 0;
  if (kdf !== 0) throw new Error(`account uses KDF ${kdf} (argon2?) — this script only supports PBKDF2`);
  return body.kdfIterations ?? body.KdfIterations ?? KDF_ITERATIONS;
}

async function registerAccount(): Promise<void> {
  const mk = masterKey(PASSWORD, EMAIL, KDF_ITERATIONS);
  const hash = masterPasswordHash(mk, PASSWORD);
  const stretched = stretchKey(mk);

  // User symmetric key: 64 random bytes (32 enc + 32 mac), protected by the stretched key.
  const symKey = crypto.randomBytes(64);
  const protectedKey = encryptType2(symKey, stretched.enc, stretched.mac);

  // RSA keypair; private key protected by the symmetric key.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const encryptedPrivateKey = encryptType2(privateKey, symKey.subarray(0, 32), symKey.subarray(32, 64));

  const res = await api('/api/accounts/register', {
    method: 'POST',
    body: JSON.stringify({
      email: EMAIL,
      name: 'LL5 agent (machine account)',
      masterPasswordHash: hash,
      masterPasswordHint: null,
      key: protectedKey,
      keys: { publicKey: publicKey.toString('base64'), encryptedPrivateKey },
      kdf: 0,
      kdfIterations: KDF_ITERATIONS,
    }),
  });
  if (res.ok) {
    did.push(`Registered machine account ${EMAIL}`);
    return;
  }
  const body = await res.text().catch(() => '');
  if (/already|exists|registered/i.test(body)) {
    did.push(`Machine account ${EMAIL} already registered — skipped`);
    return;
  }
  throw new Error(`register failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

async function login(iterations: number): Promise<{ token: string; mk: Buffer }> {
  const mk = masterKey(PASSWORD, EMAIL, iterations);
  const hash = masterPasswordHash(mk, PASSWORD);
  const form = new URLSearchParams({
    grant_type: 'password',
    username: EMAIL,
    password: hash,
    scope: 'api offline_access',
    client_id: 'cli',
    deviceType: '8',
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'll5-vault-bootstrap',
  });
  const res = await fetch(`${VAULT_URL}/identity/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Vaultwarden requires the auth-email header on password grants.
      'auth-email': Buffer.from(EMAIL, 'utf8').toString('base64url'),
    },
    body: form.toString(),
  });
  if (!res.ok) await fail('login (password grant)', res);
  const body = (await res.json()) as { access_token: string };
  return { token: body.access_token, mk };
}

interface SyncProfile {
  profile: {
    id: string;
    key: string;            // protected symmetric key (type 2)
    privateKey: string;     // encrypted private key (type 2, under sym key)
    organizations: Array<{ id: string; name: string; key: string }>; // org key type 4
  };
}

async function syncProfile(token: string): Promise<SyncProfile['profile']> {
  const res = await api('/api/sync?excludeDomains=true', { token });
  if (!res.ok) await fail('sync', res);
  const body = (await res.json()) as SyncProfile & { Profile?: SyncProfile['profile'] };
  return body.profile ?? (body as unknown as { Profile: SyncProfile['profile'] }).Profile;
}

async function main(): Promise<void> {
  console.log(`Bootstrapping vault at ${VAULT_URL} for machine account ${EMAIL}`);

  // 1+2. Login-first (Vaultwarden answers /prelogin with default KDF params for
  // UNKNOWN emails too, so prelogin success does NOT imply the account exists —
  // learned live 2026-07-04). Try to log in; only on auth failure, register and
  // log in again.
  let token: string;
  let mk: Buffer;
  try {
    const iterations = (await preloginIterations()) ?? KDF_ITERATIONS;
    ({ token, mk } = await login(iterations));
    did.push(`Machine account ${EMAIL} already exists — logged in, register skipped`);
  } catch {
    await registerAccount();
    const iterations = (await preloginIterations()) ?? KDF_ITERATIONS;
    ({ token, mk } = await login(iterations));
    did.push('Registered machine account + logged in');
  }

  const profile = await syncProfile(token);
  const stretched = stretchKey(mk);
  const symKey = decryptType2(profile.key, stretched.enc, stretched.mac);
  const privateKeyDer = decryptType2(profile.privateKey, symKey.subarray(0, 32), symKey.subarray(32, 64));
  const publicKeyDer = Buffer.from(
    crypto.createPublicKey(crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }))
      .export({ type: 'spki', format: 'der' }),
  );

  // 3. Organization "LL5" (+ default collection "agent" at creation time).
  let org = profile.organizations?.find((o) => o.name === ORG_NAME);
  let orgKey: Buffer;
  if (!org) {
    orgKey = crypto.randomBytes(64);
    const orgRsa = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const res = await api('/api/organizations', {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: ORG_NAME,
        billingEmail: EMAIL,
        planType: 0, // Free
        key: rsaEncryptType4(orgKey, publicKeyDer),
        collectionName: encryptType2(Buffer.from(COLLECTION_NAME, 'utf8'), orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
        keys: {
          publicKey: orgRsa.publicKey.toString('base64'),
          encryptedPrivateKey: encryptType2(orgRsa.privateKey, orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
        },
      }),
    });
    if (!res.ok) await fail('create organization', res);
    const created = (await res.json()) as { id: string; Id?: string };
    org = { id: created.id ?? created.Id ?? '', name: ORG_NAME, key: '' };
    did.push(`Created organization "${ORG_NAME}" with default collection "${COLLECTION_NAME}"`);
    // Re-sync so the org id is definitely correct; we already hold the org key.
    const refreshed = await syncProfile(token);
    const fresh = refreshed.organizations?.find((o) => o.name === ORG_NAME);
    if (fresh) org = fresh;
  } else {
    did.push(`Organization "${ORG_NAME}" already exists — skipped`);
    orgKey = rsaDecryptType4(org.key, privateKeyDer);
  }

  // 3b. Ensure the collection exists (covers pre-existing orgs).
  const colRes = await api(`/api/organizations/${org.id}/collections`, { token });
  if (!colRes.ok) await fail('list collections', colRes);
  const colBody = (await colRes.json()) as { data?: Array<{ id: string; name: string }>; Data?: Array<{ Id: string; Name: string }> };
  const collections = (colBody.data ?? colBody.Data ?? []).map((c) => ({
    id: (c as { id?: string; Id?: string }).id ?? (c as { Id?: string }).Id ?? '',
    name: (c as { name?: string; Name?: string }).name ?? (c as { Name?: string }).Name ?? '',
  }));
  const decryptedName = (enc: string): string => {
    try { return decryptType2(enc, orgKey.subarray(0, 32), orgKey.subarray(32, 64)).toString('utf8'); }
    catch { return ''; }
  };
  let collection = collections.find((c) => decryptedName(c.name) === COLLECTION_NAME);
  if (!collection) {
    const createCol = await api(`/api/organizations/${org.id}/collections`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: encryptType2(Buffer.from(COLLECTION_NAME, 'utf8'), orgKey.subarray(0, 32), orgKey.subarray(32, 64)),
        groups: [],
        users: [],
      }),
    });
    if (!createCol.ok) await fail('create collection', createCol);
    const createdCol = (await createCol.json()) as { id?: string; Id?: string };
    collection = { id: createdCol.id ?? createdCol.Id ?? '', name: COLLECTION_NAME };
    did.push(`Created collection "${COLLECTION_NAME}"`);
  } else {
    did.push(`Collection "${COLLECTION_NAME}" already exists — skipped`);
  }

  // 4. Invite the human as OWNER.
  const membersRes = await api(`/api/organizations/${org.id}/users`, { token });
  const membersBody = membersRes.ok
    ? ((await membersRes.json()) as { data?: Array<{ email?: string; Email?: string }>; Data?: Array<{ Email?: string }> })
    : { data: [] };
  const memberEmails = (membersBody.data ?? membersBody.Data ?? [])
    .map((m) => ((m as { email?: string; Email?: string }).email ?? (m as { Email?: string }).Email ?? '').toLowerCase());
  if (memberEmails.includes(USER_EMAIL)) {
    did.push(`${USER_EMAIL} is already a member of "${ORG_NAME}" — invite skipped`);
  } else {
    const invite = await api(`/api/organizations/${org.id}/users/invite`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        emails: [USER_EMAIL],
        type: 0, // Owner — the human fully controls the org and its items
        accessAll: true,
        collections: [{ id: collection.id, readOnly: false, hidePasswords: false, manage: true }],
        groups: [],
        permissions: {},
      }),
    });
    if (!invite.ok) await fail('invite user', invite);
    did.push(`Invited ${USER_EMAIL} to "${ORG_NAME}" as Owner`);
    todo.push(`${USER_EMAIL}: accept the org invite in the web vault (${VAULT_URL}) — if SMTP is off in Vaultwarden, confirm the invite from the Vaultwarden /admin page instead.`);
  }

  // 5. Machine account API key for the vault MCP env.
  const mkForHash = mk;
  const apiKeyRes = await api('/api/accounts/api-key', {
    method: 'POST',
    token,
    body: JSON.stringify({ masterPasswordHash: masterPasswordHash(mkForHash, PASSWORD) }),
  });
  if (apiKeyRes.ok) {
    const apiKey = (await apiKeyRes.json()) as { apiKey?: string; ApiKey?: string };
    console.log('\n--- Coolify env for the vault MCP (handle as secrets) ---');
    console.log(`BW_CLIENTID=user.${profile.id}`);
    console.log(`BW_CLIENTSECRET=${apiKey.apiKey ?? apiKey.ApiKey}`);
    console.log('BW_PASSWORD=<the BOOTSTRAP_MASTER_PASSWORD you used>');
    console.log(`VAULT_URL=${VAULT_URL}`);
  } else {
    todo.push('Fetch the machine account API key manually: web vault → Settings → Security → Keys (BW_CLIENTID/BW_CLIENTSECRET).');
  }

  console.log('\n=== Done ===');
  for (const d of did) console.log(`  [done] ${d}`);
  todo.push(`Move the credentials the agent may use into the "${ORG_NAME}" org / "${COLLECTION_NAME}" collection — that act IS the per-item permission grant.`);
  todo.push('Set the env vars above on the vault MCP service and deploy it.');
  console.log('\n=== Human next steps ===');
  for (const t of todo) console.log(`  [todo] ${t}`);
}

main().catch((err) => {
  console.error(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
