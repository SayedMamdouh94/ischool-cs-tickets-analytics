/**
 * Recomputes the rule-based classification for every ticket (e.g. after the
 * keyword rules in src/lib/classification/rules.ts change). Tickets themselves
 * are not modified.
 *
 *   npm run db:reclassify
 */
import { CLASSIFICATION_VERSION } from "@/lib/classification/rules";
import { parseMessage } from "@/lib/ingest/message";
import { connect, withRetry } from "./lib/db";
import { loadCategoryCatalog, writeClassifications } from "./lib/classify-db";

async function main(): Promise<number> {
  const { sql, target } = connect({ max: 1 });
  console.log(`Reclassifying tickets in ${target} with ${CLASSIFICATION_VERSION}`);
  try {
    const catalog = await loadCategoryCatalog(sql);
    let after = 0;
    let done = 0;
    for (;;) {
      const batch = await sql<{ ticket_id: number; topic: string; message: string | null }[]>`
        select ticket_id, topic, message from public.tickets where ticket_id > ${after} order by ticket_id limit 1000
      `;
      if (batch.length === 0) break;
      await withRetry("reclassify batch", () =>
        sql.begin((tx) =>
          writeClassifications(
            tx,
            catalog,
            batch.map((t) => ({ ticketId: Number(t.ticket_id), topic: t.topic, details: parseMessage(t.message).details })),
          ),
        ),
      );
      after = Number(batch[batch.length - 1].ticket_id);
      done += batch.length;
    }
    console.log(`✓ ${done} tickets classified.`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Reclassification aborted: ${(err as Error).message}`);
    process.exit(1);
  });
