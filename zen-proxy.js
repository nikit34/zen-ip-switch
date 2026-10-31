#!/usr/bin/env node
const http = require('http');
const net = require('net');
const dns = require('dns');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.ZEN_PROXY_PORT || '9999', 10);
const IFACE = process.env.ZEN_IFACE || 'en0';
const PREFIX = process.env.ZEN_IPV6_PREFIX;
const TARGETS = (process.env.ZEN_PROXY_TARGETS || 'opencode.ai').split(',');
const DAD_MS = parseInt(process.env.ZEN_PROXY_DAD_MS || '2000', 10);
const GRACE_MS = parseInt(process.env.ZEN_PROXY_GRACE_MS || '30000', 10);

if (!PREFIX) {
  console.error('ZEN_IPV6_PREFIX must be set');
  process.exit(2);
}

let currentIp = null;
let oldIps = [];
let rotating = false;

function randomSuffix() {
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push(Math.floor(Math.random() * 65536).toString(16).padStart(4, '0'));
  return parts.join(':');
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err)));
}

async function rotateIp() {
  if (rotating) return;
  rotating = true;
  try {
    const newIp = `${PREFIX}:${randomSuffix()}`;
    const ok = await run('/usr/bin/sudo', ['-n', '/sbin/ifconfig', IFACE, 'inet6', newIp, 'prefixlen', '64', 'alias']);
    if (!ok) { console.error(`[rotate] alias ${newIp} failed`); return; }
    await new Promise(r => setTimeout(r, DAD_MS));
    const prev = currentIp;
    currentIp = newIp;
    console.log(`[rotate] source -> ${newIp}`);
    if (prev) oldIps.push({ ip: prev, ts: Date.now() });
  } finally {
    rotating = false;
  }
  cleanupOldIps();
}

async function cleanupOldIps() {
  const now = Date.now();
  const keep = [];
  for (const e of oldIps) {
    if (now - e.ts > GRACE_MS) {
      await run('/usr/bin/sudo', ['-n', '/sbin/ifconfig', IFACE, 'inet6', e.ip, 'delete']);
    } else keep.push(e);
  }
  oldIps = keep;
}
setInterval(() => cleanupOldIps().catch(() => {}), 10000);

process.on('SIGUSR1', () => { console.log('[sigusr1] rotation requested'); rotateIp().catch(e => console.error(e)); });

async function shutdown() {
  console.error('[proxy] shutting down, cleanup');
  if (currentIp) await run('/usr/bin/sudo', ['-n', '/sbin/ifconfig', IFACE, 'inet6', currentIp, 'delete']);
  for (const e of oldIps) await run('/usr/bin/sudo', ['-n', '/sbin/ifconfig', IFACE, 'inet6', e.ip, 'delete']);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const server = http.createServer();

server.on('connect', async (req, clientSocket, head) => {
  let host, portStr;
  if (req.url.startsWith('[')) {
    const m = req.url.match(/^\[([^\]]+)\]:(\d+)$/);
    host = m ? m[1] : req.url;
    portStr = m ? m[2] : '';
  } else {
    const idx = req.url.lastIndexOf(':');
    host = idx >= 0 ? req.url.slice(0, idx) : req.url;
    portStr = idx >= 0 ? req.url.slice(idx + 1) : '';
  }
  const port = parseInt(portStr, 10);
  const bind = TARGETS.some(t => host === t || host.endsWith('.' + t));
  let opts = { host, port };
  let via = 'passthru';
  if (bind) {
    if (!currentIp) await rotateIp();
    if (!currentIp) { clientSocket.end('HTTP/1.1 502 No Source\r\n\r\n'); return; }
    opts = { host, port, family: 6, localAddress: currentIp,
             lookup: (h, o, cb) => dns.lookup(h, { ...o, family: 6 }, cb) };
    via = `via ${currentIp}`;
  }
  const upstream = net.connect(opts);
  upstream.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    console.log(`[tunnel] ${host}:${port} ${via}`);
  });
  const close = () => { try { upstream.destroy(); } catch{} try { clientSocket.destroy(); } catch{} };
  upstream.on('error', (e) => { console.error(`[upstream] ${host} ${e.code}`); close(); });
  clientSocket.on('error', close);
  upstream.on('close', close);
  clientSocket.on('close', close);
});

server.on('request', (req, res) => { res.writeHead(400); res.end('CONNECT only'); });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening http://127.0.0.1:${PORT}, prefix ${PREFIX}::/64, targets ${TARGETS.join(',')}`);
  rotateIp().catch(e => console.error(e));
});
