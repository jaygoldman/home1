# Home/1

A self-hosted, **personalized** server for the [poem.town](https://poem.town) **Poem/1** clock. It implements the Poem/1 [device API](https://poem.town/developer/device-api) but composes poems about *your* household — your people/pets, city, teams, the season, today's weather, occasional good news — while honoring the device contract: **one short poem per minute, with the time in it.**

Three surfaces in one Node process: the **device API** (`/api/v1/clock`), a login-protected **config web app** (React SPA), and a browser **simulator** (`/sim`). User-facing README is `README.md`; this file is for working *on* the code.

This is, or will be, a **public repo**. Keep secrets out of git (see `.gitignore` — all of `data/` is ignored), and don't commit poem.town's assets (the shelf render fetched by `npm run fetch:shelf` is intentionally not redistributed — MIT covers our code only, not their trademarks/Poem/1 name/hosted assets).

## Architecture

Plain Node 20+ ESM, single process, no framework beyond Express. SQLite via `better-sqlite3` (**synchronous** — no `await` on queries). No build step for the server; the web app is React + Vite built to `web/dist` and served statically by Express.

```
server/
  index.js          Express app: device API + admin API + static web + scheduler; HTTP (8080) + HTTPS (8444)
  config.js         Paths, ports, session secret, CLAUDE_BIN — env overrides; all config defaults live here
  db.js             better-sqlite3 schema, lightweight migrations, settings singleton, contextVersion
  auth.js           bcrypt username/password + session; requireAuth middleware
  setup.js          `npm run setup` — create admin login, optionally seed city/teams
  net.js  tls.js     LAN IP discovery · self-signed cert generation (for the device's forced-HTTPS)
  routes/
    device.js       poem.town device API (bearer auth except /status)
    admin.js         config API for the web app (session auth)
  poem/
    engine.js       focus selection, prompt construction, validation, fallback — the heart
    provider.js     dispatch: claude_cli | anthropic | openai
    claude.js       headless `claude -p` runner with single-flight lanes
    scheduler.js    per-minute pre-generation, in-memory cache, quiet hours
    temporal.js     season/holiday/part-of-day/birthdays (deterministic, no network)
    weather.js      Open-Meteo geocode + current conditions (free, keyless)
    news.js         good-news web-search enrichment (Claude CLI only)
web/                React + Vite SPA (pages/ Dashboard, People, Household, Notes, Settings); built to web/dist
web/public/sim.html browser shelf simulator
data/               SQLite DBs, session store, cert, logs — gitignored, created at runtime
```

**Configuration lives in the SQLite `settings` table, not env vars.** `config.js` holds only deploy-level knobs (ports, paths). App settings (provider, API keys, tz, tone, rhyme, quiet hours, weather, news) are edited through the web app and read via `getSettings()`. There is one settings row (`id = 1`); `updateSettings(patch)` whitelists columns.

## Commands

```bash
npm start              # node server/index.js — production entry (serves 8080 + 8444)
npm run dev            # node --watch — local hot-reload (prod does NOT use this)
npm run setup          # create admin login; seed city/teams
npm run build:web      # cd web && npm install && vite build → web/dist
npm run fetch:shelf    # download poem.town's shelf render for the simulator (not committed)
npm run engine:test    # node server/poem/engine.js --selftest — compose one poem to stdout, no server
```

The web app has its own `npm` scripts in `web/` (`npm run dev` for the Vite dev server on :5173, proxying `/api` to :8080). After changing anything in `web/src`, rebuild with `npm run build:web` — Express serves the built `dist`, not the source.

## Running in production (non-obvious)

Prod runs via a **launchd LaunchAgent** as a detached daemon — plain `node server/index.js`, **not** `--watch`. So **editing source does nothing until you restart the process.** To restart: `kill <pid>` of the `node server/index.js` process; launchd auto-respawns with the new code within ~1s. Confirm via a fresh start line in `data/server.log` and a new PID on :8080. (This has bitten before — validated fixes were live in the file but the running server kept serving old logic.)

- Ports: **8080** HTTP (web app + simulator + device API), **8444** HTTPS self-signed (the device forces HTTPS; it accepts the self-signed cert on the LAN). Override with `PORT` / `HTTPS_PORT` (empty `HTTPS_PORT` disables HTTPS).
- Logs: `data/server.log`. DBs: `data/poem1.sqlite` (app, WAL mode) and `data/sessions.sqlite` (session store).

## Device API quirks (poem.town contract — don't "fix" these)

The real Poem/1 firmware deviates from the published spec in ways `index.js` and `routes/device.js` deliberately accommodate:

- **It POSTs JSON without a `Content-Type` header.** `express.json({ type: () => true })` parses every body regardless of header — without this `req.body` is empty.
- **It sends its own per-device Bearer token**, not the docs' `poem.dummyKey`, and the operator can't know it in advance. On this LAN server the **`screenId` is the identity**, so the auth middleware accepts *any* non-empty Bearer (just requires one); it does not compare against `settings.bearer_token`. `/status` needs no auth at all.
- **`poemId` is a short numeric string** (`Date.now() % 1e9`) — some firmware parses it as a 32-bit int.
- `/compose` takes either `time24` ("HH:MM") or a `geolocate` UTC instant (converted to local time in the configured tz). Likes require a **claimed** device (claim once via the web Dashboard → Devices).

## Poem engine invariants (the editorial contract)

`engine.js` is where the product lives. The poem must satisfy, every minute:

- **One subject per minute.** `pickFocus()` weighted-picks a *single* person/pet/team/city/tradition/weather/season/news item. Never list or cram multiple subjects — that's the whole point of staying clock-small (~2 short lines).
- **Observer voice.** The clock writes *about* the household, never *to* or *as* a member. Rejected by validators: any second-person (`you`/`your`), and — when the focus is a person/pet — any third-person pronoun (`he/she/they/him/her/his/their`) or a missing name. A person poem must name the subject and use only the name. Relationship labels (son/mom/…) are context only; they are deliberately kept out of the poem hook (naming them produces "my son" / "Alex loves his mom" when Alex *is* the mom).
- **The time must appear as digits** exactly as given (`mentionsTime`), never spelled out. When rhyming (`poem_rhyme`), a line must not *end* on the time/number (`rhymeShapeOk`).
- Up to **3 attempts**, then a built-in **fallback verse** so the clock never goes blank. `normalizePoem()` cleans the raw output (strips fences/quotes, converts newlines to ` / ` separators, normalizes temperatures to `°`).

When changing prompts or validators, run `npm run engine:test` to eyeball output before relying on it. Keep the system prompt, the validators, and the retry hint in sync — they encode the same rules three ways.

## How generation is wired

- **Provider abstraction** (`provider.js`): `generate(prompt, opts)` dispatches on `settings.provider` — `claude_cli` (rides a Claude subscription via `claude -p`, no API key), `anthropic` (Messages API), or `openai` (any OpenAI-compatible `/chat/completions`, incl. OpenRouter/Ollama). **Web-search news enrichment is `claude_cli`-only** (`providerSupportsWebSearch()`); guard new web-search features behind it.
- **`claude.js` serializes CLI calls per *lane*** (single-flight) so a slow lane (news web search, ~120s) never blocks the latency-sensitive `poem` lane. Reuse lanes; don't spawn unbounded `claude` processes.
- **The scheduler caches poems in memory only** (`scheduler.js`, a `Map`, max 6) — the `poems` DB table is a *history log* read by the admin page, never re-served. A restart clears the cache; old rows are never replayed. Each tick pre-generates the *upcoming* minute so the device's top-of-minute poll hits a warm cache. During **quiet hours** it skips generation and `/compose` returns an empty screensaver poem (don't burn tokens on a dark screen).

## Conventions

- **SQLite is synchronous** (`better-sqlite3`): write `db.prepare(...).get()/.all()/.run()`, no `await`. Use parameterized queries (`?` placeholders) — never string-interpolate values.
- **Schema migrations are additive and idempotent**: `CREATE TABLE IF NOT EXISTS` plus the `ensureColumn(table, col, ddl)` helper for new columns on existing DBs. There is no migration framework and no down-migrations; add columns with sensible defaults.
- **Bump `contextVersion()`** (`bumpContextVersion()`) whenever people/context/settings change so cached poems regenerate against fresh context.
- Admin routes return `{ error: "..." }` JSON; the web `api.js` wrapper throws on non-2xx and treats 401 as logged-out. Match the existing route shapes in `admin.js`.
- Match the surrounding code's plain-ESM, comment-the-why style. The inline comments explaining *why* a quirk exists (device contract, voice rules) are load-bearing — keep them when you touch that code.

## Maintaining this file

Keep it lean and high-signal — it documents what isn't obvious from the code, not what is. If it drifts from reality (a renamed file, a changed port, a new provider), fix it in the same change.
