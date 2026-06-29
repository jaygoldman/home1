import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Notes() {
  const [notes, setNotes] = useState([]);
  const [body, setBody] = useState('');
  const [ttl, setTtl] = useState(30);
  const [err, setErr] = useState('');

  async function load() {
    try { setNotes(await api.get('/notes')); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function post() {
    if (!body.trim()) return;
    setErr('');
    try {
      await api.post('/notes', { body, ttlMinutes: Number(ttl) });
      setBody('');
      load();
    } catch (e) { setErr(e.message); }
  }
  async function remove(noteId) {
    await api.del(`/notes/${noteId}`);
    load();
  }

  const isLive = (n) => n.active && new Date(n.expires_at) > new Date();

  return (
    <div>
      <h1>Notes</h1>
      <p className="sub">Leave a little message on the clock. It shows on the device until it expires.</p>
      {err && <p className="error">{err}</p>}

      <div className="panel">
        <label>Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Welcome home, Sophie!" />
        <div className="row" style={{ marginTop: 10, alignItems: 'end' }}>
          <div style={{ maxWidth: 180 }}>
            <label>Show for (minutes)</label>
            <input type="number" min="1" value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </div>
          <div style={{ flex: 'none' }}><button onClick={post}>Post to clock</button></div>
        </div>
      </div>

      <div className="panel">
        {notes.length === 0 && <p className="muted">No notes yet.</p>}
        {notes.map((n) => (
          <div className="list-item" key={n.note_id}>
            <div className="grow">
              {n.body}
              <div className="muted" style={{ fontSize: 12 }}>
                posted {new Date(n.posted).toLocaleString()} · expires {new Date(n.expires_at).toLocaleTimeString()}
              </div>
            </div>
            {isLive(n) ? <span className="tag pet">live</span> : <span className="tag">expired</span>}
            {n.seen ? <span className="tag">seen</span> : null}
            <button className="small danger" onClick={() => remove(n.note_id)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
