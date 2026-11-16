import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/dal";
import { firstAllowedHref } from "@/lib/auth/permissions";

/**
 * Landing: sends each account to the first page its role may open (in sidebar
 * order), so accounts without the Executive Overview never hit a dead end.
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  const target = !viewer ? "/login" : !viewer.role ? "/no-access" : (firstAllowedHref(viewer.permissions) ?? "/no-access?reason=permission");
  return NextResponse.redirect(new URL(target, request.url));
}
