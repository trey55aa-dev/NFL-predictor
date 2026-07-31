import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEIGHTS,
  EMPTY_INPUT,
  computeEloRatings,
  computeFlowStats,
  computeYardageRanks,
  ensureWeights,
  normalizeAbbr,
  gradeGame,
  groupByDay,
  liveWinProb,
  parseInjuries,
  parseScoreboard,
  parseStandings,
  parseTeamStatistics,
  predictGame,
  pythagoreanWinPct,
  specialTeamsScore,
  situationalCategoryWinners,
  situationalSweepBonus,
  styleProfile,
  turnoverMarginPace,
  turnoverMarginScore,
  usageShiftEdge,
  yardageRankScore,
  type Game,
  type GameContext,
  type StatsMap,
  type TeamDetailStats,
  type TeamInjuryReport,
  type TeamSeasonStats,
} from "@/lib/predictor";

function mkStats(id: string, p: Partial<TeamSeasonStats> = {}): TeamSeasonStats {
  return {
    teamId: id,
    wins: 8,
    losses: 8,
    ties: 0,
    pointsFor: 350,
    pointsAgainst: 350,
    gamesPlayed: 16,
    streak: 0,
    homeWins: 4,
    homeLosses: 4,
    roadWins: 4,
    roadLosses: 4,
    ...p,
  };
}

const matchup = {
  home: { id: "1", abbreviation: "KC", displayName: "Kansas City Chiefs", shortName: "Chiefs" },
  away: { id: "2", abbreviation: "LV", displayName: "Las Vegas Raiders", shortName: "Raiders" },
};

const evenCtx = (): GameContext => ({ stats: { "1": mkStats("1"), "2": mkStats("2") } });

describe("predictGame", () => {
  it("favors the home team when stats are even (home-field edge)", () => {
    const p = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    expect(p.winner).toBe("home");
    expect(p.homeProb).toBeGreaterThan(0.5);
    expect(p.homeProb).toBeLessThan(0.75); // a bump, not a blowout
  });

  it("favors a much stronger away team over home field", () => {
    const ctx: GameContext = {
      stats: {
        "1": mkStats("1", { wins: 3, losses: 13, pointsFor: 250, pointsAgainst: 420, streak: -3 }),
        "2": mkStats("2", { wins: 13, losses: 3, pointsFor: 460, pointsAgainst: 280, streak: 4 }),
      },
    };
    const p = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(p.winner).toBe("away");
    expect(p.homeProb).toBeLessThan(0.3);
  });

  it("lets user reasoning flip a lean toward the away team", () => {
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    expect(base.winner).toBe("home");
    const flipped = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS, {
      lean: -3,
      tags: { Injuries: "away", Weather: "away" },
      note: "backup QB at home",
    });
    expect(flipped.winner).toBe("away");
  });

  it("ignores user input when reasoning weight is zero", () => {
    const weights = { ...DEFAULT_WEIGHTS, reasoning: 0 };
    const a = predictGame(matchup, evenCtx(), weights);
    const b = predictGame(matchup, evenCtx(), weights, { lean: -3, tags: {}, note: "" });
    expect(a.homeProb).toBeCloseTo(b.homeProb, 10);
  });

  it("handles missing stats gracefully (early season / bye data gaps)", () => {
    const p = predictGame(matchup, { stats: {} }, DEFAULT_WEIGHTS);
    expect(p.homeProb).toBeGreaterThan(0);
    expect(p.homeProb).toBeLessThan(1);
    expect(p.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("reports per-factor contributions for all twenty factors", () => {
    const p = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS, EMPTY_INPUT);
    expect(p.contributions.map((c) => c.label)).toEqual([
      "Record",
      "Scoring margin",
      "Home field",
      "Momentum",
      "Power rating",
      "Production",
      "Yardage",
      "Efficiency (EPA)",
      "QB metrics",
      "Game flow",
      "Injuries",
      "Style matchup",
      "Usage shift",
      "3rd down %",
      "4th down %",
      "Turnover margin",
      "Yardage rank",
      "Special teams",
      "Situational sweep",
      "Your reasoning",
    ]);
  });

  it("uses computed Elo for the power-rating factor", () => {
    const ctx: GameContext = { ...evenCtx(), elo: { "1": 1420, "2": 1620 } };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withElo = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withElo.homeProb).toBeLessThan(base.homeProb);
  });

  it("prefers published nfelo ratings over computed Elo when available", () => {
    // Computed Elo says away is far better; nfelo says home is — nfelo wins.
    const ctx: GameContext = {
      ...evenCtx(),
      elo: { "1": 1400, "2": 1650 },
      advanced: { KC: { nfeloRating: 1640 }, LV: { nfeloRating: 1450 } },
    };
    const p = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    const power = p.contributions.find((c) => c.label === "Power rating")!;
    expect(power.value).toBeGreaterThan(0); // home-positive despite Elo
  });

  it("moves with offensive EPA and QB CPOE differentials", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      advanced: {
        KC: { offEpaPerGame: 6.2, cpoe: 4.1, qbName: "Star QB" },
        LV: { offEpaPerGame: -3.5, cpoe: -2.4, qbName: "Backup QB" },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withAdv = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withAdv.homeProb).toBeGreaterThan(base.homeProb);
    const epa = withAdv.contributions.find((c) => c.label === "Efficiency (EPA)")!;
    const qb = withAdv.contributions.find((c) => c.label === "QB metrics")!;
    expect(epa.value).toBeGreaterThan(0);
    expect(qb.value).toBeGreaterThan(0);
  });

  it("moves toward the team with a big yardage edge", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      detail: {
        "1": { teamId: "1", passYpg: 180, rushYpg: 100, totalYpg: 280 },
        "2": { teamId: "2", passYpg: 280, rushYpg: 120, totalYpg: 400 },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withYards = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withYards.homeProb).toBeLessThan(base.homeProb);
  });

  it("credits the away team's injury-free week against a hurt home team", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      injuries: {
        "1": {
          teamId: "1",
          burden: 8,
          players: [{ name: "P. Mahomes", position: "QB", status: "Out" }],
        },
        "2": { teamId: "2", burden: 0.5, players: [] },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const hurt = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(hurt.homeProb).toBeLessThan(base.homeProb);
  });

  it("rewards second-half surge teams via the game-flow factor", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      flow: {
        "1": {
          teamId: "1",
          games: 10,
          firstHalfMarginPg: -2,
          secondHalfMarginPg: 6,
          avgQuarterSwing: 5,
          comebackWins: 3,
          blownLeads: 0,
        },
        "2": {
          teamId: "2",
          games: 10,
          firstHalfMarginPg: 3,
          secondHalfMarginPg: -5,
          avgQuarterSwing: 5,
          comebackWins: 0,
          blownLeads: 4,
        },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withFlow = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withFlow.homeProb).toBeGreaterThan(base.homeProb);
  });

  it("favors the team that wins 3rd/4th down and the turnover battle", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      detail: {
        "1": {
          teamId: "1",
          passYpg: null,
          rushYpg: null,
          totalYpg: null,
          thirdDownPct: 48,
          fourthDownPct: 70,
          takeawaysTotal: 22,
          giveawaysTotal: 8,
        },
        "2": {
          teamId: "2",
          passYpg: null,
          rushYpg: null,
          totalYpg: null,
          thirdDownPct: 34,
          fourthDownPct: 40,
          takeawaysTotal: 9,
          giveawaysTotal: 18,
        },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withSituational = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withSituational.homeProb).toBeGreaterThan(base.homeProb);
    const labels = ["3rd down %", "4th down %", "Turnover margin"];
    for (const label of labels) {
      const c = withSituational.contributions.find((x) => x.label === label)!;
      expect(c.value).toBeGreaterThan(0);
    }
  });

  it("docks a run-heavy home team whose starting RB is ruled out", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      detail: {
        "1": { teamId: "1", passYpg: 100, rushYpg: 160, totalYpg: 260 }, // run-heavy
        "2": { teamId: "2", passYpg: 100, rushYpg: 160, totalYpg: 260 },
      },
      injuries: {
        "1": {
          teamId: "1",
          burden: 5,
          players: [{ name: "Star RB", position: "RB", status: "Out" }],
        },
      },
    };
    const base = predictGame(matchup, { ...evenCtx(), detail: ctx.detail }, DEFAULT_WEIGHTS);
    const hurt = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(hurt.homeProb).toBeLessThan(base.homeProb);
  });

  it("favors the team ranked top-5 in both offense and defense yardage", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      yardageRanks: { "1": { offRank: 3, defRank: 4 }, "2": { offRank: 20, defRank: 22 } },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withRank = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withRank.homeProb).toBeGreaterThan(base.homeProb);
  });

  it("rewards elite special-teams production including a return touchdown", () => {
    const ctx: GameContext = {
      ...evenCtx(),
      detail: {
        "1": {
          teamId: "1",
          passYpg: null,
          rushYpg: null,
          totalYpg: null,
          puntReturnAvg: 14,
          kickReturnAvg: 28,
          specialTeamsTDs: 1,
        },
        "2": { teamId: "2", passYpg: null, rushYpg: null, totalYpg: null },
      },
    };
    const base = predictGame(matchup, evenCtx(), DEFAULT_WEIGHTS);
    const withST = predictGame(matchup, ctx, DEFAULT_WEIGHTS);
    expect(withST.homeProb).toBeGreaterThan(base.homeProb);
  });

  it("gives an extra sweep bonus on top of the standalone factors when a team wins everything", () => {
    const sweepDetail = {
      "1": {
        teamId: "1",
        passYpg: 260,
        rushYpg: 150,
        totalYpg: 410,
        thirdDownPct: 50,
        takeawaysTotal: 22,
        giveawaysTotal: 6,
      },
      "2": {
        teamId: "2",
        passYpg: 190,
        rushYpg: 90,
        totalYpg: 280,
        thirdDownPct: 30,
        takeawaysTotal: 6,
        giveawaysTotal: 20,
      },
    };
    // Zero out the sweep weight to isolate what the standalone factors
    // alone produce, then compare against the full model.
    const withoutSweep = predictGame(matchup, { ...evenCtx(), detail: sweepDetail }, {
      ...DEFAULT_WEIGHTS,
      situationalSweep: 0,
    });
    const withSweep = predictGame(matchup, { ...evenCtx(), detail: sweepDetail }, DEFAULT_WEIGHTS);
    const sweepContribution = withSweep.contributions.find((c) => c.label === "Situational sweep")!;
    expect(sweepContribution.value).toBeGreaterThan(0);
    expect(withSweep.homeProb).toBeGreaterThan(withoutSweep.homeProb);
  });
});

describe("liveWinProb (the comeback curve)", () => {
  const liveGame = (period: number, clockSeconds: number, homeScore: number, awayScore: number): Game => ({
    id: "live",
    date: "2025-12-14T18:00:00Z",
    name: "test",
    ...matchup,
    state: "in",
    completed: false,
    homeScore,
    awayScore,
    period,
    clockSeconds,
  });

  it("keeps a real chance alive for a team down 21-0 in Q1", () => {
    const p = liveWinProb(liveGame(1, 300, 0, 21), 0.5);
    expect(p).toBeGreaterThan(0.02); // still a few percent
    expect(p).toBeLessThan(0.15);
  });

  it("nearly buries the same deficit midway through Q4", () => {
    const q1 = liveWinProb(liveGame(1, 300, 0, 21), 0.5);
    const q4 = liveWinProb(liveGame(4, 300, 0, 21), 0.5);
    expect(q4).toBeLessThan(0.005);
    expect(q4).toBeLessThan(q1);
  });

  it("decays monotonically quarter by quarter at a fixed deficit", () => {
    const probs = [1, 2, 3, 4].map((q) => liveWinProb(liveGame(q, 450, 0, 14), 0.5));
    for (let i = 1; i < probs.length; i++) expect(probs[i]).toBeLessThan(probs[i - 1]);
  });

  it("lets a strong pregame favorite stay live despite trailing early", () => {
    const favorite = liveWinProb(liveGame(1, 300, 0, 14), 0.8);
    const underdog = liveWinProb(liveGame(1, 300, 0, 14), 0.2);
    expect(favorite).toBeGreaterThan(underdog * 2);
  });

  it("returns the pregame probability for games that haven't started", () => {
    const pre: Game = { ...liveGame(1, 900, 0, 0), state: "pre", homeScore: undefined, awayScore: undefined };
    expect(liveWinProb(pre, 0.63)).toBe(0.63);
  });

  it("resolves to certainty when the game is complete", () => {
    const done: Game = { ...liveGame(4, 0, 27, 17), state: "post", completed: true };
    expect(liveWinProb(done, 0.4)).toBe(1);
  });
});

describe("pythagoreanWinPct (production → wins)", () => {
  it("is 0.5 for balanced production and rises with point differential", () => {
    expect(pythagoreanWinPct(350, 350)).toBeCloseTo(0.5, 5);
    expect(pythagoreanWinPct(450, 300)).toBeGreaterThan(0.7);
    expect(pythagoreanWinPct(300, 450)).toBeLessThan(0.3);
  });
});

describe("styleProfile", () => {
  it("classifies offense type, offense tier and defense tier", () => {
    const prof = styleProfile(
      { teamId: "1", passYpg: 280, rushYpg: 95, totalYpg: 375 },
      mkStats("1", { pointsAgainst: 300, gamesPlayed: 16, wins: 10, losses: 6 }),
    );
    expect(prof.offense).toBe("Pass-heavy");
    expect(prof.offenseTier).toBe("Explosive");
    expect(prof.defenseTier).toBe("Stingy"); // 300/16 = 18.75 ppg allowed
  });

  it("returns nulls when data is missing", () => {
    const prof = styleProfile(undefined, undefined);
    expect(prof.offense).toBeNull();
    expect(prof.offenseTier).toBeNull();
    expect(prof.defenseTier).toBeNull();
  });
});

describe("computeFlowStats", () => {
  const flowGame = (
    homeLs: number[],
    awayLs: number[],
  ): Game => ({
    id: "f1",
    date: "2025-10-05T17:00:00Z",
    name: "test",
    ...matchup,
    state: "post",
    completed: true,
    homeScore: homeLs.reduce((a, b) => a + b, 0),
    awayScore: awayLs.reduce((a, b) => a + b, 0),
    homeLinescores: homeLs,
    awayLinescores: awayLs,
  });

  it("computes per-half margins and counts a comeback win", () => {
    // Home trails 0-21 at half, wins 28-21 — the classic comeback.
    const flow = computeFlowStats([{ games: [flowGame([0, 0, 14, 14], [14, 7, 0, 0])] }]);
    const home = flow["1"];
    expect(home.games).toBe(1);
    expect(home.firstHalfMarginPg).toBe(-21);
    expect(home.secondHalfMarginPg).toBe(28);
    expect(home.comebackWins).toBe(1);
    expect(flow["2"].blownLeads).toBe(1);
  });

  it("measures quarter-to-quarter volatility", () => {
    const steady = computeFlowStats([{ games: [flowGame([7, 7, 7, 7], [3, 3, 3, 3])] }]);
    const wild = computeFlowStats([{ games: [flowGame([21, 0, 21, 0], [0, 17, 0, 17])] }]);
    expect(wild["1"].avgQuarterSwing).toBeGreaterThan(steady["1"].avgQuarterSwing);
  });

  it("skips unfinished games and games without linescores", () => {
    const g = flowGame([7, 7, 7, 7], [3, 3, 3, 3]);
    expect(computeFlowStats([{ games: [{ ...g, completed: false }] }])).toEqual({});
    expect(computeFlowStats([{ games: [{ ...g, homeLinescores: undefined }] }])).toEqual({});
  });
});

describe("parseTeamStatistics", () => {
  it("extracts yards-per-game splits from core-API categories", () => {
    const d = parseTeamStatistics("12", {
      splits: {
        categories: [
          { name: "passing", stats: [{ name: "netPassingYardsPerGame", value: 245.5 }] },
          { name: "rushing", stats: [{ name: "rushingYardsPerGame", value: 118.2 }] },
        ],
      },
    });
    expect(d.passYpg).toBe(245.5);
    expect(d.rushYpg).toBe(118.2);
    expect(d.totalYpg).toBeCloseTo(363.7);
  });

  it("returns nulls on unknown shapes", () => {
    const d = parseTeamStatistics("12", { some: "other shape" });
    expect(d.totalYpg).toBeNull();
  });

  it("extracts 3rd/4th down %, defense yards allowed, and return production", () => {
    const d = parseTeamStatistics("12", {
      splits: {
        categories: [
          {
            name: "miscellaneous",
            stats: [
              { name: "thirdDownConvPct", value: 44.5 },
              { name: "fourthDownConvPct", value: 60.0 },
            ],
          },
          {
            name: "defensive",
            stats: [{ name: "yardsAllowedPerGame", value: 305.4 }],
          },
          {
            name: "returning",
            stats: [
              { name: "puntReturnAverage", value: 11.2 },
              { name: "kickReturnAverage", value: 24.8 },
              { name: "puntReturnTouchdowns", value: 1 },
              { name: "kickReturnTouchdowns", value: 0 },
            ],
          },
        ],
      },
    });
    expect(d.thirdDownPct).toBe(44.5);
    expect(d.fourthDownPct).toBe(60.0);
    expect(d.defYpg).toBe(305.4);
    expect(d.puntReturnAvg).toBe(11.2);
    expect(d.kickReturnAvg).toBe(24.8);
    expect(d.specialTeamsTDs).toBe(1);
  });

  it("keeps defensive takeaways separate from offensive giveaways using category context", () => {
    const d = parseTeamStatistics("12", {
      splits: {
        categories: [
          { name: "passing", stats: [{ name: "interceptions", value: 9 }] }, // thrown
          { name: "rushing", stats: [{ name: "fumblesLost", value: 4 }] },
          {
            name: "defensive",
            stats: [
              { name: "interceptions", value: 15 }, // picked off
              { name: "fumblesRecovered", value: 6 },
            ],
          },
        ],
      },
    });
    expect(d.giveawaysTotal).toBe(13); // 9 thrown + 4 lost
    expect(d.takeawaysTotal).toBe(21); // 15 picks + 6 recoveries
  });

  it("computes return averages from yards/attempts when no average field is published", () => {
    const d = parseTeamStatistics("12", {
      splits: {
        categories: [
          {
            name: "returning",
            stats: [
              { name: "puntReturns", value: 20 },
              { name: "puntReturnYards", value: 240 },
              { name: "kickReturns", value: 25 },
              { name: "kickReturnYards", value: 575 },
            ],
          },
        ],
      },
    });
    expect(d.puntReturnAvg).toBe(12);
    expect(d.kickReturnAvg).toBe(23);
  });

  it("falls back to a published turnover differential when takeaway/giveaway splits are absent", () => {
    const dPositive = parseTeamStatistics("12", {
      splits: { categories: [{ name: "miscellaneous", stats: [{ name: "turnOverDifferential", value: 8 }] }] },
    });
    expect(dPositive.takeawaysTotal).toBe(8);
    expect(dPositive.giveawaysTotal).toBe(0);
    const dNegative = parseTeamStatistics("12", {
      splits: { categories: [{ name: "miscellaneous", stats: [{ name: "turnOverDifferential", value: -3 }] }] },
    });
    expect(dNegative.takeawaysTotal).toBe(0);
    expect(dNegative.giveawaysTotal).toBe(3);
  });
});

describe("turnoverMarginPace + turnoverMarginScore", () => {
  it("weights forced takeaways above avoided giveaways in the margin", () => {
    // Same raw differential (10 takeaways, 5 giveaways = +5), but the
    // takeaway weight (1.2x) means this scores above a plain +5.
    const pace = turnoverMarginPace(10, 5, 16); // 16 games played, 17-game pace
    const plainMargin = ((10 - 5) / 16) * 17; // = 5.3125
    expect(pace).toBeGreaterThan(plainMargin);
  });

  it("returns 0 margin for an even takeaway/giveaway split", () => {
    expect(turnoverMarginPace(8, 8, 16)).toBeCloseTo((8 * 0.2 / 16) * 17, 5); // small positive from the weighting
    expect(turnoverMarginScore(0)).toBe(0);
  });

  it("handles zero games played without dividing by zero", () => {
    expect(turnoverMarginPace(0, 0, 0)).toBe(0);
  });

  it("scores tiers roughly as good / great / exceptional with diminishing returns above +10", () => {
    const good = turnoverMarginScore(5);
    const great = turnoverMarginScore(10);
    const exceptional = turnoverMarginScore(20);
    expect(good).toBeGreaterThan(0.4);
    expect(good).toBeLessThan(0.6);
    expect(great).toBeGreaterThan(0.7);
    expect(great).toBeLessThan(0.85);
    expect(exceptional).toBeGreaterThan(great);
    // Diminishing returns: the jump from +10 to +20 is smaller than +0 to +10.
    expect(exceptional - great).toBeLessThan(great);
  });

  it("is symmetric for a negative (giveaway-prone) margin", () => {
    expect(turnoverMarginScore(-10)).toBeCloseTo(-turnoverMarginScore(10), 10);
  });
});

describe("computeYardageRanks + yardageRankScore", () => {
  function mkDetail(id: string, totalYpg: number, defYpg: number): TeamDetailStats {
    return { teamId: id, passYpg: null, rushYpg: null, totalYpg, defYpg };
  }

  it("ranks offense by most total yards and defense by fewest yards allowed", () => {
    const detail = {
      "1": mkDetail("1", 400, 280), // best offense, best defense
      "2": mkDetail("2", 300, 380), // worst offense, worst defense
      "3": mkDetail("3", 350, 330),
    };
    const ranks = computeYardageRanks(detail);
    expect(ranks["1"]).toEqual({ offRank: 1, defRank: 1 });
    expect(ranks["2"]).toEqual({ offRank: 3, defRank: 3 });
    expect(ranks["3"]).toEqual({ offRank: 2, defRank: 2 });
  });

  it("skips teams missing one side of the data rather than crashing", () => {
    const detail = { "1": { teamId: "1", passYpg: null, rushYpg: null, totalYpg: 400, defYpg: null } };
    const ranks = computeYardageRanks(detail);
    expect(ranks["1"].offRank).toBe(1);
    expect(ranks["1"].defRank).toBeNull();
  });

  it("gives a top-5-both bonus beyond the linear rank credit", () => {
    const top5Both = yardageRankScore({ offRank: 3, defRank: 4 });
    const top5OffOnly = yardageRankScore({ offRank: 3, defRank: 20 });
    // Same offense rank, but top5Both should beat top5OffOnly by more than
    // just the defense-rank swing — the explicit bonus kicks in.
    const defRankOnlySwing = clampDiff(4, 20);
    expect(top5Both - top5OffOnly).toBeGreaterThan(defRankOnlySwing);
  });

  it("returns 0 for an unranked team", () => {
    expect(yardageRankScore(undefined)).toBe(0);
    expect(yardageRankScore({ offRank: null, defRank: null })).toBe(0);
  });

  function clampDiff(a: number, b: number) {
    const score = (r: number) => Math.min(0.5, Math.max(-0.5, (16 - r) / 16));
    return score(a) - score(b);
  }
});

describe("usageShiftEdge", () => {
  const runHeavy = { offense: "Run-heavy" as const, offenseTier: null, defenseTier: null };
  const passHeavy = { offense: "Pass-heavy" as const, offenseTier: null, defenseTier: null };

  function mkInjuries(players: TeamInjuryReport["players"]): TeamInjuryReport {
    return { teamId: "1", burden: 0, players };
  }

  it("penalizes a run-heavy team more than a pass-heavy one for the same hurt RB", () => {
    const players = [{ name: "Star RB", position: "RB", status: "Out" }];
    const runPenalty = usageShiftEdge(mkInjuries(players), runHeavy);
    const passPenalty = usageShiftEdge(mkInjuries(players), passHeavy);
    expect(runPenalty).toBeLessThan(passPenalty); // more negative
    expect(runPenalty).toBeLessThan(0);
  });

  it("applies a smaller penalty for doubtful than for out/IR", () => {
    const out = usageShiftEdge(mkInjuries([{ name: "RB", position: "RB", status: "Out" }]), runHeavy);
    const doubtful = usageShiftEdge(
      mkInjuries([{ name: "RB", position: "RB", status: "Doubtful" }]),
      runHeavy,
    );
    expect(doubtful).toBeGreaterThan(out); // less negative
  });

  it("ignores non-RB injuries and questionable/probable statuses", () => {
    expect(usageShiftEdge(mkInjuries([{ name: "WR", position: "WR", status: "Out" }]), runHeavy)).toBe(0);
    expect(
      usageShiftEdge(mkInjuries([{ name: "RB", position: "RB", status: "Questionable" }]), runHeavy),
    ).toBe(0);
  });

  it("returns 0 with no injury report", () => {
    expect(usageShiftEdge(undefined, runHeavy)).toBe(0);
  });
});

describe("specialTeamsScore", () => {
  it("credits a great punt-return average (+10 to +15) and kick return past the 25", () => {
    const great = specialTeamsScore({
      teamId: "1",
      passYpg: null,
      rushYpg: null,
      totalYpg: null,
      puntReturnAvg: 13,
      kickReturnAvg: 27,
    });
    const average = specialTeamsScore({
      teamId: "1",
      passYpg: null,
      rushYpg: null,
      totalYpg: null,
      puntReturnAvg: 8,
      kickReturnAvg: 21,
    });
    expect(great).toBeGreaterThan(average);
    expect(average).toBeCloseTo(0, 5);
  });

  it("treats a return touchdown as a large momentum bonus", () => {
    const withTd = specialTeamsScore({
      teamId: "1",
      passYpg: null,
      rushYpg: null,
      totalYpg: null,
      specialTeamsTDs: 1,
    });
    expect(withTd).toBeGreaterThan(0.3);
  });

  it("returns 0 with no detail", () => {
    expect(specialTeamsScore(undefined)).toBe(0);
  });
});

describe("situationalCategoryWinners", () => {
  const h = mkStats("1", { gamesPlayed: 16 });
  const a = mkStats("2", { gamesPlayed: 16 });

  it("picks a winner per category from detail stats", () => {
    const hd: TeamDetailStats = {
      teamId: "1",
      passYpg: 260,
      rushYpg: 90,
      totalYpg: 350,
      thirdDownPct: 48,
      takeawaysTotal: 20,
      giveawaysTotal: 8,
    };
    const ad: TeamDetailStats = {
      teamId: "2",
      passYpg: 200,
      rushYpg: 140,
      totalYpg: 340,
      thirdDownPct: 36,
      takeawaysTotal: 10,
      giveawaysTotal: 16,
    };
    const cats = situationalCategoryWinners(h, a, hd, ad);
    expect(cats.thirdDown).toBe("home");
    expect(cats.turnovers).toBe("home");
    expect(cats.passing).toBe("home");
    expect(cats.rushing).toBe("away");
  });

  it("returns null for a category missing data on either side, or a tie", () => {
    const hd: TeamDetailStats = { teamId: "1", passYpg: null, rushYpg: 120, totalYpg: null, thirdDownPct: 40 };
    const ad: TeamDetailStats = { teamId: "2", passYpg: 200, rushYpg: 120, totalYpg: null };
    const cats = situationalCategoryWinners(h, a, hd, ad);
    expect(cats.thirdDown).toBeNull(); // away has no thirdDownPct
    expect(cats.passing).toBeNull(); // home has no passYpg
    expect(cats.rushing).toBeNull(); // tied at 120
    expect(cats.turnovers).toBeNull(); // neither side has takeaway/giveaway data
  });
});

describe("situationalSweepBonus", () => {
  it("gives the full bonus for a clean sweep of all four categories", () => {
    const bonus = situationalSweepBonus({
      thirdDown: "home",
      turnovers: "home",
      rushing: "home",
      passing: "home",
    });
    expect(bonus).toBe(0.25);
  });

  it("gives a smaller bonus for winning all but one category", () => {
    const bonus = situationalSweepBonus({
      thirdDown: "home",
      turnovers: "home",
      rushing: "home",
      passing: "away",
    });
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBeLessThan(0.25);
  });

  it("is negative (symmetric) when the away team sweeps", () => {
    const bonus = situationalSweepBonus({
      thirdDown: "away",
      turnovers: "away",
      rushing: "away",
      passing: "away",
    });
    expect(bonus).toBe(-0.25);
  });

  it("gives no bonus for a split decision or too little data to judge", () => {
    expect(
      situationalSweepBonus({ thirdDown: "home", turnovers: "away", rushing: "home", passing: "away" }),
    ).toBe(0);
    expect(
      situationalSweepBonus({ thirdDown: "home", turnovers: "home", rushing: null, passing: null }),
    ).toBe(0); // only 2 of 4 categories known — not enough to call a sweep
  });
});

describe("parseInjuries", () => {
  it("weights QBs and harder statuses into the burden score", () => {
    const map = parseInjuries({
      injuries: [
        {
          id: "12",
          injuries: [
            { status: "Out", athlete: { displayName: "Star QB", position: { abbreviation: "QB" } } },
            { status: "Questionable", athlete: { displayName: "Depth LB", position: { abbreviation: "LB" } } },
          ],
        },
        {
          id: "13",
          injuries: [
            { status: "Questionable", athlete: { displayName: "WR3", position: { abbreviation: "WR" } } },
          ],
        },
      ],
    });
    expect(map["12"].burden).toBeGreaterThan(map["13"].burden);
    expect(map["12"].players[0].name).toBe("Star QB"); // worst news sorted first
    expect(parseInjuries({})).toEqual({});
  });
});

describe("computeEloRatings", () => {
  const eloGame = (homeScore: number, awayScore: number, date = "2025-09-07T17:00:00Z"): Game => ({
    id: `e-${date}-${homeScore}-${awayScore}`,
    date,
    name: "test",
    ...matchup,
    state: "post",
    completed: true,
    homeScore,
    awayScore,
  });

  it("moves rating from loser to winner, zero-sum around 1500", () => {
    const elo = computeEloRatings([{ games: [eloGame(27, 17)] }]);
    expect(elo["1"]).toBeGreaterThan(1500);
    expect(elo["2"]).toBeLessThan(1500);
    expect(elo["1"] + elo["2"]).toBeCloseTo(3000, 6);
  });

  it("rewards a road upset more than a home win", () => {
    const homeWin = computeEloRatings([{ games: [eloGame(24, 14)] }]);
    const roadWin = computeEloRatings([{ games: [eloGame(14, 24)] }]);
    const homeGain = homeWin["1"] - 1500;
    const roadGain = roadWin["2"] - 1500;
    expect(roadGain).toBeGreaterThan(homeGain);
  });

  it("scales with margin of victory and accumulates across weeks", () => {
    const narrow = computeEloRatings([{ games: [eloGame(20, 17)] }]);
    const blowout = computeEloRatings([{ games: [eloGame(41, 10)] }]);
    expect(blowout["1"]).toBeGreaterThan(narrow["1"]);
    const twoWeeks = computeEloRatings([
      { games: [eloGame(27, 17, "2025-09-07T17:00:00Z")] },
      { games: [eloGame(27, 17, "2025-09-14T17:00:00Z")] },
    ]);
    expect(twoWeeks["1"]).toBeGreaterThan(narrow["1"]);
  });

  it("ignores unfinished games", () => {
    const g = { ...eloGame(0, 0), completed: false, state: "in" as const };
    expect(computeEloRatings([{ games: [g] }])).toEqual({});
  });
});

describe("normalizeAbbr", () => {
  it("maps source variants to ESPN-style codes", () => {
    expect(normalizeAbbr("WAS")).toBe("WSH");
    expect(normalizeAbbr("jac")).toBe("JAX");
    expect(normalizeAbbr("LA")).toBe("LAR");
    expect(normalizeAbbr("KC")).toBe("KC");
  });
});

describe("ensureWeights", () => {
  it("fills factors missing from older saved weights", () => {
    const w = ensureWeights({ record: 90 } as never);
    expect(w.record).toBe(90);
    expect(w.injuries).toBe(DEFAULT_WEIGHTS.injuries);
    expect(w.flow).toBe(DEFAULT_WEIGHTS.flow);
  });
});

describe("gradeGame", () => {
  const game: Game = {
    id: "g1",
    date: "2025-12-14T18:00:00Z",
    name: "LV at KC",
    ...matchup,
    state: "post",
    completed: true,
    homeScore: 27,
    awayScore: 17,
  };

  it("grades a correct home pick as a hit", () => {
    const p = predictGame(game, evenCtx(), DEFAULT_WEIGHTS);
    expect(p.winner).toBe("home");
    expect(gradeGame(game, p)).toBe(true);
  });

  it("grades a wrong pick as a miss", () => {
    const flipped = { ...game, homeScore: 10, awayScore: 24 };
    const p = predictGame(game, evenCtx(), DEFAULT_WEIGHTS);
    expect(gradeGame(flipped, p)).toBe(false);
  });

  it("returns null for unfinished games and ties", () => {
    const p = predictGame(game, evenCtx(), DEFAULT_WEIGHTS);
    expect(gradeGame({ ...game, completed: false }, p)).toBeNull();
    expect(gradeGame({ ...game, homeScore: 20, awayScore: 20 }, p)).toBeNull();
  });
});

describe("parseScoreboard", () => {
  const payload = {
    season: { year: 2025 },
    week: { number: 15 },
    events: [
      {
        id: "401671800",
        date: "2025-12-11T01:15:00Z",
        name: "Las Vegas Raiders at Kansas City Chiefs",
        competitions: [
          {
            venue: { fullName: "GEHA Field at Arrowhead Stadium" },
            broadcasts: [{ names: ["NBC"] }],
            status: {
              period: 4,
              clock: 222,
              type: { state: "post", completed: true, shortDetail: "Final" },
            },
            competitors: [
              {
                homeAway: "home",
                score: "27",
                records: [{ type: "total", summary: "11-3" }],
                linescores: [{ value: 7 }, { value: 10 }, { value: 3 }, { value: 7 }],
                team: {
                  id: "12",
                  abbreviation: "KC",
                  displayName: "Kansas City Chiefs",
                  shortName: "Chiefs",
                  color: "e31837",
                  logo: "https://a.espncdn.com/kc.png",
                },
              },
              {
                homeAway: "away",
                score: "17",
                records: [{ type: "total", summary: "5-9" }],
                linescores: [{ value: 14 }, { value: 3 }, { value: 0 }, { value: 0 }],
                team: {
                  id: "13",
                  abbreviation: "LV",
                  displayName: "Las Vegas Raiders",
                  shortName: "Raiders",
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("parses events into games with home/away, scores, linescores and clock", () => {
    const wk = parseScoreboard(payload);
    expect(wk.seasonYear).toBe(2025);
    expect(wk.weekNumber).toBe(15);
    expect(wk.games).toHaveLength(1);
    const g = wk.games[0];
    expect(g.home.abbreviation).toBe("KC");
    expect(g.away.abbreviation).toBe("LV");
    expect(g.home.record).toBe("11-3");
    expect(g.homeScore).toBe(27);
    expect(g.awayScore).toBe(17);
    expect(g.completed).toBe(true);
    expect(g.state).toBe("post");
    expect(g.venue).toBe("GEHA Field at Arrowhead Stadium");
    expect(g.broadcast).toBe("NBC");
    expect(g.homeLinescores).toEqual([7, 10, 3, 7]);
    expect(g.awayLinescores).toEqual([14, 3, 0, 0]);
    expect(g.period).toBe(4);
    expect(g.clockSeconds).toBe(222);
  });

  it("tolerates empty/malformed payloads", () => {
    expect(parseScoreboard({}).games).toEqual([]);
    expect(parseScoreboard({ events: [{ id: "x" }] }).games).toEqual([]);
  });
});

describe("parseStandings", () => {
  const entry = (id: string) => ({
    team: { id },
    stats: [
      { name: "wins", value: 11 },
      { name: "losses", value: 3 },
      { name: "ties", value: 0 },
      { name: "pointsFor", value: 380 },
      { name: "pointsAgainst", value: 290 },
      { name: "streak", value: 4 },
      { name: "Home", displayValue: "6-1" },
      { name: "Road", displayValue: "5-2" },
    ],
  });

  it("parses conference-nested standings into a stats map", () => {
    const map = parseStandings({
      children: [{ standings: { entries: [entry("12")] } }, { standings: { entries: [entry("7")] } }],
    });
    expect(Object.keys(map).sort()).toEqual(["12", "7"]);
    const kc = map["12"];
    expect(kc.wins).toBe(11);
    expect(kc.pointsFor).toBe(380);
    expect(kc.gamesPlayed).toBe(14);
    expect(kc.streak).toBe(4);
    expect(kc.homeWins).toBe(6);
    expect(kc.roadLosses).toBe(2);
  });

  it("parses flat standings and tolerates empty payloads", () => {
    expect(parseStandings({ standings: { entries: [entry("9")] } })["9"].losses).toBe(3);
    expect(parseStandings({})).toEqual({});
  });
});

describe("groupByDay", () => {
  it("groups games by calendar day in order", () => {
    const mk = (id: string, date: string): Game => ({
      id,
      date,
      name: id,
      ...matchup,
      state: "pre",
      completed: false,
    });
    const groups = groupByDay([
      mk("thu", "2025-12-12T01:15:00Z"),
      mk("sun1", "2025-12-14T18:00:00Z"),
      mk("sun2", "2025-12-14T21:25:00Z"),
      mk("mon", "2025-12-16T01:15:00Z"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[1].games.map((g) => g.id)).toEqual(["sun1", "sun2"]);
  });
});
