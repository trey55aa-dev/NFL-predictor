/**
 * Pure parsers for the nfl-advanced-stats edge function.
 *
 * No Deno APIs here — this module is imported both by the edge function and
 * by the app's vitest suite, so every parser stays plain TypeScript. All of
 * them are defensive: advanced-stat sites change shape without notice, so a
 * parser that can't find what it wants returns an empty result rather than
 * throwing.
 */

/* ─── Team identity ───────────────────────────────────── */

/** Full team name → canonical (ESPN-style) abbreviation. */
export const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WSH",
};

/** Source-specific abbreviation variants → canonical. */
const ABBR_ALIASES: Record<string, string> = {
  WAS: "WSH",
  JAC: "JAX",
  LA: "LAR",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
  // Pro-Football-Reference 3-letter codes
  GNB: "GB",
  KAN: "KC",
  NWE: "NE",
  NOR: "NO",
  SFO: "SF",
  TAM: "TB",
  LVR: "LV",
};

export function normalizeAbbr(abbr: string): string {
  const up = abbr.trim().toUpperCase();
  return ABBR_ALIASES[up] ?? up;
}

const CANONICAL_ABBRS = new Set(Object.values(TEAM_NAME_TO_ABBR));

/** Resolve a team label of any kind (full name, nickname, abbr) to canonical abbr. */
export function resolveTeam(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (TEAM_NAME_TO_ABBR[trimmed]) return TEAM_NAME_TO_ABBR[trimmed];
  const norm = normalizeAbbr(trimmed);
  if (CANONICAL_ABBRS.has(norm)) return norm;
  // Try matching on the nickname ("Chiefs") or a name that contains it.
  const lower = trimmed.toLowerCase();
  for (const [name, abbr] of Object.entries(TEAM_NAME_TO_ABBR)) {
    if (name.toLowerCase() === lower || name.toLowerCase().endsWith(` ${lower}`)) return abbr;
  }
  return null;
}

/* ─── What one source contributes for a team ──────────── */

export interface AdvancedTeamStats {
  /** EPA per game from play-by-play aggregates (nflverse). */
  offEpaPerGame?: number;
  passEpaPerGame?: number;
  rushEpaPerGame?: number;
  epaGames?: number;
  /** Primary QB metrics (Next Gen Stats passing board). */
  qbName?: string;
  cpoe?: number;
  timeToThrow?: number;
  /** Published power rating on an Elo-like scale (nfelo). */
  nfeloRating?: number;
  /** Grab-bag of numeric advanced fields (Pro-Football-Reference). */
  pfr?: Record<string, number>;
}

export type AdvancedTeamsMap = Record<string, AdvancedTeamStats>;

/* ─── CSV (nflverse team-week stats) ──────────────────── */

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/**
 * Aggregate nflverse team-week rows into per-team EPA per game.
 * Expects columns: team, week, passing_epa, rushing_epa (extra columns ignored).
 */
export function aggregateNflverseTeamStats(rows: Record<string, string>[]): AdvancedTeamsMap {
  const acc: Record<string, { pass: number; rush: number; games: number }> = {};
  for (const row of rows) {
    const team = resolveTeam(row.team ?? row.recent_team ?? "");
    if (!team || !row.week) continue;
    const a = (acc[team] ??= { pass: 0, rush: 0, games: 0 });
    a.pass += Number(row.passing_epa) || 0;
    a.rush += Number(row.rushing_epa) || 0;
    a.games += 1;
  }
  const out: AdvancedTeamsMap = {};
  for (const [team, a] of Object.entries(acc)) {
    if (a.games === 0) continue;
    out[team] = {
      passEpaPerGame: a.pass / a.games,
      rushEpaPerGame: a.rush / a.games,
      offEpaPerGame: (a.pass + a.rush) / a.games,
      epaGames: a.games,
    };
  }
  return out;
}

/* ─── Next Gen Stats passing board ────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any -- external API payloads */

/**
 * Pull each team's primary passer (most attempts) with CPOE and time to
 * throw from an NGS statboard payload, tolerating several field spellings.
 */
export function parseNgsPassing(data: any): AdvancedTeamsMap {
  const list: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.stats)
      ? data.stats
      : Array.isArray(data?.data)
        ? data.data
        : [];
  const best: Record<string, { attempts: number; stats: AdvancedTeamStats }> = {};
  for (const e of list) {
    const abbrRaw =
      e?.teamAbbr ?? e?.team?.abbreviation ?? e?.team?.abbr ?? e?.teamAbbreviation ?? "";
    const team = typeof abbrRaw === "string" ? resolveTeam(abbrRaw) : null;
    if (!team) continue;
    const attempts = Number(e?.attempts ?? e?.passAttempts ?? e?.att ?? 0);
    const cpoe = e?.completionPercentageAboveExpectation ?? e?.cpoe;
    const ttt = e?.avgTimeToThrow ?? e?.averageTimeToThrow ?? e?.timeToThrow;
    const name = e?.playerName ?? e?.displayName ?? e?.player?.displayName;
    if (!(team in best) || attempts > best[team].attempts) {
      best[team] = {
        attempts,
        stats: {
          qbName: typeof name === "string" ? name : undefined,
          cpoe: typeof cpoe === "number" ? cpoe : undefined,
          timeToThrow: typeof ttt === "number" ? ttt : undefined,
        },
      };
    }
  }
  const out: AdvancedTeamsMap = {};
  for (const [team, b] of Object.entries(best)) out[team] = b.stats;
  return out;
}

/* ─── Pro-Football-Reference HTML tables ──────────────── */

/**
 * PFR marks every cell with data-stat attributes (and hides some tables in
 * HTML comments), which makes its pages parseable without a DOM: uncomment,
 * walk <tr> rows, key numeric cells by their data-stat name.
 */
export function parsePfrTables(html: string): AdvancedTeamsMap {
  const uncommented = html.replace(/<!--/g, "").replace(/-->/g, "");
  const out: AdvancedTeamsMap = {};
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<t[dh][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[dh]>/g;
  const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(uncommented))) {
    const cells: Record<string, string> = {};
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells[cellMatch[1]] = stripTags(cellMatch[2]);
    }
    const teamLabel = cells.team ?? cells.tm ?? "";
    const team = teamLabel ? resolveTeam(teamLabel) : null;
    if (!team) continue;
    const numbers: Record<string, number> = {};
    for (const [k, v] of Object.entries(cells)) {
      if (k === "team" || k === "tm") continue;
      const n = Number(v.replace(/%$/, ""));
      if (v !== "" && Number.isFinite(n)) numbers[k] = n;
    }
    if (Object.keys(numbers).length === 0) continue;
    out[team] = { pfr: { ...(out[team]?.pfr ?? {}), ...numbers } };
  }
  return out;
}

/* ─── Embedded JSON (__NEXT_DATA__) rating hunter ─────── */

/** Extract the __NEXT_DATA__ JSON blob from a Next.js-rendered page. */
export function extractNextData(html: string): any | null {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Deep-walk arbitrary JSON hunting for objects that look like
 * { <team label>, <rating number> } — how nfelo-style sites embed their
 * power ratings. Returns canonical-abbr → rating.
 */
export function findTeamRatings(obj: any): Record<string, number> {
  const out: Record<string, number> = {};
  const ratingKeys = ["nfelo", "elo", "power_rating", "powerRating", "rating", "overall"];
  const teamKeys = ["team", "team_name", "teamName", "abbr", "team_abbr", "name"];
  const seen = new Set<any>();
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) {
      let team: string | null = null;
      for (const tk of teamKeys) {
        if (typeof node[tk] === "string") {
          team = resolveTeam(node[tk]);
          if (team) break;
        }
      }
      if (team) {
        for (const rk of ratingKeys) {
          const v = Number(node[rk]);
          // Elo-like scale only — ignores ranks, win totals, jersey numbers.
          if (Number.isFinite(v) && v > 1000 && v < 2200) {
            if (!(team in out)) out[team] = v;
            break;
          }
        }
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(obj, 0);
  return out;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* ─── Merge ───────────────────────────────────────────── */

export function mergeTeamMaps(...maps: AdvancedTeamsMap[]): AdvancedTeamsMap {
  const out: AdvancedTeamsMap = {};
  for (const map of maps) {
    for (const [team, stats] of Object.entries(map)) {
      out[team] = { ...out[team], ...stats, pfr: { ...out[team]?.pfr, ...stats.pfr } };
      if (Object.keys(out[team].pfr ?? {}).length === 0) delete out[team].pfr;
    }
  }
  return out;
}
