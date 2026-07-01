import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Dashboard() {
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [poems, setPoems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function loadStatus() {
    try {
      const [s, p] = await Promise.all([
        api.get('/status'),
        api.get('/poems?limit=12'),
      ]);
      setStatus(s);
      setPoems(p);
    } catch (e) { setErr(e.message); }
  }

  async function loadPreview(force = false) {
    setBusy(true);
    setErr('');
    try {
      setPreview(await api.get('/preview' + (force ? '?force=1' : '')));
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { loadStatus(); loadPreview(); }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="sub">A live look at what your clock is composing right now.</p>
      {err && <p className="error">{err}</p>}

      <div className="poem-card">
        {preview ? (
          preview.screensaver ? (
            <div className="spin" style={{ padding: '16px 0' }}>
              🌙 Quiet hours — the screen is blank. No poems are being generated.
            </div>
          ) : (
            <>
              <div className="poem-text">{preview.text?.replace(/ \/ /g, '\n')}</div>
              <div className="chips" style={{ justifyContent: 'center' }}>
                <span className="tag">{preview.time24}</span>
                <span className="tag">{preview.source}</span>
                {preview.model && <span className="tag">{preview.model}</span>}
                {preview.weather && (
                  <span className="tag">{preview.weather.condition} {preview.weather.tempNow}{preview.weather.unit}</span>
                )}
              </div>
            </>
          )
        ) : (
          <div className="spin">Composing…</div>
        )}
        <div className="poem-meta">
          <button className="secondary small" onClick={() => loadPreview(true)} disabled={busy}>
            {busy ? 'Composing…' : 'Compose a fresh one'}
          </button>
        </div>
      </div>

      <h2>Recent poems</h2>
      <div className="panel">
        {poems.length === 0 && <p className="muted">None yet.</p>}
        {poems.map((p) => (
          <div className="list-item" key={p.poem_id}>
            <div className="grow">
              <span className="muted">{p.time24}</span> · {p.text}
            </div>
            {p.liked ? <span className="tag pet">♥ liked</span> : null}
            <span className="tag">{p.source}</span>
          </div>
        ))}
      </div>

      {status?.events?.length > 0 && (
        <>
          <h2>Good news in the mix</h2>
          <div className="panel">
            {status.events.map((e) => (
              <div className="list-item" key={e.id}>
                <div className="grow"><strong>{e.headline}</strong>{e.summary ? <span className="muted"> — {e.summary}</span> : null}</div>
                <span className="tag">{e.source}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
