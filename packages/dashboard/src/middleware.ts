import { NextResponse, type NextRequest } from "next/server";
import { decideTokenAction } from "@/lib/auth-decision";

/** Paths that don't require a login session. */
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/forgot",
  "/reset",
  "/accept-invite",
]);

const COOKIE_NAME = "ll5_token";

type TokenPayload = { uid?: string; exp?: number };

function decodeTokenPayload(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as TokenPayload;
  } catch {
    return null;
  }
}

async function refreshToken(gatewayUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${gatewayUrl}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    return data.token ?? null;
  } catch {
    return null;
  }
}

function withPathname(response: NextResponse, pathname: string): NextResponse {
  response.headers.set("x-pathname", pathname);
  return response;
}

/**
 * Edge middleware:
 *   1. Redirects any non-public page to /login if the ll5_token cookie is missing.
 *   2. Runs decideTokenAction() over the decoded token to pick exactly one of:
 *        - pass:    valid and not near expiry — serve as-is (no logging).
 *        - refresh: near expiry, or expired-but-within the gateway's grace
 *                   window — try /auth/refresh. On success, write the new token
 *                   into both the incoming request (so this request's server
 *                   actions see it) and the outgoing response (so the browser
 *                   persists it). On failure, serve the old token only if it's
 *                   still valid (gateway transiently down); otherwise re-login.
 *        - reauth:  expired beyond grace, or malformed (missing exp) — clear the
 *                   cookie and redirect to /login. A missing exp is handled as
 *                   reauth rather than refresh-spamming every request.
 *   3. Injects x-pathname for server-side layouts.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname);
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!isPublic && !token) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname === "/" ? "/dashboard" : pathname);
    return NextResponse.redirect(url);
  }

  if (!token) {
    return withPathname(NextResponse.next(), pathname);
  }

  const payload = decodeTokenPayload(token);
  const hasExp = typeof payload?.exp === "number";
  const now = Math.floor(Date.now() / 1000);
  // When exp is missing, secondsLeft is meaningless; the decision helper keys
  // off hasExp and treats it as reauth, so the value here is irrelevant.
  const secondsLeft = hasExp ? (payload!.exp as number) - now : 0;

  const action = decideTokenAction(secondsLeft, hasExp);

  // (a) Valid and not near expiry — serve as-is, no logging noise.
  if (action === "pass") {
    return withPathname(NextResponse.next(), pathname);
  }

  const buildReauthRedirect = (reason: string): NextResponse => {
    console.warn(
      `[middleware] auth reauth: ${reason} (path=${pathname}, secondsLeft=${secondsLeft}, hasExp=${hasExp})`,
    );
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname === "/" ? "/dashboard" : pathname);
    const redirect = NextResponse.redirect(url);
    redirect.cookies.delete(COOKIE_NAME);
    return redirect;
  };

  // (c) Expired beyond grace (or malformed / missing exp) — clear cookie and
  // force a clean re-login. Public paths never reach here (handled above), but
  // guard anyway so /login itself is never redirect-looped.
  if (action === "reauth") {
    if (isPublic) return withPathname(NextResponse.next(), pathname);
    return buildReauthRedirect(
      hasExp ? "expired beyond grace" : "token missing exp claim",
    );
  }

  // (b) Near expiry, or expired-but-within-grace — attempt a refresh.
  console.warn(
    `[middleware] auth refresh attempt (path=${pathname}, secondsLeft=${secondsLeft})`,
  );
  const gatewayUrl = process.env.GATEWAY_URL ?? "https://gateway.noninoni.click";
  const fresh = await refreshToken(gatewayUrl, token);

  if (fresh) {
    // Propagate the new token into the current request so server actions /
    // components reading cookies() via next/headers see the refreshed value,
    // and set it on the response so the browser persists it for next time.
    request.cookies.set(COOKIE_NAME, fresh);
    const response = NextResponse.next({ request });
    response.cookies.set(COOKIE_NAME, fresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return withPathname(response, pathname);
  }

  // Refresh failed. Distinguish near-expiry (still valid) from expired-in-grace:
  //   - Still valid (secondsLeft > 0): gateway likely transiently down — serve
  //     the old token; next navigation retries. The token has not expired, so
  //     downstream calls won't 401.
  //   - Already expired (secondsLeft <= 0): serving it would only produce
  //     downstream 401s and broken pages — force a clean re-login instead.
  if (secondsLeft > 0 && !isPublic) {
    console.warn(
      `[middleware] auth refresh miss, token still valid — serving stale (path=${pathname}, secondsLeft=${secondsLeft})`,
    );
    return withPathname(NextResponse.next(), pathname);
  }

  return buildReauthRedirect("refresh failed for expired token");
}

export const config = {
  // Matcher excludes api / _next / static assets — only page routes land here.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
