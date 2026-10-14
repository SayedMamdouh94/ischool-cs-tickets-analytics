import { CLASSIFICATION_VERSION, classifyTicket, type CategoryMapping } from "@/lib/classification/rules";
import { jsonLiteral, sqlLiteral, type Db } from "./db";

export interface CategoryCatalog {
  mappings: CategoryMapping[];
  idByCode: Map<string, number>;
}

export async function loadCategoryCatalog(db: Db): Promise<CategoryCatalog> {
  const rows = await db.query<{ id: number; code: string; kind: string; source_topics: string[] }>(
    "select id::int as id, code, kind, source_topics from public.ticket_categories",
  );
  return {
    mappings: rows.filter((r) => r.kind === "category").map((r) => ({ code: r.code, sourceTopics: r.source_topics ?? [] })),
    idByCode: new Map(rows.map((r) => [r.code, Number(r.id)])),
  };
}

export interface ClassificationInput {
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

/**
 * SQL statements (for inclusion in an atomic script) that make the rule-based
 * classification current for the given tickets. Rows carrying a row_hash are
 * only applied while the ticket still holds that exact source row.
 */
export function classificationStatements(rows: ReturnType<typeof classificationRows>): string {
  if (rows.length === 0) return "";
  const data = jsonLiteral(rows);
  const version = sqlLiteral(CLASSIFICATION_VERSION);
  return `
with x as (
  select * from jsonb_to_recordset(${data}) as x(ticket_id bigint, row_hash text, category_id smallint, subcategory_id smallint, confidence numeric, evidence jsonb)
), eligible as (
  select x.* from x join public.tickets t on t.ticket_id = x.ticket_id
  where x.row_hash is null or t.row_hash = x.row_hash
)
update public.ticket_classifications c
   set is_current = false
  from eligible e
 where c.ticket_id = e.ticket_id and c.is_current
   and not (c.method = 'rule_based' and c.version = ${version});

with x as (
  select * from jsonb_to_recordset(${data}) as x(ticket_id bigint, row_hash text, category_id smallint, subcategory_id smallint, confidence numeric, evidence jsonb)
)
insert into public.ticket_classifications (ticket_id, category_id, subcategory_id, method, confidence, version, evidence, is_current)
select x.ticket_id, x.category_id, x.subcategory_id, 'rule_based', x.confidence, ${version}, coalesce(x.evidence, '{}'::jsonb), true
  from x join public.tickets t on t.ticket_id = x.ticket_id
 where x.row_hash is null or t.row_hash = x.row_hash
on conflict (ticket_id, method, version) do update set
  category_id = excluded.category_id,
  subcategory_id = excluded.subcategory_id,
  confidence = excluded.confidence,
  evidence = excluded.evidence,
  is_current = true,
  created_at = now();
`;
}

/** Writes classifications atomically (used by db:reclassify). */
export async function writeClassifications(db: Db, catalog: CategoryCatalog, inputs: ClassificationInput[]): Promise<void> {
  const sql = classificationStatements(classificationRows(catalog, inputs));
  if (sql) await db.script(sql);
}
