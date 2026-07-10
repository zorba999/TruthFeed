// Minimal static server for the TruthFeed frontend.
// Serves web/ and injects /config.json (contract address + RPC) from .env.
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');

function address() {
  if (process.env.TRUTHFEED_ADDRESS) return process.env.TRUTHFEED_ADDRESS;
  const p = path.join(root, 'build', 'address.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).address;
  return '0x0000000000000000000000000000000000000000';
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PORT = Number(process.env.PORT || 8787);

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      address: address(),
      rpc: process.env.RITUAL_RPC_URL || 'https://rpc.ritualfoundation.org',
      chainId: Number(process.env.CHAIN_ID || 1979),
    }));
    return;
  }
  const file = path.join(webDir, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  if (!file.startsWith(webDir) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`TruthFeed frontend: http://localhost:${PORT}`);
  console.log('Contract:', address());
});
