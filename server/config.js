import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.POEM1_DATA_DIR || path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'poem1.sqlite');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';
// HTTPS listener for the device (which forces https). 0/empty disables it.
// Default avoids 443/8443/10000 (used by Tailscale Funnel/Serve).
export const HTTPS_PORT = process.env.HTTPS_PORT === undefined ? 8444 : Number(process.env.HTTPS_PORT);

// Session secret: persisted to data dir so sessions survive restarts.
function loadOrCreateSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    const secret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    fs.writeFileSync(p, secret, { mode: 0o600 });
    return secret;
  }
}

export const SESSION_SECRET = process.env.SESSION_SECRET || loadOrCreateSecret();

// Default device bearer token per the poem.town spec.
export const DEFAULT_BEARER = 'poem.dummyKey';

// Path to the claude CLI used for headless poem generation.
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
