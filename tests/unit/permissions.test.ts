import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  firstAllowedHref,
  normalizePermissions,
  pagePermissionFor,
  scopeSummary,
} from "@/lib/auth/permissions";
import { ALL_NAV_ITEMS, navSectionsFor } from "@/components/layout/nav-items";

const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261116120000_roles_and_permissions.sql"), "utf8");

/** The string literals of the array returned by a SQL function. */
function sqlArray(fn: string): string[] {
  const body = migration.slice(migration.indexOf(`function private.${fn}()`));
  const arr = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
  return [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("permission catalog", () => {
  it("matches private.permission_catalog() in the migration, in the same order", () => {
    expect(sqlArray("permission_catalog")).toEqual([...PERMISSION_KEYS]);
  });

  it("marks exactly the SQL global-only permissions as all-projects-only", () => {
    const flagged = PERMISSIONS.filter((p) => "allProjectsOnly" in p && p.allProjectsOnly).map((p) => p.key);
    expect(flagged.sort()).toEqual(sqlArray("global_permissions").sort());
  });

  it("seeds the analyst role with every page plus aggregated exports (the previous analyst rights)", () => {
    const seed = migration.slice(migration.indexOf("('analyst', 'Analyst'"));
    const arr = seed.slice(seed.indexOf("array["), seed.indexOf("]::text[]"));
    const keys = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...PERMISSION_KEYS.filter((k) => k.startsWith("page.")), "export.aggregate"]);
  });

  it("drops unknown keys and duplicates, keeping catalog order", () => {
    expect(normalizePermissions(["audit.view", "nope", "page.overview", "audit.view", 42])).toEqual(["page.overview", "audit.view"]);
  });
});

describe("navigation", () => {
  it("guards every sidebar item with the page permission of its route", () => {
    for (const item of ALL_NAV_ITEMS) expect(pagePermissionFor(item.href)).toBe(item.permission);
  });

  it("shows only granted pages and drops empty sections", () => {
    const sections = navSectionsFor(["page.overview", "page.tickets", "tickets.read_content"]);
    expect(sections.map((s) => s.label)).toEqual(["Analytics", "Investigate"]);
    expect(sections.flatMap((s) => s.items.map((i) => i.href))).toEqual(["/overview", "/tickets"]);
    expect(navSectionsFor([])).toEqual([]);
  });

  it("resolves nested routes to the page that owns them", () => {
    expect(pagePermissionFor("/tickets/123")).toBe("page.tickets");
    expect(pagePermissionFor("/reports/summary")).toBe("page.reports");
    expect(pagePermissionFor("/settings/imports/jobs/x")).toBe("page.settings");
    expect(pagePermissionFor("/overviewish")).toBeNull();
    expect(pagePermissionFor("/login")).toBeNull();
  });

  it("lands an account on its first allowed page in sidebar order", () => {
    expect(firstAllowedHref([...PERMISSION_KEYS])).toBe("/overview");
    expect(firstAllowedHref(["page.settings", "page.trends"])).toBe("/trends");
    expect(firstAllowedHref(["tickets.read_content", "export.tickets"])).toBeNull();
  });
});

describe("scopeSummary", () => {
  it("describes all, program and project access", () => {
    expect(scopeSummary({ allProjects: true, programs: ["DECI"], projectCodes: [] })).toBe("All projects");
    expect(scopeSummary({ allProjects: false, programs: ["DECI"], projectCodes: ["DEMI_3RD"] })).toBe("DECI (all), DEMI_3RD");
    expect(scopeSummary({ allProjects: false, programs: [], projectCodes: [] })).toBe("No projects");
  });
});
