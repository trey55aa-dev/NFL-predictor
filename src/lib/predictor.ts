/**
 * NFL game-outcome predictor.
 *
 * Data comes from ESPN's public (unauthenticated, CORS-enabled) APIs:
 *   - scoreboard: weekly schedule, live/final scores, quarter linescores
 *   - standings:  season-long team stats (points for/against, streaks, splits)
 *   - team statistics: yards per game (total / passing / rushing)
 *   - injuries:   current league-wide injury report
 *
 * The pregame model blends stat factors — record, scoring margin, home field,
 * momentum, production (Pythagorean wins + yards-per-point efficiency),
 * yardage, game flow (per-half scoring ebbs and flows from linescores),
 * injury burden, and offense-vs-defense style matchup — under user-tunable
 * weights, then layers the user's own reasoning on top: a per-game lean
 * slider, tap-to-assign environment tags, and free-form notes.
 *
 * For in-progress games a live win-probability curve reprices the pregame
 * edge by score margin vs time remaining, so a team down 21-0 in the first
 * quarter still holds a real (small) chance that decays toward zero only as
 * the fourth quarter runs out.
 *
 * Everything the user enters persists in localStorage so picks can be graded
 * once games go final.
 */

/* ─── Types ───────────────────────────────────────────── */

export interface TeamInfo {
  id: string;
  abbreviation: string;
  displayName: string;
  shortName: string;
  logo?: string;
  color?: string; // hex without '#'
  record?: string; // "10-4"
}

export interface Game {
  id: string;
  date: string; // ISO
  name: string;
  home: TeamInfo;
  away: TeamInfo;
  venue?: string;
  /** pre | in | post */
  state: "pre" | "in" | "post";
  completed: boolean;
  homeScore?: number;
  awayScore?: number;
  statusDetail?: string; // "Sun 1:00 PM" / "Final" / "Q3 4:12"
  broadcast?: string;
  /** Points per quarter (index 0 = Q1, 4+ = OT), when available. */
  homeLinescores?: number[];
  awayLinescores?: number[];
  /** Live-game clock: current period and seconds left in it. */
  period?: number;
  clockSeconds?: number;
}

export interface WeekSchedule {
  seasonYear: number;
  weekNumber: number;
  games: Game[];
}

export interface TeamSeasonStats {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesPlayed: number;
  /** positive = winning streak, negative = losing streak */
  streak: number;
  homeWins: number;
  homeLosses: number;
  roadWins: number;
  roadLosses: number;
}

export type StatsMap = Record<string, TeamSeasonStats>;

/** Per-team production detail from the team-statistics feed. */
export interface TeamDetailStats {
  teamId: string;
  passYpg: number | null;
  rushYpg: number | null;
  totalYpg: number | null;
  /** Total yards allowed per game (defense). */
  defYpg?: number | null;
  /** Offensive 3rd/4th down conversion rate, as a percent (e.g. 41.2). */
  thirdDownPct?: number | null;
  fourthDownPct?: number | null;
  /** Season totals: defensive takeaways (INTs + fumble recoveries) and
   *  offensive giveaways (INTs thrown + fumbles lost). Divide by the
   *  team's gamesPlayed (from TeamSeasonStats) for a per-game/pace rate. */
  takeawaysTotal?: number | null;
  giveawaysTotal?: number | null;
  /** Yards per punt/kick return, and season total return touchdowns
   *  (punt/kick/blocked-kick — the "huge momentum shift" special-teams
   *  plays). */
  puntReturnAvg?: number | null;
  kickReturnAvg?: number | null;
  specialTeamsTDs?: number | null;
}

export type DetailMap = Record<string, TeamDetailStats>;

/** Per-team "ebbs and flows" derived from quarter linescores of past games. */
export interface TeamFlowStats {
  teamId: string;
  games: number;
  /** Average first-half scoring margin per game. */
  firstHalfMarginPg: number;
  /** Average second-half (+OT) scoring margin per game. */
  secondHalfMarginPg: number;
  /** Mean quarter-to-quarter margin swing — how streaky/volatile games get. */
  avgQuarterSwing: number;
  /** Wins after trailing at halftime. */
  comebackWins: number;
  /** Losses after leading at halftime. */
  blownLeads: number;
}

export type FlowMap = Record<string, TeamFlowStats>;

export interface InjuredPlayer {
  name: string;
  position: string;
  status: string;
}

export interface TeamInjuryReport {
  teamId: string;
  /** QB-weighted severity total; higher = more hurt. */
  burden: number;
  players: InjuredPlayer[];
}

export type InjuryMap = Record<string, TeamInjuryReport>;

/**
 * Advanced per-team stats served by the nfl-advanced-stats edge function,
 * keyed by canonical team abbreviation. Mirrors the function's payload.
 */
export interface AdvancedTeamStats {
  offEpaPerGame?: number;
  passEpaPerGame?: number;
  rushEpaPerGame?: number;
  epaGames?: number;
  qbName?: string;
  cpoe?: number;
  timeToThrow?: number;
  nfeloRating?: number;
  pfr?: Record<string, number>;
}

export type AdvancedMap = Record<string, AdvancedTeamStats>;

/** The proxy already normalizes team codes; this covers stray variants. */
const ABBR_ALIASES: Record<string, string> = { WAS: "WSH", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC" };
export function normalizeAbbr(abbr: string): string {
  const up = abbr.trim().toUpperCase();
  return ABBR_ALIASES[up] ?? up;
}

/** Everything the model can draw on. Only `stats` is required — every other
 *  feed degrades to a neutral factor when missing. */
export interface GameContext {
  stats: StatsMap;
  detail?: DetailMap;
  flow?: FlowMap;
  injuries?: InjuryMap;
  /** Elo power ratings computed from this season's results, by team id. */
  elo?: Record<string, number>;
  /** Advanced-source stats (EPA, QB metrics, nfelo), by team abbreviation. */
  advanced?: AdvancedMap;
  /** League-wide yardage ranks. Compute with computeYardageRanks() over
   *  every team's detail you have — ranking only this week's participants
   *  understates/overstates rank versus the full 32-team league. */
  yardageRanks?: Record<string, YardageRank>;
}

/** User-tunable factor weights, each 0–100. */
export interface ModelWeights {
  record: number;
  scoring: number;
  homeField: number;
  momentum: number;
  /** Pythagorean expected wins + yards-per-point efficiency. */
  production: number;
  /** Yards per game, offense quality. */
  yardage: number;
  /** First/second-half surges from quarter scoring. */
  flow: number;
  /** Current injury-report burden. */
  injuries: number;
  /** Offense type vs defense type matchup. */
  style: number;
  /** Elo/nfelo power-rating differential. */
  powerRating: number;
  /** Offensive EPA per game (nflverse play-by-play aggregates). */
  epa: number;
  /** Primary-QB advanced metrics (CPOE, from Next Gen Stats). */
  qbMetrics: number;
  /** Game-plan shift when a starter (esp. RB) is out: pass-rate goes up,
   *  backup-RB efficiency discount kicks in. */
  usageShift: number;
  /** 3rd down conversion % differential. */
  thirdDown: number;
  /** 4th down conversion % differential — the most critical situational
   *  down, so its default weight sits above 3rd down's. */
  fourthDown: number;
  /** Turnover margin: tiered (+5 good, +10 great, 10+ exceptional) and
   *  weighted so defense-forced takeaways count for more than offense
   *  avoiding giveaways. */
  turnoverMargin: number;
  /** League-wide yardage rank; top-5 in both offense and defense is a
   *  distinct, extra-credited signal. */
  yardageRank: number;
  /** Punt/kick return production and return touchdowns (momentum). */
  specialTeams: number;
  /** How much the user's own lean + tags count. */
  reasoning: number;
}

export const DEFAULT_WEIGHTS: ModelWeights = {
  record: 55,
  scoring: 60,
  homeField: 45,
  momentum: 35,
  production: 50,
  yardage: 50,
  flow: 40,
  injuries: 60,
  style: 35,
  powerRating: 70,
  epa: 60,
  qbMetrics: 50,
  usageShift: 45,
  thirdDown: 45,
  fourthDown: 60,
  turnoverMargin: 65,
  yardageRank: 40,
  specialTeams: 35,
  reasoning: 80,
};

/** Merge stored weights with defaults so new factors appear for old saves. */
export function ensureWeights(w: Partial<ModelWeights> | undefined): ModelWeights {
  return { ...DEFAULT_WEIGHTS, ...(w ?? {}) };
}

export const ENV_TAGS = [
  "Weather",
  "Injuries",
  "Rest",
  "QB edge",
  "Trenches",
  "Motivation",
  "Travel",
] as const;
export type EnvTag = (typeof ENV_TAGS)[number];

/** Which side an environment tag favors. */
export type TagSide = "home" | "away";

/** The user's reasoning layer for one game. */
export interface GameInput {
  /** -3 (strong away) … +3 (strong home) */
  lean: number;
  tags: Partial<Record<EnvTag, TagSide>>;
  note: string;
  /** Set when the game was seen final: was the projected pick correct? */
  graded?: { pickedTeamId: string; correct: boolean; season: number; week: number };
}

export const EMPTY_INPUT: GameInput = { lean: 0, tags: {}, note: "" };

export interface Prediction {
  homeProb: number; // 0–1
  winner: "home" | "away";
  confidence: number; // 0.5–1
  /** Per-factor signed contributions (positive = home), for the breakdown UI. */
  contributions: { label: string; value: number }[];
}

/* ─── Storage keys (the browser-local database; see storage.ts) ── */

export const NFL_WEIGHTS_KEY = "nflp.weights";
export const NFL_INPUTS_KEY = "nflp.gameInputs"; // Record<gameId, GameInput>

/* ─── Math helpers ────────────────────────────────────── */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function winPct(w: number, l: number, t: number): number {
  const g = w + l + t;
  return g === 0 ? 0.5 : (w + t / 2) / g;
}

/** Standard normal CDF (Abramowitz–Stegun approximation). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Pythagorean expected win% from points production (exponent 2.37). */
export function pythagoreanWinPct(pointsFor: number, pointsAgainst: number): number {
  if (pointsFor + pointsAgainst === 0) return 0.5;
  const pf = Math.pow(Math.max(pointsFor, 1), 2.37);
  const pa = Math.pow(Math.max(pointsAgainst, 1), 2.37);
  return pf / (pf + pa);
}

/* ─── Style classification ────────────────────────────── */

export type OffenseStyle = "Pass-heavy" | "Balanced" | "Run-heavy";
export type OffenseTier = "Explosive" | "Average" | "Grinding";
export type DefenseTier = "Stingy" | "Solid" | "Leaky";

export interface StyleProfile {
  offense: OffenseStyle | null;
  offenseTier: OffenseTier | null;
  defenseTier: DefenseTier | null;
}

export function styleProfile(detail?: TeamDetailStats, season?: TeamSeasonStats): StyleProfile {
  let offense: OffenseStyle | null = null;
  let offenseTier: OffenseTier | null = null;
  if (detail?.passYpg != null && detail?.rushYpg != null && detail.passYpg + detail.rushYpg > 0) {
    const passShare = detail.passYpg / (detail.passYpg + detail.rushYpg);
    offense = passShare > 0.66 ? "Pass-heavy" : passShare < 0.54 ? "Run-heavy" : "Balanced";
  }
  if (detail?.totalYpg != null) {
    offenseTier = detail.totalYpg >= 365 ? "Explosive" : detail.totalYpg <= 315 ? "Grinding" : "Average";
  }
  let defenseTier: DefenseTier | null = null;
  if (season && season.gamesPlayed > 0) {
    const paPg = season.pointsAgainst / season.gamesPlayed;
    defenseTier = paPg <= 20 ? "Stingy" : paPg >= 26 ? "Leaky" : "Solid";
  }
  return { offense, offenseTier, defenseTier };
}

/** How well an offense profile travels against a defense profile. */
function offenseVsDefense(off: StyleProfile, def: StyleProfile): number {
  let v = 0;
  if (def.defenseTier === "Leaky") {
    v += off.offense === "Pass-heavy" ? 0.3 : off.offense === "Run-heavy" ? 0.2 : 0.25;
  } else if (def.defenseTier === "Stingy") {
    // Run-heavy attacks lose less against elite defenses than air raids do.
    v -= off.offense === "Pass-heavy" ? 0.2 : off.offense === "Run-heavy" ? 0.1 : 0.15;
  }
  if (off.offenseTier === "Explosive") v += 0.15;
  if (off.offenseTier === "Grinding") v -= 0.1;
  return v;
}

/* ─── Turnover margin: tiered, defense-forced weighted ────────────────── */

/**
 * Takeaways (defense forcing turnovers) count for more than giveaways
 * (offense simply not turning it over) — forcing the ball loose is the
 * scarcer, more repeatable skill. Applied before the tiered curve below.
 */
const TAKEAWAY_WEIGHT = 1.2;
const GIVEAWAY_WEIGHT = 1.0;

/**
 * Season-to-date turnover margin, prorated to a 17-game pace so a small
 * early-season sample isn't mistaken for a huge one, weighted so forced
 * takeaways count more than avoided giveaways.
 */
export function turnoverMarginPace(
  takeawaysTotal: number,
  giveawaysTotal: number,
  gamesPlayed: number,
): number {
  if (gamesPlayed <= 0) return 0;
  const weighted = takeawaysTotal * TAKEAWAY_WEIGHT - giveawaysTotal * GIVEAWAY_WEIGHT;
  return (weighted / gamesPlayed) * 17;
}

/**
 * Tiered scoring curve: 0 at even, ~0.5 at a +5 pace ("good"), ~0.76 at
 * +10 ("great"), then diminishing returns above +10 ("exceptional" is a
 * plateau, not an unbounded climb). Symmetric for a negative margin.
 */
export function turnoverMarginScore(marginPace: number): number {
  return Math.sign(marginPace) * (1 - Math.exp(-Math.abs(marginPace) / 7));
}

/* ─── League-wide yardage rank ────────────────────────── */

export interface YardageRank {
  offRank: number | null;
  defRank: number | null;
}

/**
 * Rank every team in `detail` by total yards (offense: most is best) and
 * yards allowed (defense: fewest is best). Ranking needs the *whole*
 * league's numbers, not just this week's participants — pass in every
 * team's detail you have, not only the teams playing this week.
 */
export function computeYardageRanks(detail: DetailMap): Record<string, YardageRank> {
  const withOff = Object.values(detail).filter((d) => d.totalYpg != null);
  const withDef = Object.values(detail).filter((d) => d.defYpg != null);
  const offSorted = [...withOff].sort((x, y) => (y.totalYpg as number) - (x.totalYpg as number));
  const defSorted = [...withDef].sort((x, y) => (x.defYpg as number) - (y.defYpg as number));
  const offRank: Record<string, number> = {};
  offSorted.forEach((d, i) => (offRank[d.teamId] = i + 1));
  const defRank: Record<string, number> = {};
  defSorted.forEach((d, i) => (defRank[d.teamId] = i + 1));
  const out: Record<string, YardageRank> = {};
  for (const teamId of new Set([...Object.keys(offRank), ...Object.keys(defRank)])) {
    out[teamId] = { offRank: offRank[teamId] ?? null, defRank: defRank[teamId] ?? null };
  }
  return out;
}

/** Rank 1 → +0.5, rank 16 (mid-pack) → 0, rank 32 → -0.5, plus an explicit
 *  bonus for landing top-5 in both — a distinct signal beyond "good stats". */
export function yardageRankScore(rank: YardageRank | undefined): number {
  if (!rank) return 0;
  let score = 0;
  if (rank.offRank != null) score += clamp((16 - rank.offRank) / 16, -0.5, 0.5);
  if (rank.defRank != null) score += clamp((16 - rank.defRank) / 16, -0.5, 0.5);
  if (rank.offRank != null && rank.offRank <= 5 && rank.defRank != null && rank.defRank <= 5) {
    score += 0.3;
  }
  return score;
}

/* ─── Game-plan usage shift (injury-driven) ───────────── */

const isSidelined = (status: string) => /out|reserve|\bir\b|doubtful/i.test(status);

/**
 * When a team's RB is out (or doubtful), the offense's plan shifts: pass
 * volume goes up, and the backup RB is assumed less effective than the
 * starter. The shift matters more for a team that already leans on the
 * run (losing what you depend on hurts more than losing a complementary
 * piece). Returns a same-team offense-strength adjustment — 0 or negative.
 */
export function usageShiftEdge(injuries: TeamInjuryReport | undefined, profile: StyleProfile): number {
  if (!injuries) return 0;
  const rbHurt = injuries.players.find((p) => p.position === "RB" && isSidelined(p.status));
  if (!rbHurt) return 0;
  const severity = /doubtful/i.test(rbHurt.status) ? 0.5 : 1;
  const dependence =
    profile.offense === "Run-heavy" ? 1 : profile.offense === "Balanced" ? 0.6 : 0.3;
  return -severity * dependence * 0.5;
}

/* ─── Special teams ────────────────────────────────────── */

/**
 * Punt return average of +10 to +15 yd is great; kick returns that get the
 * offense started past the 25 (approximated here by return average, since
 * per-play starting field position isn't in the season stat feed) are
 * great; a return touchdown is treated as a big momentum event on its own.
 */
export function specialTeamsScore(detail?: TeamDetailStats): number {
  if (!detail) return 0;
  let score = 0;
  if (detail.puntReturnAvg != null) score += clamp((detail.puntReturnAvg - 8) / 7, -0.5, 0.5);
  if (detail.kickReturnAvg != null) score += clamp((detail.kickReturnAvg - 21) / 6, -0.5, 0.5);
  if (detail.specialTeamsTDs) score += Math.min(detail.specialTeamsTDs * 0.4, 0.6);
  return score;
}

/* ─── Prediction engine (pure — unit tested) ──────────── */

/**
 * Pregame prediction. Each factor yields an edge in roughly [-1, 1]
 * (positive = home team), scaled by its weight; the sum is squashed
 * through a logistic into a win probability.
 */
export function predictGame(
  game: Pick<Game, "home" | "away">,
  ctx: GameContext,
  weights: ModelWeights,
  input: GameInput = EMPTY_INPUT,
): Prediction {
  const h = ctx.stats[game.home.id];
  const a = ctx.stats[game.away.id];
  const hd = ctx.detail?.[game.home.id];
  const ad = ctx.detail?.[game.away.id];
  const hf = ctx.flow?.[game.home.id];
  const af = ctx.flow?.[game.away.id];
  const hi = ctx.injuries?.[game.home.id];
  const ai = ctx.injuries?.[game.away.id];
  const hAdv = ctx.advanced?.[normalizeAbbr(game.home.abbreviation)];
  const aAdv = ctx.advanced?.[normalizeAbbr(game.away.abbreviation)];

  const contributions: { label: string; value: number }[] = [];
  const add = (label: string, rawEdge: number, weight: number) => {
    const v = clamp(rawEdge, -1, 1) * (weight / 100);
    contributions.push({ label, value: v });
    return v;
  };

  let edge = 0;

  // Record: win-percentage differential.
  const recEdge = h && a ? winPct(h.wins, h.losses, h.ties) - winPct(a.wins, a.losses, a.ties) : 0;
  edge += add("Record", recEdge * 2, weights.record);

  // Scoring: per-game point differential gap; a 10 pt/game gap is dominant.
  const pdpg = (s?: TeamSeasonStats) =>
    s && s.gamesPlayed > 0 ? (s.pointsFor - s.pointsAgainst) / s.gamesPlayed : 0;
  edge += add("Scoring margin", (pdpg(h) - pdpg(a)) / 10, weights.scoring);

  // Home field: baseline home bump, sharpened by home/road splits when known.
  let hfEdge = 0.35;
  if (h && a) {
    const homeSplit = winPct(h.homeWins, h.homeLosses, 0);
    const roadSplit = winPct(a.roadWins, a.roadLosses, 0);
    hfEdge += (homeSplit - roadSplit) * 0.5;
  }
  edge += add("Home field", hfEdge, weights.homeField);

  // Momentum: current streak differential (5-game streak saturates).
  const stEdge = h && a ? (h.streak - a.streak) / 5 : 0;
  edge += add("Momentum", stEdge, weights.momentum);

  // Power rating: nfelo's published rating when the proxy delivered it,
  // otherwise the Elo computed from this season's results. Both live on the
  // classic Elo scale, where a 250-point gap is a heavy favorite.
  let powerEdge = 0;
  if (hAdv?.nfeloRating != null && aAdv?.nfeloRating != null) {
    powerEdge = (hAdv.nfeloRating - aAdv.nfeloRating) / 250;
  } else {
    const he = ctx.elo?.[game.home.id];
    const ae = ctx.elo?.[game.away.id];
    if (he != null && ae != null) powerEdge = (he - ae) / 250;
  }
  edge += add("Power rating", powerEdge, weights.powerRating);

  // Production: points production converted to expected wins (Pythagorean),
  // plus yards-per-point efficiency when yardage is known — the "production
  // assumption to achieve wins".
  let prodEdge =
    h && a
      ? (pythagoreanWinPct(h.pointsFor, h.pointsAgainst) -
          pythagoreanWinPct(a.pointsFor, a.pointsAgainst)) *
        2
      : 0;
  const yardsPerPoint = (d?: TeamDetailStats, s?: TeamSeasonStats) =>
    d?.totalYpg != null && s && s.gamesPlayed > 0 && s.pointsFor > 0
      ? d.totalYpg / (s.pointsFor / s.gamesPlayed)
      : null;
  const hYpp = yardsPerPoint(hd, h);
  const aYpp = yardsPerPoint(ad, a);
  // League-typical is ~15 yd/pt; fewer yards per point = finishes drives.
  if (hYpp != null && aYpp != null) prodEdge += (aYpp - hYpp) / 8;
  edge += add("Production", prodEdge, weights.production);

  // Yardage: total yards per game differential (~100 ypg gap saturates).
  const yardEdge =
    hd?.totalYpg != null && ad?.totalYpg != null ? (hd.totalYpg - ad.totalYpg) / 100 : 0;
  edge += add("Yardage", yardEdge, weights.yardage);

  // Efficiency: offensive EPA per game — the play-by-play view of how much
  // each drive actually produces (an 8 EPA/game gap saturates).
  const epaEdge =
    hAdv?.offEpaPerGame != null && aAdv?.offEpaPerGame != null
      ? (hAdv.offEpaPerGame - aAdv.offEpaPerGame) / 8
      : 0;
  edge += add("Efficiency (EPA)", epaEdge, weights.epa);

  // QB metrics: primary passers' completion % over expectation (Next Gen
  // Stats) — a ±6 CPOE gap saturates.
  const qbEdge = hAdv?.cpoe != null && aAdv?.cpoe != null ? (hAdv.cpoe - aAdv.cpoe) / 6 : 0;
  edge += add("QB metrics", qbEdge, weights.qbMetrics);

  // Game flow: how teams' games ebb and flow — second halves count most
  // (finishing strength), first halves some (fast starts), plus a nod to
  // proven comeback ability.
  let flowEdge = 0;
  if (hf && af && hf.games > 0 && af.games > 0) {
    flowEdge =
      ((hf.secondHalfMarginPg - af.secondHalfMarginPg) / 7) * 0.7 +
      ((hf.firstHalfMarginPg - af.firstHalfMarginPg) / 7) * 0.3 +
      (hf.comebackWins - af.comebackWins) * 0.05;
  }
  edge += add("Game flow", flowEdge, weights.flow);

  // Injuries: report-burden differential (a hurt QB moves this a lot).
  const injEdge = hi || ai ? ((ai?.burden ?? 0) - (hi?.burden ?? 0)) / 8 : 0;
  edge += add("Injuries", injEdge, weights.injuries);

  // Style: offense type vs defense type, both directions.
  const hProf = styleProfile(hd, h);
  const aProf = styleProfile(ad, a);
  const styleEdge = offenseVsDefense(hProf, aProf) - offenseVsDefense(aProf, hProf);
  edge += add("Style matchup", styleEdge, weights.style);

  // Game-plan usage shift: a hurt RB pushes the offense toward more
  // passing and a less-effective run game, worse for teams that lean on
  // the run in the first place.
  const usageEdge = usageShiftEdge(hi, hProf) - usageShiftEdge(ai, aProf);
  edge += add("Usage shift", usageEdge, weights.usageShift);

  // 3rd / 4th down conversion rate — 4th down is the more critical
  // situational down, reflected in its higher default weight.
  const thirdEdge =
    hd?.thirdDownPct != null && ad?.thirdDownPct != null ? (hd.thirdDownPct - ad.thirdDownPct) / 12 : 0;
  edge += add("3rd down %", thirdEdge, weights.thirdDown);
  const fourthEdge =
    hd?.fourthDownPct != null && ad?.fourthDownPct != null
      ? (hd.fourthDownPct - ad.fourthDownPct) / 15
      : 0;
  edge += add("4th down %", fourthEdge, weights.fourthDown);

  // Turnover margin: tiered, and weighted so a defense forcing takeaways
  // outweighs an offense simply not giving the ball away.
  let toEdge = 0;
  if (hd?.takeawaysTotal != null && hd?.giveawaysTotal != null && h?.gamesPlayed) {
    toEdge += turnoverMarginScore(
      turnoverMarginPace(hd.takeawaysTotal, hd.giveawaysTotal, h.gamesPlayed),
    );
  }
  if (ad?.takeawaysTotal != null && ad?.giveawaysTotal != null && a?.gamesPlayed) {
    toEdge -= turnoverMarginScore(
      turnoverMarginPace(ad.takeawaysTotal, ad.giveawaysTotal, a.gamesPlayed),
    );
  }
  edge += add("Turnover margin", toEdge, weights.turnoverMargin);

  // League-wide yardage rank — top-5 in both offense and defense is a
  // distinct signal, not just "good stats".
  const rankEdge =
    yardageRankScore(ctx.yardageRanks?.[game.home.id]) -
    yardageRankScore(ctx.yardageRanks?.[game.away.id]);
  edge += add("Yardage rank", rankEdge, weights.yardageRank);

  // Special teams: return production plus the momentum jolt of a return TD.
  const specialTeamsEdge = specialTeamsScore(hd) - specialTeamsScore(ad);
  edge += add("Special teams", specialTeamsEdge, weights.specialTeams);

  // The user's reasoning layer: lean slider + environment tags.
  const tagSum = Object.values(input.tags).reduce(
    (sum, side) => sum + (side === "home" ? 0.35 : -0.35),
    0,
  );
  const userEdge = input.lean / 3 + tagSum;
  edge += add("Your reasoning", userEdge, weights.reasoning);

  // Logistic squash — k tuned so a full one-sided edge ≈ 90%+.
  const homeProb = 1 / (1 + Math.exp(-1.6 * edge));
  const winner = homeProb >= 0.5 ? "home" : "away";
  return {
    homeProb,
    winner,
    confidence: Math.max(homeProb, 1 - homeProb),
    contributions,
  };
}

/* ─── Live win probability (the comeback curve) ───────── */

/**
 * Reprice the pregame edge by score and clock for an in-progress game.
 *
 * Margin is compared against how much scoring variance is left:
 * sd ≈ 13.5 points over a full game, shrinking with √(time remaining).
 * Down 21-0 in Q1 that leaves a real few-percent chance; the same deficit
 * midway through Q4 is effectively zero — matching how comebacks actually
 * happen "all the way to the 4th".
 */
export function liveWinProb(game: Game, pregameHomeProb: number): number {
  if (game.completed) {
    if (game.homeScore == null || game.awayScore == null) return pregameHomeProb;
    return game.homeScore > game.awayScore ? 1 : game.homeScore < game.awayScore ? 0 : 0.5;
  }
  if (game.state !== "in" || game.homeScore == null || game.awayScore == null) {
    return pregameHomeProb;
  }
  const period = game.period ?? 1;
  const clock = game.clockSeconds ?? 900;
  // Seconds of regulation left; overtime keeps a sliver of variance alive.
  const remaining = period <= 4 ? (4 - period) * 900 + clamp(clock, 0, 900) : clamp(clock, 0, 600) / 2;
  const t = clamp(remaining / 3600, 0, 1);
  const margin = game.homeScore - game.awayScore;
  if (t <= 0.001) return margin > 0 ? 0.99 : margin < 0 ? 0.01 : 0.5;

  // Convert the pregame probability to a point spread (logistic, ~7.6 pt scale)
  // and let the un-played fraction of that edge still count.
  const p = clamp(pregameHomeProb, 0.02, 0.98);
  const spread = 7.6 * Math.log(p / (1 - p));
  const sd = 13.5 * Math.sqrt(t);
  return clamp(normCdf((margin + spread * t) / sd), 0.001, 0.999);
}

/* ─── ESPN fetch + parse ──────────────────────────────── */

const ESPN_SITE = "https://site.api.espn.com/apis";
const ESPN_CORE = "https://sports.core.api.espn.com/v2";

/* eslint-disable @typescript-eslint/no-explicit-any -- external API payloads */

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN request failed (${res.status})`);
  return res.json();
}

function parseCompetitor(
  c: any,
): TeamInfo & { score?: number; homeAway: string; linescores?: number[] } {
  const t = c?.team ?? {};
  return {
    id: String(t.id ?? ""),
    abbreviation: t.abbreviation ?? "?",
    displayName: t.displayName ?? "Unknown",
    shortName: t.shortName ?? t.name ?? t.abbreviation ?? "Unknown",
    logo: t.logo,
    color: t.color,
    record: Array.isArray(c?.records)
      ? c.records.find((r: any) => r.type === "total" || r.name === "overall")?.summary
      : undefined,
    score: c?.score != null && c.score !== "" ? Number(c.score) : undefined,
    homeAway: c?.homeAway ?? "",
    linescores: Array.isArray(c?.linescores)
      ? c.linescores.map((l: any) => Number(l?.value ?? 0))
      : undefined,
  };
}

/** Parse a scoreboard payload into a WeekSchedule. Exported for tests. */
export function parseScoreboard(data: any): WeekSchedule {
  const games: Game[] = [];
  for (const ev of data?.events ?? []) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;
    const competitors = (comp.competitors ?? []).map(parseCompetitor);
    const home = competitors.find((c: any) => c.homeAway === "home");
    const away = competitors.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;
    const status = comp.status ?? ev.status ?? {};
    const stateRaw = status?.type?.state;
    games.push({
      id: String(ev.id),
      date: ev.date ?? comp.date ?? "",
      name: ev.name ?? `${away.displayName} at ${home.displayName}`,
      home,
      away,
      venue: comp.venue?.fullName,
      state: stateRaw === "post" ? "post" : stateRaw === "in" ? "in" : "pre",
      completed: Boolean(status?.type?.completed),
      homeScore: home.score,
      awayScore: away.score,
      statusDetail: status?.type?.shortDetail ?? status?.type?.detail,
      broadcast: comp.broadcasts?.[0]?.names?.[0] ?? comp.broadcast,
      homeLinescores: home.linescores,
      awayLinescores: away.linescores,
      period: typeof status?.period === "number" ? status.period : undefined,
      clockSeconds: typeof status?.clock === "number" ? status.clock : undefined,
    });
  }
  games.sort((x, y) => x.date.localeCompare(y.date));
  return {
    seasonYear: Number(data?.season?.year ?? new Date().getFullYear()),
    weekNumber: Number(data?.week?.number ?? 1),
    games,
  };
}

/**
 * Fetch a week's schedule. With no args, ESPN returns the current week —
 * used on first load to discover where we are in the season.
 */
export async function fetchWeek(season?: number, week?: number): Promise<WeekSchedule> {
  const params = season && week ? `?dates=${season}&seasontype=2&week=${week}` : "";
  const data = await fetchJson(`${ESPN_SITE}/site/v2/sports/football/nfl/scoreboard${params}`);
  return parseScoreboard(data);
}

/** Parse a standings payload into a per-team stats map. Exported for tests. */
export function parseStandings(data: any): StatsMap {
  const map: StatsMap = {};
  // Standings arrive either flat (data.standings.entries) or nested by
  // conference (data.children[].standings.entries).
  const groups: any[] = data?.children?.length ? data.children : [data];
  for (const group of groups) {
    for (const entry of group?.standings?.entries ?? []) {
      const id = String(entry?.team?.id ?? "");
      if (!id) continue;
      const stat = (name: string) =>
        Number(entry.stats?.find((s: any) => s.name === name || s.type === name)?.value ?? 0);
      const rec = (type: string) => {
        const summary = entry.stats?.find(
          (s: any) => s.name === type || s.type === type,
        )?.displayValue as string | undefined;
        const [w, l] = (summary ?? "0-0").split("-").map(Number);
        return { w: w || 0, l: l || 0 };
      };
      const wins = stat("wins");
      const losses = stat("losses");
      const ties = stat("ties");
      const home = rec("Home");
      const road = rec("Road");
      map[id] = {
        teamId: id,
        wins,
        losses,
        ties,
        pointsFor: stat("pointsFor"),
        pointsAgainst: stat("pointsAgainst"),
        gamesPlayed: wins + losses + ties,
        streak: stat("streak"),
        homeWins: home.w,
        homeLosses: home.l,
        roadWins: road.w,
        roadLosses: road.l,
      };
    }
  }
  return map;
}

export async function fetchStandings(season: number): Promise<StatsMap> {
  const data = await fetchJson(
    `${ESPN_SITE}/v2/sports/football/nfl/standings?season=${season}&level=1`,
  );
  return parseStandings(data);
}

/**
 * Parse a core-API team statistics payload into yardage + situational
 * detail. Scans every category so shape drift degrades gracefully; a few
 * fields (interceptions, fumbles) mean different things in a "defensive"
 * category (takeaways) vs an offensive one (giveaways), so those are kept
 * category-aware rather than folded into one flat lookup. Exported for
 * tests.
 */
export function parseTeamStatistics(teamId: string, data: any): TeamDetailStats {
  const idx: Record<string, number> = {};
  let defInterceptions = 0;
  let defFumbleRecoveries = 0;
  let offInterceptionsThrown = 0;
  let offFumblesLost = 0;
  let turnoverDifferential: number | null = null;

  for (const cat of data?.splits?.categories ?? []) {
    const catName = String(cat?.name ?? "").toLowerCase();
    const isDefense = catName.includes("defensive") || catName.includes("defense");
    for (const s of cat?.stats ?? []) {
      if (!s?.name || typeof s.value !== "number") continue;
      if (!(s.name in idx)) idx[s.name] = s.value;
      if (s.name === "interceptions") {
        if (isDefense) defInterceptions = s.value;
        else offInterceptionsThrown = s.value;
      } else if (s.name === "fumblesRecovered") {
        defFumbleRecoveries = s.value;
      } else if (s.name === "fumblesLost") {
        offFumblesLost = s.value;
      } else if (s.name === "turnOverDifferential" && turnoverDifferential == null) {
        turnoverDifferential = s.value;
      }
    }
  }

  const passYpg = idx.netPassingYardsPerGame ?? idx.passingYardsPerGame ?? null;
  const rushYpg = idx.rushingYardsPerGame ?? null;
  const totalYpg =
    idx.totalYardsPerGame ?? (passYpg != null && rushYpg != null ? passYpg + rushYpg : null);
  const defYpg = idx.yardsAllowedPerGame ?? idx.totalYardsAllowedPerGame ?? null;
  const thirdDownPct = idx.thirdDownConvPct ?? null;
  const fourthDownPct = idx.fourthDownConvPct ?? null;

  const takeawaysTotal =
    defInterceptions || defFumbleRecoveries ? defInterceptions + defFumbleRecoveries : null;
  const giveawaysTotal =
    offInterceptionsThrown || offFumblesLost ? offInterceptionsThrown + offFumblesLost : null;
  // Cross-check fallback: if we couldn't separate takeaways/giveaways but a
  // direct differential stat is present, at least the margin math still
  // works (turnoverMarginPace only needs the two numbers, so split it
  // evenly around the published differential as a last resort).
  const takeaways = takeawaysTotal ?? (turnoverDifferential != null ? Math.max(turnoverDifferential, 0) : null);
  const giveaways = giveawaysTotal ?? (turnoverDifferential != null ? Math.max(-turnoverDifferential, 0) : null);

  const puntReturns = idx.puntReturns ?? null;
  const puntReturnYards = idx.puntReturnYards ?? null;
  const puntReturnAvg =
    idx.puntReturnAverage ??
    (puntReturns && puntReturnYards != null ? puntReturnYards / puntReturns : null);
  const kickReturns = idx.kickReturns ?? null;
  const kickReturnYards = idx.kickReturnYards ?? null;
  const kickReturnAvg =
    idx.kickReturnAverage ??
    (kickReturns && kickReturnYards != null ? kickReturnYards / kickReturns : null);
  const specialTeamsTDs =
    (idx.puntReturnTouchdowns ?? 0) + (idx.kickReturnTouchdowns ?? 0) || null;

  return {
    teamId,
    passYpg,
    rushYpg,
    totalYpg,
    defYpg,
    thirdDownPct,
    fourthDownPct,
    takeawaysTotal: takeaways,
    giveawaysTotal: giveaways,
    puntReturnAvg,
    kickReturnAvg,
    specialTeamsTDs,
  };
}

/** Fetch yardage detail for a set of teams; failures leave gaps, not errors. */
export async function fetchDetailMap(season: number, teamIds: string[]): Promise<DetailMap> {
  const results = await Promise.allSettled(
    teamIds.map(async (id) => {
      const data = await fetchJson(
        `${ESPN_CORE}/sports/football/leagues/nfl/seasons/${season}/types/2/teams/${id}/statistics`,
      );
      return parseTeamStatistics(id, data);
    }),
  );
  const map: DetailMap = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.totalYpg != null) map[r.value.teamId] = r.value;
  }
  return map;
}

/** Parse the league-wide injuries payload. Exported for tests. */
export function parseInjuries(data: any): InjuryMap {
  const statusWeight = (status: string): number => {
    const s = status.toLowerCase();
    if (s.includes("injured reserve") || s === "ir" || s.includes("out")) return 1;
    if (s.includes("doubtful")) return 0.8;
    if (s.includes("questionable")) return 0.4;
    return 0.2; // day-to-day / probable
  };
  const posWeight = (pos: string): number => {
    if (pos === "QB") return 5;
    if (["RB", "WR", "TE"].includes(pos)) return 2;
    if (["LT", "RT", "OT", "G", "C", "OL"].includes(pos)) return 1.5;
    return 1;
  };
  const map: InjuryMap = {};
  for (const teamEntry of data?.injuries ?? []) {
    const teamId = String(teamEntry?.id ?? teamEntry?.team?.id ?? "");
    if (!teamId) continue;
    const players: InjuredPlayer[] = [];
    let burden = 0;
    for (const inj of teamEntry?.injuries ?? []) {
      const name = inj?.athlete?.displayName ?? inj?.athlete?.shortName;
      const status = inj?.status ?? inj?.type?.description ?? "";
      if (!name || !status) continue;
      const position = inj?.athlete?.position?.abbreviation ?? "";
      players.push({ name, position, status });
      burden += statusWeight(status) * posWeight(position);
    }
    // Worst news first: QBs and harder statuses at the top of the list.
    players.sort(
      (x, y) => statusWeight(y.status) * posWeight(y.position) - statusWeight(x.status) * posWeight(x.position),
    );
    map[teamId] = { teamId, burden, players };
  }
  return map;
}

export async function fetchInjuries(): Promise<InjuryMap> {
  const data = await fetchJson(`${ESPN_SITE}/site/v2/sports/football/nfl/injuries`);
  return parseInjuries(data);
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* ─── Game-flow stats from linescores ─────────────────── */

/**
 * Fold completed games' quarter linescores into per-team flow stats —
 * the "ebbs and flows of the game previously". Exported for tests.
 */
export function computeFlowStats(weeks: { games: Game[] }[]): FlowMap {
  const acc: Record<
    string,
    { g: number; fh: number; sh: number; swing: number; comebacks: number; blown: number }
  > = {};
  const tally = (teamId: string, own: number[], opp: number[], won: boolean) => {
    const a = (acc[teamId] ??= { g: 0, fh: 0, sh: 0, swing: 0, comebacks: 0, blown: 0 });
    const q = (arr: number[], i: number) => arr[i] ?? 0;
    const fhMargin = q(own, 0) + q(own, 1) - (q(opp, 0) + q(opp, 1));
    const rest = (arr: number[]) => arr.slice(2).reduce((s, v) => s + v, 0);
    const shMargin = rest(own) - rest(opp);
    const quarters = Math.max(own.length, opp.length, 4);
    let swings = 0;
    for (let i = 1; i < quarters; i++) {
      swings += Math.abs(q(own, i) - q(opp, i) - (q(own, i - 1) - q(opp, i - 1)));
    }
    a.g += 1;
    a.fh += fhMargin;
    a.sh += shMargin;
    a.swing += swings / Math.max(quarters - 1, 1);
    if (fhMargin < 0 && won) a.comebacks += 1;
    if (fhMargin > 0 && !won) a.blown += 1;
  };
  for (const wk of weeks) {
    for (const g of wk.games) {
      if (!g.completed || !g.homeLinescores?.length || !g.awayLinescores?.length) continue;
      if (g.homeScore == null || g.awayScore == null || g.homeScore === g.awayScore) continue;
      tally(g.home.id, g.homeLinescores, g.awayLinescores, g.homeScore > g.awayScore);
      tally(g.away.id, g.awayLinescores, g.homeLinescores, g.awayScore > g.homeScore);
    }
  }
  const map: FlowMap = {};
  for (const [teamId, a] of Object.entries(acc)) {
    map[teamId] = {
      teamId,
      games: a.g,
      firstHalfMarginPg: a.g ? a.fh / a.g : 0,
      secondHalfMarginPg: a.g ? a.sh / a.g : 0,
      avgQuarterSwing: a.g ? a.swing / a.g : 0,
      comebackWins: a.comebacks,
      blownLeads: a.blown,
    };
  }
  return map;
}

/* ─── Elo power ratings from season results ───────────── */

/**
 * nfelo-style Elo power ratings computed from this season's games:
 * everyone starts at 1500, K=20, ~48 points of home advantage, and a
 * margin-of-victory multiplier that damps blowouts by heavy favorites.
 * Used as the fallback when nfelo's published ratings aren't reachable.
 */
export function computeEloRatings(weeks: { games: Game[] }[]): Record<string, number> {
  const R: Record<string, number> = {};
  const get = (id: string) => (R[id] ??= 1500);
  const games = weeks
    .flatMap((w) => w.games)
    .filter((g) => g.completed && g.homeScore != null && g.awayScore != null)
    .sort((x, y) => x.date.localeCompare(y.date));
  for (const g of games) {
    const rh = get(g.home.id);
    const ra = get(g.away.id);
    const diff = rh + 48 - ra;
    const expected = 1 / (1 + Math.pow(10, -diff / 400));
    const actual = g.homeScore! > g.awayScore! ? 1 : g.homeScore! < g.awayScore! ? 0 : 0.5;
    const margin = Math.abs(g.homeScore! - g.awayScore!);
    const winnerDiff = actual === 1 ? diff : actual === 0 ? -diff : 0;
    const mov = Math.log(margin + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    const delta = 20 * mov * (actual - expected);
    R[g.home.id] = rh + delta;
    R[g.away.id] = ra - delta;
  }
  return R;
}

export interface SeasonHistory {
  flow: FlowMap;
  elo: Record<string, number>;
}

/** Fetch every played week's scoreboard and derive flow stats + Elo. */
export async function fetchSeasonHistory(
  season: number,
  throughWeek: number,
): Promise<SeasonHistory> {
  const weekNums = Array.from({ length: Math.max(1, Math.min(throughWeek, 18)) }, (_, i) => i + 1);
  const weeks = await Promise.all(
    weekNums.map((w) =>
      fetchWeek(season, w).catch(() => ({ seasonYear: season, weekNumber: w, games: [] as Game[] })),
    ),
  );
  return { flow: computeFlowStats(weeks), elo: computeEloRatings(weeks) };
}

/* ─── Helpers for the page ────────────────────────────── */

/** Group games by local calendar day, preserving chronological order. */
export function groupByDay(games: Game[]): { label: string; games: Game[] }[] {
  const out: { label: string; games: Game[] }[] = [];
  for (const g of games) {
    const label = new Date(g.date).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const bucket = out.find((b) => b.label === label);
    if (bucket) bucket.games.push(g);
    else out.push({ label, games: [g] });
  }
  return out;
}

export function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Grade a completed game against the model's pick. */
export function gradeGame(game: Game, prediction: Prediction): boolean | null {
  if (!game.completed || game.homeScore == null || game.awayScore == null) return null;
  if (game.homeScore === game.awayScore) return null; // tie — no grade
  const actual = game.homeScore > game.awayScore ? "home" : "away";
  return actual === prediction.winner;
}
