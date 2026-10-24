import "server-only";
import { cache } from "react";
import { detectProjectSpikes, type ProjectSpike } from "./anomalies";
import { buildInsights, rulesFrom, type Insight, type InsightRules } from "./insights";
import {
  getCrossTab,
  getGroupedMetrics,
  getPeriodComparison,
  getRecurringSessions,
  getSettings,
  getVolumeSeries,
  type FilterContext,
} from "./queries";
import type { PeriodComparison } from "./types";

export interface LoadedInsights {
  insights: Insight[];
  spikes: ProjectSpike[];
  rules: InsightRules;
  topicPeriods: PeriodComparison;
}

/** Computes insights for the current scope and filters from live data (memoized per request only). */
export const loadInsights = cache(async (ctx: FilterContext): Promise<LoadedInsights> => {
  const rules = rulesFrom((await getSettings()).insight_rules);
  const [overall, projects, topics, topicPeriods, topicThemes, recurring, dailyByProject, lessons] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "project"),
    getGroupedMetrics(ctx.rpc, "topic"),
    // An explicit date range is compared as one calendar window; otherwise each
    // project uses its own latest N complete days (exports end on different dates).
    getPeriodComparison(ctx.rpc, "topic", ctx.range.from ? null : rules.trend_window_days),
    getCrossTab(ctx.rpc, "topic", "subcategory"),
    getRecurringSessions(ctx.rpc, rules.recurring_min_students, 10),
    getVolumeSeries(ctx.rpc, "day", "project"),
    getGroupedMetrics(ctx.rpc, "lesson", 50),
  ]);
  const o = ctx.options;
  const spikes = detectProjectSpikes(dailyByProject.points, o.coverage, {
    window: rules.spike_window_days,
    threshold: rules.spike_threshold,
    minCount: rules.spike_min_count,
    rampupDays: rules.spike_rampup_days,
  });
  const subcategoryLabels = Object.fromEntries(o.categories.filter((c) => c.kind === "subcategory").map((c) => [c.code, c.name]));
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
    rules,
    projectNames: Object.fromEntries(o.projects.map((p) => [p.code, p.name])),
    health: {
      coverage: o.coverage,
      activeImports: o.active_imports,
      partialImports: o.partial_imports,
      rejectedRows: o.latest_rejections,
      unmappedTopics: o.unmapped_topics,
      unclassifiedStatusTickets: o.unclassified_status_tickets,
    },
  });
  return { insights, spikes, rules, topicPeriods };
});
