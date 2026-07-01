import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Each category is its own section with an inline add-row at the bottom, so the
// form for a City makes sense next to Cities (and Traditions get a Holiday
// column that other categories don't). `ph` is the Value placeholder.
const CATEGORIES = [
  { key: 'city', label: 'City', ph: 'Toronto' },
  { key: 'team', label: 'Sports team', ph: 'Toronto Blue Jays' },
  { key: 'tradition', label: 'Tradition', ph: 'Sunday pancakes' },
  { key: 'fact', label: 'Fact', ph: 'We love hiking the Bruce Trail' },
  { key: 'other', label: 'Other', ph: 'Anything else worth a mention' },
];

const BLANK = { label: '', value: '', holiday: '' };

export default function Household() {
  const [items, setItems] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [drafts, setDrafts] = useState({}); // per-category add-row draft, keyed by category
  const [editing, setEditing] = useState(null); // an item draft while inline-editing, or null
  const [err, setErr] = useState('');

  async function load() {
    try { setItems(await api.get('/context')); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/holidays').then(setHolidays).catch(() => {}); }, []);

  const holidayName = (code) => holidays.find((h) => h.code === code)?.name || code;
  const draftFor = (cat) => drafts[cat] || BLANK;
  const setDraft = (cat, patch) => setDrafts((d) => ({ ...d, [cat]: { ...draftFor(cat), ...patch } }));

  async function add(cat) {
    const d = draftFor(cat);
    if (!d.value.trim()) return;
    setErr('');
    try {
      await api.post('/context', {
        category: cat,
        label: d.label,
        value: d.value,
        holiday: cat === 'tradition' ? d.holiday : '',
        active: true,
      });
      setDrafts((s) => ({ ...s, [cat]: { ...BLANK } }));
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
  function startEdit(it) {
    setErr('');
    setEditing({ ...it, holiday: it.holiday || '', active: !!it.active });
  }
  async function saveEdit() {
    if (!editing.value.trim()) return;
    setErr('');
    try {
      await api.put(`/context/${editing.id}`, editing);
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); }
  }

  const byCat = (cat) => items.filter((i) => i.category === cat);

  // The Holiday cell keeps a fixed width so the tradition rows read as a column.
  const holidayCell = (child) => <div style={{ width: 180, flexShrink: 0 }}>{child}</div>;

  return (
    <div>
      <h1>Household</h1>
      <p className="sub">The things that make the poems ours — your city, teams, traditions, and the small facts.</p>
      {err && <p className="error">{err}</p>}

      {CATEGORIES.map((c) => {
        const list = byCat(c.key);
        const isTrad = c.key === 'tradition';
        const d = draftFor(c.key);
        return (
          <div key={c.key}>
            <h2>{c.label}</h2>
            <div className="panel">
              {isTrad && list.length > 0 && (
                <div className="list-item muted" style={{ fontSize: 12, paddingBottom: 6 }}>
                  <div className="grow">Tradition</div>
                  {holidayCell('Holiday')}
                </div>
              )}

              {list.map((it) => (
                editing && editing.id === it.id ? (
                  <div className="list-item" key={it.id}>
                    <input className="grow" value={editing.value}
                      onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit()} />
                    {isTrad && holidayCell(
                      <select value={editing.holiday} style={{ width: '100%' }}
                        onChange={(e) => setEditing({ ...editing, holiday: e.target.value })}>
                        <option value="">Year-round</option>
                        {holidays.map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}
                      </select>
                    )}
                    <button className="small" onClick={saveEdit}>Save</button>
                    <button className="small secondary" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="list-item" key={it.id}>
                    <div className="grow">
                      {it.label && <span className="muted">{it.label}: </span>}
                      <strong>{it.value}</strong>
                      {!it.active && <span className="tag">off</span>}
                    </div>
                    {isTrad && holidayCell(
                      it.holiday
                        ? <span className="tag">{holidayName(it.holiday)}</span>
                        : <span className="muted">Year-round</span>
                    )}
                    <button className="small secondary" onClick={() => startEdit(it)}>Edit</button>
                    <button className="small secondary" onClick={() => toggle(it)}>{it.active ? 'Disable' : 'Enable'}</button>
                    <button className="small danger" onClick={() => remove(it.id)}>Delete</button>
                  </div>
                )
              ))}

              {/* Add-row: always at the bottom of the section (the only "add" when empty). */}
              <div className="list-item">
                <input value={d.label} placeholder="Label (optional)" style={{ width: 150, flexShrink: 0 }}
                  onChange={(e) => setDraft(c.key, { label: e.target.value })} />
                <input className="grow" value={d.value} placeholder={c.ph}
                  onChange={(e) => setDraft(c.key, { value: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && add(c.key)} />
                {isTrad && holidayCell(
                  <select value={d.holiday} style={{ width: '100%' }}
                    onChange={(e) => setDraft(c.key, { holiday: e.target.value })}>
                    <option value="">Year-round</option>
                    {holidays.map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}
                  </select>
                )}
                <button className="small" onClick={() => add(c.key)}>+ Add</button>
              </div>
            </div>

            {c.key === 'city' && (
              <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 16 }}>
                Tip: the first active City is used to fetch local weather.
              </p>
            )}
            {isTrad && (
              <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 16 }}>
                Tip: tag a tradition with a holiday and it only appears in the poems around that time of year.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
