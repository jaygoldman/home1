// Pluggable text-generation providers so any Poem/1 owner can choose how poems
// are written: the Claude CLI (rides a Claude subscription, no API key), the
// Anthropic API, or any OpenAI-compatible API (OpenAI, OpenRouter, Ollama, …).
import { getSettings } from '../db.js';
import { runClaude } from './claude.js';

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

async function anthropicGenerate({ system, prompt, model, apiKey, baseUrl, timeoutMs }) {
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const data = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    timeoutMs
  );
  const block = (data.content || []).find((b) => b.type === 'text');
  return (block?.text || '').trim();
}

async function openaiGenerate({ system, prompt, model, apiKey, baseUrl, timeoutMs }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const data = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    },
    timeoutMs
  );
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Generate plain poem text. Dispatches on the configured provider.
export async function generate(prompt, { system, timeoutMs = 45000, lane = 'poem' } = {}) {
  const s = getSettings();
  const provider = s.provider || 'claude_cli';

  if (provider === 'claude_cli') {
    const { text } = await runClaude(prompt, {
      model: s.model,
      systemPrompt: system,
      allowedTools: [],
      timeoutMs,
      lane,
    });
    return text;
  }
  if (provider === 'anthropic') {
    if (!s.api_key) throw new Error('Anthropic API key not set in Settings');
    return anthropicGenerate({ system, prompt, model: s.model, apiKey: s.api_key, baseUrl: s.api_base_url, timeoutMs });
  }
  if (provider === 'openai') {
    if (!s.api_key) throw new Error('OpenAI API key not set in Settings');
    return openaiGenerate({ system, prompt, model: s.model, apiKey: s.api_key, baseUrl: s.api_base_url, timeoutMs });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// Web-search-backed news enrichment currently relies on the Claude CLI's
// built-in WebSearch tool, so it is only available with the claude_cli provider.
export function providerSupportsWebSearch() {
  return (getSettings().provider || 'claude_cli') === 'claude_cli';
}
