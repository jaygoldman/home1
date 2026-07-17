// Poem engine: assemble context -> prompt -> `claude -p` -> validated poem,
// with a template fallback so the clock never goes blank.
import { db, getSettings, contextVersion } from '../db.js';
import { temporalContext, holidayActive } from './temporal.js';
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

// --- anti-repetition memory (in-memory, resets on restart, like the cache) ---
// Recently-used subject keys, so the clock doesn't dwell on the same person or
// "the weather" minute after minute; and recent poem texts, fed to the poet as a
// "don't echo these" list so phrasing varies even when a subject legitimately
// recurs. Both are bounded rings.
const RECENT_SUBJECTS_MAX = 5;
const RECENT_POEMS_MAX = 3;
const recentSubjects = [];
const recentPoems = [];
function pushRecent(arr, val, max) {
  arr.push(val);
  while (arr.length > max) arr.shift();
}

// Poetic "move" for the minute — rotates the shape so subjects don't always come
// out the same way. Applies to every focus (people, weather, city, season…).
const ANGLES = [
  'a tiny action',
  'a sensory close-up',
  'a quiet scene',
  'a small comparison',
  'a single image',
];

// Split traits/interests/notes into individual hooks and pick ONE, so a poem
// leans on a single concrete detail ("baking") instead of the whole comma blob
// ("soccer, baking, sunbeams"). A field with no comma stays whole (its own hook).
function pickFacet(p) {
  const tokens = [p.traits, p.interests, p.notes]
    .filter((x) => x && x.trim())
    .flatMap((f) => f.split(',').map((t) => t.trim()).filter(Boolean));
  return tokens.length ? randItem(tokens) : '';
}

// Pick ONE subject for this minute, so each poem stays small and focused
// instead of cramming every person/team/fact into four lines.
function pickFocus({ people, ctx, temporal, wx }) {
  const pool = [];
  for (const p of people) {
    // Poem fodder = traits/interests/notes ONLY. The relationship (son/mom/...)
    // is deliberately left out of the hook: it's a role *within the family*, not
    // a relationship to the clock. Naming it confuses the poet — it produces
    // "my son" or, worse, "Alex loves his mom" when Alex IS the mom.
    const d = pickFacet(p); // one concrete detail, not the whole comma blob
    const kind = p.kind === 'pet' ? ' the pet' : '';
    pool.push({
      w: 3,
      desc: `${p.name}${kind}${d ? ` — ${d}` : ''}`,
      name: p.name,
      palette: p.word_bank || '', // fresh diction for this same subject
      key: `person:${p.name}`,
    });
  }
  for (const c of ctx) {
    if (c.category === 'team') pool.push({ w: 1.2, desc: `the home team, ${c.value}`, key: `team:${c.value}` });
    else if (c.category === 'city') pool.push({ w: 1.5, desc: `our city, ${c.value}`, key: `city:${c.value}` });
    else if (c.category === 'tradition') {
      // A tradition tagged with a holiday only enters the pool inside that
      // holiday's window, so "Christmas baking" can't surface in July. Untagged
      // traditions stay year-round (holidayActive returns true for an empty tag).
      if (holidayActive(c.holiday, temporal.month, temporal.day)) {
        pool.push({ w: 1, desc: c.value, key: `trad:${c.value}` });
      }
    }
    else pool.push({ w: 0.8, desc: c.label ? `${c.label}: ${c.value}` : c.value, key: `ctx:${c.id}` });
  }
  if (wx) pool.push({ w: 2.5, desc: `the weather right now (${wx})`, key: 'weather' });
  pool.push({ w: 1.5, desc: `the quiet feel of this season (${temporal.season}, ${temporal.dayPart})`, key: 'season' });
  const ev = pickEvent();
  if (ev) pool.push({ w: 1.2, desc: `a small happy thing in the air: ${ev.headline}`, key: `event:${ev.id}` });
  if (!pool.length) pool.push({ w: 1, desc: 'this quiet minute at home', key: 'quiet' });
  // Soft-penalize recently-used subjects so the clock doesn't dwell on one, but
  // never hard-exclude — a small household must never end up with an empty pool.
  for (const x of pool) if (recentSubjects.includes(x.key)) x.w *= 0.15;
  const pick = weightedPick(pool);
  return { desc: pick.desc, name: pick.name || '', palette: pick.palette || '', key: pick.key };
}

function systemPrompt(tone, rhyme, timeStyle) {
  // Where the clock time sits. 'start' opens the poem with the time; 'rhyme'
  // lets it sit anywhere the poem reads best. Either way, when rhyming, the
  // line-ends carry the rhyme on real words — numbers never end a line.
  let rhymeRule;
  if (rhyme) {
    rhymeRule = 'The lines MUST rhyme: the final word of each line has to rhyme cleanly with its partner as the words are actually spoken (a true rhyme, not just similar spelling).';
    rhymeRule += timeStyle === 'start'
      ? ' The digits open the poem, so end the lines on real rhyming words — do not end a line on a number.'
      : ' The clock time is spoken aloud as words ("9:45" is heard as "nine forty-five", "9:09" as "nine oh nine"), so a line MAY end on the time and rhyme on that spoken sound, OR the time can sit mid-line and the lines rhyme on ordinary words — either is good, as long as the two lines truly rhyme.';
  } else {
    rhymeRule = 'Do NOT force a rhyme; free verse is good.';
  }
  const placeRule = timeStyle === 'start'
    ? 'Begin the poem with the clock time, as in "At 2:07, …" — the digits belong at the very start.'
    : '';
  return [
    'You are the poet inside a small family poem clock.',
    'You are a warm, affectionate OBSERVER of this household — not a member of it, and not a parent, child, or relative of anyone in it. Refer to every person by their given name. NEVER use a first-person possessive about a person ("my son", "our daughter", "my wife", "my dad"); any relationship label you are given (son, mom, grandmother, etc.) describes their role within the family for your context only — it is NOT your relationship to them.',
    `Voice: ${tone}.`,
    // Short LINES are what matters: the device shrinks its font as any single
    // line grows, so one long line makes the whole poem read small. Two lines
    // is fine — but keep each line short and tight (a handful of words). Favor
    // compact phrasing over a long line that says the same thing.
    'Write a VERY SHORT poem: 2 lines (a 3rd only if truly needed). Keep each line SHORT — aim for about 6 words (roughly 30 characters) per line, and never let a line sprawl past ~8 words. A long line shrinks the clock\'s font, so trim every line to its tightest form. When in doubt, cut words rather than add them.',
    'Separate lines with a single forward slash " / " (the device renders slashes as line breaks).',
    rhymeRule,
    placeRule,
    'Write about ONE subject only — the single focus you are given. Do NOT list other people, places, or topics. No catalogues, no cramming.',
    'If the focus is a person or pet, refer to them ONLY by their given name — repeat the name when needed, or rewrite the line so no pronoun is necessary. Do NOT use "he", "she", "they", "him", "her", "his", "hers", "them", or "their" for them at all. Every reference must make it unmistakable who the poem is about.',
    'You are an observer writing ABOUT the household, never TO it. NEVER address anyone as "you" or "your" — write in the third person, naming the subject.',
    'Never invent imagery that contradicts the time of day: no moon, stars, or nightfall during daytime hours, and no bright sun or daylight at night. Match the sky to the actual time you are given.',
    'CRITICAL: include the clock time as DIGITS exactly as given (e.g. 2:07 or 9:45). Never spell the time in words; never change the digits.',
    'If you mention a temperature, always write it with a degree symbol (e.g. 24°), never as a bare number or the word "degrees".',
    'Be concrete and quiet — one small observation. Output ONLY the poem: no title, no quotation marks, no commentary.',
  ].filter(Boolean).join(' ');
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

function buildUserPrompt(focus, time24, { retry = false, rhyme = false, name = '', timeStyle = 'rhyme', palette = '', angle = '', avoid = [] } = {}) {
  const digits = displayTime(time24);

  let timeRule;
  if (timeStyle === 'start') {
    timeRule = `Begin the poem with the time, as these exact digits ${digits} (e.g. "At ${digits}, …"). Do not end any line on a number.`;
  } else if (rhyme) {
    timeRule = `Make the two lines rhyme cleanly with each other. Include the time as these exact digits ${digits} somewhere in the poem — it can open a line, sit mid-line, or END a line as the rhyme itself. Spoken aloud the digits are words (e.g. 9:45 is "nine forty-five", 9:09 is "nine oh nine"), so a line ending on ${digits} rhymes on that sound. Whatever you choose, make sure the two lines genuinely rhyme.`;
  } else {
    timeRule = `Include the time as these exact digits: ${digits} — but not as the last word of a line.`;
  }

  let retryRule = '';
  if (retry) {
    const nameNote = name ? ` (it must use the name "${name}" and NO pronouns like he/she/they/him/her/his/their)` : '';
    const rhymeNote = rhyme ? ' The two lines must truly rhyme with each other.' : '';
    retryRule = `IMPORTANT: your last attempt didn't work${nameNote}. Do NOT address anyone as "you", and do not use sky imagery that contradicts the time of day.${rhymeNote} Keep the digits ${digits} verbatim and keep both lines short — a handful of words each, no long sprawling line.`;
  }

  // Optional palette: alternate words/imagery for THIS subject (see vocab.js),
  // so the same person reads differently across minutes. Use sparingly — the
  // one-subject/name-only rules still win.
  const paletteRule = palette && name
    ? `Optional word palette you may draw on for fresh imagery (do NOT list them, use at most one, only if it fits): ${palette}.`
    : '';
  const angleRule = angle ? `Angle for this poem: lean on ${angle}.` : '';
  // Recent poems the poet should NOT echo — keeps phrasing from converging.
  const avoidRule = avoid && avoid.length
    ? `To stay fresh, do NOT reuse the images, phrasings, or opening words of these recent poems: ${avoid.map((a) => `"${a}"`).join(' ')}.`
    : '';

  return [
    `Focus on ONLY this one thing: ${focus}.`,
    name ? `This poem is about ${name}. Refer to ${name} ONLY by name — use "${name}" (repeat it if needed) and do NOT use any pronoun ("he", "she", "they", "him", "her", "his", "their") for ${name}.` : '',
    `Right now it is ${dayPhrase(time24)} — ${digits} ${ampm(time24)}. The mood must match this time of day (never call evening or night "morning").`,
    angleRule,
    paletteRule,
    timeRule,
    avoidRule,
    retryRule,
    'Write the short poem now — keep each line short and tight.',
  ].filter(Boolean).join('\n');
}

// When rhyming with the time at the front, no line may end on the time/number
// (numbers don't rhyme). When the time IS the rhyme, this check is skipped.
function rhymeShapeOk(text) {
  return text.split(' / ').map((l) => l.trim()).filter(Boolean)
    .every((l) => !/\d[\s)"'.,!?;:–—-]*$/.test(l));
}

const lines = (text) => text.split(' / ').map((l) => l.trim()).filter(Boolean);

// 'start' style: the poem opens on the time (first line carries the digits).
function timeAtStart(text, time24) {
  const first = lines(text)[0] || '';
  return mentionsTime(first, time24);
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
  // Temperatures: "24 degrees"/"24C"/"24 C" -> "24°" (leave clock times alone).
  t = t.replace(/(\d{1,3})\s*degrees?(\s*(celsius|fahrenheit|[cf]))?\b/gi, '$1°');
  t = t.replace(/(\d{1,3})\s*°?\s*([CF])\b/g, '$1°$2');
  t = t.replace(/(\d{1,3})\s+°/g, '$1°');
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

// When the focus is a person/pet, the poem must actually name them — otherwise
// we get ambiguous "she drinks her protein" poems with no subject.
function namePresent(text, name) {
  if (!name) return true;
  // match the first word of the name (handles "Sophie Goldman" -> "Sophie"),
  // case-insensitive, on a word boundary.
  const first = name.trim().split(/\s+/)[0];
  if (!first) return true;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(text);
}

// Third-person personal pronouns leave a person/pet poem ambiguous ("she drinks
// her protein" — which household member?). When the focus is a person/pet we
// require the name AND reject any of these so the subject is always unmistakable.
const PERSON_PRONOUN_RE = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/i;
function nameNotPronoun(text, name) {
  if (!name) return true;
  return namePresent(text, name) && !PERSON_PRONOUN_RE.test(text);
}

// The clock is an observer; it writes ABOUT the household, never TO it. Second
// person ("you call to say hello") is off-voice and ambiguous about who's meant.
const SECOND_PERSON_RE = /\byou(r|rs|rself|rselves)?\b/i;
function noSecondPerson(text) {
  return !SECOND_PERSON_RE.test(text);
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
  const { desc: focus, name, palette, key } = pickFocus(gather()); // ONE subject for this minute
  const angle = randItem(ANGLES);           // rotate the poetic move
  const avoid = recentPoems.slice();        // "don't echo these" list
  let text = '';
  let source = 'fallback';
  let model = s.model;

  const rhyme = !!s.poem_rhyme;
  const timeStyle = s.poem_time_style === 'start' ? 'start' : 'rhyme';
  for (let attempt = 0; attempt < 3 && !text; attempt++) {
    try {
      const raw = await generate(buildUserPrompt(focus, time24, { retry: attempt > 0, rhyme, name, timeStyle, palette, angle, avoid }), {
        system: systemPrompt(s.poem_tone, rhyme, timeStyle),
        timeoutMs: 45000,
        lane: 'poem',
      });
      const norm = normalizePoem(raw);
      // Time placement: 'start' must open on the time; 'rhyme' just needs it
      // present (looksValid checks that) anywhere — including a line-end, where
      // it rhymes on its spoken form. We only forbid line-ending numbers in
      // 'start' mode (the digits are up front, so the couplet rhymes on words);
      // in 'rhyme' mode we trust the poet to make the two lines rhyme.
      const timeOk = timeStyle === 'start' ? timeAtStart(norm, time24) : true;
      const shapeOk = (rhyme && timeStyle === 'start') ? rhymeShapeOk(norm) : true;
      if (looksValid(norm, time24) && timeOk && shapeOk && nameNotPronoun(norm, name) && noSecondPerson(norm)) {
        text = norm;
        source = 'claude';
      } else {
        console.warn(`[engine] attempt ${attempt + 1} rejected (shape/time/rhyme/name/pronoun/2nd-person) for ${time24}`);
      }
    } catch (err) {
      console.error(`[engine] claude failed (attempt ${attempt + 1}):`, err.message);
    }
  }

  if (!text) {
    text = fallbackPoem(time24);
    source = 'fallback';
    model = '';
  } else {
    // Remember what we just wrote so the next minutes vary subject and phrasing.
    // Only on a real (non-fallback) poem: the fallback isn't about this subject.
    pushRecent(recentSubjects, key, RECENT_SUBJECTS_MAX);
    pushRecent(recentPoems, text, RECENT_POEMS_MAX);
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
