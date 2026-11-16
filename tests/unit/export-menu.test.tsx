// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExportMenu } from "@/components/dashboard/export-menu";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("project=DECI_4TH"),
  usePathname: () => "/overview",
}));

afterEach(cleanup);

const AGGREGATE = [{ dataset: "projects", label: "Project metrics" }];

function open(permissions: string[]) {
  render(<ExportMenu permissions={permissions} aggregate={AGGREGATE} />);
  const trigger = screen.queryByRole("button", { name: /export/i });
  if (!trigger) return null;
  // Radix opens on pointerdown with the primary button.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
}

describe("ExportMenu", () => {
  it("is hidden when the role grants no export and no summary", () => {
    expect(open(["page.overview", "page.tickets"])).toBeNull();
  });

  it("offers aggregated CSVs only with export.aggregate", () => {
    expect(open(["export.aggregate"])).toEqual(["Project metrics (CSV)"]);
  });

  it("offers ticket rows with metadata only, unless message text may be read", () => {
    expect(open(["export.tickets"])).toEqual(["Filtered tickets — metadata (CSV)"]);
    cleanup();
    expect(open(["export.tickets", "tickets.read_content"])).toEqual(["Filtered tickets — metadata (CSV)", "Filtered tickets — with message text (CSV)"]);
  });

  it("links the printable summary only with page.reports, keeping the active filters", () => {
    render(<ExportMenu permissions={["page.reports"]} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /export/i }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const link = screen.getByRole("menuitem", { name: /management summary/i });
    expect(link.getAttribute("href")).toBe("/reports/summary?project=DECI_4TH");
  });
});
