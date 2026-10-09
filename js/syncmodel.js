// 同步的規則（純函式，伺服器和 App 共用想法、可以用 node 測試）。
//
// 所有資料拆成一筆一筆的紀錄（record）：
//   nb:<id>               筆記本
//   sc:<id>               分區
//   pg:<id>               頁面資訊（標題、背景、順序）
//   it:<pageId>:<itemId>  頁面上的一個項目（一筆筆跡、一個文字框、一張圖、一張心智圖）
//   as:<id>               圖片的資訊（圖片本身另外上傳）
// 每筆紀錄有一個版本號 rev。同一筆紀錄兩邊都改過時，rev 比較大的贏；刪除也是一筆紀錄（deleted: 1）。
// 筆跡新增後不會再改，所以兩台裝置同時在同一頁寫字，兩邊的筆跡都會保留。

// rev：<毫秒 36 進位>.<計數 36 進位>.<裝置 id>，字串直接比大小就是時間先後
export function makeRev(ms, counter, deviceId) {
  return `${Math.floor(ms).toString(36).padStart(10, '0')}.${counter.toString(36).padStart(4, '0')}.${deviceId}`;
}

export function parseRev(rev) {
  const [ms, counter, device] = rev.split('.');
  return { ms: parseInt(ms, 36), counter: parseInt(counter, 36), device };
}

export function compareRev(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
}

// 混合邏輯時鐘：兩台裝置的時間對不準時，也能保證新的修改 rev 一定比看過的都大
export function createClock(deviceId, saved = null, now = () => Date.now()) {
  let last = saved && saved.ms ? { ms: saved.ms, counter: saved.counter || 0 } : { ms: 0, counter: 0 };
  return {
    next() {
      const t = now();
      if (t > last.ms) last = { ms: t, counter: 0 };
      else last = { ms: last.ms, counter: last.counter + 1 };
      return makeRev(last.ms, last.counter, deviceId);
    },
    // 收到別台裝置的 rev 時呼叫，之後產生的 rev 都會比它大
    observe(rev) {
      const r = parseRev(rev);
      if (r.ms > last.ms || (r.ms === last.ms && r.counter > last.counter)) last = { ms: r.ms, counter: r.counter };
    },
    state: () => ({ ...last }),
  };
}

export const keyFor = {
  notebooks: (x) => `nb:${x.id}`,
  sections: (x) => `sc:${x.id}`,
  pages: (x) => `pg:${x.id}`,
  item: (pageId, itemId) => `it:${pageId}:${itemId}`,
  asset: (id) => `as:${id}`,
};

const KIND_BY_PREFIX = { nb: 'notebooks', sc: 'sections', pg: 'pages', it: 'item', as: 'asset' };

export function parseKey(key) {
  const i = key.indexOf(':');
  const kind = KIND_BY_PREFIX[key.slice(0, i)];
  if (!kind) return null;
  if (kind === 'item') {
    const rest = key.slice(i + 1);
    const j = rest.indexOf(':');
    return { kind, page: rest.slice(0, j), id: rest.slice(j + 1) };
  }
  return { kind, id: key.slice(i + 1) };
}

// 很快的字串雜湊（FNV-1a），只用來判斷有沒有變
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + str.length.toString(36);
}

// 項目的指紋：筆跡點很多，不必整筆字串化，看頭尾和數量就夠判斷有沒有被移動或換色
export function fingerprint(it) {
  if (it.type === 'stroke') {
    const p = it.points;
    const a = p[0] || [];
    const z = p[p.length - 1] || [];
    return `s|${p.length}|${a[0]},${a[1]}|${z[0]},${z[1]}|${it.color}|${it.size}|${it.tool}`;
  }
  return hash(JSON.stringify(it));
}

export function entityFingerprint(x) {
  return hash(JSON.stringify(x));
}

// 比較一頁的項目和上次同步時的指紋，找出要送出的變更。
// known: Map(itemId → fingerprint)，這一頁上次同步時有哪些項目
// 回傳 { upserts: [item], deletes: [itemId] }
export function diffItems(items, known) {
  const upserts = [];
  const seen = new Set();
  for (const it of items) {
    seen.add(it.id);
    if (known.get(it.id) !== fingerprint(it)) upserts.push(it);
  }
  const deletes = [...known.keys()].filter((id) => !seen.has(id));
  return { upserts, deletes };
}

// 把遠端的項目變更套到一頁的內容上。已經有的就地換掉（保留疊放順序），新的加在最上面。
// changes: [{ id, deleted, data }]
export function applyItemChanges(items, changes) {
  const byId = new Map(items.map((it, i) => [it.id, i]));
  const out = items.slice();
  const removed = new Set();
  for (const c of changes) {
    if (c.deleted) { removed.add(c.id); continue; }
    removed.delete(c.id);
    if (byId.has(c.id)) out[byId.get(c.id)] = c.data;
    else { byId.set(c.id, out.length); out.push(c.data); }
  }
  return out.filter((it) => !removed.has(it.id));
}

// 遠端紀錄要不要套用：比本機已知的版本新才套用
export function shouldApply(remoteRev, localRev) {
  return compareRev(remoteRev, localRev) > 0;
}

// 一次上傳的紀錄不要太大（Workers 的請求和 SQL 都有大小限制）
export function batchRecords(records, { maxCount = 200, maxBytes = 900_000 } = {}) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const r of records) {
    const n = JSON.stringify(r).length;
    if (cur.length && (cur.length >= maxCount || size + n > maxBytes)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
