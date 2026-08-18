import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/marketing", "/privacy", "/tos", "/privacy-policy", "/terms-of-service", "/pricing", "/about", "/contact"];
// Auth-adjacent public pages: visible when logged out, redirected home when logged in.
const AUTH_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get("access_token")?.value;

  // The public marketing/start site (landing at "/", plus /marketing/* policies)
  // is visible without signing in.
  const isPublic =
    pathname === "/" ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (isPublic) {
    return NextResponse.next();
  }

  if (AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    if (token) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icons|icon\\.png|apple-icon\\.png|prysm-logo\\.png).*)"],
};
