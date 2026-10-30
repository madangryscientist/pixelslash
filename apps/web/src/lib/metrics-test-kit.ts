import type { AiReview, AiUsage } from "#/db/schema";
import type { MetricBuild, MetricShot } from "./run-metrics";

/** Shots and builds for the metrics tests (PS-233): a measured, unchanged server shot by default. */

let next = 0;

export function metricShot(over: Partial<MetricShot> = {}): MetricShot {
  next++;
  return {
    name: `shot-${next}`,
    viewport: "1280x720",
    theme: "light",
    diffStatus: "unchanged",
    rebaselineNeeded: false,
    measuredBy: "server",
    diffMs: null,
    reviewState: "pending",
    reviewedBy: null,
    carriedFrom: null,
    flakeId: null,
    flakyPolicy: null,
    aiReview: null,
    ...over,
  };
}

export function metricBuild(over: Partial<MetricBuild> = {}): MetricBuild & { rerun: boolean } {
  return {
    branch: "feat/x",
    createdAt: new Date("2026-10-27T10:00:00Z"),
    finishedAt: null,
    aiSummary: null,
    timings: null,
    rerun: false,
    ...over,
  };
}

export const usage = (over: Partial<AiUsage> = {}): AiUsage => ({
  calls: 1,
  reported: 1,
  input: 100,
  output: 20,
  total: 120,
  ...over,
});

/** An explanation as stored; `usage` left out is one stored before tokens were. */
export const review = (u?: AiUsage): AiReview => ({
  model: "m",
  at: 0,
  regions: [],
  autoPassed: false,
  ...(u ? { usage: u } : {}),
});
