// 跨裝置同步（App 這一側）。
// - 本機每次存檔，store 會呼叫這裡的 hook：和上次同步時的指紋比對，把變更放進 outbox。
// - 有網路時把 outbox 送到伺服器，再把別台裝置的變更拿回來套用。
// - WebSocket 收到「有新資料」就馬上拿；斷線會自己重連。沒網路時照常可以用，連上後再補。
// 規則在 syncmodel.js：每筆紀錄 rev 比較大的贏。

import * as store from './store.js';
import {
  createClock, keyFor, parseKey, fingerprint, entityFingerprint, diffItems, applyItemChanges,
  shouldApply, compareRev, batchRecords,
} from './syncmodel.js';

const CONFIG_KEY = 'folio.sync';
const STATE_KEY = 'folio.syncstate';
const ENTITY_KINDS = ['notebooks', 'sections', 'pages'];

let config = loadJson(CONFIG_KEY, { enabled: false, url: '', token: '' });
let state = loadJson(STATE_KEY, null);
if (!state || !state.device) state = { device: randomId(), seq: 0, clock: null };
const clock = createClock(state.device, state.clock);

let host = null; // App 給的回呼：beforeApply()、canApply()、afterApply(info)、status(s)
let running = false;
let rerun = false;
let pushTimer = null;
let ws = null;
let wsRetry = 2000;
let wsTimer = null;
let pingTimer = null;
let status = { state: config.enabled ? 'idle' : 'off', at: null, message: '' };

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不了就算了 */ }
}
function saveState() {
  state.clock = clock.state();
  saveJson(STATE_KEY, state);
}
function randomId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

export function getConfig() {
  return { ...config };
}

export function getStatus() {
  return { ...status };
}

function setStatus(s, message = '') {
  status = { state: s, at: s === 'idle' ? Date.now() : status.at, message };
  if (host && host.status) host.status(getStatus());
}

function apiBase() {
  const base = (config.url || '').trim().replace(/\/+$/, '');
  return (base || location.origin) + '/api';
}

// 密碼可能有符號或中文，HTTP 標頭放不下，所以編碼成 b64.<base64url>（伺服器會解回來）
export function encodeToken(token) {
  const bytes = new TextEncoder().encode((token || '').trim());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'b64.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      ...opts,
      headers: { Authorization: `Bearer ${encodeToken(config.token)}`, 'X-Folio-Device': state.device, ...(opts.headers || {}) },
    });
  } catch {
    throw Object.assign(new Error('offline'), { code: 'offline' });
  }
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  if (res.status === 503) throw Object.assign(new Error('not_configured'), { code: 'not_configured' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'server' });
  return res;
}

// ---------- 本機變更 → outbox ----------
const hook = {
  async put(data) {
    if (!config.enabled) return;
    const records = [];
    const metas = [];
    for (const kind of ENTITY_KINDS) {
      for (const x of data[kind] || []) {
        const key = keyFor[kind](x);
        const fp = entityFingerprint(x);
        const m = await store.meta.get(key);
        if (m && m.fp === fp && !m.deleted) continue;
        const rev = clock.next();
        records.push({ key, rev, deleted: 0, data: x });
        metas.push({ key, rev, fp, page: null });
      }
    }
    for (const c of data.contents || []) {
      const known = new Map();
      for (const m of await store.meta.byPage(c.id)) if (!m.deleted) known.set(parseKey(m.key).id, m.fp);
      const { upserts, deletes } = diffItems(c.items, known);
      for (const it of upserts) {
        const key = keyFor.item(c.id, it.id);
        const rev = clock.next();
        records.push({ key, rev, deleted: 0, data: it });
        metas.push({ key, rev, fp: fingerprint(it), page: c.id });
      }
      for (const id of deletes) {
        const key = keyFor.item(c.id, id);
        const rev = clock.next();
        records.push({ key, rev, deleted: 1, data: null });
        metas.push({ key, rev, fp: null, page: c.id, deleted: 1 });
      }
    }
    await queue(records, metas);
    // 匯入備份時圖片也一起寫進來
    for (const a of data.assets || []) await hook.asset(a);
  },
  async remove(ids) {
    if (!config.enabled) return;
    const records = [];
    const metas = [];
    for (const kind of ENTITY_KINDS) {
      for (const id of ids[kind] || []) {
        const key = keyFor[kind]({ id });
        const rev = clock.next();
        records.push({ key, rev, deleted: 1, data: null });
        metas.push({ key, rev, fp: null, page: null, deleted: 1 });
      }
    }
    // 刪掉的頁面，它的項目在本機也不必再記
    for (const pageId of ids.pages || []) {
      const items = await store.meta.byPage(pageId);
      if (items.length) await store.meta.deleteMany(items.map((m) => m.key));
    }
    await queue(records, metas);
  },
  async asset(a) {
    if (!config.enabled) return;
    const key = keyFor.asset(a.id);
    if (await store.meta.get(key)) return;
    const rev = clock.next();
    const info = { id: a.id, w: a.w, h: a.h, type: a.blob.type, size: a.blob.size };
    await store.outbox.putMany([{ key: 'blob:' + a.id, rev, blob: true }]);
    await queue([{ key, rev, deleted: 0, data: info }], [{ key, rev, fp: 'asset', page: null, data: info }]);
  },
};

async function queue(records, metas) {
  if (!records.length) return;
  await store.outbox.putMany(records);
  await store.meta.putMany(metas);
  saveState();
  schedulePush();
}

function schedulePush(delay = 1200) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), delay);
}

// ---------- 送出、拿回來 ----------
export async function syncNow() {
  if (!config.enabled) return;
  if (running) { rerun = true; return; }
  running = true;
  setStatus('syncing');
  try {
    do {
      rerun = false;
      await pushBlobs();
      await pushRecords();
      await pull();
    } while (rerun);
    setStatus('idle');
    prefetchAssets();
  } catch (e) {
    if (e.code === 'offline') setStatus('offline');
    else if (e.code === 'unauthorized') setStatus('unauthorized');
    else if (e.code === 'not_configured') setStatus('error', '伺服器還沒有設定同步密碼（SYNC_TOKEN）。');
    else if (e.code === 'busy') { setStatus('syncing'); setTimeout(syncNow, 1500); }
    else { console.error(e); setStatus('error', e.message || '同步失敗'); }
  } finally {
    running = false;
  }
}

async function pushBlobs() {
  const pending = (await store.outbox.all()).filter((r) => r.blob);
  if (!pending.length) return;
  const ids = pending.map((r) => r.key.slice(5));
  const { missing } = await (await api('/assets/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })).json();
  const need = new Set(missing);
  for (const r of pending) {
    const id = r.key.slice(5);
    if (need.has(id)) {
      const a = await store.getAsset(id);
      if (a) await api('/assets/' + id, { method: 'PUT', headers: { 'Content-Type': a.blob.type }, body: a.blob });
    }
    await store.outbox.ack([r]);
  }
}

async function pushRecords() {
  const pending = (await store.outbox.all()).filter((r) => !r.blob).sort((a, b) => compareRev(a.rev, b.rev));
  for (const batch of batchRecords(pending)) {
    await api('/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: batch }) });
    await store.outbox.ack(batch);
  }
}

async function pull() {
  for (;;) {
    const res = await (await api('/changes?since=' + state.seq)).json();
    if (res.records.length) await applyRemote(res.records);
    state.seq = res.seq;
    saveState();
    if (!res.more) break;
  }
}

async function applyRemote(records) {
  // 正在寫字、打字的那一頁有遠端變更時，等手停下來再套用（其他頁照常套用）
  const affected = new Set();
  for (const r of records) {
    const k = parseKey(r.key);
    if (k && k.kind === 'item') affected.add(k.page);
    else if (k && k.kind === 'pages') affected.add(k.id);
  }
  if (host && host.canApply && !host.canApply(affected)) throw Object.assign(new Error('busy'), { code: 'busy' });
  if (host && host.beforeApply) await host.beforeApply();
  const puts = { notebooks: [], sections: [], pages: [] };
  const dels = { notebooks: [], sections: [], pages: [] };
  const pageChanges = new Map();
  const metas = [];
  const applied = [];
  for (const r of records) {
    clock.observe(r.rev);
    const k = parseKey(r.key);
    if (!k) continue;
    const m = await store.meta.get(r.key);
    if (m && !shouldApply(r.rev, m.rev)) continue;
    applied.push(r);
    if (k.kind === 'asset') {
      metas.push({ key: r.key, rev: r.rev, fp: 'asset', page: null, data: r.data });
    } else if (k.kind === 'item') {
      if (!pageChanges.has(k.page)) pageChanges.set(k.page, []);
      pageChanges.get(k.page).push({ id: k.id, deleted: r.deleted, data: r.data });
      metas.push({ key: r.key, rev: r.rev, fp: r.deleted ? null : fingerprint(r.data), page: k.page, deleted: r.deleted ? 1 : 0 });
    } else {
      if (r.deleted) dels[k.kind].push(k.id);
      else puts[k.kind].push(r.data);
      metas.push({ key: r.key, rev: r.rev, fp: r.deleted ? null : entityFingerprint(r.data), page: null, deleted: r.deleted ? 1 : 0 });
    }
  }
  if (!applied.length) return;
  await store.putMany(puts, { remote: true });
  if (dels.notebooks.length || dels.sections.length || dels.pages.length) await store.removeMany(dels, { remote: true });
  const contents = [];
  for (const [pageId, changes] of pageChanges) {
    if (dels.pages.includes(pageId)) continue;
    const c = (await store.getContent(pageId)) || { id: pageId, items: [] };
    contents.push({ id: pageId, items: applyItemChanges(c.items, changes) });
  }
  if (contents.length) await store.putMany({ contents }, { remote: true });
  await store.meta.putMany(metas);
  // 遠端比較新的，蓋掉本機還沒送出的那筆
  const outbox = new Map((await store.outbox.all()).map((r) => [r.key, r]));
  const superseded = applied.filter((r) => outbox.has(r.key) && compareRev(outbox.get(r.key).rev, r.rev) <= 0).map((r) => r.key);
  if (superseded.length) await store.outbox.deleteMany(superseded);
  if (host && host.afterApply) {
    await host.afterApply({
      structure: Object.values(puts).some((l) => l.length) || Object.values(dels).some((l) => l.length),
      pages: new Set([...pageChanges.keys(), ...puts.pages.map((p) => p.id), ...dels.pages]),
    });
  }
}

// ---------- 圖片 ----------
const downloading = new Map();
export function fetchAsset(id) {
  if (!config.enabled) return Promise.resolve(null);
  if (!downloading.has(id)) {
    downloading.set(id, (async () => {
      try {
        const res = await api('/assets/' + id);
        const blob = await res.blob();
        const info = await store.meta.get(keyFor.asset(id));
        const asset = { id, blob, w: info?.data?.w || 0, h: info?.data?.h || 0 };
        await store.putAsset(asset, { remote: true });
        return asset;
      } catch {
        return null;
      } finally {
        downloading.delete(id);
      }
    })());
  }
  return downloading.get(id);
}

// 拿到新資料後，在背景把還沒有的圖片下載下來，之後離線也看得到
let prefetching = false;
async function prefetchAssets() {
  if (prefetching) return;
  prefetching = true;
  try {
    const have = new Set((await store.allAssets()).map((a) => a.id));
    const wanted = new Set();
    for (const c of await store.allContents()) for (const it of c.items) if (it.type === 'image' && !have.has(it.asset)) wanted.add(it.asset);
    for (const id of wanted) {
      const a = await fetchAsset(id);
      if (a && host && host.assetArrived) host.assetArrived(id);
    }
  } finally {
    prefetching = false;
  }
}

// ---------- 即時通知 ----------
function connect() {
  disconnect();
  if (!config.enabled || !config.token) return;
  const url = apiBase().replace(/^http/, 'ws') + '/ws?device=' + encodeURIComponent(state.device);
  try {
    ws = new WebSocket(url, ['folio', 'token.' + encodeToken(config.token)]);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsRetry = 2000;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.send('ping'); } catch { /* 斷了會自己重連 */ } }, 45000);
    syncNow();
  };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'changed' && msg.seq > state.seq) syncNow();
    } catch { /* 看不懂的訊息就略過 */ }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(wsTimer);
  if (!config.enabled) return;
  wsTimer = setTimeout(connect, wsRetry);
  wsRetry = Math.min(60000, wsRetry * 2);
}

function disconnect() {
  clearTimeout(wsTimer);
  clearInterval(pingTimer);
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* 已經關了 */ }
    ws = null;
  }
}

// ---------- 開啟、關閉 ----------
export function init(callbacks) {
  host = callbacks;
  store.setHook(hook);
  if (!store.syncAvailable()) { config.enabled = false; setStatus('off'); return; }
  window.addEventListener('online', () => { connect(); syncNow(); });
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && config.enabled) {
      if (!ws) connect();
      syncNow();
    }
  });
  if (config.enabled) {
    setStatus('idle');
    connect();
    syncNow();
  } else {
    setStatus('off');
  }
}

// 檢查伺服器和密碼，回傳 { ok, seq, records } 或 { ok: false, code }
export async function probe(url, token) {
  const prev = config;
  config = { ...config, url, token };
  try {
    const s = await (await api('/status')).json();
    return { ok: true, ...s };
  } catch (e) {
    return { ok: false, code: e.code || 'error' };
  } finally {
    config = prev;
  }
}

// mode: 'upload'（雲端是空的，把這台的筆記傳上去）、'merge'（兩邊合併）、'replace'（用雲端的取代這台）
export async function enable(url, token, mode) {
  config = { enabled: true, url, token };
  saveJson(CONFIG_KEY, config);
  state.seq = 0;
  saveState();
  if (mode === 'replace') {
    await store.clearForReplace();
  } else {
    await seedAll();
  }
  connect();
  await syncNow();
}

// 第一次開啟同步：把這台裝置現有的全部內容放進 outbox
async function seedAll() {
  const idx = await store.loadIndex();
  await hook.put({ notebooks: idx.notebooks, sections: idx.sections, pages: idx.pages, contents: await store.allContents() });
  for (const a of await store.allAssets()) await hook.asset(a);
}

export async function disable() {
  config = { ...config, enabled: false };
  saveJson(CONFIG_KEY, config);
  disconnect();
  clearTimeout(pushTimer);
  // 關閉後的修改不會記錄；下次開啟時會重新比對全部內容
  await store.meta.deleteMany((await store.meta.all()).map((m) => m.key));
  await store.outbox.deleteMany((await store.outbox.all()).map((r) => r.key));
  state.seq = 0;
  saveState();
  setStatus('off');
}

export async function pendingCount() {
  if (!store.syncAvailable()) return 0;
  return store.outbox.count();
}
