import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-muted-foreground">The page or record you are looking for does not exist or is not available to your account.</p>
      <Button asChild variant="outline">
        <Link href="/overview">Back to the overview</Link>
      </Button>
    </main>
  );
}
