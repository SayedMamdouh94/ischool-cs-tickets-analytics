import { ExternalLink, FileText, Lock, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { TicketDetail } from "@/lib/analytics/types";
import { RESPONSE_KIND_LABELS, fmtDateTime, fmtDuration, keyLabel, statusLabel } from "@/lib/format";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function TextBlock({ title, text, caption }: { title: string; text: string | null; caption?: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold">{title}</h3>
      {caption && <p className="text-[11px] text-muted-foreground">{caption}</p>}
      {text ? (
        // Rendered as plain text (React escapes it); direction follows the content (Arabic/English).
        <div dir="auto" className="user-text rounded-md border bg-muted/30 p-3 text-sm leading-relaxed">
          {text}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Not recorded.</p>
      )}
    </section>
  );
}

export function TicketDetailView({ ticket }: { ticket: TicketDetail }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{ticket.project_name}</Badge>
        <Badge variant="secondary">{statusLabel(ticket.status)}</Badge>
        {ticket.category && <Badge variant="outline" className="font-normal">{ticket.category}</Badge>}
        {ticket.subcategory && (
          <Badge variant="outline" className="font-normal" title="Rule-based theme (indicative)">
            Theme: {ticket.subcategory}
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3">
        <Field label="Topic">
          <span dir="auto" className="user-text">
            {ticket.topic}
          </span>
        </Field>
        <Field label="Owner ID">{ticket.owner_id ?? "—"}</Field>
        <Field label="Department">{ticket.department ?? "—"}</Field>
        <Field label="Created">{fmtDateTime(ticket.created_at)}</Field>
        <Field label="Recorded response">{fmtDateTime(ticket.responded_at)}</Field>
        <Field label="Resolved">{fmtDateTime(ticket.resolved_at)}</Field>
        <Field label="Recorded response time">{fmtDuration(ticket.response_seconds)}</Field>
        <Field label="Resolution time">{fmtDuration(ticket.resolution_seconds)}</Field>
        <Field label="Response text type">{RESPONSE_KIND_LABELS[ticket.response_kind] ?? ticket.response_kind}</Field>
        <Field label="Responder">{keyLabel(ticket.responder_name)}</Field>
        <Field label="Resolver">{keyLabel(ticket.resolved_by)}</Field>
        <Field label="Priority">{ticket.priority ?? "Not provided in export"}</Field>
        {ticket.session_ref && <Field label="Session ID">{ticket.session_ref}</Field>}
        {ticket.lesson_name && (
          <Field label="Lesson">
            <span dir="auto" className="user-text">
              {ticket.lesson_name}
            </span>
          </Field>
        )}
        {ticket.sub_topic && <Field label="Sub topic">{ticket.sub_topic}</Field>}
      </dl>

      <Separator />

      {ticket.content_visible ? (
        <div className="space-y-4">
          <TextBlock title="Student message" text={ticket.message} />
          <TextBlock
            title="Recorded response"
            text={ticket.response}
            caption={ticket.response_kind === "generic_acknowledgement" ? "Templated acknowledgement — not evidence of a human reply." : undefined}
          />
          <TextBlock title="Agent note" text={ticket.note} />
          <section className="space-y-1.5">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <Paperclip className="size-3.5" aria-hidden /> Attachment references ({ticket.attachment_count})
            </h3>
            {ticket.attachments && ticket.attachments.length > 0 ? (
              <ul className="space-y-1.5">
                {ticket.attachments.map((a) => (
                  <li key={`${a.type}-${a.position}`} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate" dir="auto" title={a.file_name ?? a.url}>
                      {a.file_name ?? "attachment"}
                    </span>
                    <Badge variant="outline" className="font-normal">
                      {a.type === "request" ? "Student" : "Response"}
                    </Badge>
                    {/* Reference only: the file is never fetched or previewed by this application. */}
                    <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      {a.host} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
            <p className="text-[11px] text-muted-foreground">Links open the original file on the ticketing platform. Files are not downloaded or previewed here.</p>
          </section>
          <p className="text-[11px] text-muted-foreground">Viewing ticket content is recorded in the audit log.</p>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">Message content hidden</p>
            <p className="text-muted-foreground">
              Student messages, responses, notes and attachments are visible to administrators only ({ticket.attachment_count} attachment reference
              {ticket.attachment_count === 1 ? "" : "s"}).
            </p>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Source: {ticket.source_filename}, row {ticket.source_row_number} · imported {fmtDateTime(ticket.imported_at)} · classification{" "}
        {ticket.classification ? `${ticket.classification.method} ${ticket.classification.version}` : "none"}
      </p>
    </div>
  );
}
