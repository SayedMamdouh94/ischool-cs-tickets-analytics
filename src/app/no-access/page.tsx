import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";

export const metadata: Metadata = { title: "No access" };

export default function NoAccessPage() {
  return (
    <AuthShell
      title="Access not granted"
      description="You are signed in, but your account has not been given access to this page or to the analytics data."
    >
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>Ask an administrator to grant you the analyst or administrator role, then sign in again.</p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
