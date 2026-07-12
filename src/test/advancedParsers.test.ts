import { describe, it, expect } from "vitest";
import {
  aggregateNflverseTeamStats,
  extractNextData,
  findTeamRatings,
  mergeTeamMaps,
  parseCsv,
  parseNgsPassing,
  parsePfrTables,
  resolveTeam,
} from "@/lib/advancedParsers";

describe("resolveTeam", () => {
  it("resolves full names, abbreviations, aliases and nicknames", () => {
    expect(resolveTeam("Kansas City Chiefs")).toBe("KC");
    expect(resolveTeam("KAN")).toBe("KC"); // PFR code
    expect(resolveTeam("WAS")).toBe("WSH");
    expect(resolveTeam("Chiefs")).toBe("KC");
    expect(resolveTeam("Packers")).toBe("GB");
    expect(resolveTeam("Not A Team")).toBeNull();
    expect(resolveTeam("")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("parses headers, quoted fields and escaped quotes", () => {
    const rows = parseCsv('team,note,week\nKC,"hello, world",1\nBUF,"say ""hi""",2\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe("hello, world");
    expect(rows[1].note).toBe('say "hi"');
    expect(rows[1].week).toBe("2");
  });

  it("returns empty for blank input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("only,a,header\n")).toEqual([]);
  });
});

describe("aggregateNflverseTeamStats", () => {
  it("sums weekly EPA into per-game rates", () => {
    const map = aggregateNflverseTeamStats([
      { team: "KC", week: "1", passing_epa: "8.5", rushing_epa: "1.5" },
      { team: "KC", week: "2", passing_epa: "-2.0", rushing_epa: "4.0" },
      { team: "WAS", week: "1", passing_epa: "3.0", rushing_epa: "0.0" },
    ]);
    expect(map.KC.offEpaPerGame).toBeCloseTo(6.0); // (10 + 2) / 2
    expect(map.KC.passEpaPerGame).toBeCloseTo(3.25);
    expect(map.KC.epaGames).toBe(2);
    expect(map.WSH.offEpaPerGame).toBeCloseTo(3.0); // alias normalized
  });

  it("skips unknown teams and rows without weeks", () => {
    expect(aggregateNflverseTeamStats([{ team: "???", week: "1" }, { team: "KC" }])).toEqual({});
  });
});

describe("parseNgsPassing", () => {
  it("keeps each team's primary passer by attempts", () => {
    const map = parseNgsPassing({
      stats: [
        {
          teamAbbr: "KC",
          playerName: "Star QB",
          attempts: 420,
          completionPercentageAboveExpectation: 3.7,
          avgTimeToThrow: 2.71,
        },
        { teamAbbr: "KC", playerName: "Backup", attempts: 40, completionPercentageAboveExpectation: -5 },
        { teamAbbr: "JAC", playerName: "Jag QB", attempts: 300, cpoe: -1.2 },
      ],
    });
    expect(map.KC.qbName).toBe("Star QB");
    expect(map.KC.cpoe).toBe(3.7);
    expect(map.KC.timeToThrow).toBe(2.71);
    expect(map.JAX.cpoe).toBe(-1.2); // alias + alt field name
  });

  it("tolerates unknown shapes", () => {
    expect(parseNgsPassing(null)).toEqual({});
    expect(parseNgsPassing({ nothing: true })).toEqual({});
  });
});

describe("parsePfrTables", () => {
  const html = `
    <html><body>
    <div><!--
    <table id="advanced_defense">
      <tr><th data-stat="team">Team</th><th data-stat="bltz_pct">Blitz%</th></tr>
      <tr>
        <th data-stat="team"><a href="/teams/kan/2025.htm">Kansas City Chiefs</a></th>
        <td data-stat="bltz_pct">22.5%</td>
        <td data-stat="pressures">142</td>
      </tr>
      <tr>
        <th data-stat="team"><a href="/teams/was/2025.htm">Washington Commanders</a></th>
        <td data-stat="bltz_pct">31.0%</td>
        <td data-stat="pressures">120</td>
      </tr>
    </table>
    --></div>
    </body></html>`;

  it("parses comment-wrapped tables keyed by data-stat", () => {
    const map = parsePfrTables(html);
    expect(map.KC.pfr?.bltz_pct).toBe(22.5);
    expect(map.KC.pfr?.pressures).toBe(142);
    expect(map.WSH.pfr?.bltz_pct).toBe(31.0);
  });

  it("returns empty on pages without team tables", () => {
    expect(parsePfrTables("<html><table><tr><td>plain</td></tr></table></html>")).toEqual({});
  });
});

describe("extractNextData + findTeamRatings", () => {
  it("digs Elo-scale power ratings out of embedded page JSON", () => {
    const nextData = {
      props: {
        pageProps: {
          ratings: [
            { team: "Kansas City Chiefs", nfelo: 1652.3, rank: 1 },
            { team: "CAR", nfelo: 1398.4, rank: 32 },
            { team: "Buffalo Bills", wins: 11 }, // no rating — ignored
          ],
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;
    const ratings = findTeamRatings(extractNextData(html));
    expect(ratings.KC).toBeCloseTo(1652.3);
    expect(ratings.CAR).toBeCloseTo(1398.4);
    expect(ratings.BUF).toBeUndefined();
  });

  it("ignores numbers outside the Elo scale (ranks, win totals)", () => {
    expect(findTeamRatings({ team: "KC", rating: 1 })).toEqual({});
    expect(findTeamRatings({ team: "KC", rating: 9000 })).toEqual({});
    expect(extractNextData("<html>no blob</html>")).toBeNull();
  });
});

describe("mergeTeamMaps", () => {
  it("merges sources per team without losing pfr sub-objects", () => {
    const merged = mergeTeamMaps(
      { KC: { offEpaPerGame: 5.1 } },
      { KC: { cpoe: 3.2, qbName: "Star QB" } },
      { KC: { pfr: { bltz_pct: 22.5 } }, LV: { nfeloRating: 1450 } },
    );
    expect(merged.KC.offEpaPerGame).toBe(5.1);
    expect(merged.KC.cpoe).toBe(3.2);
    expect(merged.KC.pfr?.bltz_pct).toBe(22.5);
    expect(merged.LV.nfeloRating).toBe(1450);
  });
});
