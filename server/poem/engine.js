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
    // Poem fodder = traits/interests/notes ONLY. The relationship (son/mom/...)
    // is deliberately left out of the hook: it's a role *within the family*, not
    // a relationship to the clock. Naming it confuses the poet — it produces
    // "my son" or, worse, "Alex loves his mom" when Alex IS the mom.
    const details = [p.traits, p.interests, p.notes].filter((x) => x && x.trim());
    const d = details.length ? randItem(details) : '';
    const kind = p.kind === 'pet' ? ' the pet' : '';
    pool.push({ w: 3, desc: `${p.name}${kind}${d ? ` — ${d}` : ''}`, name: p.name });
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
  const pick = weightedPick(pool);
  return { desc: pick.desc, name: pick.name || '' };
}

function systemPrompt(tone, rhyme, timeStyle) {
  // Where the clock time sits. 'start' opens the poem with the time and keeps
  // numbers off the line-ends; 'rhyme' lands the time as a rhyme word.
  const timeInRhyme = rhyme && timeStyle === 'rhyme';
  let rhymeRule;
  if (timeInRhyme) {
    rhymeRule = 'The lines MUST rhyme. End ONE line on the clock time itself: read the time aloud and treat its final spoken word as the rhyme (e.g. 2:07 is "two oh seven" → rhyme on "seven"; 9:45 is "nine forty-five" → rhyme on "five"). A round hour can be read either way — 10:00 is "ten o\'clock" → rhyme on "o\'clock", OR simply "ten" → rhyme on "ten" — so use whichever reads better. The partner line\'s final word must rhyme cleanly with that spoken time as actually heard. Write the time itself as digits at the end of its line, woven into the grammar as a phrase like "at 2:32" — NEVER tack it on after a comma or dash once the line has already ended on another word. The whole poem has exactly ONE rhyming pair (the time and its partner); never let a third line-ending land on that same rhyme.';
  } else if (rhyme) {
    rhymeRule = 'The lines MUST rhyme: the final word of each line has to rhyme cleanly with its partner as the words are actually spoken (a true rhyme, not just similar spelling). Do NOT end a line on the clock time or any number — numbers are hard to rhyme — so place the digits at the START of the poem and end the lines on real rhyming words.';
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
    'Write a VERY SHORT poem: 2 lines (a 3rd only if truly needed). Keep each line short.',
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

// --- how a clock time SOUNDS, so the poet can rhyme it ---------------------
// The device reads "2:07" aloud as "two oh seven", "9:45" as "nine forty-five",
// "3:00" as "three o'clock". What a line ending on the time has to rhyme with is
// the LAST spoken word ("seven", "five", "o'clock"), so we expose that word plus
// a handful of clean rhymes to seed the poet.
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { 2: 'twenty', 3: 'thirty', 4: 'forty', 5: 'fifty' };

// Spell a minute value (0–59) the way a clock speaks it, and return the final word.
function minuteWords(m) {
  if (m < 10) return { words: ONES[m], last: ONES[m] };          // single ones word
  if (m < 20) return { words: TEENS[m - 10], last: TEENS[m - 10] };
  const tens = TENS[Math.floor(m / 10)];
  const one = m % 10;
  if (!one) return { words: tens, last: tens };                  // twenty, thirty…
  return { words: `${tens}-${ONES[one]}`, last: ONES[one] };       // forty-five -> five
}

// Clean rhymes for every word a spoken time can end on. Hard cases (twelve,
// forty, o'clock) get the best available near-rhymes; the poet does the rest.
const RHYMES = {
  "o'clock": ['clock', 'rock', 'lock', 'knock', 'flock', 'block', 'dock'],
  one: ['sun', 'done', 'fun', 'run', 'begun', 'none', 'spun'],
  two: ['blue', 'through', 'new', 'true', 'view', 'dew', 'too'],
  three: ['free', 'tree', 'sea', 'key', 'tea', 'me', 'be'],
  four: ['door', 'more', 'shore', 'floor', 'before', 'pour', 'core'],
  five: ['alive', 'arrive', 'drive', 'dive', 'thrive', 'survive', 'hive'],
  six: ['tricks', 'mix', 'fix', 'sticks', 'bricks', 'ticks'],
  seven: ['heaven', 'eleven', 'leaven'],
  eight: ['late', 'wait', 'gate', 'state', 'straight', 'weight', 'fate'],
  nine: ['shine', 'line', 'mine', 'sign', 'divine', 'design', 'wine'],
  ten: ['again', 'then', 'pen', 'when', 'men', 'hen'],
  eleven: ['heaven', 'seven'],
  twelve: ['shelve', 'delve', 'themselves'],
  thirteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  fourteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  fifteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  sixteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  seventeen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  eighteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  nineteen: ['green', 'seen', 'between', 'machine', 'serene', 'clean'],
  twenty: ['plenty', 'many'],
  thirty: ['dirty', 'flirty', 'sturdy'],
  forty: ['shorty', 'sporty', 'naughty'],
  fifty: ['nifty', 'shifty', 'thrifty'],
};

// Spell an hour (1–12) the way a clock speaks it.
const hourWord = (h12) => (h12 < 10 ? ONES[h12] : TEENS[h12 - 10]);

// Full spoken form + the word(s) a line ending on the time can rhyme with, for a
// 24h "HH:MM". `readings` lists every legitimate spoken ending: usually one, but a
// round hour reads as "ten o'clock" OR simply "ten", and "ten" rhymes far more
// easily than "o'clock", so we offer the poet both.
function spokenTime(time24) {
  const [h, m] = time24.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  if (m === 0) {
    const hw = hourWord(h12);
    return {
      spoken: `${hw} o'clock`,
      readings: [
        { word: "o'clock", rhymes: RHYMES["o'clock"] },
        { word: hw, rhymes: RHYMES[hw] || [] },
      ],
    };
  }
  const mw = minuteWords(m);
  const joiner = m < 10 ? ' oh ' : ' ';
  return {
    spoken: `${hourWord(h12)}${joiner}${mw.words}`,
    readings: [{ word: mw.last, rhymes: RHYMES[mw.last] || [] }],
  };
}

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

function buildUserPrompt(focus, time24, { retry = false, rhyme = false, name = '', timeStyle = 'rhyme' } = {}) {
  const digits = displayTime(time24);
  const timeInRhyme = rhyme && timeStyle === 'rhyme';
  const sp = timeInRhyme ? spokenTime(time24) : null;

  let timeRule;
  if (timeInRhyme) {
    const choices = sp.readings.map((r) => {
      const hints = r.rhymes.length ? ` (e.g. ${r.rhymes.slice(0, 6).join(', ')})` : '';
      return `"${r.word}"${hints}`;
    }).join(' or ');
    const multi = sp.readings.length > 1
      ? ` It can be heard as "${sp.spoken}" or simply "${sp.readings[1].word}", so`
      : ` Spoken aloud it sounds like "${sp.spoken}", so`;
    // Vary which line carries the time so the poem doesn't always close on it —
    // sometimes the time OPENS the couplet and the second line answers the rhyme.
    const posRule = Math.random() < 0.5
      ? ` Put the time on the FIRST line — end the opening line with ${digits}, then let the second line land the rhyming word. Do NOT end the poem on the time this round.`
      : ` Put the time on the LAST line — end the poem with ${digits}, with the line before setting up the rhyme.`;
    timeRule = `End one line on the time, written as these exact digits ${digits}, placed as that line's final token.${multi} make the OTHER line's last word rhyme cleanly with ${choices}.${posRule} The digits must be the natural grammatical end of their line — woven in as a phrase like "at ${digits}" or "by ${digits}", NOT tacked on after a comma or dash. The poem has exactly ONE rhyming pair: the time is one half, its partner line's last word is the other. Do NOT give any line a separate end-rhyme of its own (no third rhyming word), and do not let a complete rhyming line then have the time appended. CRUCIAL: the line holding the time must lead in on a word that does NOT rhyme with the time — never place a rhyming or near-rhyming word right before the digits (e.g. for ${digits} do not write "...alive at ${digits}" or "...somehow fits at ${digits}"). Only the digits carry the rhyme on that line; everything before them is plain.`;
  } else if (timeStyle === 'start') {
    timeRule = `Begin the poem with the time, as these exact digits ${digits} (e.g. "At ${digits}, …"). Do not end any line on a number.`;
  } else {
    timeRule = `Include the time as these exact digits: ${digits} — but not as the last word of a line.`;
  }

  let retryRule = '';
  if (retry) {
    const nameNote = name ? ` (it must use the name "${name}" and NO pronouns like he/she/they/him/her/his/their)` : '';
    let rhymeNote = '';
    if (timeInRhyme) {
      const words = sp.readings.map((r) => `"${r.word}"`).join(' or ');
      rhymeNote = ` The lines must truly rhyme, and one line must END on the digits ${digits} with the other line rhyming on ${words}.`;
    }
    else if (rhyme) rhymeNote = ' The lines must truly rhyme, and no line may end on the time/number.';
    retryRule = `IMPORTANT: your last attempt didn't work${nameNote}. Do NOT address anyone as "you", and do not use sky imagery that contradicts the time of day.${rhymeNote} Keep the digits ${digits} verbatim and keep it to 2 short lines.`;
  }

  return [
    `Focus on ONLY this one thing: ${focus}.`,
    name ? `This poem is about ${name}. Refer to ${name} ONLY by name — use "${name}" (repeat it if needed) and do NOT use any pronoun ("he", "she", "they", "him", "her", "his", "their") for ${name}.` : '',
    `Right now it is ${dayPhrase(time24)} — ${digits} ${ampm(time24)}. The mood must match this time of day (never call evening or night "morning").`,
    timeRule,
    retryRule,
    'Write the short poem now.',
  ].filter(Boolean).join('\n');
}

// When rhyming with the time at the front, no line may end on the time/number
// (numbers don't rhyme). When the time IS the rhyme, this check is skipped.
function rhymeShapeOk(text) {
  return text.split(' / ').map((l) => l.trim()).filter(Boolean)
    .every((l) => !/\d[\s)"'.,!?;:–—-]*$/.test(l));
}

const lines = (text) => text.split(' / ').map((l) => l.trim()).filter(Boolean);

// 'rhyme' style: a line must actually END on the clock time so it lands as the
// rhyme — trailing punctuation is fine, but the digits must be the last token.
function timeAtLineEnd(text, time24) {
  const ds = displayTime(time24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${ds}[\\s)"'.,!?;:–—-]*$`);
  return lines(text).some((l) => re.test(l));
}

// 'rhyme' style: the time must be WOVEN into its line as a phrase ("…at 2:32"),
// not tacked on after a comma/dash once the line already ended on another word
// ("…like only Leia can do, 2:32"). The add-on form leaves the real rhyme word
// in place and makes the time a third wheel, so reject it.
function timeWovenIn(text, time24) {
  const ds = displayTime(time24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const endLine = lines(text).find((l) => new RegExp(`${ds}[\\s)"'.,!?;:–—-]*$`).test(l));
  if (!endLine) return false;
  // a real word followed by comma/dash/colon/semicolon then the time = add-on tail
  return !new RegExp(`[a-z][\\s]*[,;:—–-]\\s*${ds}[\\s)"'.,!?;:–—-]*$`, 'i').test(endLine);
}

// Crude rhyme tail (no pronunciation dictionary): drop a silent trailing 'e',
// then take from the last vowel to the end. "five"/"alive"/"thrive" all -> "iv".
function rhymeKey(w) {
  w = String(w).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  if (w.length > 2 && w.endsWith('e') && !/[aeiou]/.test(w.slice(-2, -1))) w = w.slice(0, -1);
  const m = w.match(/[aeiouy][a-z]*$/);
  return m ? m[0] : w;
}

// Does a word rhyme with the spoken time? Checks the curated rhyme lists first,
// then the crude vowel-tail key as a fallback for words not in the lists.
function wordRhymesTime(word, sp) {
  const w = String(word).toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, '');
  if (!w || !sp) return false;
  const key = rhymeKey(w);
  return sp.readings.some((r) =>
    w === r.word.toLowerCase().replace(/[^a-z]/g, '') ||
    r.rhymes.some((x) => x.toLowerCase() === w) ||
    (key && rhymeKey(r.word) === key) ||
    r.rhymes.some((x) => rhymeKey(x) === key));
}

// The line that holds the time must LEAD IN on a non-rhyming word — only the
// digits carry the rhyme there. "…the kids alive at 3:35" is a triple rhyme
// (alive / five / its partner), so reject when the word before the time rhymes
// with it. Also reject when 2+ other lines rhyme with the time (a cross-line
// triple). The single partner line that rhymes with the time is fine.
function rhymeIsClean(text, time24, sp) {
  if (!sp) return true;
  const ds = displayTime(time24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ls = lines(text);
  const tail = new RegExp(`${ds}[\\s)"'.,!?;:–—-]*$`);
  const timeLine = ls.find((l) => tail.test(l));
  if (!timeLine) return true; // absence handled by timeAtLineEnd
  // strip the trailing time phrase (incl. an optional connector) and read the
  // word that leads into it.
  const head = timeLine.replace(
    new RegExp(`[\\s,;:—–-]*(?:at|by|it'?s|its|is|near|past|around|reads|says|of|this|'?til|till)?\\s*${ds}[\\s)"'.,!?;:–—-]*$`, 'i'),
    '');
  const leadIn = (head.trim().split(/\s+/).pop() || '');
  if (wordRhymesTime(leadIn, sp)) return false;
  // count other line-endings that rhyme with the time
  const others = ls.filter((l) => l !== timeLine);
  const rhyming = others.filter((l) => wordRhymesTime(l.trim().split(/\s+/).pop() || '', sp)).length;
  return rhyming < 2;
}

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
  const { desc: focus, name } = pickFocus(gather()); // ONE subject for this minute
  let text = '';
  let source = 'fallback';
  let model = s.model;

  const rhyme = !!s.poem_rhyme;
  const timeStyle = s.poem_time_style === 'start' ? 'start' : 'rhyme';
  const timeInRhyme = rhyme && timeStyle === 'rhyme';
  const sp = timeInRhyme ? spokenTime(time24) : null;
  for (let attempt = 0; attempt < 3 && !text; attempt++) {
    try {
      const raw = await generate(buildUserPrompt(focus, time24, { retry: attempt > 0, rhyme, name, timeStyle }), {
        system: systemPrompt(s.poem_tone, rhyme, timeStyle),
        timeoutMs: 45000,
        lane: 'poem',
      });
      const norm = normalizePoem(raw);
      // Time placement: rhyme-style must end a line on the time; start-style must
      // open on it. Only the front-loaded rhyme variant bans line-ending numbers.
      const timeOk = timeInRhyme ? (timeAtLineEnd(norm, time24) && timeWovenIn(norm, time24) && rhymeIsClean(norm, time24, sp))
        : timeStyle === 'start' ? timeAtStart(norm, time24)
        : true;
      const shapeOk = timeInRhyme ? true : (!rhyme || rhymeShapeOk(norm));
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
