import {
  BarChart3,
  FileText,
  FolderKanban,
  Hourglass,
  LayoutDashboard,
  Lightbulb,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Table2,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PagePermission } from "@/lib/auth/permissions";

export interface NavItem {
  href: string;
  title: string;
  icon: LucideIcon;
  description: string;
  /** The page permission an account needs to see and open this item. */
  permission: PagePermission;
}

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Analytics",
    items: [
      { href: "/overview", title: "Executive Overview", icon: LayoutDashboard, description: "Headline KPIs and trends", permission: "page.overview" },
      { href: "/projects", title: "Projects", icon: FolderKanban, description: "Compare projects", permission: "page.projects" },
      { href: "/trends", title: "Ticket Trends", icon: TrendingUp, description: "Volume over time", permission: "page.trends" },
      { href: "/topics", title: "Topics & Complaints", icon: MessagesSquare, description: "What students report", permission: "page.topics" },
      { href: "/team", title: "Support Team", icon: Users, description: "Workload and handling", permission: "page.team" },
      { href: "/backlog", title: "Backlog & Resolution", icon: Hourglass, description: "Open tickets and durations", permission: "page.backlog" },
    ],
  },
  {
    label: "Investigate",
    items: [
      { href: "/tickets", title: "Ticket Explorer", icon: Table2, description: "Search individual tickets", permission: "page.tickets" },
      { href: "/insights", title: "Insights", icon: Lightbulb, description: "Data-grounded observations", permission: "page.insights" },
      { href: "/data-quality", title: "Data Quality", icon: ShieldCheck, description: "Gaps and anomalies", permission: "page.data_quality" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/reports/summary", title: "Management Summary", icon: FileText, description: "Printable report", permission: "page.reports" },
      { href: "/settings", title: "Settings & Imports", icon: Settings, description: "Configuration and access", permission: "page.settings" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

/** The sidebar an account sees: items its role grants, without empty sections. */
export function navSectionsFor(permissions: readonly string[]): { label: string; items: NavItem[] }[] {
  return NAV_SECTIONS.map((s) => ({ label: s.label, items: s.items.filter((i) => permissions.includes(i.permission)) })).filter((s) => s.items.length > 0);
}
export const BRAND_ICON = BarChart3;

/** Query parameters that represent global filters (carried between pages). */
export const GLOBAL_FILTER_PARAMS = [
  "project",
  "program",
  "intake",
  "status",
  "topic",
  "responder",
  "resolver",
  "category",
  "theme",
  "preset",
  "from",
  "to",
  "cycle",
  "archived",
];

export function filterQuery(params: URLSearchParams | null): string {
  if (!params) return "";
  const out = new URLSearchParams();
  for (const key of GLOBAL_FILTER_PARAMS) {
    for (const v of params.getAll(key)) out.append(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}
