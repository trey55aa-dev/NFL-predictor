// Advanced NFL stats aggregator — Vercel serverless function.
//
// The predictor's browser code can't read advanced-stat sites directly
// (CORS + JS-rendered pages), so this endpoint fetches server-side and
// returns one normalized payload:
//
//   GET /api/advanced?season=2025  →  {
//     season, generatedAt,
//     teams:   { [abbr]: { offEpaPerGame, cpoe, timeToThrow, qbName,
//                          nfeloRating, pfr: {...} } },
//     sources: { [source]: { status: "ok" | "error", detail?, teams? } },
//   }
//
// Sources (each independent — one failing never hides the others):
//   nflverse  EPA per game from the open nflverse play-by-play aggregates
//   ngs       Next Gen Stats passing board → per-team primary QB CPOE,
//             time to throw
//   pfr       Pro-Football-Reference advanced team tables
//   nfelo     nfeloapp.com power ratings (Elo-scale) from embedded JSON
//
// Cached in-memory per warm instance and at the CDN (s-maxage) for 6h.

import {
  aggregateNflverseTeamStats,
  extractNextData,
  findTeamRatings,
  mergeTeamMaps,
  parseCsv,
  parseNgsPassing,
  parsePfrTables,
  type AdvancedTeamsMap,
} from "../src/lib/advancedParsers";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.text();
}

interface SourceStatus {
  status: "ok" | "error";
  detail?: string;
  teams?: number;
}

async function srcNflverse(season: number): Promise<AdvancedTeamsMap> {
  const csv = await getText(
    `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`,
  );
  return aggregateNflverseTeamStats(parseCsv(csv));
}

async function srcNgs(season: number): Promise<AdvancedTeamsMap> {
  const res = await fetch(
    `https://appapi.ngs.nfl.com/statboard/passing?season=${season}&seasonType=REG`,
    {
      headers: {
        "user-agent": UA,
        accept: "application/json",
        referer: "https://nextgenstats.nfl.com/stats/passing",
        origin: "https://nextgenstats.nfl.com",
      },
    },
  );
  if (!res.ok) throw new Error(`${res.status} from appapi.ngs.nfl.com`);
  return parseNgsPassing(await res.json());
}

async function srcPfr(season: number): Promise<AdvancedTeamsMap> {
  const html = await getText(
    `https://www.pro-football-reference.com/years/${season}/advanced.htm`,
    { accept: "text/html" },
  );
  return parsePfrTables(html);
}

async function srcNfelo(): Promise<AdvancedTeamsMap> {
  const html = await getText("https://www.nfeloapp.com/nfl-power-ratings/", {
    accept: "text/html",
  });
  const ratings = findTeamRatings(extractNextData(html) ?? {});
  const out: AdvancedTeamsMap = {};
  for (const [team, rating] of Object.entries(ratings)) out[team] = { nfeloRating: rating };
  return out;
}

interface Payload {
  season: number;
  generatedAt: string;
  teams: AdvancedTeamsMap;
  sources: Record<string, SourceStatus>;
}

async function buildPayload(season: number): Promise<Payload> {
  const runners: [string, Promise<AdvancedTeamsMap>][] = [
    ["nflverse", srcNflverse(season)],
    ["ngs", srcNgs(season)],
    ["pfr", srcPfr(season)],
    ["nfelo", srcNfelo()],
  ];
  const sources: Record<string, SourceStatus> = {};
  const maps: AdvancedTeamsMap[] = [];
  const settled = await Promise.allSettled(runners.map(([, p]) => p));
  settled.forEach((result, i) => {
    const name = runners[i][0];
    if (result.status === "fulfilled" && Object.keys(result.value).length > 0) {
      sources[name] = { status: "ok", teams: Object.keys(result.value).length };
      maps.push(result.value);
    } else {
      sources[name] = {
        status: "error",
        detail:
          result.status === "rejected"
            ? result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
            : "no teams parsed",
      };
    }
  });
  return {
    season,
    generatedAt: new Date().toISOString(),
    teams: mergeTeamMaps(...maps),
    sources,
  };
}

const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = new Map<number, { at: number; payload: Payload }>();

// Minimal request/response contracts — enough of Vercel's Node handler
// surface for this endpoint, without pulling in @vercel/node.
interface ApiRequest {
  url?: string;
}
interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const season = Number(url.searchParams.get("season")) || new Date().getFullYear();
    const hit = cache.get(season);
    const payload =
      hit && Date.now() - hit.at < CACHE_TTL ? hit.payload : await buildPayload(season);
    // Only cache runs that got at least one source, so a bad network moment
    // doesn't stick for six hours.
    if (Object.values(payload.sources).some((s) => s.status === "ok")) {
      cache.set(season, { at: Date.now(), payload });
      res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
