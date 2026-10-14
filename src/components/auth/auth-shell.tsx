import { BarChart3 } from "lucide-react";

export function AuthShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BarChart3 className="size-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">CS Tickets Analytics</p>
            <p className="text-xs text-muted-foreground">DECI · DEMI support insights</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Access is restricted to authorized staff. Accounts are created by an administrator.
        </p>
      </div>
    </main>
  );
}
