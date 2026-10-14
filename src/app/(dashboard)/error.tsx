"use client";

import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-20 text-center" role="alert">
      <TriangleAlert className="size-8 text-[var(--status-serious)]" aria-hidden />
      <h1 className="text-lg font-semibold">This view could not be loaded</h1>
      <p className="text-sm text-muted-foreground">
        The analytics database did not return a result. This can happen if the connection was interrupted or your access changed.
        {error.digest && <span className="mt-1 block text-xs">Reference: {error.digest}</span>}
      </p>
      <Button onClick={reset} variant="outline">
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
