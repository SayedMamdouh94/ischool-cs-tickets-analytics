// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DataTable } from "@/components/dashboard/data-table";
import { TicketDetailView } from "@/components/tickets/ticket-detail";
import type { TicketDetail } from "@/lib/analytics/types";

afterEach(cleanup);

describe("DataTable", () => {
  const table = {
    columns: [
      { key: "label", label: "Project" },
      { key: "tickets", label: "Tickets", kind: "int" as const },
      { key: "share", label: "Share", kind: "pct" as const },
    ],
    rows: [
      { label: "B", tickets: 1200, share: 0.25 },
      { label: "A", tickets: 300, share: null },
    ],
  };

  it("formats cells by kind and shows missing values as a dash", () => {
    render(<DataTable table={table} />);
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByText("25.0%")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("sorts when a header is clicked", () => {
    render(<DataTable table={table} />);
    fireEvent.click(screen.getByRole("button", { name: /Tickets/ }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Tickets/ }));
    expect(within(screen.getAllByRole("row")[1]).getByText("A")).toBeTruthy();
  });
});

describe("TicketDetailView", () => {
  const base: TicketDetail = {
    ticket_id: 1,
    project_code: "DECI_4TH",
    project_name: "DECI — 4th Intake",
    organization_id: 1610,
    topic: "Report a Problem / inquiry",
    status: "completed",
    priority: null,
    department: "education",
    owner_type: "Student",
    owner_id: "S-1",
    affected_student_id: null,
    created_at: "2026-09-01T07:00:00Z",
    responded_at: null,
    resolved_at: null,
    response_seconds: null,
    resolution_seconds: null,
    responder_name: null,
    resolved_by: null,
    response_kind: "generic_acknowledgement",
    sub_topic: null,
    session_ref: null,
    lesson_name: null,
    message_language: "ar",
    source_filename: "f.csv",
    source_row_number: 3,
    imported_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    category: null,
    subcategory: null,
    classification: null,
    content_visible: true,
    message: '<img src=x onerror="alert(1)"> مرحبا',
    response: "تم استلام طلبكم بنجاح",
    note: null,
    attachments: [{ type: "request", position: 1, url: "https://files.example/a.png", host: "files.example", file_name: "a.png", extension: "png" }],
    attachment_count: 1,
  };

  it("renders student text as inert text, never HTML", () => {
    const { container } = render(<TicketDetailView ticket={base} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/onerror/)).toBeTruthy();
    expect(screen.getByText(/Templated acknowledgement/)).toBeTruthy();
  });

  it("links attachments without loading them", () => {
    const { container } = render(<TicketDetailView ticket={base} />);
    const link = container.querySelector('a[href="https://files.example/a.png"]')!;
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(container.querySelector("img, iframe, object")).toBeNull();
  });

  it("hides content for viewers without content access", () => {
    render(<TicketDetailView ticket={{ ...base, content_visible: false, message: null, response: null, attachments: null }} />);
    expect(screen.getByText("Message content hidden")).toBeTruthy();
    expect(screen.queryByText(/onerror/)).toBeNull();
  });
});
