import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const AUTH_COOKIE = "cp_admin_access_token";

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (!token) return false;

  try {
    const response = await fetch(new URL("/api/auth/me", request.url), {
      headers: {
        cookie: request.headers.get("cookie") || "",
      },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === "/login";
  const authed = await isAuthenticated(request);

  if (isLoginPage && authed) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (!isLoginPage && !authed) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/church-profiles", "/moderation", "/history-facts", "/church-of-day", "/login"],
};
