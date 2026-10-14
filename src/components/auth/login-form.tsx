"use client";

import { useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requestPasswordReset, signIn, type AuthFormState } from "@/lib/auth/actions";

const ERRORS: Record<string, string> = {
  config: "The application is not configured to reach Supabase. Contact an administrator.",
  link: "That link is invalid or has expired. Request a new one.",
};

export function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/overview";
  const urlError = ERRORS[params.get("error") ?? ""];
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [state, action, pending] = useActionState<AuthFormState, FormData>(signIn, {});
  const [resetState, resetAction, resetPending] = useActionState<AuthFormState, FormData>(requestPasswordReset, {});

  if (mode === "reset") {
    return (
      <form action={resetAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="reset-email">Email</Label>
          <Input id="reset-email" name="email" type="email" autoComplete="email" required />
        </div>
        {resetState.error && <FormError message={resetState.error} />}
        {resetState.message && <p className="text-sm text-muted-foreground" role="status">{resetState.message}</p>}
        <Button type="submit" className="w-full" disabled={resetPending}>
          {resetPending && <Loader2 className="animate-spin" />}
          Send reset link
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={() => setMode("signin")}>
          Back to sign in
        </Button>
      </form>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <button type="button" onClick={() => setMode("reset")} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            Forgot password?
          </button>
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {(state.error || urlError) && <FormError message={state.error ?? urlError!} />}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        Sign in
      </Button>
    </form>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
