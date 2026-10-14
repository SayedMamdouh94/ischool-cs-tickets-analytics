import { Suspense } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { FilterTransitionProvider } from "@/components/filters/filter-transition";
import { DataFreshness } from "@/components/layout/data-freshness";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header
          data-print-hide
          className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4"
        >
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Suspense fallback={null}>
              <DataFreshness />
            </Suspense>
          </div>
          <ThemeToggle />
          <Suspense fallback={<Skeleton className="h-8 w-20" />}>
            <UserMenu />
          </Suspense>
        </header>
        <div className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
          <FilterTransitionProvider>{children}</FilterTransitionProvider>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
