# NFL Predictor — build roadmap

Standing checklist for the recurring build sessions (fires 3-4x/day until
end of August). Each firing: pick the next unchecked item, implement it with
tests, run the full suite, check it off, commit, and attempt a push (falls
back to a local commit if GitHub access for this repo still isn't
authorized — see NOTES.md).

## Spec (from the user, 2026-07-31)

Model needs to reason like a coach game-planning into a week, not just
crunch season averages:

1. **Game-plan / usage shift** — when a starter goes down (esp. RB), the
   offense's plan changes: passing volume goes up, backup RB efficiency
   drops toward replacement level. Model the shift, don't just dock a
   generic injury-burden number.
2. **3rd down conversion %** — differential factor.
3. **4th down conversion %** — most critical situational down; weighted
   above 3rd down.
4. **Turnover margin, tiered + asymmetric**:
   - Forcing turnovers (defense) counts for *more* than avoiding giveaways
     (offense) — takeaways are the scarcer, more skill-driven signal.
   - Tiered, not linear: margin +5 good, +10 great, 10+ exceptional
     (diminishing marginal returns above +10, not a straight line).
5. **Yardage rank** — not just yards/game, but where a team ranks
   league-wide. Being top-5 in *both* offense and defense yardage is a
   distinct strong signal, not just "good stats."
6. **Situational "wins the battle" composite** — count how many of
   {3rd down%, turnover battle, rushing, passing} a team wins, weighted:
   - Rushing needs a run-rate adjustment (run-heavy teams simply rush more
     — raw volume isn't skill) *and* a late-game weighting (4th-quarter
     rushing with a lead is the "put the game away" skill, worth more than
     1st-quarter rushing).
   - Passing yards need context-adjustment: garbage-time yardage (down
     multiple scores, trailing badly in the 4th) should count for much
     less than winning-context yardage.
7. **Special teams**:
   - Punt return average +10 to +15 yd/return → great.
   - Kick return average crossing the 25-yard line → great.
   - Special-teams TD (punt/kick/blocked-kick return) → treated as a big
     momentum event, not just points.
8. **Momentum** — already have game-flow (1st/2nd half margins) and live
   win probability; extend to fold in the special-teams-TD / turnover
   swing signal above as explicit momentum events, not just half splits.

## Checklist

- [x] `usageShift` factor — injury-driven play-calling shift (RB out →
      pass-rate bump, backup RB discount, scaled by how run-dependent the
      offense already is). 2026-07-31.
- [x] `thirdDown` factor — 3rd down conversion % differential. 2026-07-31.
- [x] `fourthDown` factor — 4th down conversion % differential, weighted
      above 3rd down (default weight 60 vs 45). 2026-07-31.
- [x] `turnoverMargin` factor — tiered (saturating curve, ~0.5 at +5 pace,
      ~0.76 at +10, diminishing above), defense-forced takeaways weighted
      1.2x vs offense-avoided giveaways at 1.0x. 2026-07-31.
- [x] `yardageRank` factor — league rank score (linear ±0.5 by rank 1-32)
      plus an explicit +0.3 bonus for landing top-5 in *both* offense and
      defense. 2026-07-31. **Caveat:** currently ranks only the teams whose
      detail we've fetched (this week's participants), not the full
      32-team league — see the data item below.
- [x] `specialTeams` factor — punt/kick return averages (calibrated so a
      +13 punt-return avg and a 27-yard kick-return avg score near max) +
      return-TD bonus. 2026-07-31.
- [ ] `situationalBattle` composite factor — explicit "how many of {3rd
      down%, turnover battle, rushing, passing} does each team win" count,
      with rushing run-rate-adjusted + late-game-weighted and passing
      discounted in garbage time. **Deferred** — needs a design decision on
      how to avoid double-counting against the standalone factors above
      (see design notes below) plus play-by-play data for the late-game /
      garbage-time splits, which we don't fetch yet.
- [ ] Extend momentum/flow to treat special-teams TDs and takeaways as
      explicit in-game momentum events (currently `specialTeams` and
      `turnoverMargin` are season-long factors; the *in-game* momentum
      swing from a pick-six or punt-return TD isn't yet folded into
      `liveWinProb` the way score/clock is).
- [x] Data: extend ESPN team-statistics parsing for 3rd/4th down%,
      turnovers (category-aware, offense vs defense), return yardage.
      2026-07-31.
- [ ] Data: fetch detail for **every** league team (not just this week's
      participants) so `yardageRank` reflects the true 1-32 rank, not a
      rank among ~8-16 teams.
- [ ] Data: weekly injury depth-chart context (who's QB1/RB1 vs QB2/RB2) —
      `usageShift` currently treats any sidelined RB as "the starter,"
      which overstates the hit when the injured player was already a
      backup.
- [x] Wire all new factors into the weights panel (App.tsx WEIGHT_LABELS)
      — factor breakdown UI needed no changes since it already renders
      whatever `predictGame` returns. 2026-07-31.
- [ ] Live data refresh (phase 2, after the model is built out) — revisit
      once the core spec above is done; needs a persistence decision
      (see NOTES.md)

### Design note: situationalBattle, next time up

Don't just linearly add another factor for "wins 3rd down + turnovers +
rushing + passing" — `thirdDown` and `turnoverMargin` already exist as
standalone factors, so a naive composite double-counts them. Options to
consider: (a) make `situationalBattle` a *multiplier/bonus* on top of the
existing factors when a team sweeps 3+ of the 4 categories, rather than an
additive edge of its own, or (b) fold rushing/passing context-adjustment
in as refinements to the existing `yardage`/`production` factors instead of
a new top-level factor. Pick one and document why before implementing —
don't build both halfway.

## Notes

- GitHub push access to `trey55aa-dev/nfl-predictor` was not authorized as
  of 2026-07-31 (add_repo kept returning "requires approval"). Until that
  clears, work accumulates as local commits in this working copy — check
  `git log` for what's landed. Once access clears, `git push -u origin main`
  catches the remote up in one shot.
- This project intentionally has zero dependency on alfredassist — do not
  reintroduce imports from `../src` or similar.
