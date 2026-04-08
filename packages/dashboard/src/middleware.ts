import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware that injects the current pathname into a request header
 * so that server-side layouts can read it.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-pathname", request.nextUrl.pathname);
  return response;
}

export const config = {
  // Run on all routes inside (user) group
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
