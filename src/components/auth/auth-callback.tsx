"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { safeNext } from "@/lib/auth/redirect";

/**
 * Completes Supabase email links that deliver tokens in the URL fragment
 * (invitations sent with the default email template). The fragment is removed
 * from the address bar immediately; tokens are only sent to this app's own
 * /auth/session endpoint, which validates them server-side.
 */
export function AuthCallback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

    const accessToken = fragment.get("access_token");
    const refreshToken = fragment.get("refresh_token");
    const establish = async (): Promise<boolean> => {
      if (fragment.get("error") || !accessToken || !refreshToken) return false;
      const res = await fetch("/auth/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
      });
      return res.ok;
    };
    establish()
      .then((ok) => (ok ? router.replace(safeNext(query.get("next"))) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [router]);

  if (failed) {
    return (
      <div className="space-y-3 text-sm">
        <p>This link is invalid or has expired.</p>
        <Link href="/login" className="font-medium underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Signing you in…
    </p>
  );
}
