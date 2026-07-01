import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const BLANK = { name: '', kind: 'person', relationship: '', traits: '', interests: '', birthday: '', notes: '', active: true };

export default function People() {
  const [people, setPeople] = useState([]);
  const [editing, setEditing] = useState(null); // object or null
  const [err, setErr] = useState('');
  const [regenId, setRegenId] = useState(null); // person whose word bank is regenerating

  async function load() {
    try { setPeople(await api.get('/people')); } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setErr('');
    try {
      if (editing.id) await api.put(`/people/${editing.id}`, editing);
      else await api.post('/people', editing);
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); }
  }
  async function remove(id) {
    if (!confirm('Remove this person?')) return;
    await api.del(`/people/${id}`);
    load();
  }
  // Force-regenerate the derived word bank (alternate words/imagery the poet can
  // reach for, so the same person reads differently minute to minute).
  async function regen(id) {
    setErr('');
    setRegenId(id);
    try { await api.post(`/people/${id}/vocab`); load(); }
    catch (e) { setErr(e.message); }
    finally { setRegenId(null); }
  }

  const f = editing || {};
  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div>
      <h1>People &amp; Pets</h1>
      <p className="sub">Who the clock knows. The more specific the traits, the more "ours" the poems feel.</p>
      {err && <p className="error">{err}</p>}

      {!editing && <button onClick={() => setEditing({ ...BLANK })}>+ Add someone</button>}

      {editing && (
        <div className="panel">
          <div className="row">
            <div>
              <label>Name</label>
              <input value={f.name} onChange={set('name')} autoFocus />
            </div>
            <div style={{ maxWidth: 140 }}>
              <label>Kind</label>
              <select value={f.kind} onChange={set('kind')}>
                <option value="person">Person</option>
                <option value="pet">Pet</option>
              </select>
            </div>
            <div>
              <label>Relationship</label>
              <input value={f.relationship} onChange={set('relationship')} placeholder="dad, daughter, grandmother…" />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Traits</label>
              <input value={f.traits} onChange={set('traits')} placeholder="curious, gentle, loud laugh" />
            </div>
            <div>
              <label>Interests / loves</label>
              <input value={f.interests} onChange={set('interests')} placeholder="soccer, baking, sunbeams" />
            </div>
            <div style={{ maxWidth: 160 }}>
              <label>Birthday (MM-DD)</label>
              <input value={f.birthday} onChange={set('birthday')} placeholder="08-14" />
            </div>
          </div>
          <label>Notes</label>
          <textarea value={f.notes} onChange={set('notes')} placeholder="anything that makes a poem feel like them" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!f.active} onChange={set('active')} /> Active (include in poems)
          </label>
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <button onClick={save}>Save</button>
            <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="panel">
        {people.length === 0 && <p className="muted">No one yet.</p>}
        {people.map((p) => (
          <div className="list-item" key={p.id}>
            <div className="grow">
              <strong>{p.name}</strong>{' '}
              <span className={`tag ${p.kind === 'pet' ? 'pet' : ''}`}>{p.kind}</span>{' '}
              {!p.active && <span className="tag">inactive</span>}
              <div className="muted" style={{ fontSize: 13 }}>
                {[p.relationship, p.traits, p.interests].filter(Boolean).join(' · ')}
              </div>
              <details style={{ fontSize: 13, marginTop: 4 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Word palette {regenId === p.id ? '(regenerating…)' : ''}
                </summary>
                <div className="muted" style={{ marginTop: 4 }}>
                  {p.word_bank
                    ? p.word_bank
                    : 'Derived automatically from traits/interests/notes when you save. None yet.'}
                </div>
                <button
                  className="small secondary"
                  style={{ marginTop: 6 }}
                  disabled={regenId === p.id}
                  onClick={() => regen(p.id)}
                >
                  {regenId === p.id ? 'Regenerating…' : 'Regenerate'}
                </button>
              </details>
            </div>
            <button className="small secondary" onClick={() => setEditing({ ...p, active: !!p.active })}>Edit</button>
            <button className="small danger" onClick={() => remove(p.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
