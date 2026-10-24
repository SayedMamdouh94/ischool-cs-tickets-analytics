import { CLASSIFICATION_VERSION, classifyTicket, type CategoryMapping } from "@/lib/classification/rules";
import { jsonLiteral, sqlLiteral, type Db } from "./db";

export interface CategoryCatalog {
  mappings: CategoryMapping[];
  idByCode: Map<string, number>;
}

export async function loadCategoryCatalog(db: Db): Promise<CategoryCatalog> {
  const rows = await db.query<{ id: number; code: string; kind: string; topics: string[] | null }>(
    `select k.id::int as id, k.code, k.kind,
            (select array_agg(m.topic order by m.topic) from public.topic_categories m where m.category_id = k.id) as topics
       from public.ticket_categories k`,
  );
  return {
    mappings: rows.filter((r) => r.kind === "category").map((r) => ({ code: r.code, sourceTopics: r.topics ?? [] })),
    idByCode: new Map(rows.map((r) => [r.code, Number(r.id)])),
  };
}

export interface ClassificationInput {
  /** Source Ticket_ID (with a project) or the internal key (see TicketKey). */
  ticketId: number;
  topic: string;
  details: string | null;
  /** When set, the row is only written if the ticket currently holds this exact source row. */
  rowHash?: string;
}

export function classificationRows(catalog: CategoryCatalog, inputs: ClassificationInput[]) {
  return inputs.map((i) => {
    const c = classifyTicket(i.topic, i.details, catalog.mappings);
    const categoryId = catalog.idByCode.get(c.categoryCode) ?? catalog.idByCode.get("uncategorized");
    if (categoryId === undefined) throw new Error("Category catalog is missing 'uncategorized'.");
    return {
      ticket_id: i.ticketId,
      row_hash: i.rowHash ?? null,
      category_id: categoryId,
      subcategory_id: catalog.idByCode.get(c.subcategoryCode) ?? null,
      confidence: c.confidence,
      evidence: c.evidence,
    };
  });
}

/** How ClassificationInput.ticketId identifies a ticket: a source ID inside one project, or the internal key. */
export type TicketKey = { projectId: string } | "internal";

/**
 * SQL statements (for inclusion in an atomic script) that make the rule-based
 * classification current for the given tickets. Rows carrying a row_hash are
 * only applied while the ticket still holds that exact source row.
 */
export function classificationStatements(rows: ReturnType<typeof classificationRows>, key: TicketKey): string {
  if (rows.length === 0) return "";
  const data = jsonLiteral(rows);
  const version = sqlLiteral(CLASSIFICATION_VERSION);
  const match = key === "internal" ? "t.id = x.ticket_id" : `t.project_id = ${sqlLiteral(key.projectId)}::uuid and t.ticket_id = x.ticket_id`;
  return `
with x as (
  select * from jsonb_to_recordset(${data}) as x(ticket_id bigint, row_hash text, category_id smallint, subcategory_id smallint, confidence numeric, evidence jsonb)
), eligible as (
  select t.id as ticket_pk from x join public.tickets t on ${match}
  where x.row_hash is null or t.row_hash = x.row_hash
)
update public.ticket_classifications c
   set is_current = false
  from eligible e
 where c.ticket_pk = e.ticket_pk and c.is_current
   and not (c.method = 'rule_based' and c.version = ${version});

with x as (
  select * from jsonb_to_recordset(${data}) as x(ticket_id bigint, row_hash text, category_id smallint, subcategory_id smallint, confidence numeric, evidence jsonb)
)
insert into public.ticket_classifications (ticket_pk, category_id, subcategory_id, method, confidence, version, evidence, is_current)
select t.id, x.category_id, x.subcategory_id, 'rule_based', x.confidence, ${version}, coalesce(x.evidence, '{}'::jsonb), true
  from x join public.tickets t on ${match}
 where x.row_hash is null or t.row_hash = x.row_hash
on conflict (ticket_pk, method, version) do update set
  category_id = excluded.category_id,
  subcategory_id = excluded.subcategory_id,
  confidence = excluded.confidence,
  evidence = excluded.evidence,
  is_current = true,
  created_at = now();
`;
}

/** Writes classifications atomically (used by db:reclassify, keyed by internal ticket key). */
export async function writeClassifications(db: Db, catalog: CategoryCatalog, inputs: ClassificationInput[]): Promise<void> {
  const sql = classificationStatements(classificationRows(catalog, inputs), "internal");
  if (sql) await db.script(sql);
}
