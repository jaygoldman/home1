# Home/1

A self-hosted, **personalized** server for the [poem.town](https://poem.town) **Poem/1** clock.

Out of the box, Poem/1 shows a new (often charmingly random) poem every minute with the time woven in. **Home/1** points the device at your own server so the poems are about *your* household — your people and pets, your city, your teams, the season, today's weather, and even a little good news — while still honoring the device contract: **one short poem per minute, with the time in it.**

It comes with:

- 🪶 **A poem server** implementing the Poem/1 [device API](https://poem.town/developer/device-api).
- 🛠️ **A config web app** (login-protected) to manage people, household context, notes, and settings.
- 🖼️ **A browser simulator** that renders the live poem onto a Poem/1 sitting on a shelf — handy for testing without the hardware.

> Each minute's poem picks **one** subject (a person, the weather, your team, the season…) and keeps it to ~2 short lines, so it stays small and clock-like instead of cramming everything in.

---

## How poems are generated

You choose the engine in **Settings → Poem generation**:

| Provider | What it does | Needs |
|---|---|---|
| **Claude CLI** (`claude -p`) | Runs the Claude CLI locally. No API key — rides your Claude subscription. **Only provider that can fetch live "good news"** (uses the CLI's web search). | [Claude CLI](https://docs.claude.com/en/docs/claude-code) installed & signed in |
| **Anthropic API** | Calls the Anthropic Messages API. | An Anthropic API key |
| **OpenAI-compatible API** | Calls any OpenAI-style `/chat/completions` endpoint (OpenAI, OpenRouter, local Ollama, …). | API key + optional base URL |

Context layered into every poem: your **people/pets & household facts**, **temporal** context (season, part of day, holidays, upcoming birthdays — deterministic, no network), the current **weather** (free, keyless [Open-Meteo](https://open-meteo.com)), and occasionally one fresh **good-news** item (Claude CLI only).

If generation fails or times out, a built-in **fallback verse** is served so the clock never goes blank.

---

## Quick start

Requirements: **Node 20+**. For the default provider, the **Claude CLI** installed and signed in.

```bash
git clone <your-repo-url> home1 && cd home1
npm install
npm run build:web        # build the config web app
npm run fetch:shelf      # download poem.town's shelf render for the simulator (optional)
npm run setup            # create your admin login (and optionally seed city/teams)
npm start                # serves on http://localhost:8080
```

Then open **http://localhost:8080**, log in, and add your people and household details.

Configuration lives in `./data/` (SQLite + session store), which is gitignored.

---

## Keep it running (always-on)

A poem-a-minute clock needs the server up 24/7 and restarted after reboots. On macOS, a `launchd` LaunchAgent is the simplest way:

1. Create `~/Library/LaunchAgents/town.poem.home1.plist` (replace the paths/username):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <plist version="1.0"><dict>
     <key>Label</key><string>town.poem.home1</string>
     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/bin/node</string>           <!-- `which node` -->
       <string>/Users/you/home1/server/index.js</string>
     </array>
     <key>WorkingDirectory</key><string>/Users/you/home1</string>
     <key>EnvironmentVariables</key><dict><key>PORT</key><string>8080</string></dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/Users/you/home1/data/server.log</string>
     <key>StandardErrorPath</key><string>/Users/you/home1/data/server.log</string>
   </dict></plist>
   ```

2. Load it: `launchctl load ~/Library/LaunchAgents/town.poem.home1.plist`
   (unload with `launchctl unload …`; it now starts on login and restarts if it crashes.)

If you expose the server with **Tailscale Funnel**, run it in the background so it persists too: `tailscale funnel --bg 8080`.

> On Linux, the equivalent is a `systemd` service with `Restart=always`; on any platform `pm2 start server/index.js --name home1` works.

---

## Pointing your Poem/1 at the server

The device builds an `https://<server>/api/v1/clock` URL, so it needs to reach this machine over a trusted connection. Two common setups:

1. **Same LAN, direct** — if your device's Wi-Fi config accepts an IP/port (or `http://`), point it at this machine's LAN address (e.g. `http://192.168.1.x:8080`).
2. **Trusted HTTPS via Tailscale Funnel** — if the device requires real TLS, expose the local port publicly with a valid cert:
   ```bash
   tailscale funnel 8080
   ```
   then set the device's server to your `https://<machine>.<tailnet>.ts.net` hostname. The device only needs internet access — it does **not** need to be on your tailnet.

You can verify the device endpoints without hardware:

```bash
# health check (no auth) — registers the device
curl -X POST localhost:8080/api/v1/clock/status \
  -H 'Content-Type: application/json' -d '{"screenId":"TEST123"}'

# compose a poem for a given local time (bearer token from Settings)
curl -X POST localhost:8080/api/v1/clock/compose \
  -H 'Authorization: Bearer poem.dummyKey' -H 'Content-Type: application/json' \
  -d '{"screenId":"TEST123","time24":"14:07"}'
```

---

## The simulator

Visit **`/sim`** (e.g. `http://localhost:8080/sim`). It registers a virtual device, polls `/compose` every minute, renders the poem onto a Poem/1 on a shelf, and lets you **tap the device to save** a poem (♥). To save, claim the simulator device once under **Dashboard → Devices → Claim** (likes require a claimed device, per the spec).

The shelf image is poem.town's product render and is **not** committed to this repo — run `npm run fetch:shelf` to pull it locally, or the simulator falls back to a simple device outline.

---

## Device API implemented

Mounted at `/api/v1/clock` (bearer auth on all but `/status`):

- `POST /status` — boot/health check; registers the device.
- `POST /compose` — returns a poem for `time24` (`"HH:MM"`) or a `geolocate` UTC instant.
- `POST /notes/{noteId}/seen` — mark a posted note as seen.
- `POST /likes/{poemId}/mark` · `POST /likes/{poemId}/unmark` — like/unlike (claimed devices).

## Project layout

```
server/
  index.js            Express app: device API + admin API + static web + scheduler
  db.js               SQLite schema, migrations, settings
  auth.js             username/password + session
  routes/device.js    Poem/1 device API
  routes/admin.js     config API for the web app
  poem/
    provider.js       provider dispatch (Claude CLI / Anthropic / OpenAI)
    claude.js         `claude -p` runner (single-flight lanes)
    engine.js         focus selection, prompt, validation, fallback
    temporal.js       season/holiday/part-of-day context
    weather.js        Open-Meteo geocode + current conditions
    news.js           good-news web-search enrichment (Claude CLI)
    scheduler.js      per-minute pre-generation + enrichment timers
web/                  React + Vite config app  (built to web/dist)
web/public/sim.html   shelf simulator
```

---

Not affiliated with poem.town. Poem/1 is their lovely product; this is a community server for owners who want to make it theirs.
