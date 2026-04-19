import { NextResponse, type NextRequest } from "next/server";

/** Paths that don't require a login session. */
const PUBLIC_PATHS = new Set<string>(["/login"]);

/**
 * Edge middleware that:
 *   1. Redirects any non-public page to /login if the ll5_token cookie
 *      is missing — so users can't navigate through non-working screens
 *      under (user) or (admin) layouts. (user)/layout.tsx already had
 *      this check; admin did not.
 *   2. Injects x-pathname so server-side layouts can read it (retained
 *      from the previous middleware).
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublic = PUBLIC_PATHS.has(pathname);
  if (!isPublic) {
    const token = request.cookies.get("ll5_token")?.value;
    if (!token) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname === "/" ? "/dashboard" : pathname);
      return NextResponse.redirect(url);
    }
  }

  const response = NextResponse.next();
  response.headers.set("x-pathname", pathname);
  return response;
}

export const config = {
  // Matcher excludes api / _next / static assets — only page routes land here.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
