// Per-minute poem pre-generation + cache, weather/news refresh, quiet hours.
// We pre-generate the *upcoming* minute so the device's top-of-minute poll
// always hits a warm cache instead of waiting ~4s for generation.
import { getSettings } from '../db.js';
import { temporalContext } from './temporal.js';
import { composePoem } from './engine.js';
import { refreshWeather } from './weather.js';
import { refreshNews } from './news.js';

const CACHE_MAX = 6;
const cache = new Map();    // time24 -> poem object
const inflight = new Map(); // time24 -> Promise

function tzTime24(date) {
  return temporalContext(getSettings().tz, [], date).time24;
}
export function localTime24() {
  return tzTime24(new Date());
}
function nextTime24() {
  return tzTime24(new Date(Date.now() + 60000));
}

function prune() {
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// HH:MM in [start, end) with wrap-around midnight support.
function inQuietHours(time24) {
  const s = getSettings();
  const start = (s.quiet_start || '').trim();
  const end = (s.quiet_end || '').trim();
  if (!start || !end) return false;
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const now = toMin(time24);
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

export function isScreensaver(time24 = localTime24()) {
  return inQuietHours(time24);
}

// Return the cached poem for time24, generating it if needed (coalesced).
export async function getPoemForTime(time24, opts = {}) {
  if (cache.has(time24)) return cache.get(time24);
  if (inflight.has(time24)) return inflight.get(time24);
  const promise = composePoem(time24, opts)
    .then((poem) => {
      cache.set(time24, poem);
      prune();
      inflight.delete(time24);
      return poem;
    })
    .catch((e) => {
      inflight.delete(time24);
      throw e;
    });
  inflight.set(time24, promise);
  return promise;
}

export function getCachedPoem() {
  let last = null;
  for (const v of cache.values()) last = v;
  return last;
}

// Warm the current minute and pre-generate the next one — but skip any minute
// that falls in quiet hours (the screen is blank then, so generating would just
// burn tokens). The wake-up minute is still pre-generated because it isn't quiet.
async function tick() {
  try {
    const cur = localTime24();
    if (!isScreensaver(cur) && !cache.has(cur)) await getPoemForTime(cur);
    const nxt = nextTime24();
    if (!isScreensaver(nxt) && !cache.has(nxt)) await getPoemForTime(nxt);
  } catch (e) {
    console.error('[scheduler] tick error:', e.message);
  }
}

let minuteTimer = null;
let weatherTimer = null;
let newsTimer = null;

export function startScheduler() {
  refreshWeather({ force: true }).catch(() => {});
  tick();
  setTimeout(() => refreshNews({ force: false }).catch(() => {}), 30000);

  // Run a few seconds after the top of each minute so the upcoming minute is
  // ready well before the device polls.
  const now = new Date();
  const msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  setTimeout(() => {
    tick();
    minuteTimer = setInterval(tick, 60000);
  }, msToNextMinute + 1500);

  weatherTimer = setInterval(() => refreshWeather().catch(() => {}), 5 * 60 * 1000);
  newsTimer = setInterval(() => refreshNews().catch(() => {}), 5 * 60 * 1000);
}

export function stopScheduler() {
  clearInterval(minuteTimer);
  clearInterval(weatherTimer);
  clearInterval(newsTimer);
}
