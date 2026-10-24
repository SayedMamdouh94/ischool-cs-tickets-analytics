/**
 * Recomputes the rule-based classification for every ticket (e.g. after the
 * keyword rules in src/lib/classification/rules.ts change). Tickets themselves
 * are not modified.
 *
 *   npm run db:reclassify
 */
import { CLASSIFICATION_VERSION } from "@/lib/classification/rules";
import { parseMessage } from "@/lib/ingest/message";
import { connectDb, withRetry } from "./lib/db";
import { loadCategoryCatalog, writeClassifications } from "./lib/classify-db";

async function main(): Promise<number> {
  const db = connectDb();
  console.log(`Reclassifying tickets in ${db.target} [${db.kind}] with ${CLASSIFICATION_VERSION}`);
  try {
    const catalog = await loadCategoryCatalog(db);
    let after = 0;
    let done = 0;
    for (;;) {
      // Small pages keep each request well under the HTTP transport's size limit.
      const batch = await db.query<{ id: number; topic: string; message: string | null }>(
        "select id::bigint as id, topic, message from public.tickets where id > $1::bigint order by id limit 300",
        [after],
      );
      if (batch.length === 0) break;
      await withRetry("reclassify batch", () =>
        writeClassifications(
          db,
          catalog,
          batch.map((t) => ({ ticketId: Number(t.id), topic: t.topic, details: parseMessage(t.message).details })),
        ),
      );
      after = Number(batch[batch.length - 1].id);
      done += batch.length;
    }
    console.log(`✓ ${done} tickets classified.`);
    return 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Reclassification aborted: ${(err as Error).message}`);
    process.exit(1);
  });
