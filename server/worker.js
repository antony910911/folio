// Folio 的同步伺服器（Cloudflare Worker + 一個 Durable Object）。
// - App 本身的檔案由 Workers 靜態資源直接提供，免費不限次數。
// - /api/* 交給 Library 這個 Durable Object：所有紀錄存在它的 SQLite 裡，圖片也是（切成小塊）。
// - 裝置之間用 WebSocket 互相通知「有新資料」，收到通知的裝置再來拿。
// 存取要帶同步密碼（SYNC_TOKEN，在 Cloudflare 後台設成 Secret）。

import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1_000_000; // 每塊圖片 1 MB（SQLite 單列上限 2 MB）
const MAX_ASSET = 25_000_000;
const PAGE = 500; // 一次最多回傳幾筆紀錄

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    // 在後台貼上密碼時常會多帶空白或換行，前後的空白不算
    const token = (env.SYNC_TOKEN || '').trim();
    if (!token) return json(request, { error: 'not_configured' }, 503);
    if (!(await authorized(request, token))) return json(request, { error: 'unauthorized' }, 401);
    const stub = env.LIBRARY.getByName('main');
    const res = await stub.fetch(request);
    if (res.webSocket) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
    return out;
  },
};

// 一般請求用 Authorization: Bearer；瀏覽器的 WebSocket 不能自訂標頭，改放在子協定裡
async function authorized(request, token) {
  let given = '';
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) given = auth.slice(7);
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  const p = protocols.find((s) => s.startsWith('token.'));
  if (!given && p) given = p.slice(6);
  given = decodeToken(given);
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, token].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// App 會把密碼編碼成 b64.<base64url>，這樣密碼可以有符號、中文（HTTP 標頭和 WebSocket 子協定只收部分字元）。
// 沒有 b64. 開頭的照原樣比對（Beamup 和舊版 App）。
function decodeToken(s) {
  s = (s || '').trim();
  if (!s.startsWith('b64.')) return s;
  try {
    const b64 = s.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))).trim();
  } catch {
    return '';
  }
}

function cors(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Folio-Device',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(request) } });
}

export class Library extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY,
        rev TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        data TEXT,
        seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_seq ON records (seq);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT NOT NULL,
        part INTEGER NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (id, part)
      );
    `);
    this.seq = this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM records').one().s;
    // 裝置每隔一陣子送 ping 保持連線；自動回 pong，不用叫醒 Durable Object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/ws') return this.connect(request);
      if (path === '/api/status' && request.method === 'GET') return this.status(request);
      if (path === '/api/changes' && request.method === 'GET') return this.pull(request, url);
      if (path === '/api/changes' && request.method === 'POST') return this.push(request);
      if (path === '/api/assets/check' && request.method === 'POST') return this.checkAssets(request);
      const m = path.match(/^\/api\/assets\/([\w-]{1,80})$/);
      if (m && request.method === 'PUT') return this.putAsset(request, m[1]);
      if (m && request.method === 'GET') return this.getAsset(request, m[1]);
      return json(request, { error: 'not_found' }, 404);
    } catch (e) {
      return json(request, { error: 'server_error', message: String(e && e.message || e) }, 500);
    }
  }

  status(request) {
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM records').one().n;
    const bytes = this.ctx.storage.sql.databaseSize;
    return json(request, { seq: this.seq, records: n, bytes });
  }

  pull(request, url) {
    const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
    const rows = this.sql.exec('SELECT key, rev, deleted, data, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?', since, PAGE + 1).toArray();
    const more = rows.length > PAGE;
    const records = rows.slice(0, PAGE).map((r) => ({ key: r.key, rev: r.rev, deleted: r.deleted, data: r.data == null ? null : JSON.parse(r.data), seq: r.seq }));
    return json(request, { records, seq: records.length ? records[records.length - 1].seq : this.seq, latest: this.seq, more });
  }

  async push(request) {
    const body = await request.json();
    const list = Array.isArray(body.records) ? body.records : [];
    let accepted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const r of list) {
        if (!r || typeof r.key !== 'string' || typeof r.rev !== 'string' || r.key.length > 300 || r.rev.length > 80) continue;
        const cur = this.sql.exec('SELECT rev FROM records WHERE key = ?', r.key).toArray()[0];
        if (cur && cur.rev >= r.rev) continue; // 伺服器上的比較新（或一樣），不收
        this.seq += 1;
        const data = r.deleted ? null : JSON.stringify(r.data ?? null);
        this.sql.exec(
          'INSERT INTO records (key, rev, deleted, data, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev, deleted = excluded.deleted, data = excluded.data, seq = excluded.seq',
          r.key, r.rev, r.deleted ? 1 : 0, data, this.seq,
        );
        accepted += 1;
      }
    });
    if (accepted) this.notify(request.headers.get('X-Folio-Device'));
    return json(request, { accepted, seq: this.seq });
  }

  checkAssets(request) {
    return request.json().then((body) => {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string').slice(0, 500);
      const have = new Set();
      for (const id of ids) {
        if (this.sql.exec('SELECT 1 FROM assets WHERE id = ? AND part = 0', id).toArray().length) have.add(id);
      }
      return json(request, { missing: ids.filter((id) => !have.has(id)) });
    });
  }

  async putAsset(request, id) {
    if (this.sql.exec('SELECT 1 FROM assets WHERE id = ? AND part = 0', id).toArray().length) return json(request, { ok: true, existed: true });
    const type = (request.headers.get('Content-Type') || 'application/octet-stream').slice(0, 100);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return json(request, { error: 'bad_type' }, 415);
    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.length || buf.length > MAX_ASSET) return json(request, { error: 'bad_size' }, 413);
    this.ctx.storage.transactionSync(() => {
      for (let part = 0, off = 0; off < buf.length; part++, off += CHUNK) {
        this.sql.exec('INSERT INTO assets (id, part, type, size, data) VALUES (?, ?, ?, ?, ?)', id, part, type, buf.length, buf.subarray(off, off + CHUNK));
      }
    });
    return json(request, { ok: true });
  }

  getAsset(request, id) {
    const rows = this.sql.exec('SELECT type, size, data FROM assets WHERE id = ? ORDER BY part', id).toArray();
    if (!rows.length) return json(request, { error: 'not_found' }, 404);
    const out = new Uint8Array(rows[0].size);
    let off = 0;
    for (const r of rows) {
      const chunk = new Uint8Array(r.data);
      out.set(chunk, off);
      off += chunk.length;
    }
    return new Response(out, { headers: { 'Content-Type': rows[0].type, 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }

  connect(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return json(request, { error: 'expected_websocket' }, 426);
    const url = new URL(request.url);
    const device = (url.searchParams.get('device') || 'unknown').slice(0, 64);
    const pair = new WebSocketPair();
    // 用休眠 API：沒有訊息時 Durable Object 可以休眠，不算執行時間
    this.ctx.acceptWebSocket(pair[1], [device]);
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'folio' } });
  }

  // 告訴其他裝置有新資料；送出變更的那台不用通知
  notify(fromDevice) {
    const msg = JSON.stringify({ type: 'changed', seq: this.seq });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (fromDevice && this.ctx.getTags(ws).includes(fromDevice)) continue;
        ws.send(msg);
      } catch { /* 已經斷線的就算了 */ }
    }
  }

  webSocketMessage() {
    // 裝置不會送 ping 以外的訊息（ping 已經自動回覆）
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* 已經關了 */ }
  }
}
