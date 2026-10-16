// Outage alerts: text the operator (iMessage, macOS only) when poem generation
// keeps erroring — e.g. the Claude CLI's login expired — so the clock doesn't
// quietly serve fallback verses for days. The dashboard isn't watched; a text is.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { getSettings } from './db.js';

const SCRIPT = path.join(import.meta.dirname, '../scripts/imessage-push.sh');
const ALERT_AFTER_MINUTES = 5;              // consecutive errored minutes before the first text
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000; // repeat while still down, at most this often

// In-memory, like the poem cache: a restart mid-outage just re-alerts after
// another ALERT_AFTER_MINUTES, which is fine.
let failStreak = 0;
let downSince = null;
let lastAlertAt = 0;
let alerted = false;

export function sendImessage(text) {
  const recipient = (getSettings().alert_imessage || '').trim();
  if (!recipient) return Promise.resolve(false);
  if (process.platform !== 'darwin') {
    console.warn('[alerts] iMessage alerts need macOS; skipping');
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    execFile(SCRIPT, [text], {
      env: { ...process.env, IMESSAGE_RECIPIENT: recipient },
      timeout: 30000,
    }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[alerts] iMessage send failed:', (stderr || err.message).trim());
        reject(new Error((stderr || err.message).trim()));
      } else {
        resolve(true);
      }
    });
  });
}

function fire(text) {
  sendImessage(text).catch(() => {}); // already logged; never let alerting break generation
}

// Called once per composed minute. `errored` = every attempt threw (provider
// down); validator rejections are not outages and don't count either way.
export function noteGeneration({ ok, errored, error }) {
  if (ok) {
    if (alerted) {
      const mins = Math.round((Date.now() - downSince) / 60000);
      fire(`Home/1 recovered — real poems are back after ~${mins} min of fallbacks.`);
      console.log('[alerts] generation recovered; sent all-clear');
    }
    failStreak = 0;
    downSince = null;
    alerted = false;
    return;
  }
  if (!errored) return;

  failStreak += 1;
  if (!downSince) downSince = Date.now();
  const due = failStreak >= ALERT_AFTER_MINUTES && (!alerted || Date.now() - lastAlertAt >= REMIND_EVERY_MS);
  if (!due) return;

  const mins = Math.round((Date.now() - downSince) / 60000);
  const provider = getSettings().provider;
  const hint = provider === 'claude_cli' ? ' If the Claude CLI is logged out, run `claude` then /login on the server Mac.' : '';
  fire(`Home/1: poem generation has failed for ~${mins} min (${provider}); the clock is showing fallback verses. Last error: ${String(error || 'unknown').slice(0, 200)}.${hint}`);
  console.warn(`[alerts] sent outage alert (streak ${failStreak})`);
  alerted = true;
  lastAlertAt = Date.now();
}
