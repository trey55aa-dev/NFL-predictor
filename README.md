# NFL Predictor

A standalone website that projects NFL winners week by week from **your model
and your reasoning** — no account, no backend database required.

## What it does

- **Live weekly slate** from ESPN's public API: every game grouped by game day
  (Thu/Sun/Mon) with kickoff times, broadcasts, records, and logos.
- **Thirteen-factor prediction model** with a weights panel you tune:
  power rating (nfelo or computed Elo), record, scoring margin, production
  (Pythagorean wins + yards-per-point), EPA efficiency, QB metrics (CPOE),
  yardage, game flow (1st/2nd-half surges from quarter linescores), injuries
  (QB-weighted report burden), style matchup (pass-heavy vs leaky defense,
  etc.), home field, momentum — and *your reasoning*.
- **Your reasoning layer** per game: a lean slider, tap-to-assign environment
  edges (weather, injuries, rest, QB, trenches, motivation, travel), and notes.
- **Comeback-aware live odds**: in-progress games get a live win probability
  that prices the score deficit against the clock — down 21-0 in Q1 is still a
  live few-percent chance; the same hole in Q4 is near zero.
- **Automatic grading**: picks lock and grade when games go final, building
  weekly and all-time hit records.

## The database

Your weights, per-game reads, notes, and graded pick history live in the
browser's localStorage (`nflp.*` keys) — instant, private, and yours.
**Export data** downloads the whole thing as JSON; **Import data** restores it
on any device. No sign-up, nothing leaves your machine.

## Run it

```bash
npm install
npm run dev        # app at http://localhost:5173 (ESPN data + computed Elo)
npm test           # engine + parser + UI tests
```

Plain `npm run dev` runs everything except the advanced-stats sources (they
need the serverless function below); the sources strip on the page shows
what's live.

## Deploy (Vercel — includes the advanced sources)

```bash
npm i -g vercel
vercel             # from this directory; accept the defaults
```

Vercel serves the site and runs `api/advanced.ts`, a serverless function that
aggregates advanced sources server-side (browsers can't read these sites
directly):

| Source | What it provides |
|---|---|
| nflverse | Offensive EPA per game (open play-by-play aggregates) |
| Next Gen Stats | Primary QB CPOE + time to throw |
| Pro-Football-Reference | Advanced team tables |
| nfelo | Published Elo-scale power ratings |

Each source is independent — failures show struck-through in the sources
strip and the model simply goes neutral on that factor. To test the function
locally, use `vercel dev` instead of `npm run dev`.

Any other static host works too (Netlify, Cloudflare Pages) — port
`api/advanced.ts` to that host's function format, or skip it and run on
ESPN data + computed Elo.
