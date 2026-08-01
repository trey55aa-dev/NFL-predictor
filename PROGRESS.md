# NFL Predictor — build roadmap

Standing checklist for the recurring build sessions (fires 3-4x/day until
end of August, via a Routine). Each firing: pick the next unchecked item,
implement it with tests, run the full suite, check it off, commit, and push.

**2026-08-01: repo access + the Routine are both live now.** `git push`
works — the canonical remote is `https://github.com/trey55aa-dev/NFL-predictor`
(note the casing; the old `nfl-predictor` URL 301-redirects to it, but set
your `origin` to the new one directly). Ignore any older note below implying
push is blocked — that's resolved. Always end a firing with an actual
`git push`, not just a local commit.

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

## Spec, round 2 (from the user, 2026-08-01)

1. **Roster from each team** — pull each team's roster so injury-driven
   factors know whether the hurt player was actually the starter.
2. **Momentum changes** — home field advantage, in-game injury changes,
   official calls (penalties), and "good plays after another" (streaks)
   as things that swing momentum and can decide a game on their own.
3. **An algorithm for "how the game is going"** — i.e., sharpen the live
   win-probability model beyond just score+clock.
4. **Time of possession** — nuanced, not just "more TOP is better":
   control matters *if* paired with the ability to score; the team with
   *less* TOP needs to be efficient when it has the ball and get
   defensive stops when it counts.

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
- [x] `situationalBattle` composite factor — built as `situationalSweep`:
      a bonus/malus layered on top of the standalone factors (not a
      re-count of them), scoring who wins 3+ of {3rd down%, turnover
      margin, rushing ypg, passing ypg} — full sweep = ±0.25 edge, "all but
      one" = ±0.12, anything less decisive = 0. Needs ≥3 of the 4
      categories resolved before it says anything. 2026-07-31. **Known
      simplification** (see design note below, now resolved): rushing/
      passing are compared on raw season yards/game — no run-rate
      adjustment for volume, no late-game weighting, no garbage-time
      discount. Real versions of those need play-by-play/game-state data
      we don't fetch. Revisit once that data exists; don't just widen this
      factor's guesswork in the meantime.
- [x] Extend momentum/flow to treat explosive plays as in-game momentum
      events — built as `momentumBump()`: a pick-six, fumble/punt/kick
      return TD, or blocked-kick return gets a short-lived probability
      bump (max ±0.06, decaying linearly to 0 over ~5 game-minutes,
      stacking-but-capped at ±0.15 for multiple plays close together) on
      top of `liveWinProb`'s existing score/clock curve. Detected from
      each scoring play's description text via `isExplosiveScoringPlay()`
      (more stable across ESPN's payload than guessing structured field
      names) rather than a generic `situation` feed. 2026-08-01.
- [x] Data: extend ESPN team-statistics parsing for 3rd/4th down%,
      turnovers (category-aware, offense vs defense), return yardage.
      2026-07-31.
- [x] Data: fetch detail for **every** league team (not just this week's
      participants) — `teamIds` for the detail fetch now comes from
      `standings.data` (which always covers all 32 teams, byes included)
      instead of only the current week's game participants, so
      `yardageRank` reflects a true 1-32 rank. 2026-07-31.
- [x] Data: weekly injury depth-chart context (who's QB1/RB1 vs QB2/RB2) —
      `fetchRosterMap`/`parseRoster` pull each team's roster; `usageShift`
      now checks the roster's presumptive starter (depthIndex 0 at that
      position) against the hurt player (matched by athlete id when both
      feeds have one, normalized-name otherwise) and applies a much
      smaller penalty (0.35x) when the hurt RB wasn't actually the
      starter. Falls back to the old "treat any RB injury as the starter"
      behavior when no roster data is available. 2026-08-01. **Caveat:**
      "presumptive starter" is a heuristic (first-listed player in the
      position group) — ESPN's roster feed doesn't publish an official
      depth chart, so this can be wrong for a genuinely competitive
      backfield. Good enough to be *directionally* right almost always,
      not authoritative.
- [x] Wire all new factors into the weights panel (App.tsx WEIGHT_LABELS)
      — factor breakdown UI needed no changes since it already renders
      whatever `predictGame` returns. 2026-07-31, 2026-08-01.
- [x] Time of possession factor — `possessionQualityScore()`: raw control
      (TOP% vs 50/50) amplified by scoring efficiency (reusing the
      Production factor's yards-per-point), plus a defense-tier
      compensation that only kicks in when a team's TOP is *below* even —
      a stingy defense earns extra credit for covering fewer offensive
      snaps, a leaky one gets penalized for compounding the disadvantage.
      2026-08-01.
- [ ] Home field advantage as an explicit momentum contributor — currently
      `homeField` is a static pregame factor (baseline bump + home/road
      splits); the round-2 spec frames it as part of *momentum* (crowd
      noise swinging a live game), which isn't modeled distinctly from
      the pregame factor yet. Not started — needs a design decision on
      whether this is really separable from the existing homeField factor
      or just a restatement of it applied differently.
- [ ] In-game injury changes (a player getting hurt mid-game shifting the
      live probability further) — **not started, and not safely
      buildable without new data.** ESPN's live "situation" feed for a
      real-time injury event isn't verified to exist in a parseable form;
      don't fake this with a guess. If it turns out ESPN's play-by-play
      does carry injury markers, wire it in as another momentumBump()
      input; otherwise this may need a different data source entirely.
- [ ] Official calls (penalties) as a momentum factor — **deferred,
      correctly scoped, not started.** A single scoring-plays list (what
      `parseScoringPlays`/`momentumBump` use today) doesn't carry penalty
      data — this needs full play-by-play (`drives.plays`, not just
      `scoringPlays`) from ESPN's summary endpoint, which is a
      meaningfully bigger parsing job (down-by-down, not just the scoring
      moments) and unverified against a live payload from this
      environment. Don't half-build this from scoring plays alone.
- [ ] "Good plays after another" (streakiness within a game, not just
      half-by-half) — **deferred alongside penalties**, same reason: needs
      full play-by-play (success/failure per play) to detect a team
      stringing together good plays, not just the scoring-plays list.
      `TeamFlowStats` already covers this at the *season* and *half*
      grain (avgQuarterSwing, comeback wins); a true in-game version is a
      genuinely separate, bigger feature.
- [ ] Live data refresh (phase 2, after the model is built out) — revisit
      once the core spec above is done; needs a persistence decision
      (see NOTES.md)

### Resolved design note: situationalBattle

Went with option (a) from the original note: `situationalSweep` is a
bonus/malus on top of the standalone `thirdDown`/`turnoverMargin`/`yardage`
factors, not an additive re-count of them — it only activates for the
distinct "wins basically everything" case (full sweep or all-but-one of
the 4 categories), so it can't just be duplicating credit those factors
already give for a narrow single-category edge. See
`situationalSweepBonus`/`situationalCategoryWinners` in predictor.ts.

### Found-during-this-cycle: a test-timing race, fixed

`app.test.tsx`'s "grades the final game" test checked
`localStorage.getItem(...)` synchronously right after a `getByText` match —
that happened to work before this cycle's changes but broke once an extra
render pass (from the `yardageRanks` memo) shifted timing enough to expose
it: the DOM updates (via React state) one tick before the *separate*
`useLocalStorage` persistence effect actually writes to `localStorage`.
Root-caused by instrumenting the grading effect directly (see git history
if this resurfaces) — confirmed grading itself was correct the whole time,
it was purely a test assertion racing ahead of an unrelated effect. Fixed
by wrapping the localStorage assertion in `waitFor` instead of asserting
synchronously. If a future cycle sees similar "state says X but storage
read says Y" flakiness, check this pattern first before assuming a logic
bug.

## Not verified against live ESPN payloads (2026-08-01)

Two new data sources went in this cycle that couldn't be checked against
real ESPN responses from this sandboxed environment (same limitation noted
elsewhere in this file) — both degrade gracefully (return empty/null
rather than throw) if the shape is off, but the *values* could be silently
wrong rather than obviously broken:

- **Roster endpoint** (`fetchRoster`/`parseRoster`,
  `.../teams/{id}/roster`) — the grouped `{ athletes: [{ items }] }` shape
  is a best guess; if it turns out flat, the parser's flat-shape fallback
  should still work, but depth-order (which player is "first") depends on
  array order in the actual response, which is unverified.
- **Scoring plays** (`fetchScoringPlays`/`parseScoringPlays`, the
  `summary?event=` endpoint's `scoringPlays` array) — field names
  (`team.id`, `period.number`, `clock.value`/`clock.displayValue`) are
  plausible based on general knowledge of ESPN's API family, not confirmed
  live.

**First thing to check if roster-aware usageShift or the live momentum
bump seem to be no-ops in production:** open the browser devtools Network
tab on a live game day, hit the two endpoints above directly, and diff the
real shape against what these parsers expect. Don't just re-guess field
names blind — get the real payload first.

## Out-of-spec addition: single-user login (2026-07-31, direct request)

Not part of the football model spec above — the user asked directly (in
conversation, not via this file) for the deployed site to sit behind a
real login so it's only reachable by them. Built as:

- `middleware.ts` (Vercel Edge Middleware) gates every request behind a
  signed session cookie, verified via `lib/session.ts` (HMAC-SHA256 over
  Web Crypto, so the same code works in both the Edge middleware and the
  Node.js login function).
- `lib/password.ts` — scrypt hash/verify, no dependency.
- `api/login.ts` / `api/logout.ts` — the only two routes middleware always
  lets through (plus `/login.html`), so the login flow can never lock
  itself out even if Vercel's `matcher` config isn't honored exactly as
  expected (there's a redundant in-function path check for this).
- `public/login.html` — a self-contained static login page (no JS/CSS
  dependencies of its own, so it never needs to pass through the auth
  gate to load its own assets).
- `scripts/hash-password.mjs` — one-time CLI to turn a chosen password
  into the `AUTH_PASSWORD_HASH` value; the plaintext password is never
  stored anywhere.
- Setup instructions are in README.md's "Locking it to just you" section.

**Not verified against a live Vercel deploy** — this sandbox can't reach
Vercel's infrastructure, so `middleware.ts`'s `config.matcher` behavior on
the actual platform (as opposed to the unit-tested pure function logic)
needs a real post-deploy check. If a login loop or lockout ever appears in
production, start by checking whether the matcher regex is being honored
the way Next.js's is, since that assumption is the one part of this that
couldn't be tested here.

## Notes

- **Resolved 2026-08-01:** GitHub push access is authorized. Remote is
  `https://github.com/trey55aa-dev/NFL-predictor` (canonical casing — the
  lowercase URL redirects). Every firing should push for real now, not just
  commit locally.
- This project intentionally has zero dependency on alfredassist — do not
  reintroduce imports from `../src` or similar.
