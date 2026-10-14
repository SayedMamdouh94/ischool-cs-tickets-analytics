import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthCallback } from "@/components/auth/auth-callback";

export const metadata: Metadata = { title: "Signing in" };

export default function AuthCallbackPage() {
  return (
    <AuthShell title="Completing sign-in" description="Verifying your invitation link.">
      <AuthCallback />
    </AuthShell>
  );
}
