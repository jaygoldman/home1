import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import People from './pages/People.jsx';
import Household from './pages/Household.jsx';
import Notes from './pages/Notes.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined=loading
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  async function refresh() {
    try {
      const s = await api.get('/session');
      setSession(s);
    } catch {
      setSession({ user: null });
    }
  }
  useEffect(() => { refresh(); }, []);

  async function logout() {
    await api.post('/logout');
    setSession({ user: null });
    navigate('/login');
  }

  if (session === undefined) return <div className="login-wrap spin">Loading…</div>;

  if (!session.user) {
    return (
      <Routes>
        <Route path="*" element={<Login onLogin={refresh} needsSetup={session.needsSetup} />} />
      </Routes>
    );
  }

  return (
    <div className="app">
      <nav className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-mark">
              <img className="brand-logo" src="/home1-logo.svg" alt="" />
              <span className="wordmark">Home/1</span>
            </div>
            <span className="tagline">poem clock</span>
          </div>
          <button
            className="nav-toggle"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
        <div className="sidebar-menu">
          <div className="nav" onClick={() => setMenuOpen(false)}>
            <NavLink to="/" end>Dashboard</NavLink>
            <NavLink to="/people">People &amp; Pets</NavLink>
            <NavLink to="/household">Household</NavLink>
            <NavLink to="/notes">Notes</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            <a className="ext" href="/sim" target="_blank" rel="noreferrer">Shelf preview ↗</a>
          </div>
          <div className="logout">
            <button className="secondary small" onClick={logout}>Log out</button>
          </div>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/people" element={<People />} />
          <Route path="/household" element={<Household />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
