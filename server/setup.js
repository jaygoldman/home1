// Interactive first-run setup: create the admin user and optionally seed
// the family/household context. Run with `npm run setup`.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from './db.js';
import { userCount, createUser, setPassword } from './auth.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(q, def = '') {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
}

async function askHidden(q) {
  // Minimal hidden (no-echo) input.
  return new Promise((resolve) => {
    stdout.write(`${q}: `);
    let buf = '';
    const onData = (data) => {
      const str = data.toString('utf8');
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          return resolve(buf);
        } else if (code === 3) {
          process.exit(1); // Ctrl-C
        } else if (code === 127 || code === 8) {
          buf = buf.slice(0, -1); // backspace
        } else if (code >= 32) {
          buf += ch;
        }
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('\n=== poem1-server setup ===\n');

  if (userCount() === 0) {
    const username = await ask('Admin username', 'jay');
    let pw = '';
    while (pw.length < 6) {
      pw = await askHidden('Admin password (min 6 chars)');
      if (pw.length < 6) console.log('  too short, try again');
    }
    createUser(username, pw);
    console.log(`Created admin user "${username}".`);
  } else {
    console.log('An admin user already exists.');
    const reset = (await ask('Reset its password? (y/N)', 'n')).toLowerCase();
    if (reset === 'y') {
      const username = await ask('Username to reset');
      const pw = await askHidden('New password');
      console.log(setPassword(username, pw) ? 'Password updated.' : 'User not found.');
    }
  }

  const seed = (await ask('\nSeed starter household context (city + teams)? (y/N)', 'n')).toLowerCase();
  if (seed === 'y') {
    const city = await ask('Your city', 'Toronto');
    const ctx = db.prepare(`INSERT INTO context_items (category, label, value, active) VALUES (?, ?, ?, 1)`);
    ctx.run('city', 'City', city);
    const teams = (await ask('Sports teams (comma separated)', 'Toronto Blue Jays, Toronto Maple Leafs'))
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of teams) ctx.run('team', 'Team', t);
    db.prepare(`UPDATE settings SET weather_place = ? WHERE id = 1`).run(city);
    console.log('Seeded city + teams. Add people and more in the web app.');
  }

  console.log('\nDone. Start the server with `npm start`.\n');
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
