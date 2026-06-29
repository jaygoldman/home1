import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin, needsSetup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.post('/login', { username, password });
      onLogin();
    } catch (e) {
      setErr(e.status === 401 ? 'Invalid username or password.' : e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand brand-lg" style={{ marginBottom: 14 }}>
          <div className="brand-mark">
            <img className="brand-logo" src="/home1-icon.svg" alt="" />
            <span className="wordmark">Home/1</span>
          </div>
        </div>
        <p className="sub">Sign in to configure your clock.</p>
        {needsSetup && (
          <p className="muted" style={{ fontSize: 13 }}>
            No account yet — run <code>npm run setup</code> on the server to create one.
          </p>
        )}
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="error">{err}</p>}
        <div style={{ marginTop: 16 }}>
          <button disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}
