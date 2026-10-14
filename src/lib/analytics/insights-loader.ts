import "server-only";
import { cache } from "react";
import { detectSpikes } from "./anomalies";
import { buildInsights, type Insight } from "./insights";
import {
  getCrossTab,
  getGroupedMetrics,
  getPeriodComparison,
  getRecurringSessions,
  getVolumeSeries,
  type FilterContext,
} from "./queries";
import { totalsByBucket } from "./shape";

export const loadInsights = cache(async (ctx: FilterContext): Promise<{ insights: Insight[]; spikes: ReturnType<typeof detectSpikes> }> => {
  const [overall, projects, topics, topicPeriods, topicThemes, recurring, daily, lessons] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "project"),
    getGroupedMetrics(ctx.rpc, "topic"),
    getPeriodComparison(ctx.rpc, "topic", ctx.range.from ? null : 30),
    getCrossTab(ctx.rpc, "topic", "subcategory"),
    getRecurringSessions(ctx.rpc, 2, 10),
    getVolumeSeries(ctx.rpc, "day", "none"),
    getGroupedMetrics(ctx.rpc, "lesson", 50),
  ]);
  const spikes = detectSpikes(totalsByBucket(daily));
  const subcategoryLabels = Object.fromEntries(
    ctx.options.categories.filter((c) => c.kind === "subcategory").map((c) => [c.code, c.name]),
  );
  const insights = buildInsights({
    overall: overall.rows[0] ?? null,
    projects: projects.rows,
    topics: topics.rows,
    topicPeriods,
    topicThemes,
    recurring,
    lessons: lessons.rows,
    spikes,
    subcategoryLabels,
    thresholds: overall.thresholds,
  });
  return { insights, spikes };
});
