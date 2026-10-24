import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Runs before every matched request:
 *  1. Refreshes the Supabase session cookie when needed.
 *  2. Redirects unauthenticated visitors to /login (the dashboard is never public).
 *
 * This is the first line of defence only. Every page and route handler also
 * verifies the session and role server-side, and PostgreSQL enforces RLS and
 * role checks inside every function.
 */
const PUBLIC_PATHS = ["/login", "/auth/confirm", "/auth/callback", "/auth/session", "/auth/error"];
/** Machine endpoints without a user session; each verifies its own credentials (bearer secret). */
const MACHINE_PATHS = ["/api/imports/worker"];

export async function proxy(request: NextRequest) {
  if (MACHINE_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.next({ request });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let response = NextResponse.next({ request });
  if (!url || !key) {
    // Misconfiguration: fail closed for everything except the login page.
    if (!PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p))) {
      return NextResponse.redirect(new URL("/login?error=config", request.url));
    }
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  // Validates the JWT (signature + expiry) and refreshes it if needed.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!isAuthenticated && !isPublic) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (isAuthenticated && pathname === "/login") {
    return NextResponse.redirect(new URL("/overview", request.url));
  }

  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
