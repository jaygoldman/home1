import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Devices() {
  const [devices, setDevices] = useState([]);
  const [err, setErr] = useState('');
  const [forgetting, setForgetting] = useState(null); // device pending confirmation

  async function load() {
    try {
      setDevices(await api.get('/devices'));
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => { load(); }, []);

  async function claim(screenId, claimed) {
    await api.post(`/devices/${screenId}/claim`, { claimed });
    load();
  }

  async function forget() {
    if (!forgetting) return;
    try {
      await api.del(`/devices/${forgetting.screen_id}`);
      setForgetting(null);
      load();
    } catch (e) { setErr(e.message); }
  }

  return (
    <div>
      <h1>Devices</h1>
      <p className="sub">Poem/1 clocks that have checked in with this server.</p>
      {err && <p className="error">{err}</p>}

      <div className="panel">
        {devices.length === 0 && <p className="muted">No device has checked in yet. Point your Poem/1 at this server.</p>}
        {devices.map((d) => (
          <div className="list-item" key={d.screen_id}>
            <div className="grow">
              <strong>{d.screen_id}</strong>{' '}
              <span className="muted">· seen {d.seen}× · last {d.last_seen ? new Date(d.last_seen).toLocaleString() : '—'}</span>
            </div>
            <span className={`tag ${d.is_claimed ? 'pet' : ''}`}>{d.is_claimed ? 'claimed' : 'unclaimed'}</span>
            <button className="small secondary" onClick={() => claim(d.screen_id, !d.is_claimed)}>
              {d.is_claimed ? 'Unclaim' : 'Claim'}
            </button>
            <button className="small danger" onClick={() => setForgetting(d)}>
              Forget
            </button>
          </div>
        ))}
      </div>

      {forgetting && (
        <div className="modal-backdrop" onClick={() => setForgetting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Forget this device?</h2>
            <p>
              <strong>{forgetting.screen_id}</strong> will be removed from the list. If the clock
              checks in again, it will reappear as unclaimed.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setForgetting(null)}>Cancel</button>
              <button className="danger" onClick={forget}>Forget device</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
