// Periodic good-news enrichment via `claude -p` with WebSearch.
import { db, getSettings } from '../db.js';
import { runClaude } from './claude.js';
import { providerSupportsWebSearch } from './provider.js';

let lastRun = 0;
let running = false;

function topicsFromContext() {
  const ctx = db
    .prepare(`SELECT category, value FROM context_items WHERE active=1 AND category IN ('team','city')`)
    .all();
  return ctx.map((c) => c.value);
}

function buildNewsPrompt(topics, goodOnly) {
  const list = topics.length ? topics.join(', ') : 'the local city and major sports teams';
  return [
    `Use web search to find 2-4 genuinely recent (last 24-48 hours) news items about: ${list}.`,
    goodOnly
      ? 'Only include POSITIVE, uplifting, or celebratory items (wins, milestones, good community news). Skip anything negative, tragic, or controversial.'
      : 'Prefer notable, family-friendly items.',
    'Each item must be TRUE and verifiable from your search — do not invent anything. If you cannot verify recent items, return fewer (or an empty list).',
    'Respond with ONLY a JSON array, no prose, in this exact shape:',
    '[{"source":"team|city|general","headline":"short headline","summary":"one sentence","sentiment":"positive|neutral"}]',
  ].join('\n');
}

function extractJsonArray(text) {
  if (!text) return [];
  // Find the first [...] block.
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

// Run the news job. Returns the number of events stored.
export async function refreshNews({ force = false } = {}) {
  const s = getSettings();
  if (!s.news_enabled) return 0;
  if (!providerSupportsWebSearch()) {
    console.log('[news] web-search enrichment needs the claude_cli provider; skipping');
    return 0;
  }
  const intervalMs = Math.max(15, s.news_interval_minutes) * 60 * 1000;
  if (!force && Date.now() - lastRun < intervalMs) return 0;
  if (running) return 0;
  running = true;
  lastRun = Date.now();

  try {
    const topics = [
      ...topicsFromContext(),
      ...(s.news_topics || '').split(',').map((x) => x.trim()).filter(Boolean),
    ];
    const { text } = await runClaude(buildNewsPrompt(topics, !!s.news_good_only), {
      model: s.model,
      allowedTools: ['WebSearch'],
      timeoutMs: 120000,
      lane: 'news',
    });
    const items = extractJsonArray(text).slice(0, 5);
    if (!items.length) return 0;

    // Fresh set: clear expired, then insert new with a TTL a bit over the interval.
    const ttlMin = Math.max(180, s.news_interval_minutes * 2);
    const expires = new Date(Date.now() + ttlMin * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, 'Z');

    db.prepare(`DELETE FROM current_events WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run();
    const insert = db.prepare(
      `INSERT INTO current_events (source, headline, summary, sentiment, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const seen = new Set(
      db.prepare(`SELECT headline FROM current_events`).all().map((r) => r.headline.toLowerCase())
    );
    let stored = 0;
    const tx = db.transaction((rows) => {
      for (const it of rows) {
        const headline = String(it.headline || '').trim();
        if (!headline || seen.has(headline.toLowerCase())) continue;
        seen.add(headline.toLowerCase());
        insert.run(
          ['team', 'city', 'general'].includes(it.source) ? it.source : 'general',
          headline,
          String(it.summary || '').trim(),
          it.sentiment === 'neutral' ? 'neutral' : 'positive',
          expires
        );
        stored++;
      }
    });
    tx(items);
    console.log(`[news] stored ${stored} event(s)`);
    return stored;
  } catch (err) {
    console.error('[news] refresh failed:', err.message);
    return 0;
  } finally {
    running = false;
  }
}

export function currentEvents() {
  return db
    .prepare(
      `SELECT * FROM current_events
       WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')
       ORDER BY fetched_at DESC`
    )
    .all();
}
