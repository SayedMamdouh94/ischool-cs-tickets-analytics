import { LogOut, ShieldCheck, UserRound } from "lucide-react";
import { getViewer } from "@/lib/auth/dal";
import { signOut } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export async function UserMenu() {
  const viewer = await getViewer();
  if (!viewer) return null;
  const initials = (viewer.email ?? "?").slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-2" aria-label="Account menu">
          <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{initials}</span>
          <Badge variant="secondary" className="hidden capitalize sm:inline-flex">
            {viewer.role ?? "no role"}
          </Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <UserRound className="size-4 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm">{viewer.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuLabel className="flex items-center gap-2 pt-0 text-xs font-normal text-muted-foreground">
          <ShieldCheck className="size-3.5" aria-hidden />
          {viewer.role === "admin" ? "Administrator — full access" : viewer.role === "analyst" ? "Analyst — aggregated data and metadata" : "No data access"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <form action={signOut}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut /> Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
