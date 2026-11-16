import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";

export const metadata: Metadata = { title: "No access" };

const MESSAGES = {
  none: "Ask an administrator to give your account a role, then sign in again.",
  permission: "Your role does not include this page or action. Ask an administrator if you need it.",
  admin: "Only administrators can open this page.",
} as const;

async function Reason({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const reason = (await searchParams).reason;
  const key = reason === "permission" || reason === "admin" ? reason : "none";
  return (
    <>
      <div className="flex gap-3 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{MESSAGES[key]}</p>
      </div>
      {key !== "none" && (
        <Button asChild className="w-full">
          <Link href="/">Go to your dashboard</Link>
        </Button>
      )}
    </>
  );
}

export default function NoAccessPage({ searchParams }: PageProps<"/no-access">) {
  return (
    <AuthShell
      title="Access not granted"
      description="You are signed in, but your account has not been given access to this page or to the analytics data."
    >
      <div className="space-y-4">
        <Suspense fallback={null}>
          <Reason searchParams={searchParams} />
        </Suspense>
        <form action={signOut}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
