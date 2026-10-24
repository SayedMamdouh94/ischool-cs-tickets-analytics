"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { BRAND_ICON as Brand, NAV_SECTIONS, filterQuery } from "./nav-items";

function Nav({ query, pathname }: { query: string; pathname: string | null }) {
  return (
    <>
      {NAV_SECTIONS.map((section) => (
        <SidebarGroup key={section.label}>
          <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => {
                const active = pathname !== null && (pathname === item.href || pathname.startsWith(`${item.href}/`));
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link href={`${item.href}${query}`}>
                        <item.icon aria-hidden />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function NavWithFilters() {
  const params = useSearchParams();
  const pathname = usePathname();
  return <Nav query={filterQuery(params)} pathname={pathname} />;
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/overview">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Brand className="size-4" aria-hidden />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">CS Tickets Analytics</span>
                  <span className="truncate text-xs text-muted-foreground">Support ticket analytics</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <Suspense fallback={<Nav query="" pathname={null} />}>
          <NavWithFilters />
        </Suspense>
      </SidebarContent>
      <SidebarFooter>
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden">
          Historical ticket exports · times shown in Africa/Cairo
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
