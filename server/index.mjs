import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(root, 'data');
const dataFile = join(dataDir, 'inventory.json');
const distDir = join(root, 'dist');
const port = Number(process.env.PORT || 4179);
const host = process.env.HOST || '127.0.0.1';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const emptyState = () => ({ products: [], events: [], pendingScans: [] });
await mkdir(dataDir, { recursive: true });
if (!existsSync(dataFile)) await writeFile(dataFile, JSON.stringify(emptyState(), null, 2));

async function loadState() {
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch { return emptyState(); }
}
let writeQueue = Promise.resolve();
function updateState(fn) {
  const job = writeQueue.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    const nextFile = `${dataFile}.tmp`;
    await writeFile(nextFile, JSON.stringify(state, null, 2));
    await rename(nextFile, dataFile);
    return result;
  });
  writeQueue = job.catch(() => {});
  return job;
}
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length > 100_000) throw new Error('Request too large');
  return raw ? JSON.parse(raw) : {};
}
function normalizeCode(code) { return String(code || '').replace(/\s/g, ''); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await loadState());

    if (url.pathname === '/api/products' && req.method === 'POST') {
      const input = await body(req);
      const barcode = normalizeCode(input.barcode);
      if (!input.name?.trim()) return json(res, 400, { error: 'Product name is required.' });
      const product = await updateState(state => {
        const existing = barcode && state.products.find(item => item.barcode === barcode);
        if (existing) {
          existing.name = input.name.trim();
          existing.brand = (input.brand || '').trim();
          existing.category = input.category || existing.category || 'Other';
          existing.location = input.location || existing.location || 'Pantry';
          existing.unit = input.unit || existing.unit || 'item';
          existing.updatedAt = new Date().toISOString();
          return existing;
        }
        const created = {
          id: randomUUID(), barcode,
          name: input.name.trim(), brand: (input.brand || '').trim(),
          category: input.category || 'Other', location: input.location || 'Pantry',
          unit: input.unit || 'item', quantity: Math.max(0, Number(input.quantity || 0)),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        state.products.unshift(created);
        if (created.quantity > 0) state.events.unshift({ id: randomUUID(), productId: created.id, barcode, productName: created.name, delta: created.quantity, source: 'setup', at: created.createdAt });
        state.pendingScans = state.pendingScans.filter(scan => scan.barcode !== barcode);
        return created;
      });
      return json(res, 201, { product });
    }

    if (url.pathname === '/api/scans' && req.method === 'POST') {
      const input = await body(req);
      const barcode = normalizeCode(input.barcode);
      if (!barcode) return json(res, 400, { error: 'Barcode is required.' });
      const result = await updateState(state => {
        const product = state.products.find(item => item.barcode === barcode);
        if (!product) {
          let pending = state.pendingScans.find(scan => scan.barcode === barcode);
          if (!pending) {
            pending = { id: randomUUID(), barcode, count: 0, delta: 0, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
            state.pendingScans.unshift(pending);
          }
          pending.count += 1;
          pending.delta = Number(pending.delta || 0) + (input.action === 'remove' ? -1 : 1);
          pending.lastSeenAt = new Date().toISOString();
          return { status: 'needs_product', pending };
        }
        const delta = input.action === 'remove' ? -Math.max(1, Number(input.quantity || 1)) : Math.max(1, Number(input.quantity || 1));
        const before = product.quantity;
        product.quantity = Math.max(0, before + delta);
        const appliedDelta = product.quantity - before;
        product.updatedAt = new Date().toISOString();
        const event = { id: randomUUID(), productId: product.id, barcode, productName: product.name, delta: appliedDelta, source: input.source || 'scanner', at: product.updatedAt };
        state.events.unshift(event);
        return { status: 'recorded', product, event };
      });
      return json(res, 200, result);
    }

    if (url.pathname === '/api/stock' && req.method === 'POST') {
      const input = await body(req);
      const result = await updateState(state => {
        const product = state.products.find(item => item.id === input.productId);
        if (!product) return null;
        const requested = Math.trunc(Number(input.delta));
        const before = product.quantity;
        product.quantity = Math.max(0, before + requested);
        const applied = product.quantity - before;
        product.updatedAt = new Date().toISOString();
        const event = { id: randomUUID(), productId: product.id, barcode: product.barcode, productName: product.name, delta: applied, source: 'app', at: product.updatedAt };
        state.events.unshift(event);
        return { product, event };
      });
      if (!result) return json(res, 404, { error: 'Product not found.' });
      return json(res, 200, result);
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
    if (existsSync(join(distDir, 'index.html'))) {
      const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
      const candidate = join(distDir, requested || 'index.html');
      const filePath = existsSync(candidate) ? candidate : join(distDir, 'index.html');
      const content = await readFile(filePath);
      res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream' });
      return res.end(content);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Food Inventory API is running. Start the Vite app with npm run dev.');
  } catch (error) {
    json(res, 400, { error: error.message || 'Request failed.' });
  }
});
server.listen(port, host, () => console.log(`Inventory server listening on http://${host}:${port}`));
