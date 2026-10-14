import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  access_token: z.string().min(20).max(8192).regex(/^[A-Za-z0-9._-]+$/),
  refresh_token: z.string().min(8).max(512).regex(/^[A-Za-z0-9._-]+$/),
});

/**
 * Turns the tokens from an implicit-flow email link (e.g. a Supabase invitation
 * using the default template) into the app's server-side session cookie.
 * Same-origin only (prevents login CSRF); the tokens are verified with
 * Supabase Auth by setSession() before any cookie is written.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid session payload" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase.auth.setSession(parsed.data);
  if (error || !data.user) return NextResponse.json({ error: "Invalid or expired link" }, { status: 401 });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
}
