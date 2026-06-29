// Self-signed TLS cert for the device's forced-HTTPS connection.
// The Poem/1 builds https://<hostname>/api/v1/clock, so we need to answer over
// TLS. Many simple devices don't validate the cert, so a self-signed one
// (regenerated to include the current LAN IPs as SANs) is worth a try before
// reaching for a trusted-cert setup (Tailscale/Caddy/Cloudflare).
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { DATA_DIR } from './config.js';
import { lanIPv4s } from './net.js';

const CERT_PATH = path.join(DATA_DIR, 'device-cert.pem');
const KEY_PATH = path.join(DATA_DIR, 'device-key.pem');
const SANS_PATH = path.join(DATA_DIR, 'device-cert.sans');

export function ensureSelfSignedCert() {
  const ips = lanIPv4s();
  const sansKey = ips.join(',');

  // Regenerate if missing or if the machine's IPs changed.
  let reuse = false;
  try {
    if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
      reuse = fs.readFileSync(SANS_PATH, 'utf8').trim() === sansKey;
    }
  } catch {}

  if (reuse) {
    return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) };
  }

  const altNames = [
    { type: 2, value: 'home1.local' }, // DNS
    { type: 2, value: 'localhost' },
    ...ips.map((ip) => ({ type: 7, ip })), // IP SANs
    { type: 7, ip: '127.0.0.1' },
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'home1.local' }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.writeFileSync(KEY_PATH, pems.private, { mode: 0o600 });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(SANS_PATH, sansKey);
  return { key: pems.private, cert: pems.cert };
}
