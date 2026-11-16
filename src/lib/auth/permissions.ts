/**
 * Permission catalog shared by the server and the browser.
 *
 * Mirrors private.permission_catalog() in
 * supabase/migrations/20261116120000_roles_and_permissions.sql (a unit test
 * keeps the two lists identical). PostgreSQL enforces project scope and every
 * permission marked `enforcedInDatabase`; page permissions decide which pages
 * the application serves and shows.
 */

export type PermissionGroup = "Pages" | "Ticket data" | "Exports" | "Management";

export interface PermissionDef {
  key: string;
  group: PermissionGroup;
  label: string;
  description: string;
  /** Page permissions: the route they open (and its sub-routes). */
  href?: string;
  enforcedInDatabase: boolean;
  /** Only effective for accounts with access to all projects. */
  allProjectsOnly?: boolean;
  /** Another permission this one is only useful with. */
  requires?: string;
}

export const PERMISSIONS = [
  { key: "page.overview", group: "Pages", label: "Executive Overview", description: "Headline KPIs and trends", href: "/overview", enforcedInDatabase: false },
  { key: "page.projects", group: "Pages", label: "Projects", description: "Project comparison and project pages", href: "/projects", enforcedInDatabase: false },
  { key: "page.trends", group: "Pages", label: "Ticket Trends", description: "Volume over time", href: "/trends", enforcedInDatabase: false },
  { key: "page.topics", group: "Pages", label: "Topics & Complaints", description: "What students report", href: "/topics", enforcedInDatabase: false },
  { key: "page.team", group: "Pages", label: "Support Team", description: "Workload and handling", href: "/team", enforcedInDatabase: false },
  { key: "page.backlog", group: "Pages", label: "Backlog & Resolution", description: "Open tickets and durations", href: "/backlog", enforcedInDatabase: false },
  { key: "page.tickets", group: "Pages", label: "Ticket Explorer", description: "Search and open individual tickets (metadata)", href: "/tickets", enforcedInDatabase: true },
  { key: "page.insights", group: "Pages", label: "Insights", description: "Data-grounded observations", href: "/insights", enforcedInDatabase: false },
  { key: "page.data_quality", group: "Pages", label: "Data Quality", description: "Gaps and anomalies", href: "/data-quality", enforcedInDatabase: false },
  { key: "page.reports", group: "Pages", label: "Management Summary", description: "Printable report", href: "/reports/summary", enforcedInDatabase: false },
  { key: "page.settings", group: "Pages", label: "Settings & Imports", description: "Projects, import history, categories and thresholds (read-only without the management permissions)", href: "/settings", enforcedInDatabase: false },
  {
    key: "tickets.read_content",
    group: "Ticket data",
    label: "Read message text",
    description: "Message, response, notes, attachments and previous values; search inside message text. Every view is audited.",
    enforcedInDatabase: true,
    requires: "page.tickets",
  },
  { key: "export.aggregate", group: "Exports", label: "Export chart data (CSV)", description: "Download the aggregated tables behind charts", enforcedInDatabase: true },
  { key: "export.tickets", group: "Exports", label: "Export ticket rows (CSV)", description: "Download filtered tickets; with message text only together with “Read message text”", enforcedInDatabase: true },
  {
    key: "imports.manage",
    group: "Management",
    label: "Run imports",
    description: "Upload, review, confirm, cancel and retry imports",
    enforcedInDatabase: true,
    allProjectsOnly: true,
  },
  {
    key: "projects.manage",
    group: "Management",
    label: "Manage projects & cycles",
    description: "Create, edit, archive and restore projects and reporting cycles",
    enforcedInDatabase: true,
    allProjectsOnly: true,
  },
  { key: "categories.manage", group: "Management", label: "Manage categories", description: "Map topics to categories, edit categories and status classes", enforcedInDatabase: true },
  { key: "settings.manage", group: "Management", label: "Edit thresholds & preferences", description: "Analytics thresholds, insight rules and application preferences", enforcedInDatabase: true },
  { key: "audit.view", group: "Management", label: "View audit log", description: "Imports, exports, content views, settings and access changes", enforcedInDatabase: true },
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSIONS)[number]["key"];
export type PagePermission = Extract<Permission, `page.${string}`>;

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key);
export const PERMISSION_GROUPS: readonly PermissionGroup[] = ["Pages", "Ticket data", "Exports", "Management"];

const KEY_SET = new Set<string>(PERMISSION_KEYS);
const BY_KEY = new Map<string, PermissionDef>(PERMISSIONS.map((p) => [p.key, p]));

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && KEY_SET.has(value);
}

export function permissionDef(key: Permission): PermissionDef {
  return BY_KEY.get(key)!;
}

/** Known permission keys from untrusted input, in catalog order, without duplicates. */
export function normalizePermissions(values: readonly unknown[]): Permission[] {
  const wanted = new Set(values.filter(isPermission));
  return PERMISSION_KEYS.filter((k) => wanted.has(k));
}

export function can(permissions: readonly string[] | undefined | null, key: Permission): boolean {
  return Boolean(permissions?.includes(key));
}

const PAGE_PERMISSIONS = (PERMISSIONS as readonly PermissionDef[])
  .filter((p): p is PermissionDef & { href: string } => Boolean(p.href))
  // Longest prefix first so that nested routes resolve to the most specific page.
  .sort((a, b) => b.href.length - a.href.length);

/** The page permission guarding a pathname (null for routes that are not permission pages). */
export function pagePermissionFor(pathname: string): PagePermission | null {
  const hit = PAGE_PERMISSIONS.find((p) => pathname === p.href || pathname.startsWith(`${p.href}/`));
  return (hit?.key as PagePermission | undefined) ?? null;
}

/** Where to send a signed-in account: the first page (in sidebar order) it may open. */
export function firstAllowedHref(permissions: readonly string[]): string | null {
  for (const p of PERMISSIONS as readonly PermissionDef[]) {
    if (p.href && permissions.includes(p.key)) return p.href;
  }
  return null;
}

/** Human summary of an account's project scope. */
export function scopeSummary(scope: { allProjects: boolean; programs: readonly string[]; projectCodes: readonly string[] }): string {
  if (scope.allProjects) return "All projects";
  const parts = [...scope.programs.map((p) => `${p} (all)`), ...scope.projectCodes];
  return parts.length ? parts.join(", ") : "No projects";
}
