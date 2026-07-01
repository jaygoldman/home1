import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Settings() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [events, setEvents] = useState([]);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState('');
  const [conn, setConn] = useState(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setS(await api.get('/settings'));
      setEvents(await api.get('/events'));
      setConn(await api.get('/connect-info'));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function copyHostname() {
    try { await navigator.clipboard.writeText(conn.recommended); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
    setS({ ...s, [k]: v });
  };

  async function save() {
    setErr(''); setMsg('');
    try {
      const saved = await api.put('/settings', s);
      setS(saved);
      flash('Saved.');
    } catch (e) { setErr(e.message); }
  }

  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 2500); }

  async function refreshWeather() {
    setBusy('weather');
    try { await api.post('/weather/refresh'); flash('Weather refreshed.'); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function refreshNews() {
    setBusy('news');
    try { const r = await api.post('/news/refresh'); flash(`News refreshed (${r.stored} stored).`); setEvents(r.events || []); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function changePw() {
    if (pw.length < 6) { setErr('Password too short.'); return; }
    try { await api.post('/password', { password: pw }); setPw(''); flash('Password changed.'); }
    catch (e) { setErr(e.message); }
  }

  if (!s) return <div className="spin">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <div className="actions">
          {err && <span className="error">{err}</span>}
          {msg && <span className="ok">{msg}</span>}
          <button onClick={save}>Save settings</button>
        </div>
      </div>
      <p className="sub">Tune how the clock looks, sounds, and what it knows about right now.</p>

      <h2>Connect your Poem/1</h2>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Unplug the Poem/1, then <b>hold the top button while plugging it back in</b> until the “Connect to me” screen
          shows a QR code and a temporary <code>Poem-XXXX</code> Wi-Fi. Join that Wi-Fi from your phone, open the captive
          page, go to <b>Advanced</b>, and set <b>Server hostname</b> to:
        </p>
        {conn && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <code style={{ fontSize: 20, fontWeight: 600, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px' }}>
                {conn.recommended}
              </code>
              <button className="secondary small" onClick={copyHostname}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              The device will call <code>{conn.endpointPreview}</code> (it always uses HTTPS).
              {conn.httpsEnabled
                ? ` We’re serving a self-signed certificate on port ${conn.httpsPort}.`
                : ' HTTPS is currently disabled on the server.'}
            </p>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              If the field won’t accept a port, the device uses 443 — serve on 443 (see README) or use a trusted-cert
              option (Tailscale&nbsp;Funnel / Caddy / Cloudflare Tunnel). LAN addresses detected: {conn.lanIps.join(', ') || '—'}.
            </p>
            <label>Override (domain or Tailscale/Cloudflare hostname — leave blank to use the LAN address above)</label>
            <div className="row" style={{ alignItems: 'end' }}>
              <div><input value={s.device_hostname || ''} onChange={set('device_hostname')} placeholder="clock.example.com" /></div>
              <div style={{ flex: 'none' }}><button className="secondary" onClick={save}>Save</button></div>
            </div>
          </>
        )}
      </div>

      <h2>Clock</h2>
      <div className="panel">
        <div className="row">
          <div><label>Site name</label><input value={s.site_name} onChange={set('site_name')} /></div>
          <div><label>Timezone (IANA)</label><input value={s.tz} onChange={set('tz')} placeholder="America/Toronto" /></div>
        </div>
        <label>Preferred font</label>
        <select value={s.default_font} onChange={set('default_font')} style={{ maxWidth: 200 }}>
          <option value="INTER">INTER</option>
          <option value="PLAYFAIR">PLAYFAIR</option>
        </select>
      </div>

      <h2>Quiet hours</h2>
      <div className="panel">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!s.quiet_enabled} onChange={set('quiet_enabled')} />
          Enable quiet hours (blank the screen overnight, no poems generated)
        </label>
        <div className="row" style={{ maxWidth: 420, opacity: s.quiet_enabled ? 1 : 0.5 }}>
          <div>
            <label>Start (HH:MM)</label>
            <input value={s.quiet_start} onChange={set('quiet_start')} placeholder="00:00" disabled={!s.quiet_enabled} />
          </div>
          <div>
            <label>End (HH:MM)</label>
            <input value={s.quiet_end} onChange={set('quiet_end')} placeholder="07:00" disabled={!s.quiet_enabled} />
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          {s.quiet_enabled
            ? 'During this window the device shows a blank screen and the server skips poem generation (saving tokens).'
            : 'Off — the clock shows a fresh poem every minute, around the clock.'}
        </p>
      </div>

      <h2>Poem generation</h2>
      <div className="panel">
        <div className="row">
          <div style={{ maxWidth: 220 }}>
            <label>Provider</label>
            <select value={s.provider} onChange={set('provider')}>
              <option value="claude_cli">Claude CLI (claude -p)</option>
              <option value="anthropic">Anthropic API</option>
              <option value="openai">OpenAI-compatible API</option>
            </select>
          </div>
          <div><label>Model</label><input value={s.model} onChange={set('model')} placeholder={s.provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-6'} /></div>
        </div>

        {s.provider === 'claude_cli' && (
          <p className="muted" style={{ fontSize: 12 }}>
            Runs <code>claude -p</code> on this machine — no API key, rides your Claude subscription. Requires the Claude CLI installed and signed in. This is the only provider that can fetch live “good news” (it uses the CLI’s web search).
          </p>
        )}
        {s.provider !== 'claude_cli' && (
          <>
            <div className="row">
              <div><label>API key</label><input type="password" value={s.api_key || ''} onChange={set('api_key')} placeholder="sk-…" /></div>
              <div><label>Base URL (optional)</label><input value={s.api_base_url || ''} onChange={set('api_base_url')}
                placeholder={s.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} /></div>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Key is stored locally in this server’s database. Base URL lets you point at OpenRouter, a local Ollama, etc. Note: live “good news” search is unavailable on API providers (weather and seasonal context still work).
            </p>
          </>
        )}

        <label>Tone / voice</label>
        <input value={s.poem_tone} onChange={set('poem_tone')} placeholder="warm, concrete, a little playful" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!s.poem_rhyme} onChange={set('poem_rhyme')} /> Poems should rhyme
        </label>
        <label style={{ marginTop: 12 }}>Where the clock time goes</label>
        <select value={s.poem_time_style || 'rhyme'} onChange={set('poem_time_style')} style={{ maxWidth: 320 }}>
          <option value="rhyme">Woven in anywhere (9:45 sits inside the lines)</option>
          <option value="start">At the start (At 9:45, …)</option>
        </select>
        <p className="muted" style={{ fontSize: 12 }}>
          {s.poem_time_style === 'start'
            ? 'Each poem opens with the time, e.g. “At 9:45, …”.'
            : 'The time can land anywhere — opening a line, woven mid-line, or ending a line as the rhyme itself (9:09 read as “nine oh nine”). The two lines rhyme; the poet decides where the time sits.'}
        </p>
        <label style={{ marginTop: 12 }}>Device bearer token</label>
        <input value={s.bearer_token} onChange={set('bearer_token')} />
        <p className="muted" style={{ fontSize: 12 }}>The token must match what the device sends (default <code>poem.dummyKey</code>).</p>
      </div>

      <h2>Weather</h2>
      <div className="panel">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!s.weather_enabled} onChange={set('weather_enabled')} /> Include weather in poems
        </label>
        <div className="row">
          <div style={{ maxWidth: 140 }}>
            <label>Units</label>
            <select value={s.weather_units} onChange={set('weather_units')}>
              <option value="C">Celsius</option>
              <option value="F">Fahrenheit</option>
            </select>
          </div>
          <div><label>Place (blank = use City)</label><input value={s.weather_place || ''} onChange={set('weather_place')} placeholder="Toronto" /></div>
          <div style={{ flex: 'none', alignSelf: 'end' }}>
            <button className="secondary" onClick={refreshWeather} disabled={busy === 'weather'}>{busy === 'weather' ? 'Refreshing…' : 'Refresh now'}</button>
          </div>
        </div>
      </div>

      <h2>Good news</h2>
      <div className="panel">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!s.news_enabled} onChange={set('news_enabled')} /> Mix in timely happenings
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!s.news_good_only} onChange={set('news_good_only')} /> Good news only
        </label>
        <div className="row">
          <div style={{ maxWidth: 200 }}><label>Refresh every (minutes)</label><input type="number" min="15" value={s.news_interval_minutes} onChange={set('news_interval_minutes')} /></div>
          <div><label>Extra topics (comma separated)</label><input value={s.news_topics || ''} onChange={set('news_topics')} placeholder="local festival, space launches" /></div>
          <div style={{ flex: 'none', alignSelf: 'end' }}>
            <button className="secondary" onClick={refreshNews} disabled={busy === 'news'}>{busy === 'news' ? 'Searching…' : 'Refresh now'}</button>
          </div>
        </div>
        {events.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {events.map((e) => (
              <div className="kvp" key={e.id}><span>{e.headline}</span><span className="tag">{e.source}</span></div>
            ))}
          </div>
        )}
      </div>

      <h2>Change password</h2>
      <div className="panel">
        <div className="row" style={{ alignItems: 'end' }}>
          <div><label>New password</label><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <div style={{ flex: 'none' }}><button className="secondary" onClick={changePw}>Update</button></div>
        </div>
      </div>
    </div>
  );
}
