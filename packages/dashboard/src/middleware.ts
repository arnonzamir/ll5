import { NextResponse, type NextRequest } from "next/server";

/** Paths that don't require a login session. */
const PUBLIC_PATHS = new Set<string>(["/login"]);

/** Refresh the token when it has less than this many seconds of life left. */
const REFRESH_WINDOW_SECONDS = 2 * 24 * 60 * 60; // 2 days

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
 *   2. Auto-refreshes the token when it's within REFRESH_WINDOW_SECONDS of
 *      expiry (or has just expired — gateway grants a 7-day grace). Writes the
 *      new token back into both the incoming request and the outgoing response
 *      so the current request's server actions see it too. Beyond the grace
 *      window, clears the cookie and redirects to /login.
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
  const exp = payload?.exp ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const secondsLeft = exp - now;

  if (secondsLeft >= REFRESH_WINDOW_SECONDS) {
    return withPathname(NextResponse.next(), pathname);
  }

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

  if (secondsLeft <= 0 && !isPublic) {
    // Expired beyond grace period — force re-login.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    const redirect = NextResponse.redirect(url);
    redirect.cookies.delete(COOKIE_NAME);
    return redirect;
  }

  // Valid-but-near-expiry refresh miss (gateway down?) — serve with the old
  // token; next navigation will retry.
  return withPathname(NextResponse.next(), pathname);
}

export const config = {
  // Matcher excludes api / _next / static assets — only page routes land here.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
