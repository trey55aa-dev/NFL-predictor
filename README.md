# NFL Predictor

A standalone website that projects NFL winners week by week from **your model
and your reasoning**. No database — your data lives in the browser, and an
optional single-user login (see below) keeps the whole site to just you.

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

## Locking it to just you (real login, one account)

The whole site sits behind a login screen once deployed — a real signed
session (not just a client-side check), backed by a username + hashed
password you set yourself. There's still no user database: your one
account lives entirely in three Vercel environment variables.

**1. Pick a username and password, then hash the password locally:**

```bash
node scripts/hash-password.mjs "your-chosen-password"
```

This prints a `salt:hash` string — copy it. Your plaintext password is
never stored anywhere; only this hash is.

**2. Set the three secrets on Vercel** (from this directory, after your
first `vercel` deploy so the project exists):

```bash
vercel env add AUTH_USERNAME          # e.g. your name or email
vercel env add AUTH_PASSWORD_HASH     # the salt:hash string from step 1
vercel env add AUTH_SESSION_SECRET    # any long random string — e.g. output of:
                                       #   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**3. Redeploy** so the new env vars take effect:

```bash
vercel --prod
```

That's it — visiting the site now redirects to a sign-in page first.
Sessions last 30 days; use the **Sign out** button in the app header to
clear yours early (useful on a shared or public computer).

**Notes:**
- This only activates on a real Vercel deploy — Edge Middleware isn't
  something plain `npm run dev` runs, so local testing stays login-free
  by design.
- Change your password anytime by re-running step 1 and updating
  `AUTH_PASSWORD_HASH` (`vercel env rm AUTH_PASSWORD_HASH` then
  `vercel env add AUTH_PASSWORD_HASH`), then redeploy.
- If `AUTH_SESSION_SECRET` is missing, the site fails *closed* (a 500
  page, not an open one) — a misconfigured deploy should be obviously
  broken, never silently public.
- Want this at your own domain instead of a `*.vercel.app` one? Add it
  under the Vercel project's Settings → Domains — the login gate covers
  whatever domain the deploy answers to, no extra config needed.
