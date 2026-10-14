import type { ProjectRef } from "./file";

/**
 * Mirror of the projects seeded by supabase/migrations/*_reference_data.sql.
 * Used ONLY for offline dry runs (`npm run db:import -- --dry-run` without a
 * database). Imports always read projects from the database. A unit test keeps
 * this list in sync with the migration.
 */
export const DEFAULT_PROJECTS: ProjectRef[] = [
  { id: "offline-DECI_4TH", code: "DECI_4TH", name: "DECI — 4th Intake", organization_id: 1610, file_name_hint: "DECI 4th Intake" },
  { id: "offline-DECI_SUMMER", code: "DECI_SUMMER", name: "DECI — Summer Intake", organization_id: 1906, file_name_hint: "DECI Summer Intake" },
  { id: "offline-DEMI_3RD", code: "DEMI_3RD", name: "DEMI — 3rd Intake", organization_id: 1609, file_name_hint: "DEMI 3rd Intake" },
  { id: "offline-DEMI_SUMMER", code: "DEMI_SUMMER", name: "DEMI — Summer Intake", organization_id: 1939, file_name_hint: "DEMI Summer Intake" },
];

/** Initial export expectations from the project brief (informational check in db:validate). */
export const BRIEF_EXPECTED_COUNTS: Record<string, number> = {
  DECI_4TH: 2114,
  DECI_SUMMER: 582,
  DEMI_3RD: 6470,
  DEMI_SUMMER: 3803,
};
