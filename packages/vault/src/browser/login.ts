/**
 * Server-side credential injection (DECISION-022 §2 + §4).
 *
 * The credential enters and leaves this module in process memory only. The
 * two hard rules are enforced HERE, at the moment of use:
 *
 *  - Domain binding: we navigate to the ITEM's stored URL (never a caller
 *    URL) and re-verify the LIVE page's registrable domain equals the item's
 *    registrable domain immediately before every fill. A redirect, a
 *    meta-refresh, or an injected navigation between checks aborts the fill.
 *  - No secret ever appears in a return value, log line, or error (all
 *    errors are sanitized upstream; results here are status + URL only).
 */
import type { Browser, Page } from 'playwright-core';
import { connectSharedBrowser } from './cdp.js';
import { registrableDomain, sameRegistrableDomain } from '../domain.js';
import type { ResolvedCredential } from '../bw/client.js';
import { logger } from '../utils/logger.js';

export type LoginStatus = 'success' | 'failed' | 'mfa_required';

export interface LoginResult {
  status: LoginStatus;
  final_url?: string;
  reason?: string;
}

export interface LoginRunner {
  performLogin(credential: ResolvedCredential): Promise<LoginResult>;
  checkLoginStatus(url: string): Promise<{ authenticated: boolean; final_url?: string; note?: string }>;
}

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 12_000;

const USERNAME_SELECTORS = [
  // autocomplete attributes first — the most reliable signal.
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[type="text"]',
  'input[type="tel"]',
];

const OTP_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
  'input[id*="otp" i]',
  'input[name*="2fa" i]',
  'input[id*="two-factor" i]',
  'input[name*="verification" i]',
].join(', ');

const ERROR_TEXT_RE = /(incorrect|invalid|wrong|failed|try again|does not match|unrecognized|שגוי|שגויה|לא נכון)/i;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
}

async function visiblePasswordField(page: Page) {
  const loc = page.locator('input[type="password"]:visible').first();
  try {
    if (await loc.count() === 0) return null;
    if (!(await loc.isVisible().catch(() => false))) return null;
    return loc;
  } catch {
    return null;
  }
}

async function findUsernameField(page: Page) {
  for (const selector of USERNAME_SELECTORS) {
    const loc = page.locator(`${selector}:visible`).first();
    try {
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return loc;
    } catch { /* try next selector */ }
  }
  return null;
}

/** Throws when the LIVE page is not on the item's registrable domain. */
function assertDomainBound(page: Page, expectedDomain: string, stage: string): void {
  const live = registrableDomain(page.url());
  if (!live || live !== expectedDomain) {
    throw new DomainMismatchError(`domain_mismatch at ${stage}: page is on "${live ?? 'unresolvable'}", credential is bound to "${expectedDomain}"`);
  }
}

export class DomainMismatchError extends Error {}

async function submitAndWait(page: Page, passwordLoc: NonNullable<Awaited<ReturnType<typeof visiblePasswordField>>>): Promise<void> {
  const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  const hasSubmit = await submit.count().then((c) => c > 0).catch(() => false);
  if (hasSubmit) {
    await submit.click({ timeout: 5_000 }).catch(async () => {
      await passwordLoc.press('Enter').catch(() => undefined);
    });
  } else {
    await passwordLoc.press('Enter').catch(() => undefined);
  }
  await page.waitForTimeout(1_000);
  await settle(page);
}

async function classifyOutcome(page: Page, urlBefore: string): Promise<LoginResult> {
  const finalUrl = page.url();
  const pwd = await visiblePasswordField(page);

  // OTP / verification-code field present (and it's not just the password box) → MFA.
  const otp = page.locator(OTP_SELECTOR).first();
  const otpVisible = await otp.isVisible().catch(() => false);
  if (otpVisible && !pwd) {
    return { status: 'mfa_required', final_url: finalUrl };
  }

  if (pwd) {
    const bodyText = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    const errorText = ERROR_TEXT_RE.test(bodyText.slice(0, 5_000));
    if (errorText || finalUrl === urlBefore) {
      return { status: 'failed', final_url: finalUrl, reason: errorText ? 'error_text_on_page' : 'still_on_login_form' };
    }
    // URL changed but a password field exists (e.g. a different form) — count as success-ish? No: fail closed.
    return { status: 'failed', final_url: finalUrl, reason: 'password_field_still_present' };
  }

  return { status: 'success', final_url: finalUrl };
}

export function createLoginRunner(browserCdpUrl: string): LoginRunner {
  async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      browser = await connectSharedBrowser(browserCdpUrl);
      const context = browser.contexts()[0] ?? await browser.newContext();
      page = await context.newPage();
      return await fn(page);
    } finally {
      await page?.close().catch(() => undefined);
      // Disconnect only — the shared browser stays alive for the agent.
      await browser?.close().catch(() => undefined);
    }
  }

  return {
    async performLogin(credential: ResolvedCredential): Promise<LoginResult> {
      const expectedDomain = registrableDomain(credential.url);
      if (!expectedDomain) {
        return { status: 'failed', reason: 'item_url_has_no_registrable_domain' };
      }

      try {
        return await withPage(async (page) => {
          // Navigate to the ITEM's stored URL — never caller input.
          await page.goto(credential.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await settle(page);
          assertDomainBound(page, expectedDomain, 'after_navigation');

          let pwd = await visiblePasswordField(page);

          // Two-step flows (username page → password page).
          if (!pwd && credential.username) {
            const user = await findUsernameField(page);
            if (user) {
              assertDomainBound(page, expectedDomain, 'before_username_fill');
              await user.fill(credential.username, { timeout: 5_000 });
              await user.press('Enter').catch(() => undefined);
              await settle(page);
              assertDomainBound(page, expectedDomain, 'after_username_step');
              pwd = await visiblePasswordField(page);
            }
          }

          if (!pwd) {
            // No password field anywhere — either already authenticated or an
            // unsupported flow (passkey-only etc.). Report without filling.
            return { status: 'failed', final_url: page.url(), reason: 'no_password_field_found' } as LoginResult;
          }

          // Single-page form: fill username if there's an empty field for it.
          if (credential.username) {
            const user = await findUsernameField(page);
            if (user) {
              const existing = await user.inputValue().catch(() => '');
              if (existing !== credential.username) {
                assertDomainBound(page, expectedDomain, 'before_username_fill');
                await user.fill(credential.username, { timeout: 5_000 }).catch(() => undefined);
              }
            }
          }

          // HARD RULE: re-verify the live domain immediately before the secret is used.
          assertDomainBound(page, expectedDomain, 'before_password_fill');
          const urlBefore = page.url();
          await pwd.fill(credential.password, { timeout: 5_000 });
          await submitAndWait(page, pwd);

          const result = await classifyOutcome(page, urlBefore);
          logger.info('[login][performLogin] done', { site: credential.itemName, status: result.status });
          return result;
        });
      } catch (err) {
        if (err instanceof DomainMismatchError) {
          logger.warn('[login][performLogin] refused: domain binding violated', { site: credential.itemName });
          return { status: 'failed', reason: 'domain_mismatch' };
        }
        // Message is sanitized at the tool boundary; keep it generic here too.
        logger.error('[login][performLogin] failed', { site: credential.itemName });
        return { status: 'failed', reason: 'browser_error' };
      }
    },

    async checkLoginStatus(url: string): Promise<{ authenticated: boolean; final_url?: string; note?: string }> {
      try {
        return await withPage(async (page) => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await settle(page);
          const finalUrl = page.url();
          const pwd = await visiblePasswordField(page);
          const path = (() => { try { return new URL(finalUrl).pathname.toLowerCase(); } catch { return ''; } })();
          const onLoginPath = /(login|signin|sign-in|auth)/.test(path);
          const offDomain = !sameRegistrableDomain(url, finalUrl);
          const authenticated = !pwd && !onLoginPath && !offDomain;
          return {
            authenticated,
            final_url: finalUrl,
            note: pwd ? 'password field visible' : onLoginPath ? 'redirected to a login path' : offDomain ? 'redirected off-domain' : 'no login form detected',
          };
        });
      } catch {
        return { authenticated: false, note: 'browser_error' };
      }
    },
  };
}
