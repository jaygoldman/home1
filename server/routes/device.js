// poem.town Device API — mounted at /api/v1/clock
import express from 'express';
import { db, getSettings } from '../db.js';
import { getPoemForTime, isScreensaver } from '../poem/scheduler.js';
import { temporalContext } from '../poem/temporal.js';

export const deviceRouter = express.Router();

const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Bearer auth for every endpoint except /status.
deviceRouter.use((req, res, next) => {
  if (req.path === '/status') return next();
  const got = req.get('authorization') || '';
  const token = got.replace(/^Bearer\s+/i, '');
  const expected = getSettings().bearer_token;
  // A real Poem/1 sends its own per-device token (not the docs' "poem.dummyKey"),
  // and the operator can't know it in advance. On this self-hosted LAN server the
  // screenId is the identity, so accept any Bearer token; just require one.
  if (!got.toLowerCase().startsWith('bearer ') || !token) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // token may differ from the configured one (real devices use their own) — the
  // screenId is the identity on this LAN server, so any Bearer is accepted.
  next();
});

function touchDevice(screenId, buildId) {
  if (!screenId) return null;
  const existing = db.prepare(`SELECT * FROM devices WHERE screen_id = ?`).get(screenId);
  if (existing) {
    db.prepare(
      `UPDATE devices SET last_seen = ?, seen = seen + 1, build_id = COALESCE(NULLIF(?, ''), build_id) WHERE screen_id = ?`
    ).run(isoNow(), buildId || '', screenId);
  } else {
    db.prepare(
      `INSERT INTO devices (screen_id, build_id, last_seen, seen, is_claimed) VALUES (?, ?, ?, 1, 0)`
    ).run(screenId, buildId || '', isoNow());
  }
  return db.prepare(`SELECT * FROM devices WHERE screen_id = ?`).get(screenId);
}

function deviceDto(d) {
  return {
    screenId: d.screen_id,
    buildId: d.build_id || undefined,
    lastSeen: d.last_seen,
    seen: d.seen,
    createdAt: d.created_at,
    isClaimed: !!d.is_claimed,
  };
}

// POST /status  (no auth) — boot/health check, registers device.
deviceRouter.post('/status', (req, res) => {
  const { screenId, buildId } = req.body || {};
  if (!screenId) return res.status(400).json({ success: false, error: 'screenId required' });
  const d = touchDevice(screenId, buildId);
  res.json({ success: true, device: deviceDto(d) });
});

// Convert a geolocate UTC instant to local HH:MM in the configured tz.
function geolocateToTime24(iso, tz) {
  const date = new Date(iso);
  if (isNaN(date)) return null;
  return temporalContext(tz, [], date).time24;
}

// POST /compose — make a poem for this minute.
deviceRouter.post('/compose', async (req, res) => {
  const { screenId, time24, geolocate } = req.body || {};
  if (!screenId) return res.status(400).json({ error: 'screenId required' });
  const s = getSettings();

  let t = time24;
  if (!t && geolocate) t = geolocateToTime24(geolocate, s.tz);
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) {
    return res.status(400).json({ error: 'provide time24 ("HH:MM") or a valid geolocate timestamp' });
  }
  // normalize to zero-padded HH:MM
  const [h, m] = t.split(':');
  t = `${h.padStart(2, '0')}:${m}`;

  touchDevice(screenId, req.body.buildId);

  // During quiet hours: send screensaver on AND an empty poem, so the device
  // goes dark whether or not its firmware acts on the screensaver flag — and we
  // spend no tokens generating a poem nobody sees.
  const screensaver = isScreensaver(t);
  let poem;
  if (screensaver) {
    poem = { poemId: String(Date.now() % 1000000000), text: '' };
  } else {
    try {
      poem = await getPoemForTime(t, { screenId });
    } catch (e) {
      console.error('[compose] failed:', e.message);
      return res.status(500).json({ error: 'poem generation failed' });
    }
  }

  // Attach an active, unseen note if present.
  const note = db
    .prepare(
      `SELECT * FROM notes
       WHERE active = 1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')
       ORDER BY posted DESC LIMIT 1`
    )
    .get();

  res.json({
    poemId: poem.poemId,
    time24: t,
    poem: poem.text,
    note: note
      ? {
          noteId: note.note_id,
          body: note.body,
          posted: note.posted,
          seen: !!note.seen,
        }
      : undefined,
    preferredFont: s.default_font,
    screensaver,
    debug: {},
  });
});

// POST /notes/:noteId/seen
deviceRouter.post('/notes/:noteId/seen', (req, res) => {
  const { noteId } = req.params;
  db.prepare(`UPDATE notes SET seen = 1 WHERE note_id = ?`).run(noteId);
  res.json({ success: true });
});

// POST /likes/:poemId/mark — requires a claimed screenId.
function setLike(req, res, liked) {
  const { poemId } = req.params;
  const { screenId } = req.body || {};
  if (!screenId) return res.status(400).json({ success: false, error: 'screenId required' });
  const device = db.prepare(`SELECT * FROM devices WHERE screen_id = ?`).get(screenId);
  if (!device || !device.is_claimed) {
    return res.status(403).json({ success: false, error: 'screenId not claimed' });
  }
  db.prepare(`UPDATE poems SET liked = ? WHERE poem_id = ?`).run(liked ? 1 : 0, poemId);
  res.json({ success: true });
}

deviceRouter.post('/likes/:poemId/mark', (req, res) => setLike(req, res, true));
deviceRouter.post('/likes/:poemId/unmark', (req, res) => setLike(req, res, false));
