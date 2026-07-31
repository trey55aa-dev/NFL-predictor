import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the /api/advanced client with a canned response.
vi.mock("@/lib/advanced", () => ({
  ADVANCED_SOURCE_LABELS: {
    nflverse: "nflverse EPA",
    ngs: "Next Gen Stats",
    pfr: "Pro-Football-Reference",
    nfelo: "nfelo power ratings",
  },
  fetchAdvancedStats: vi.fn(async () => ({
    teams: {
      MIA: { offEpaPerGame: -1.2, cpoe: -0.5, qbName: "Fins QB", nfeloRating: 1490 },
      BUF: { offEpaPerGame: 5.4, cpoe: 3.1, qbName: "Bills QB", nfeloRating: 1610 },
    },
    sources: {
      nflverse: { status: "ok", teams: 32 },
      ngs: { status: "ok", teams: 32 },
      pfr: { status: "error", detail: "403 from www.pro-football-reference.com" },
      nfelo: { status: "ok", teams: 32 },
    },
  })),
}));

import App from "@/App";

/**
 * Minimal ESPN payloads: one final game (a second-half comeback), one
 * upcoming game, and one live game where the home team is down 21-0 in Q1.
 */

const team = (id: string, abbr: string, name: string) => ({
  id,
  abbreviation: abbr,
  displayName: name,
  shortName: name.split(" ").pop(),
});

const scoreboard = {
  season: { year: 2025 },
  week: { number: 15 },
  events: [
    {
      id: "final1",
      date: "2025-12-12T01:15:00Z",
      name: "Las Vegas Raiders at Kansas City Chiefs",
      competitions: [
        {
          status: { period: 4, clock: 0, type: { state: "post", completed: true, shortDetail: "Final" } },
          competitors: [
            {
              homeAway: "home",
              score: "27",
              records: [{ type: "total", summary: "11-3" }],
              linescores: [{ value: 0 }, { value: 7 }, { value: 10 }, { value: 10 }],
              team: team("12", "KC", "Kansas City Chiefs"),
            },
            {
              homeAway: "away",
              score: "17",
              records: [{ type: "total", summary: "5-9" }],
              linescores: [{ value: 14 }, { value: 3 }, { value: 0 }, { value: 0 }],
              team: team("13", "LV", "Las Vegas Raiders"),
            },
          ],
        },
      ],
    },
    {
      id: "pre1",
      date: "2025-12-14T18:00:00Z",
      name: "Buffalo Bills at Miami Dolphins",
      competitions: [
        {
          status: { type: { state: "pre", completed: false, shortDetail: "Sun 1:00 PM" } },
          broadcasts: [{ names: ["CBS"] }],
          competitors: [
            {
              homeAway: "home",
              records: [{ type: "total", summary: "7-7" }],
              team: team("15", "MIA", "Miami Dolphins"),
            },
            {
              homeAway: "away",
              records: [{ type: "total", summary: "10-4" }],
              team: team("2", "BUF", "Buffalo Bills"),
            },
          ],
        },
      ],
    },
    {
      id: "live1",
      date: "2025-12-15T01:15:00Z",
      name: "Denver Broncos at Los Angeles Chargers",
      competitions: [
        {
          status: {
            period: 1,
            clock: 300,
            type: { state: "in", completed: false, shortDetail: "Q1 5:00" },
          },
          competitors: [
            {
              homeAway: "home",
              score: "0",
              records: [{ type: "total", summary: "8-6" }],
              team: team("24", "LAC", "Los Angeles Chargers"),
            },
            {
              homeAway: "away",
              score: "21",
              records: [{ type: "total", summary: "8-6" }],
              team: team("7", "DEN", "Denver Broncos"),
            },
          ],
        },
      ],
    },
  ],
};

const standingsEntry = (id: string, wins: number, losses: number, pf: number, pa: number) => ({
  team: { id },
  stats: [
    { name: "wins", value: wins },
    { name: "losses", value: losses },
    { name: "ties", value: 0 },
    { name: "pointsFor", value: pf },
    { name: "pointsAgainst", value: pa },
    { name: "streak", value: 1 },
    { name: "Home", displayValue: "4-3" },
    { name: "Road", displayValue: "4-3" },
  ],
});

const standings = {
  children: [
    {
      standings: {
        entries: [
          standingsEntry("12", 11, 3, 380, 290),
          standingsEntry("13", 5, 9, 280, 360),
          standingsEntry("15", 7, 7, 320, 330),
          standingsEntry("2", 10, 4, 400, 300),
          standingsEntry("24", 8, 6, 330, 320),
          standingsEntry("7", 8, 6, 340, 330),
          // On a bye this week — no game in `scoreboard` above — used to
          // verify detail is fetched league-wide, not just for teams
          // playing this week.
          standingsEntry("99", 6, 8, 300, 310),
        ],
      },
    },
  ],
};

const injuries = {
  injuries: [
    {
      id: "15",
      injuries: [
        { status: "Out", athlete: { displayName: "Star QB", position: { abbreviation: "QB" } } },
        { status: "Questionable", athlete: { displayName: "WR One", position: { abbreviation: "WR" } } },
      ],
    },
  ],
};

const teamStatistics = {
  splits: {
    categories: [
      { name: "passing", stats: [{ name: "netPassingYardsPerGame", value: 230 }] },
      { name: "rushing", stats: [{ name: "rushingYardsPerGame", value: 115 }] },
    ],
  },
};

function mountPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.includes("/injuries")
        ? injuries
        : u.includes("/statistics")
          ? teamStatistics
          : u.includes("/standings")
            ? standings
            : scoreboard;
      return { ok: true, json: async () => body };
    }),
  );
});

describe("App", () => {
  it("renders the week's games grouped by day with picks", async () => {
    mountPage();
    expect(await screen.findByText("Week 15")).toBeInTheDocument();
    expect((await screen.findAllByText("Chiefs")).length).toBeGreaterThan(0);
    expect(screen.getByText("Dolphins")).toBeInTheDocument();
    const pickLabels = screen.getAllByText("Pick");
    expect(pickLabels).toHaveLength(3);
  });

  it("fetches team detail for the whole league, including bye-week teams, not just this week's participants", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.includes("/injuries")
        ? injuries
        : u.includes("/statistics")
          ? teamStatistics
          : u.includes("/standings")
            ? standings
            : scoreboard;
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal("fetch", fetchSpy);

    mountPage();
    await screen.findAllByText("Chiefs");
    // Team "99" is on a bye (no game in the scoreboard fixture) but is in
    // standings — its statistics should still be fetched so yardageRank
    // covers the full league, not only teams playing this week.
    await waitFor(() => {
      const calledBye = fetchSpy.mock.calls.some((c) => String(c[0]).includes("/teams/99/statistics"));
      expect(calledBye).toBe(true);
    });
  });

  it("shows a clock-priced live win probability for the 21-0 game", async () => {
    mountPage();
    expect(await screen.findByText("Live win probability")).toBeInTheDocument();
    // Home team down 21-0 in Q1: still alive, single-digit-ish chance —
    // the trailing-team note quotes a nonzero percentage.
    const note = screen.getByText(/LAC still wins \d+% of the time from here/);
    expect(note).toBeInTheDocument();
    const pct = Number(/wins (\d+)%/.exec(note.textContent ?? "")?.[1]);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(20);
  });

  it("grades the final game and shows the all-time record", async () => {
    mountPage();
    // KC 11-3 favored at home over LV 5-9; final KC 27-17 → hit
    expect(await screen.findByText(/Hit/)).toBeInTheDocument();
    expect(await screen.findByText("All-time")).toBeInTheDocument();
    expect(await screen.findByText("1–0")).toBeInTheDocument();
    // The grade lands in React state (driving the DOM above) and in
    // localStorage via a separate effect in useLocalStorage — poll rather
    // than assume both have settled in the same tick as the DOM text.
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("nflp.gameInputs") ?? "{}");
      expect(stored.final1?.graded?.correct).toBe(true);
    });
  });

  it("opens 'Your read' and assigns an environment tag to the home side", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getAllByText("Your read")[1]); // upcoming game
    const weather = await screen.findByText("Weather");
    fireEvent.click(weather);
    expect(screen.getByText("Weather → MIA")).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem("nflp.gameInputs") ?? "{}");
    expect(stored.pre1.tags.Weather).toBe("home");
  });

  it("shows the injury report for the banged-up team", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getAllByText("Your read")[1]); // MIA game
    expect(await screen.findByText("Injury report")).toBeInTheDocument();
    expect(screen.getByText("Star QB")).toBeInTheDocument();
    expect(screen.getByText("Out")).toBeInTheDocument();
  });

  it("shows game-flow chips derived from quarter linescores", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getAllByText("Your read")[0]); // final KC game
    expect(await screen.findByText("Game flow this season")).toBeInTheDocument();
    // KC trailed 17-7 at half and won → comeback credit appears
    expect(screen.getAllByText(/comeback W/).length).toBeGreaterThan(0);
  });

  it("shows advanced source health chips", async () => {
    mountPage();
    expect(await screen.findByText("Advanced sources")).toBeInTheDocument();
    expect(await screen.findByText("nflverse EPA")).toBeInTheDocument();
    expect(screen.getByText("nfelo power ratings")).toBeInTheDocument();
    // failed source still listed (struck through), with the error on hover
    expect(screen.getByText("Pro-Football-Reference")).toBeInTheDocument();
  });

  it("shows advanced metrics (nfelo, EPA, QB) in the expanded card", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getAllByText("Your read")[1]); // BUF @ MIA
    expect(await screen.findByText("Advanced metrics")).toBeInTheDocument();
    expect(screen.getByText("nfelo 1610")).toBeInTheDocument();
    expect(screen.getByText("EPA +5.4/gm")).toBeInTheDocument();
    expect(screen.getByText("Bills QB CPOE +3.1")).toBeInTheDocument();
  });

  it("shows the factor breakdown with the new factors", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getAllByText("Your read")[0]);
    expect(await screen.findByText("Factor breakdown")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Yardage")).toBeInTheDocument();
    expect(screen.getByText("Game flow")).toBeInTheDocument();
    // "Injuries" appears both as an environment tag and a factor row
    expect(screen.getAllByText("Injuries").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Style matchup")).toBeInTheDocument();
    expect(screen.getByText("3rd down %")).toBeInTheDocument();
    expect(screen.getByText("4th down %")).toBeInTheDocument();
    expect(screen.getByText("Turnover margin")).toBeInTheDocument();
    expect(screen.getByText("Yardage rank")).toBeInTheDocument();
    expect(screen.getByText("Situational sweep")).toBeInTheDocument();
    expect(screen.getByText("Your reasoning")).toBeInTheDocument();
  });

  it("shows the new situational weight sliders in the model weights panel", async () => {
    mountPage();
    await screen.findAllByText("Chiefs");
    fireEvent.click(screen.getByText("Model weights"));
    expect(screen.getByText("Situational sweep")).toBeInTheDocument();
    expect(screen.getByText("Usage shift")).toBeInTheDocument();
    expect(screen.getByText("3rd down %")).toBeInTheDocument();
    expect(screen.getByText("4th down %")).toBeInTheDocument();
  });
});
