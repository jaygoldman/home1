// Simple username/password auth backed by the users table + session cookie.
import bcrypt from 'bcryptjs';
import { db } from './db.js';

export function userCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
}

export function createUser(username, password) {
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`).run(username, hash);
}

export function verifyUser(username, password) {
  const row = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  if (!row) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  return { id: row.id, username: row.username };
}

export function setPassword(username, password) {
  const hash = bcrypt.hashSync(password, 12);
  const res = db.prepare(`UPDATE users SET password_hash = ? WHERE username = ?`).run(hash, username);
  return res.changes > 0;
}

// Express middleware: require a logged-in session for admin API routes.
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'not authenticated' });
}
