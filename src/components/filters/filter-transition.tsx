"use client";

import { createContext, useCallback, useContext, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface FilterTransitionValue {
  isPending: boolean;
  navigate: (search: URLSearchParams | string, opts?: { pathname?: string }) => void;
}

const Ctx = createContext<FilterTransitionValue | null>(null);

/**
 * Shares one transition between the filter controls and the page content, so
 * the previous results stay visible (dimmed) while the server renders the new
 * slice — no skeleton flash on every filter change.
 */
export function FilterTransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const navigate = useCallback(
    (search: URLSearchParams | string, opts?: { pathname?: string }) => {
      // Read the path at interaction time (keeps this provider out of the prerender's URL dependencies).
      const qs = typeof search === "string" ? search : search.toString();
      const target = `${opts?.pathname ?? window.location.pathname}${qs ? `?${qs}` : ""}`;
      startTransition(() => router.replace(target, { scroll: false }));
    },
    [router],
  );
  return <Ctx value={{ isPending, navigate }}>{children}</Ctx>;
}

export function useFilterTransition(): FilterTransitionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFilterTransition must be used inside FilterTransitionProvider");
  return ctx;
}

export function PendingContent({ children, className }: { children: React.ReactNode; className?: string }) {
  const { isPending } = useFilterTransition();
  return (
    <div
      aria-busy={isPending}
      className={cn("transition-opacity duration-200", isPending && "pointer-events-none opacity-60", className)}
    >
      {children}
    </div>
  );
}
