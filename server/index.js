import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

import { PORT, HOST, HTTPS_PORT, SESSION_SECRET, DATA_DIR, WEB_DIST } from './config.js';
import { ensureSelfSignedCert } from './tls.js';
import { primaryLanIP } from './net.js';
import './db.js';
import { deviceRouter } from './routes/device.js';
import { adminRouter } from './routes/admin.js';
import { startScheduler } from './poem/scheduler.js';

const SQLiteStore = connectSqlite3(session);
const app = express();

app.set('trust proxy', 1);
// Parse JSON regardless of Content-Type — the Poem/1 posts JSON without an
// application/json header, which would otherwise leave req.body empty.
app.use(express.json({ limit: '256kb', type: () => true }));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

// Concise access log for device traffic.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/v1/clock')) {
    res.on('finish', () => console.log(`[dev] ${req.method} ${req.path} ${res.statusCode} ${req.ip}`));
  }
  next();
});

// Health check.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Device API (poem.town spec).
app.use('/api/v1/clock', deviceRouter);

// Admin/config API.
app.use('/api/admin', adminRouter);

// Poem/1 hardware simulator (standalone page). Served from the built dist if
// present, else from the source public/ dir so it works before `build:web`.
app.get(['/sim', '/device'], (req, res) => {
  const distSim = path.join(WEB_DIST, 'sim.html');
  const srcSim = path.resolve(WEB_DIST, '..', 'public', 'sim.html');
  res.sendFile(fs.existsSync(distSim) ? distSim : srcSim);
});

// Static web app (built React SPA), with SPA fallback.
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.type('text/plain').send('Web app not built yet. Run `npm run build:web`.\nDevice API is live at /api/v1/clock.')
  );
}

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, HOST, () => {
  const ip = primaryLanIP();
  console.log(`Home/1 listening on http://${HOST}:${PORT}  (LAN: http://${ip}:${PORT})`);
  console.log(`  device API: /api/v1/clock   config app: /`);
  startScheduler();
});

// HTTPS listener so the device's forced-https endpoint has somewhere to land.
if (HTTPS_PORT) {
  try {
    const { key, cert } = ensureSelfSignedCert();
    const httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      const ip = primaryLanIP();
      const shown = HTTPS_PORT === 443 ? ip : `${ip}:${HTTPS_PORT}`;
      console.log(`Home/1 HTTPS (self-signed) on ${HTTPS_PORT}  → set Poem/1 Server hostname to: ${shown}`);
    }).on('error', (e) => {
      console.error(`[https] could not bind ${HTTPS_PORT}: ${e.message}` +
        (e.code === 'EACCES' ? ' (ports <1024 need elevated privileges)' : ''));
    });
  } catch (e) {
    console.error('[https] disabled:', e.message);
  }
}
