import type postgres from "postgres";
import { CLASSIFICATION_VERSION, classifyTicket, type CategoryMapping } from "@/lib/classification/rules";
import type { Sql } from "./db";

type Queryable = Sql | postgres.TransactionSql;

export interface CategoryCatalog {
  mappings: CategoryMapping[];
  idByCode: Map<string, number>;
}

export async function loadCategoryCatalog(sql: Sql): Promise<CategoryCatalog> {
  const rows = await sql<{ id: number; code: string; kind: string; source_topics: string[] }[]>`
    select id, code, kind, source_topics from public.ticket_categories
  `;
  return {
    mappings: rows.filter((r) => r.kind === "category").map((r) => ({ code: r.code, sourceTopics: r.source_topics })),
    idByCode: new Map(rows.map((r) => [r.code, r.id])),
  };
}

export interface ClassificationInput {
  ticketId: number;
  topic: string;
  details: string | null;
}

/** Writes the current rule-based classification for the given tickets (inside the caller's transaction). */
export async function writeClassifications(tx: Queryable, catalog: CategoryCatalog, inputs: ClassificationInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const rows = inputs.map((i) => {
    const c = classifyTicket(i.topic, i.details, catalog.mappings);
    const categoryId = catalog.idByCode.get(c.categoryCode) ?? catalog.idByCode.get("uncategorized");
    const subcategoryId = catalog.idByCode.get(c.subcategoryCode) ?? null;
    if (categoryId === undefined) throw new Error("Category catalog is missing 'uncategorized'.");
    return {
      ticket_id: i.ticketId,
      category_id: categoryId,
      subcategory_id: subcategoryId,
      method: "rule_based",
      confidence: c.confidence,
      version: CLASSIFICATION_VERSION,
      evidence: c.evidence,
      is_current: true,
    };
  });
  const ids = inputs.map((i) => i.ticketId);

  await tx`
    update public.ticket_classifications
       set is_current = false
     where ticket_id = any(${ids}::bigint[])
       and is_current
       and not (method = 'rule_based' and version = ${CLASSIFICATION_VERSION})
  `;
  await tx`
    insert into public.ticket_classifications ${tx(
      rows,
      "ticket_id",
      "category_id",
      "subcategory_id",
      "method",
      "confidence",
      "version",
      "evidence",
      "is_current",
    )}
    on conflict (ticket_id, method, version) do update set
      category_id = excluded.category_id,
      subcategory_id = excluded.subcategory_id,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      is_current = true,
      created_at = now()
  `;
}
