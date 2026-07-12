/**
 * Client for the site's own /api/advanced serverless function, which
 * aggregates advanced-stat sources (nflverse EPA, Next Gen Stats passing,
 * PFR advanced tables, nfelo power ratings) server-side — browsers can't
 * read those sites directly.
 *
 * The predictor treats this feed as optional: running the site without the
 * API (plain `vite dev`, or a static-only host) just means the model falls
 * back to ESPN data plus its own computed Elo.
 */

import { normalizeAbbr, type AdvancedMap } from "./predictor";

export interface AdvancedSourceStatus {
  status: "ok" | "error";
  detail?: string;
  teams?: number;
}

export interface AdvancedStatsResult {
  teams: AdvancedMap;
  sources: Record<string, AdvancedSourceStatus>;
}

export const ADVANCED_SOURCE_LABELS: Record<string, string> = {
  nflverse: "nflverse EPA",
  ngs: "Next Gen Stats",
  pfr: "Pro-Football-Reference",
  nfelo: "nfelo power ratings",
};

export async function fetchAdvancedStats(season: number): Promise<AdvancedStatsResult> {
  const res = await fetch(`/api/advanced?season=${season}`);
  if (!res.ok) throw new Error(`Advanced stats unavailable (${res.status})`);
  const payload = (await res.json()) as {
    teams?: Record<string, AdvancedMap[string]>;
    sources?: Record<string, AdvancedSourceStatus>;
  } | null;
  const teams: AdvancedMap = {};
  for (const [abbr, stats] of Object.entries(payload?.teams ?? {})) {
    teams[normalizeAbbr(abbr)] = stats;
  }
  return { teams, sources: payload?.sources ?? {} };
}
