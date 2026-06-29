import os from 'node:os';

// Private/LAN IPv4 addresses of this machine, best candidate first.
export function lanIPv4s() {
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) all.push({ name, address: a.address });
    }
  }
  const rank = (ip) => {
    if (/^100\./.test(ip)) return 3; // Tailscale CGNAT range — last resort for LAN device
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
    return 2;
  };
  return all
    .sort((x, y) => rank(x.address) - rank(y.address))
    .map((x) => x.address);
}

// The single best LAN address a device on the same Wi-Fi would use.
export function primaryLanIP() {
  return lanIPv4s()[0] || '127.0.0.1';
}
