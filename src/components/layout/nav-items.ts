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

export interface NavItem {
  href: string;
  title: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Analytics",
    items: [
      { href: "/overview", title: "Executive Overview", icon: LayoutDashboard, description: "Headline KPIs and trends" },
      { href: "/projects", title: "Projects", icon: FolderKanban, description: "Compare the four projects" },
      { href: "/trends", title: "Ticket Trends", icon: TrendingUp, description: "Volume over time" },
      { href: "/topics", title: "Topics & Complaints", icon: MessagesSquare, description: "What students report" },
      { href: "/team", title: "Support Team", icon: Users, description: "Workload and handling" },
      { href: "/backlog", title: "Backlog & Resolution", icon: Hourglass, description: "Open tickets and durations" },
    ],
  },
  {
    label: "Investigate",
    items: [
      { href: "/tickets", title: "Ticket Explorer", icon: Table2, description: "Search individual tickets" },
      { href: "/insights", title: "Insights", icon: Lightbulb, description: "Data-grounded observations" },
      { href: "/data-quality", title: "Data Quality", icon: ShieldCheck, description: "Gaps and anomalies" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/reports/summary", title: "Management Summary", icon: FileText, description: "Printable report" },
      { href: "/settings", title: "Settings & Imports", icon: Settings, description: "Configuration and access" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
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
