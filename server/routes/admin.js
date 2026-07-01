// Admin API — mounted at /api/admin (session-auth except /login & /session).
import express from 'express';
import { db, getSettings, updateSettings, bumpContextVersion } from '../db.js';
import { verifyUser, requireAuth, userCount, setPassword } from '../auth.js';
import { getPoemForTime, localTime24, getCachedPoem, isScreensaver } from '../poem/scheduler.js';
import { refreshWeather, getCachedWeather } from '../poem/weather.js';
import { refreshNews, currentEvents } from '../poem/news.js';
import { deriveVocab } from '../poem/vocab.js';
import { buildContextBlock } from '../poem/engine.js';
import { HOLIDAY_DEFS } from '../poem/temporal.js';
import { lanIPv4s } from '../net.js';
import { HTTPS_PORT, PORT } from '../config.js';

export const adminRouter = express.Router();

// --- auth (open) ---
adminRouter.get('/session', (req, res) => {
  res.json({ user: req.session?.user || null, needsSetup: userCount() === 0 });
});

adminRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = verifyUser(username || '', password || '');
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  req.session.user = user;
  res.json({ user });
});

adminRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- everything below requires auth ---
adminRouter.use(requireAuth);

adminRouter.post('/password', (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'password too short' });
  setPassword(req.session.user.username, password);
  res.json({ ok: true });
});

// --- people ---
adminRouter.get('/people', (req, res) => {
  res.json(db.prepare(`SELECT * FROM people ORDER BY id`).all());
});
adminRouter.post('/people', (req, res) => {
  const p = req.body || {};
  const info = db
    .prepare(
      `INSERT INTO people (name, kind, relationship, traits, interests, birthday, notes, active)
       VALUES (@name, @kind, @relationship, @traits, @interests, @birthday, @notes, @active)`
    )
    .run({
      name: p.name || 'Unnamed',
      kind: p.kind === 'pet' ? 'pet' : 'person',
      relationship: p.relationship || '',
      traits: p.traits || '',
      interests: p.interests || '',
      birthday: p.birthday || '',
      notes: p.notes || '',
      active: p.active === false ? 0 : 1,
    });
  bumpContextVersion();
  // Derive the word bank in the background so the save returns instantly.
  deriveVocab(info.lastInsertRowid).catch(() => {});
  res.json(db.prepare(`SELECT * FROM people WHERE id = ?`).get(info.lastInsertRowid));
});
adminRouter.put('/people/:id', (req, res) => {
  const p = req.body || {};
  db.prepare(
    `UPDATE people SET name=@name, kind=@kind, relationship=@relationship, traits=@traits,
     interests=@interests, birthday=@birthday, notes=@notes, active=@active WHERE id=@id`
  ).run({
    id: Number(req.params.id),
    name: p.name || 'Unnamed',
    kind: p.kind === 'pet' ? 'pet' : 'person',
    relationship: p.relationship || '',
    traits: p.traits || '',
    interests: p.interests || '',
    birthday: p.birthday || '',
    notes: p.notes || '',
    active: p.active === false ? 0 : 1,
  });
  bumpContextVersion();
  // Re-derive in the background; deriveVocab no-ops if the source text is unchanged.
  deriveVocab(Number(req.params.id)).catch(() => {});
  res.json(db.prepare(`SELECT * FROM people WHERE id = ?`).get(Number(req.params.id)));
});
// Force-regenerate a person's word bank (the "Regenerate" button in the web app).
adminRouter.post('/people/:id/vocab', async (req, res) => {
  await deriveVocab(Number(req.params.id), { force: true });
  const row = db.prepare(`SELECT * FROM people WHERE id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});
adminRouter.delete('/people/:id', (req, res) => {
  db.prepare(`DELETE FROM people WHERE id = ?`).run(Number(req.params.id));
  bumpContextVersion();
  res.json({ ok: true });
});

// The holiday windows that can tag a tradition — drives the web app drop-down.
adminRouter.get('/holidays', (req, res) => {
  res.json(HOLIDAY_DEFS.map((h) => ({ code: h.code, name: h.name })));
});

// --- context items ---
// `holiday` only applies to traditions; ignored for other categories.
adminRouter.get('/context', (req, res) => {
  res.json(db.prepare(`SELECT * FROM context_items ORDER BY category, id`).all());
});
adminRouter.post('/context', (req, res) => {
  const c = req.body || {};
  const holiday = c.category === 'tradition' ? (c.holiday || '') : '';
  const info = db
    .prepare(`INSERT INTO context_items (category, label, value, active, holiday) VALUES (?, ?, ?, ?, ?)`)
    .run(c.category || 'fact', c.label || '', c.value || '', c.active === false ? 0 : 1, holiday);
  bumpContextVersion();
  res.json(db.prepare(`SELECT * FROM context_items WHERE id = ?`).get(info.lastInsertRowid));
});
adminRouter.put('/context/:id', (req, res) => {
  const c = req.body || {};
  const holiday = c.category === 'tradition' ? (c.holiday || '') : '';
  db.prepare(
    `UPDATE context_items SET category=?, label=?, value=?, active=?, holiday=? WHERE id=?`
  ).run(c.category || 'fact', c.label || '', c.value || '', c.active === false ? 0 : 1, holiday, Number(req.params.id));
  bumpContextVersion();
  res.json(db.prepare(`SELECT * FROM context_items WHERE id = ?`).get(Number(req.params.id)));
});
adminRouter.delete('/context/:id', (req, res) => {
  db.prepare(`DELETE FROM context_items WHERE id = ?`).run(Number(req.params.id));
  bumpContextVersion();
  res.json({ ok: true });
});

// --- settings ---
adminRouter.get('/settings', (req, res) => res.json(getSettings()));
adminRouter.put('/settings', (req, res) => {
  const before = getSettings();
  const patch = { ...req.body };
  // If the city changed, clear cached geocode so weather re-resolves.
  const after = updateSettings(patch);
  if (patch.weather_place !== undefined && patch.weather_place !== before.weather_place) {
    updateSettings({ weather_lat: null, weather_lon: null });
  }
  bumpContextVersion();
  res.json(getSettings());
});

// --- notes (family messages on the clock) ---
adminRouter.get('/notes', (req, res) => {
  res.json(db.prepare(`SELECT * FROM notes ORDER BY posted DESC`).all());
});
adminRouter.post('/notes', (req, res) => {
  const n = req.body || {};
  const minutes = Number(n.ttlMinutes) > 0 ? Number(n.ttlMinutes) : 30;
  const noteId = `${Date.now()}`;
  const expires = new Date(Date.now() + minutes * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  db.prepare(
    `INSERT INTO notes (note_id, body, expires_at, active) VALUES (?, ?, ?, 1)`
  ).run(noteId, n.body || '', expires);
  res.json(db.prepare(`SELECT * FROM notes WHERE note_id = ?`).get(noteId));
});
adminRouter.delete('/notes/:noteId', (req, res) => {
  db.prepare(`UPDATE notes SET active = 0 WHERE note_id = ?`).run(req.params.noteId);
  res.json({ ok: true });
});

// --- devices ---
adminRouter.get('/devices', (req, res) => {
  res.json(db.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all());
});
adminRouter.post('/devices/:screenId/claim', (req, res) => {
  const claimed = req.body?.claimed !== false;
  db.prepare(`UPDATE devices SET is_claimed = ? WHERE screen_id = ?`).run(claimed ? 1 : 0, req.params.screenId);
  res.json(db.prepare(`SELECT * FROM devices WHERE screen_id = ?`).get(req.params.screenId));
});
// Forget a device — drops the row. It reappears (unclaimed) if the device checks in again.
adminRouter.delete('/devices/:screenId', (req, res) => {
  db.prepare(`DELETE FROM devices WHERE screen_id = ?`).run(req.params.screenId);
  res.json({ ok: true });
});

// --- poems history ---
adminRouter.get('/poems', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(db.prepare(`SELECT * FROM poems ORDER BY created_at DESC LIMIT ?`).all(limit));
});

// --- dashboard helpers ---
adminRouter.get('/preview', async (req, res) => {
  const t = (req.query.time24 && /^\d{1,2}:\d{2}$/.test(req.query.time24))
    ? req.query.time24
    : localTime24();
  // During quiet hours the device is blank, so don't generate (burn tokens)
  // just because the dashboard is open. The "Compose a fresh one" button passes
  // ?force=1 to override.
  if (isScreensaver(t) && req.query.force !== '1') {
    return res.json({
      time24: t, text: '', source: 'screensaver', screensaver: true,
      weather: getCachedWeather(), contextBlock: buildContextBlock(t).block,
    });
  }
  try {
    const poem = await getPoemForTime(t);
    res.json({ ...poem, weather: getCachedWeather(), contextBlock: buildContextBlock(t).block });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

adminRouter.get('/status', (req, res) => {
  res.json({
    localTime24: localTime24(),
    cachedPoem: getCachedPoem(),
    weather: getCachedWeather(),
    events: currentEvents(),
  });
});

// Manual enrichment triggers.
adminRouter.post('/weather/refresh', async (req, res) => {
  try {
    const w = await refreshWeather({ force: true });
    res.json({ ok: true, weather: w });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
adminRouter.post('/news/refresh', async (req, res) => {
  try {
    const n = await refreshNews({ force: true });
    res.json({ ok: true, stored: n, events: currentEvents() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
adminRouter.get('/events', (req, res) => res.json(currentEvents()));

// What to enter on the Poem/1's "Server hostname" field.
adminRouter.get('/connect-info', (req, res) => {
  const s = getSettings();
  const ips = lanIPv4s();
  const override = (s.device_hostname || '').trim();
  // The device forces https://<hostname>/api/v1/clock. If we serve HTTPS on a
  // non-standard port, the hostname must include :port (when the field allows).
  const portSuffix = HTTPS_PORT && HTTPS_PORT !== 443 ? `:${HTTPS_PORT}` : '';
  const lanIp = ips[0] || '127.0.0.1';
  const recommended = override || `${lanIp}${portSuffix}`;
  res.json({
    recommended,
    override,
    lanIps: ips,
    httpsPort: HTTPS_PORT || null,
    httpPort: PORT,
    httpsEnabled: !!HTTPS_PORT,
    endpointPreview: `https://${recommended}/api/v1/clock`,
    bearer: s.bearer_token,
  });
});
