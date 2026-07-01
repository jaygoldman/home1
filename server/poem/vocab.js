// Per-person "word bank" derivation. Once, on save, we ask the model for a
// small palette of alternate words/imagery around a person's traits/interests/
// notes, and stash it on the row. The poem engine then feeds that palette to the
// poet so the SAME subject can be described with fresh diction minute to minute —
// without spending tokens every minute. Patterned on news.js (build prompt →
// generate() on its own lane → parse JSON → write back → guard concurrency),
// but uses generate() rather than the WebSearch CLI, so it works on every
// provider (claude_cli | anthropic | openai).
import { db, getSettings, bumpContextVersion } from '../db.js';
import { generate } from './provider.js';

// In-flight person ids, so a rapid double-save doesn't derive twice at once.
const inflight = new Set();

// The source text a word bank is derived from. When this is unchanged we skip
// re-derivation (nothing new to say). Kept deliberately simple: the raw fields
// joined — relationship is intentionally excluded (roles aren't poem fodder).
function sourceText(p) {
  return [p.traits, p.interests, p.notes].map((x) => (x || '').trim()).join(' | ');
}

function systemPrompt() {
  return [
    'You build a small vocabulary palette for a family poem clock.',
    'Given a few traits and interests, return evocative alternate words and concrete images a poet could reach for INSTEAD of the plain word — synonyms, associated objects, sensory details.',
    'Rules: family-friendly and concrete; NO second person ("you"/"your"); NO pronouns; do NOT invent names or alternate names for the person; imagery only, never full sentences.',
    'Respond with ONLY a JSON array, no prose, in this exact shape:',
    '[{"term":"the trait or interest","words":["image or synonym","another","a third"]}]',
    'Give 3-5 items, each with 3-5 short words/phrases. If there is nothing to work with, return [].',
  ].join(' ');
}

function buildPrompt(p) {
  const bits = [];
  if (p.traits && p.traits.trim()) bits.push(`Traits: ${p.traits.trim()}.`);
  if (p.interests && p.interests.trim()) bits.push(`Interests / loves: ${p.interests.trim()}.`);
  if (p.notes && p.notes.trim()) bits.push(`Notes: ${p.notes.trim()}.`);
  const kind = p.kind === 'pet' ? 'a pet' : 'a person';
  return [
    `Build a word palette for ${kind} in a household.`,
    ...bits,
    'Return the JSON array now.',
  ].join('\n');
}

function extractJsonArray(text) {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Flatten the model's JSON into a compact one-line palette we can drop straight
// into a prompt, e.g. "soccer: the pitch, cleats, the far post; baking: flour
// dust, warm oven". Empty terms/words are dropped.
function flatten(items) {
  const parts = [];
  for (const it of items) {
    const term = String(it?.term || '').trim();
    const words = Array.isArray(it?.words)
      ? it.words.map((w) => String(w || '').trim()).filter(Boolean)
      : [];
    if (!words.length) continue;
    parts.push(term ? `${term}: ${words.join(', ')}` : words.join(', '));
  }
  return parts.join('; ');
}

// Derive (and persist) the word bank for one person. Non-blocking by design:
// callers fire-and-forget. Returns the stored palette string ('' if none).
export async function deriveVocab(personId, { force = false } = {}) {
  const id = Number(personId);
  if (!id || inflight.has(id)) return '';
  const s = getSettings();
  if (!s.vocab_enabled) return '';

  const p = db.prepare(`SELECT * FROM people WHERE id = ?`).get(id);
  if (!p) return '';

  const src = sourceText(p);
  // Nothing to derive from → clear any stale bank so poems don't keep old words.
  if (!src.replace(/\|/g, '').trim()) {
    if (p.word_bank || p.word_bank_src) {
      db.prepare(`UPDATE people SET word_bank = '', word_bank_src = '' WHERE id = ?`).run(id);
      bumpContextVersion();
    }
    return '';
  }
  if (!force && p.word_bank_src === src) return p.word_bank || '';

  inflight.add(id);
  try {
    const text = await generate(buildPrompt(p), {
      system: systemPrompt(),
      timeoutMs: 45000,
      lane: 'vocab', // own single-flight lane so it never blocks the poem lane
    });
    const bank = flatten(extractJsonArray(text));
    db.prepare(`UPDATE people SET word_bank = ?, word_bank_src = ? WHERE id = ?`).run(bank, src, id);
    bumpContextVersion(); // so the pre-generated upcoming minute sees fresh diction
    console.log(`[vocab] ${p.name}: ${bank ? bank.length + ' chars' : 'empty'}`);
    return bank;
  } catch (err) {
    console.error(`[vocab] derive failed for #${id}:`, err.message);
    return p.word_bank || '';
  } finally {
    inflight.delete(id);
  }
}

export function personVocab(personId) {
  const row = db.prepare(`SELECT word_bank FROM people WHERE id = ?`).get(Number(personId));
  return row?.word_bank || '';
}
