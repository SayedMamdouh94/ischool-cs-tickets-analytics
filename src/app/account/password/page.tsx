import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordForm } from "@/components/auth/password-form";

export const metadata: Metadata = { title: "Set password" };

export default function PasswordPage() {
  return (
    <AuthShell title="Set your password" description="Choose a password to finish setting up your account.">
      <PasswordForm />
    </AuthShell>
  );
}
