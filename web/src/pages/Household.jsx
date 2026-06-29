import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const CATEGORIES = [
  { key: 'city', label: 'City' },
  { key: 'team', label: 'Sports team' },
  { key: 'tradition', label: 'Tradition' },
  { key: 'fact', label: 'Fact' },
  { key: 'other', label: 'Other' },
];

export default function Household() {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ category: 'team', label: '', value: '', active: true });
  const [err, setErr] = useState('');

  async function load() {
    try { setItems(await api.get('/context')); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!draft.value.trim()) return;
    setErr('');
    try {
      await api.post('/context', draft);
      setDraft({ category: draft.category, label: '', value: '', active: true });
      load();
    } catch (e) { setErr(e.message); }
  }
  async function toggle(it) {
    await api.put(`/context/${it.id}`, { ...it, active: !it.active });
    load();
  }
  async function remove(id) {
    await api.del(`/context/${id}`);
    load();
  }

  const byCat = (cat) => items.filter((i) => i.category === cat);

  return (
    <div>
      <h1>Household</h1>
      <p className="sub">The things that make the poems ours — your city, teams, traditions, and the small facts.</p>
      {err && <p className="error">{err}</p>}

      <div className="panel">
        <div className="row">
          <div style={{ maxWidth: 160 }}>
            <label>Category</label>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div style={{ maxWidth: 180 }}>
            <label>Label (optional)</label>
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. favourite park" />
          </div>
          <div>
            <label>Value</label>
            <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              placeholder="Toronto Blue Jays" onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}><button onClick={add}>+ Add</button></div>
        {draft.category === 'city' && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Tip: the first active City is used to fetch local weather.
          </p>
        )}
      </div>

      {CATEGORIES.map((c) => {
        const list = byCat(c.key);
        if (!list.length) return null;
        return (
          <div key={c.key}>
            <h2>{c.label}</h2>
            <div className="panel">
              {list.map((it) => (
                <div className="list-item" key={it.id}>
                  <div className="grow">
                    {it.label && <span className="muted">{it.label}: </span>}
                    <strong>{it.value}</strong> {!it.active && <span className="tag">off</span>}
                  </div>
                  <button className="small secondary" onClick={() => toggle(it)}>{it.active ? 'Disable' : 'Enable'}</button>
                  <button className="small danger" onClick={() => remove(it.id)}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
