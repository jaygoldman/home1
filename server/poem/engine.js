// Poem engine: assemble context -> prompt -> `claude -p` -> validated poem,
// with a template fallback so the clock never goes blank.
import { db, getSettings, contextVersion } from '../db.js';
import { temporalContext } from './temporal.js';
import { weatherLine } from './weather.js';
import { generate } from './provider.js';

function activePeople() {
  return db.prepare(`SELECT * FROM people WHERE active = 1 ORDER BY id`).all();
}
function activeContext() {
  return db.prepare(`SELECT * FROM context_items WHERE active = 1 ORDER BY category, id`).all();
}

// Pick at most one still-fresh current event, least recently used first.
function pickEvent() {
  const s = getSettings();
  if (!s.news_enabled) return null;
  const row = db
    .prepare(
      `SELECT * FROM current_events
       WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')
       ORDER BY used_count ASC, fetched_at DESC LIMIT 1`
    )
    .get();
  if (row) {
    db.prepare(`UPDATE current_events SET used_count = used_count + 1 WHERE id = ?`).run(row.id);
  }
  return row || null;
}

function gather() {
  const s = getSettings();
  const people = activePeople();
  const ctx = activeContext();
  const temporal = temporalContext(s.tz, people);
  const wx = weatherLine();
  return { s, people, ctx, temporal, wx };
}

// A short summary of everything the clock currently knows — shown in the
// dashboard for transparency. NOT used as the poem prompt.
export function buildContextBlock() {
  const { people, ctx, temporal, wx } = gather();
  const grp = (cat) => ctx.filter((c) => c.category === cat).map((c) => c.value);
  const lines = [`When: ${temporal.line}.`];
  if (temporal.birthdays.length) lines.push(`Birthdays: ${temporal.birthdays.join('; ')}.`);
  if (wx) lines.push(`Weather: ${wx}.`);
  const city = grp('city'), teams = grp('team'), trad = grp('tradition');
  if (city.length) lines.push(`City: ${city.join(', ')}.`);
  if (teams.length) lines.push(`Teams: ${teams.join(', ')}.`);
  if (trad.length) lines.push(`Traditions: ${trad.join('; ')}.`);
  if (people.length) lines.push(`People & pets: ${people.map((p) => p.name).join(', ')}.`);
  return { block: lines.join('\n'), temporal };
}

const randItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(pool) {
  const total = pool.reduce((sum, x) => sum + x.w, 0);
  let r = Math.random() * total;
  for (const x of pool) if ((r -= x.w) <= 0) return x;
  return pool[pool.length - 1];
}

// Pick ONE subject for this minute, so each poem stays small and focused
// instead of cramming every person/team/fact into four lines.
function pickFocus({ people, ctx, temporal, wx }) {
  const pool = [];
  for (const p of people) {
    const details = [p.relationship, p.traits, p.interests, p.notes].filter((x) => x && x.trim());
    const d = details.length ? randItem(details) : '';
    const kind = p.kind === 'pet' ? ' the pet' : '';
    pool.push({ w: 3, desc: `${p.name}${kind}${d ? ` — ${d}` : ''}` });
  }
  for (const c of ctx) {
    if (c.category === 'team') pool.push({ w: 1.2, desc: `the home team, ${c.value}` });
    else if (c.category === 'city') pool.push({ w: 1.5, desc: `our city, ${c.value}` });
    else if (c.category === 'tradition') pool.push({ w: 1, desc: c.value });
    else pool.push({ w: 0.8, desc: c.label ? `${c.label}: ${c.value}` : c.value });
  }
  if (wx) pool.push({ w: 2.5, desc: `the weather right now (${wx})` });
  pool.push({ w: 1.5, desc: `the quiet feel of this season (${temporal.season}, ${temporal.dayPart})` });
  const ev = pickEvent();
  if (ev) pool.push({ w: 1.2, desc: `a small happy thing in the air: ${ev.headline}` });
  if (!pool.length) pool.push({ w: 1, desc: 'this quiet minute at home' });
  return weightedPick(pool).desc;
}

function systemPrompt(tone, rhyme) {
  return [
    'You are the poet inside a small family poem clock.',
    `Voice: ${tone}.`,
    'Write a VERY SHORT poem: 2 lines (a 3rd only if truly needed). Keep each line short.',
    'Separate lines with a single forward slash " / " (the device renders slashes as line breaks).',
    rhyme
      ? 'The lines MUST rhyme: the final word of each line has to rhyme cleanly with its partner as the words are actually spoken (a true rhyme, not just similar spelling). Do NOT end a line on the clock time or any number — numbers are hard to rhyme — so place the digits earlier in a line and end the lines on real rhyming words.'
      : 'Do NOT force a rhyme; free verse is good.',
    'Write about ONE subject only — the single focus you are given. Do NOT list other people, places, or topics. No catalogues, no cramming.',
    'CRITICAL: include the clock time as DIGITS exactly as given (e.g. 2:07 or 9:45). Never spell the time in words; never change the digits.',
    'Be concrete and quiet — one small observation. Output ONLY the poem: no title, no quotation marks, no commentary.',
  ].join(' ');
}

// Natural 12-hour display digits for a 24h "HH:MM" (e.g. 14:07 -> 2:07).
function displayTime(time24) {
  const [h, m] = time24.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')}`;
}

const ampm = (time24) => (Number(time24.split(':')[0]) < 12 ? 'AM' : 'PM');

// Plain-language part of day for a 24h hour, so the poem never calls 11pm "morning".
function dayPhrase(time24) {
  const h = Number(time24.split(':')[0]);
  if (h < 5) return 'the middle of the night';
  if (h < 8) return 'early morning';
  if (h < 12) return 'morning';
  if (h < 14) return 'midday';
  if (h < 18) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late at night';
}

function buildUserPrompt(focus, time24, { retry = false, rhyme = false } = {}) {
  return [
    `Focus on ONLY this one thing: ${focus}.`,
    `Right now it is ${dayPhrase(time24)} — ${displayTime(time24)} ${ampm(time24)}. The mood must match this time of day (never call evening or night "morning").`,
    `Include the time as these exact digits: ${displayTime(time24)} — but not as the last word of a line.`,
    retry
      ? `IMPORTANT: your last attempt didn't work${rhyme ? ' (the lines must truly rhyme, and a line must not end on the time/number)' : ''}. Keep the digits ${displayTime(time24)} verbatim, keep it to 2 short lines${rhyme ? ', and make the final words rhyme cleanly' : ''}.`
      : '',
    'Write the short poem now.',
  ].filter(Boolean).join('\n');
}

// When rhyming, a line must not end on the time/number (those don't rhyme).
function rhymeShapeOk(text) {
  return text.split(' / ').map((l) => l.trim()).filter(Boolean)
    .every((l) => !/\d[\s)"'.,!?;:–—-]*$/.test(l));
}

// --- validation & fallback ---

function normalizePoem(text) {
  if (!text) return '';
  let t = text.trim();
  // strip surrounding quotes / code fences / leading labels
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
  t = t.replace(/^["'“]+|["'”]+$/g, '').trim();
  // If the model used real newlines, convert to slash separators.
  if (!t.includes(' / ') && t.includes('\n')) {
    t = t.split('\n').map((l) => l.trim()).filter(Boolean).join(' / ');
  }
  // collapse whitespace
  t = t.replace(/\s*\/\s*/g, ' / ').replace(/[ \t]+/g, ' ').trim();
  return t;
}

function looksValid(text, time24) {
  if (!text) return false;
  const lineCount = text.split(' / ').length;
  if (lineCount < 1 || lineCount > 3) return false; // keep it short
  if (text.length > 180) return false;
  // must reference the time in digits or contain at least the hour/minute
  return mentionsTime(text, time24);
}

function mentionsTime(text, time24) {
  const [h, m] = time24.split(':');
  const mm = m; // minutes always 2-digit
  const h24 = Number(h);
  const h12 = ((h24 + 11) % 12) + 1;
  const candidates = new Set([
    `${String(h24).padStart(2, '0')}:${mm}`, // 14:07
    `${h24}:${mm}`,                            // 14:07 / 9:07
    `${h12}:${mm}`,                            // 2:07 / 9:07
  ]);
  return [...candidates].some((c) => text.includes(c));
}

const FALLBACKS = [
  (t) => `The clock holds ${t} in its quiet hands / and the house breathes slow, unhurried, ours.`,
  (t) => `At ${t} the kettle thinks about singing / light leans on the table / someone is almost awake.`,
  (t) => `${t}, and the day folds a small corner down / to mark the place we are.`,
];

export function fallbackPoem(time24) {
  // deterministic-ish pick by minute so it varies through the hour
  const idx = Number(time24.split(':')[1]) % FALLBACKS.length;
  return FALLBACKS[idx](time24);
}

// Short numeric id (fits a 32-bit int, like poem.town's examples) — some
// device firmware parses poemId as an integer.
function newPoemId() {
  return String(Date.now() % 1000000000);
}

// Generate (and persist) a poem for the given local time24.
export async function composePoem(time24, { screenId = '' } = {}) {
  const s = getSettings();
  const focus = pickFocus(gather()); // ONE subject for this minute
  let text = '';
  let source = 'fallback';
  let model = s.model;

  const rhyme = !!s.poem_rhyme;
  for (let attempt = 0; attempt < 3 && !text; attempt++) {
    try {
      const raw = await generate(buildUserPrompt(focus, time24, { retry: attempt > 0, rhyme }), {
        system: systemPrompt(s.poem_tone, rhyme),
        timeoutMs: 45000,
        lane: 'poem',
      });
      const norm = normalizePoem(raw);
      if (looksValid(norm, time24) && (!rhyme || rhymeShapeOk(norm))) {
        text = norm;
        source = 'claude';
      } else {
        console.warn(`[engine] attempt ${attempt + 1} rejected (shape/time/rhyme) for ${time24}`);
      }
    } catch (err) {
      console.error(`[engine] claude failed (attempt ${attempt + 1}):`, err.message);
    }
  }

  if (!text) {
    text = fallbackPoem(time24);
    source = 'fallback';
    model = '';
  }

  const poemId = newPoemId();
  db.prepare(
    `INSERT INTO poems (poem_id, time24, text, model, source, context_version, screen_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(poemId, time24, text, model, source, contextVersion(), screenId);

  return { poemId, time24, text, source, model };
}

// --- standalone self-test: `node server/poem/engine.js --selftest` ---
if (process.argv[1] && process.argv[1].endsWith('engine.js') && process.argv.includes('--selftest')) {
  const time = process.argv[3] || '14:07';
  console.log('Context block:\n' + buildContextBlock(time).block + '\n---');
  composePoem(time)
    .then((p) => {
      console.log(`source=${p.source} model=${p.model}`);
      console.log(p.text.replace(/ \/ /g, '\n'));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
