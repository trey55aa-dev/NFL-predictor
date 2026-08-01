import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_WEIGHTS,
  EMPTY_INPUT,
  ENV_TAGS,
  NFL_INPUTS_KEY,
  NFL_WEIGHTS_KEY,
  computeYardageRanks,
  ensureWeights,
  fetchDetailMap,
  fetchInjuries,
  fetchRosterMap,
  fetchScoringPlays,
  fetchSeasonHistory,
  fetchStandings,
  fetchWeek,
  formatKickoff,
  gradeGame,
  groupByDay,
  liveWinProb,
  normalizeAbbr,
  predictGame,
  styleProfile,
  type EnvTag,
  type Game,
  type GameContext,
  type GameInput,
  type ModelWeights,
  type ScoringPlay,
  type TeamFlowStats,
} from "@/lib/predictor";
import { ADVANCED_SOURCE_LABELS, fetchAdvancedStats } from "@/lib/advanced";
import { downloadDatabase, importDatabase, useLocalStorage } from "@/lib/storage";

type InputsMap = Record<string, GameInput>;

const WEIGHT_LABELS: { key: keyof ModelWeights; label: string; hint: string }[] = [
  { key: "powerRating", label: "Power rating", hint: "nfelo / computed Elo differential" },
  { key: "record", label: "Record", hint: "Win-loss percentage gap" },
  { key: "scoring", label: "Scoring margin", hint: "Points for vs against, per game" },
  { key: "production", label: "Production", hint: "Points → expected wins, yards-per-point" },
  { key: "epa", label: "Efficiency (EPA)", hint: "Offensive EPA per game (nflverse)" },
  { key: "qbMetrics", label: "QB metrics", hint: "Primary QB CPOE (Next Gen Stats)" },
  { key: "yardage", label: "Yardage", hint: "Total yards per game" },
  { key: "yardageRank", label: "Yardage rank", hint: "League rank; top-5 both ways is a bonus" },
  { key: "thirdDown", label: "3rd down %", hint: "Conversion rate differential" },
  { key: "fourthDown", label: "4th down %", hint: "Conversion rate — the most critical down" },
  { key: "turnoverMargin", label: "Turnover margin", hint: "Tiered; takeaways count more than giveaways avoided" },
  { key: "specialTeams", label: "Special teams", hint: "Return production + return-TD momentum" },
  { key: "situationalSweep", label: "Situational sweep", hint: "Bonus for winning nearly everything: 3rd down, turnovers, rushing, passing" },
  { key: "usageShift", label: "Usage shift", hint: "RB injury → pass-heavier game plan (roster-aware: starter vs backup)" },
  { key: "possession", label: "Time of possession", hint: "Control + ability to score; clutch D matters more with less TOP" },
  { key: "flow", label: "Game flow", hint: "1st/2nd-half surges from quarter scoring" },
  { key: "injuries", label: "Injuries", hint: "Injury-report burden, QB-weighted" },
  { key: "style", label: "Style matchup", hint: "Offense type vs defense type" },
  { key: "homeField", label: "Home field", hint: "Baseline bump + home/road splits" },
  { key: "momentum", label: "Momentum", hint: "Current win/loss streaks" },
  { key: "reasoning", label: "My reasoning", hint: "Your lean, tags and notes" },
];

const label10 = "font-mono text-[10px] tracking-[0.15em] uppercase text-zinc-400";
const ghostBtn =
  "px-2 py-1 rounded-md font-mono text-[11px] text-zinc-400 hover:text-gold hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none";

/* ─── Weights panel ───────────────────────────────────── */

function WeightsPanel({
  weights,
  setWeights,
}: {
  weights: ModelWeights;
  setWeights: (w: ModelWeights) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card p-4 mb-6">
      <button className="w-full flex items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold">
          Model weights
        </span>
        <span className="text-zinc-500 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          {WEIGHT_LABELS.map(({ key, label, hint }) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1.5">
                <div>
                  <span className="text-sm text-zinc-100">{label}</span>
                  <span className="ml-2 text-xs text-zinc-500">{hint}</span>
                </div>
                <span className="font-mono text-xs text-gold w-8 text-right">{weights[key]}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={weights[key]}
                onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                aria-label={label}
              />
            </div>
          ))}
          <button className={ghostBtn} onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}>
            ↺ Reset defaults
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Probability bar ─────────────────────────────────── */

function ProbBar({
  game,
  homeProb,
  winner,
}: {
  game: Game;
  homeProb: number;
  winner: "home" | "away";
}) {
  const homePct = Math.round(homeProb * 100);
  const awayColor = game.away.color ? `#${game.away.color}` : "#3f3f46";
  const homeColor = game.home.color ? `#${game.home.color}` : "#3f3f46";
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden bg-white/5">
        <div style={{ width: `${100 - homePct}%`, background: awayColor }} />
        <div style={{ width: `${homePct}%`, background: homeColor }} />
      </div>
      <div className="flex justify-between mt-1 font-mono text-[10px] text-zinc-400">
        <span className={winner === "away" ? "text-gold" : ""}>
          {game.away.abbreviation} {100 - homePct}%
        </span>
        <span className={winner === "home" ? "text-gold" : ""}>
          {game.home.abbreviation} {homePct}%
        </span>
      </div>
    </div>
  );
}

/* ─── Game card pieces ────────────────────────────────── */

function TeamRow({
  team,
  score,
  winner,
  badges,
}: {
  team: Game["home"];
  score?: number;
  winner: boolean;
  badges: string[];
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {team.logo && <img src={team.logo} alt="" className="h-7 w-7 shrink-0" loading="lazy" />}
      <div className="min-w-0">
        <div className={`text-sm truncate ${winner ? "text-gold" : "text-zinc-100"}`}>
          {team.shortName}
        </div>
        <div className="font-mono text-[10px] text-zinc-400">
          {team.record ?? ""}
          {badges.length > 0 && <span className="text-zinc-500"> · {badges.join(" · ")}</span>}
        </div>
      </div>
      {score != null && <div className="ml-auto text-xl text-zinc-100">{score}</div>}
    </div>
  );
}

function FlowChips({ team, flow }: { team: Game["home"]; flow?: TeamFlowStats }) {
  if (!flow || flow.games === 0) return null;
  const chips: string[] = [];
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
  chips.push(`1H ${fmt(flow.firstHalfMarginPg)}/gm`);
  chips.push(`2H ${fmt(flow.secondHalfMarginPg)}/gm`);
  if (flow.comebackWins > 0)
    chips.push(`${flow.comebackWins} comeback W${flow.comebackWins > 1 ? "s" : ""}`);
  if (flow.blownLeads > 0)
    chips.push(`${flow.blownLeads} blown lead${flow.blownLeads > 1 ? "s" : ""}`);
  chips.push(
    flow.avgQuarterSwing >= 7 ? "Volatile" : flow.avgQuarterSwing <= 4 ? "Steady" : "Ebbs & flows",
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] text-zinc-300 w-10">{team.abbreviation}</span>
      {chips.map((c) => (
        <span key={c} className="px-1.5 py-0.5 rounded bg-white/5 font-mono text-[10px] text-zinc-400">
          {c}
        </span>
      ))}
    </div>
  );
}

function AdvancedMetrics({ team, ctx }: { team: Game["home"]; ctx: GameContext }) {
  const adv = ctx.advanced?.[normalizeAbbr(team.abbreviation)];
  const elo = adv?.nfeloRating ?? ctx.elo?.[team.id];
  const rows: string[] = [];
  if (elo != null) rows.push(`${adv?.nfeloRating != null ? "nfelo" : "Elo"} ${Math.round(elo)}`);
  if (adv?.offEpaPerGame != null)
    rows.push(`EPA ${adv.offEpaPerGame >= 0 ? "+" : ""}${adv.offEpaPerGame.toFixed(1)}/gm`);
  if (adv?.qbName && adv?.cpoe != null)
    rows.push(`${adv.qbName} CPOE ${adv.cpoe >= 0 ? "+" : ""}${adv.cpoe.toFixed(1)}`);
  if (adv?.timeToThrow != null) rows.push(`TTT ${adv.timeToThrow.toFixed(2)}s`);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] text-zinc-300 w-10">{team.abbreviation}</span>
      {rows.map((r) => (
        <span key={r} className="px-1.5 py-0.5 rounded bg-white/5 font-mono text-[10px] text-zinc-400">
          {r}
        </span>
      ))}
    </div>
  );
}

function InjuryList({ team, ctx }: { team: Game["home"]; ctx: GameContext }) {
  const report = ctx.injuries?.[team.id];
  if (!report || report.players.length === 0) return null;
  const top = report.players.slice(0, 4);
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] text-zinc-300 mb-1">{team.abbreviation}</div>
      <ul className="space-y-0.5">
        {top.map((p, i) => (
          <li key={`${p.name}-${i}`} className="text-xs text-zinc-400 truncate">
            {p.name} <span className="text-zinc-500">{p.position}</span>{" "}
            <span className={/out|reserve|ir/i.test(p.status) ? "text-red-400" : "text-amber-400/80"}>
              {p.status}
            </span>
          </li>
        ))}
        {report.players.length > 4 && (
          <li className="text-[10px] font-mono text-zinc-500">+{report.players.length - 4} more</li>
        )}
      </ul>
    </div>
  );
}

function teamBadges(team: Game["home"], ctx: GameContext): string[] {
  const prof = styleProfile(ctx.detail?.[team.id], ctx.stats[team.id]);
  const badges: string[] = [];
  if (prof.offense) badges.push(prof.offense);
  if (prof.offenseTier && prof.offenseTier !== "Average") badges.push(`${prof.offenseTier} O`);
  if (prof.defenseTier && prof.defenseTier !== "Solid") badges.push(`${prof.defenseTier} D`);
  return badges;
}

/* ─── Game card ───────────────────────────────────────── */

function GameCard({
  game,
  ctx,
  weights,
  input,
  setInput,
}: {
  game: Game;
  ctx: GameContext;
  weights: ModelWeights;
  input: GameInput;
  setInput: (gi: GameInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const prediction = useMemo(
    () => predictGame(game, ctx, weights, input),
    [game, ctx, weights, input],
  );
  const pick = prediction.winner === "home" ? game.home : game.away;
  const graded = input.graded ?? null;
  const liveGrade = graded ? graded.correct : gradeGame(game, prediction);

  // In-progress: reprice by score + clock (the comeback curve).
  const live = game.state === "in" ? liveWinProb(game, prediction.homeProb) : null;
  const liveLeader = live != null && live >= 0.5 ? game.home : game.away;
  const trailerProbPct =
    live != null ? Math.round((liveLeader.id === game.home.id ? 1 - live : live) * 100) : 0;

  const cycleTag = (tag: EnvTag) => {
    const cur = input.tags[tag];
    const next = cur === undefined ? "home" : cur === "home" ? "away" : undefined;
    const tags = { ...input.tags };
    if (next === undefined) delete tags[tag];
    else tags[tag] = next;
    setInput({ ...input, tags });
  };

  const hasInjuries =
    (ctx.injuries?.[game.home.id]?.players.length ?? 0) > 0 ||
    (ctx.injuries?.[game.away.id]?.players.length ?? 0) > 0;
  const homeFlow = ctx.flow?.[game.home.id];
  const awayFlow = ctx.flow?.[game.away.id];

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 flex-1 min-w-0">
          <TeamRow
            team={game.away}
            score={game.state !== "pre" ? game.awayScore : undefined}
            winner={prediction.winner === "away"}
            badges={teamBadges(game.away, ctx)}
          />
          <TeamRow
            team={game.home}
            score={game.state !== "pre" ? game.homeScore : undefined}
            winner={prediction.winner === "home"}
            badges={teamBadges(game.home, ctx)}
          />
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-[10px] text-zinc-400">
            {game.state === "pre" ? formatKickoff(game.date) : game.statusDetail}
          </div>
          {game.broadcast && game.state === "pre" && (
            <div className="font-mono text-[10px] text-zinc-500">{game.broadcast}</div>
          )}
        </div>
      </div>

      <div className="mt-3">
        <ProbBar game={game} homeProb={prediction.homeProb} winner={prediction.winner} />
      </div>

      {live != null && (
        <div className="mt-3 rounded-md bg-white/5 p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-gold">
              Live win probability
            </span>
            <span className="font-mono text-[10px] text-zinc-400">
              {liveLeader.abbreviation} {Math.round(Math.max(live, 1 - live) * 100)}%
            </span>
          </div>
          <div className="flex h-1.5 rounded-full overflow-hidden bg-white/5">
            <div
              style={{
                width: `${100 - Math.round(live * 100)}%`,
                background: game.away.color ? `#${game.away.color}` : "#3f3f46",
              }}
            />
            <div
              style={{
                width: `${Math.round(live * 100)}%`,
                background: game.home.color ? `#${game.home.color}` : "#3f3f46",
              }}
            />
          </div>
          <div className="mt-1.5 font-mono text-[10px] text-zinc-500">
            Deficits are priced against the clock —{" "}
            {liveLeader.id === game.home.id ? game.away.abbreviation : game.home.abbreviation} still
            wins {trailerProbPct}% of the time from here.
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-zinc-500">
            Pick
          </span>
          <span className="text-sm text-gold truncate">{pick.shortName}</span>
          <span className="font-mono text-[10px] text-zinc-400">
            {Math.round(prediction.confidence * 100)}%
          </span>
          {game.completed && liveGrade !== null && (
            <span
              className={`inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded ${
                liveGrade ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
              }`}
            >
              {liveGrade ? "✓ Hit" : "✗ Miss"}
            </span>
          )}
        </div>
        <button
          className="font-mono text-[10px] tracking-[0.15em] uppercase text-zinc-400 hover:text-gold transition-colors shrink-0"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Close" : "Your read"}
          {(input.lean !== 0 || Object.keys(input.tags).length > 0 || input.note) && !open && (
            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
          )}
        </button>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-zinc-800/60 space-y-4">
          {/* Lean slider */}
          <div>
            <div className="flex justify-between font-mono text-[10px] text-zinc-400 mb-1.5">
              <span>{game.away.abbreviation}</span>
              <span className="tracking-[0.15em] uppercase">Your lean</span>
              <span>{game.home.abbreviation}</span>
            </div>
            <input
              type="range"
              min={-3}
              max={3}
              step={1}
              value={input.lean}
              onChange={(e) => setInput({ ...input, lean: Number(e.target.value) })}
              aria-label="Your lean"
            />
          </div>

          {/* Environment tags — tap to cycle: off → home → away → off */}
          <div>
            <div className={`${label10} mb-1.5`}>Environment edges</div>
            <div className="flex flex-wrap gap-1.5">
              {ENV_TAGS.map((tag) => {
                const side = input.tags[tag];
                return (
                  <button
                    key={tag}
                    onClick={() => cycleTag(tag)}
                    className={`px-2 py-1 rounded-md font-mono text-[10px] border transition-colors ${
                      side
                        ? "border-gold/60 text-gold bg-gold/10"
                        : "border-zinc-800 text-zinc-400 hover:border-gold/40"
                    }`}
                  >
                    {tag}
                    {side && ` → ${side === "home" ? game.home.abbreviation : game.away.abbreviation}`}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notes */}
          <textarea
            value={input.note}
            onChange={(e) => setInput({ ...input, note: e.target.value })}
            placeholder="Why do you like this side? (matchups, injuries, weather…)"
            className="w-full min-h-[64px] text-sm rounded-md border border-zinc-800 bg-zinc-900/60 p-2 placeholder:text-zinc-600 focus:outline-none focus:border-gold/50"
          />

          {/* Advanced metrics: power rating, EPA, QB (when sources are live) */}
          {(ctx.elo || ctx.advanced) && (
            <div>
              <div className={`${label10} mb-1.5`}>Advanced metrics</div>
              <div className="space-y-1.5">
                <AdvancedMetrics team={game.away} ctx={ctx} />
                <AdvancedMetrics team={game.home} ctx={ctx} />
              </div>
            </div>
          )}

          {/* Game flow: per-half scoring, comebacks, volatility */}
          {(homeFlow || awayFlow) && (
            <div>
              <div className={`${label10} mb-1.5`}>Game flow this season</div>
              <div className="space-y-1.5">
                <FlowChips team={game.away} flow={awayFlow} />
                <FlowChips team={game.home} flow={homeFlow} />
              </div>
            </div>
          )}

          {/* Injury report */}
          {hasInjuries && (
            <div>
              <div className={`${label10} mb-1.5`}>Injury report</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InjuryList team={game.away} ctx={ctx} />
                <InjuryList team={game.home} ctx={ctx} />
              </div>
            </div>
          )}

          {/* Factor breakdown */}
          <div className="space-y-1">
            <div className={`${label10} mb-1.5`}>Factor breakdown</div>
            {prediction.contributions.map(({ label, value }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-xs text-zinc-400 w-28 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 relative bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 bg-gold/70"
                    style={{
                      left: value < 0 ? `${50 + value * 50}%` : "50%",
                      width: `${Math.abs(value) * 50}%`,
                    }}
                  />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-zinc-800" />
                </div>
                <span className="font-mono text-[10px] text-zinc-400 w-10 text-right">
                  {value >= 0 ? game.home.abbreviation : game.away.abbreviation}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── App ─────────────────────────────────────────────── */

export default function App() {
  const [storedWeights, setWeights] = useLocalStorage<ModelWeights>(
    NFL_WEIGHTS_KEY,
    DEFAULT_WEIGHTS,
  );
  // Older saves may predate newly added factors — fill them from defaults.
  const weights = useMemo(() => ensureWeights(storedWeights), [storedWeights]);
  const [inputs, setInputs] = useLocalStorage<InputsMap>(NFL_INPUTS_KEY, {});
  const [selected, setSelected] = useState<{ season: number; week: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // First load: no args → ESPN tells us the current season + week.
  const currentWeek = useQuery({
    queryKey: ["nfl", "currentWeek"],
    queryFn: () => fetchWeek(),
    staleTime: 5 * 60_000,
  });

  const season = selected?.season ?? currentWeek.data?.seasonYear;
  const week = selected?.week ?? currentWeek.data?.weekNumber;

  const schedule = useQuery({
    queryKey: ["nfl", "week", season, week],
    queryFn: () => fetchWeek(season!, week!),
    enabled: season != null && week != null,
    staleTime: 60_000,
  });

  const standings = useQuery({
    queryKey: ["nfl", "standings", season],
    queryFn: () => fetchStandings(season!),
    enabled: season != null,
    staleTime: 10 * 60_000,
  });

  const games = useMemo(() => schedule.data?.games ?? [], [schedule.data]);
  // Prefer every team in the league (from standings, which always covers
  // all 32 regardless of byes) so yardageRank reflects a true 1-32 rank
  // rather than only ranking this week's ~8-16 participants. Standings
  // loads slightly ahead of/alongside the schedule in practice, but fall
  // back to just this week's teams so detail still populates before it
  // resolves.
  const teamIds = useMemo(() => {
    const leagueIds = Object.keys(standings.data ?? {});
    if (leagueIds.length > 0) return leagueIds.sort();
    return Array.from(new Set(games.flatMap((g) => [g.home.id, g.away.id]))).sort();
  }, [standings.data, games]);

  // Enrichment feeds — each optional; the model stays neutral where they fail.
  const detail = useQuery({
    queryKey: ["nfl", "detail", season, teamIds.join(",")],
    queryFn: () => fetchDetailMap(season!, teamIds),
    enabled: season != null && teamIds.length > 0,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const injuries = useQuery({
    queryKey: ["nfl", "injuries"],
    queryFn: fetchInjuries,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  // One pass over the season's scoreboards feeds both the game-flow stats
  // and the computed Elo power ratings.
  const history = useQuery({
    queryKey: ["nfl", "history", season, week],
    queryFn: () => fetchSeasonHistory(season!, week!),
    enabled: season != null && week != null,
    staleTime: 30 * 60_000,
    retry: 1,
  });

  // Advanced sources (EPA, NGS, PFR, nfelo) via this site's own /api proxy.
  const advanced = useQuery({
    queryKey: ["nfl", "advanced", season],
    queryFn: () => fetchAdvancedStats(season!),
    enabled: season != null,
    staleTime: 30 * 60_000,
    retry: 1,
  });

  // Rosters, so usageShift can tell a hurt starter from a hurt backup.
  const rosters = useQuery({
    queryKey: ["nfl", "rosters", season, teamIds.join(",")],
    queryFn: () => fetchRosterMap(season!, teamIds),
    enabled: season != null && teamIds.length > 0,
    staleTime: 60 * 60_000, // rosters barely move within a week
    retry: 1,
  });

  // Scoring plays for live games only, refetched often so the in-game
  // momentum bump (see momentumBump()) reflects what just happened.
  const liveGameIds = useMemo(
    () => games.filter((g) => g.state === "in").map((g) => g.id),
    [games],
  );
  const scoringPlays = useQuery({
    queryKey: ["nfl", "scoringPlays", liveGameIds.join(",")],
    queryFn: async () => {
      const liveGames = games.filter((g) => g.state === "in");
      const entries = await Promise.all(
        liveGames.map(
          async (g) => [g.id, await fetchScoringPlays(g.id, g.home.id, g.away.id)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, ScoringPlay[]>;
    },
    enabled: liveGameIds.length > 0,
    staleTime: 20_000,
    refetchInterval: liveGameIds.length > 0 ? 20_000 : false,
    retry: 1,
  });

  // NOTE: ranks only this week's participants, not the full 32-team
  // league, until detail is fetched for every team (tracked in
  // PROGRESS.md) — a genuine approximation, not a full league rank yet.
  const yardageRanks = useMemo(
    () => (detail.data ? computeYardageRanks(detail.data) : undefined),
    [detail.data],
  );

  const ctx: GameContext = useMemo(
    () => ({
      stats: standings.data ?? {},
      detail: detail.data,
      flow: history.data?.flow,
      elo: history.data?.elo,
      injuries: injuries.data,
      rosters: rosters.data,
      advanced: advanced.data?.teams,
      yardageRanks,
    }),
    [standings.data, detail.data, history.data, injuries.data, rosters.data, advanced.data, yardageRanks],
  );

  // Live games get their fetched scoring plays attached so liveWinProb can
  // price the in-game momentum bump; grading/record calculations below use
  // the plain `games` list since they don't need this.
  const renderGames = useMemo(
    () =>
      games.map((g) =>
        g.state === "in" && scoringPlays.data?.[g.id]
          ? { ...g, scoringPlays: scoringPlays.data[g.id] }
          : g,
      ),
    [games, scoringPlays.data],
  );

  const days = useMemo(() => groupByDay(renderGames), [renderGames]);

  // Lock in grades the first time a game is seen final, so later weight
  // tweaks can't rewrite history.
  useEffect(() => {
    if (!games.length || !season || !week) return;
    const updates: InputsMap = {};
    for (const g of games) {
      const existing = inputs[g.id] ?? EMPTY_INPUT;
      if (existing.graded || !g.completed) continue;
      const pred = predictGame(g, ctx, weights, existing);
      const correct = gradeGame(g, pred);
      if (correct === null) continue;
      const pickedTeamId = pred.winner === "home" ? g.home.id : g.away.id;
      updates[g.id] = { ...existing, graded: { pickedTeamId, correct, season, week } };
    }
    if (Object.keys(updates).length) setInputs({ ...inputs, ...updates });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, ctx]);

  // Accuracy: this week + all time, from locked grades.
  const record = useMemo(() => {
    let wkHit = 0, wkTot = 0, allHit = 0, allTot = 0;
    const weekIds = new Set(games.map((g) => g.id));
    for (const [id, gi] of Object.entries(inputs)) {
      if (!gi.graded) continue;
      allTot++;
      if (gi.graded.correct) allHit++;
      if (weekIds.has(id)) {
        wkTot++;
        if (gi.graded.correct) wkHit++;
      }
    }
    return { wkHit, wkTot, allHit, allTot };
  }, [inputs, games]);

  const nav = (delta: number) => {
    if (!season || !week) return;
    setSelected({ season, week: Math.min(18, Math.max(1, week + delta)) });
  };

  const onImportFile = async (file: File) => {
    try {
      const n = importDatabase(await file.text());
      setImportMsg(`Imported ${n} data set${n > 1 ? "s" : ""} — reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : "Import failed");
      setTimeout(() => setImportMsg(null), 4000);
    }
  };

  const loading = currentWeek.isLoading || schedule.isLoading;
  const error = currentWeek.error ?? schedule.error;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="h-1 w-1 rounded-full bg-gold inline-block" />
              <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-gold">
                Game day
              </span>
            </div>
            <h1 className="text-3xl sm:text-4xl text-zinc-100 leading-tight">NFL Predictor</h1>
            <p className="mt-1.5 font-mono text-[11px] tracking-[0.15em] uppercase text-zinc-500">
              Your model · your reasoning · projected winners
            </p>
          </div>
          <div className="flex items-start gap-3">
            {record.allTot > 0 && (
              <div className="text-right">
                <div className={label10}>All-time</div>
                <div className="text-xl text-gold">
                  {record.allHit}–{record.allTot - record.allHit}
                </div>
              </div>
            )}
            <div className="flex flex-col items-end gap-1">
              <button className={ghostBtn} onClick={downloadDatabase}>
                ⭳ Export data
              </button>
              <button className={ghostBtn} onClick={() => fileRef.current?.click()}>
                ⭱ Import data
              </button>
              <button
                className={ghostBtn}
                onClick={() => {
                  // /api/logout only exists on a real Vercel deploy; under
                  // plain `vite dev` this 404s harmlessly and we still send
                  // the browser to login.html (a static file either way).
                  fetch("/api/logout", { method: "POST" }).finally(() => {
                    window.location.href = "/login.html";
                  });
                }}
              >
                Sign out
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImportFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
        {importMsg && <div className="mt-2 font-mono text-[11px] text-gold">{importMsg}</div>}
        <div className="mt-4 h-px bg-gradient-to-r from-gold/50 via-zinc-800 to-transparent" />
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between mb-4">
        <button className={ghostBtn} onClick={() => nav(-1)} disabled={!week || week <= 1}>
          ← Prev
        </button>
        <div className="text-center">
          <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold">
            {week ? `Week ${week}` : "…"}
          </div>
          <div className="font-mono text-[10px] text-zinc-500">
            {season ?? ""}
            {record.wkTot > 0 && ` · ${record.wkHit}–${record.wkTot - record.wkHit} this week`}
          </div>
        </div>
        <button className={ghostBtn} onClick={() => nav(1)} disabled={!week || week >= 18}>
          Next →
        </button>
      </div>

      <WeightsPanel weights={weights} setWeights={setWeights} />

      {loading && (
        <div className="card p-10 text-center">
          <div className="font-mono text-[11px] tracking-[0.3em] uppercase text-gold animate-pulse">
            Fetching the slate…
          </div>
        </div>
      )}

      {!loading && error != null && (
        <div className="card p-10 text-center">
          <p className="text-sm text-zinc-400">
            Couldn't reach the schedule service. Check your connection and try again.
          </p>
          <button
            className={`${ghostBtn} mt-3 text-gold`}
            onClick={() => {
              currentWeek.refetch();
              schedule.refetch();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && games.length === 0 && (
        <div className="card p-10 text-center">
          <p className="text-sm text-zinc-400">No games on this week's slate — try another week.</p>
        </div>
      )}

      {/* Advanced data source health */}
      {!loading && games.length > 0 && (
        <div className="card p-3 mb-6">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`${label10} mr-1`}>Advanced sources</span>
            {advanced.isError ||
            (advanced.isSuccess && Object.keys(advanced.data.sources).length === 0) ? (
              <span className="font-mono text-[10px] text-zinc-400">
                offline — run with the <code className="text-gold">/api/advanced</code> function
                (deployed on Vercel, or locally via <code className="text-gold">vercel dev</code>) to
                light up EPA, Next Gen Stats, PFR and nfelo. The model still runs on ESPN data +
                computed Elo.
              </span>
            ) : advanced.isLoading ? (
              <span className="font-mono text-[10px] text-zinc-400 animate-pulse">loading…</span>
            ) : (
              Object.entries(advanced.data?.sources ?? {}).map(([key, s]) => (
                <span
                  key={key}
                  title={s.status === "error" ? s.detail : `${s.teams ?? 0} teams`}
                  className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                    s.status === "ok"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-white/5 text-zinc-500 line-through"
                  }`}
                >
                  {ADVANCED_SOURCE_LABELS[key] ?? key}
                </span>
              ))
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {days.map(({ label, games: dayGames }) => (
          <div key={label}>
            <div className="flex items-center gap-2 mb-2">
              <span className="h-1 w-1 rounded-full bg-gold inline-block" />
              <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-zinc-400">
                {label}
              </span>
            </div>
            <div className="space-y-3">
              {dayGames.map((g) => (
                <GameCard
                  key={g.id}
                  game={g}
                  ctx={ctx}
                  weights={weights}
                  input={inputs[g.id] ?? EMPTY_INPUT}
                  setInput={(gi) => setInputs({ ...inputs, [g.id]: gi })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer className="mt-10 pb-6 text-center font-mono text-[10px] text-zinc-600">
        Data: ESPN · nflverse · Next Gen Stats · Pro-Football-Reference · nfelo — picks are graded
        automatically when games go final. Your data lives in this browser; use Export to back it up.
      </footer>
    </div>
  );
}
