// 本機儲存：IndexedDB。筆記本、分區、頁面清單在啟動時全部讀進記憶體；頁面內容打開時才讀。
// IndexedDB 不能用時（例如私密瀏覽），改存在記憶體裡，畫面會提示資料不會保留。

import { seedData } from './model.js';

const DB_NAME = 'folio';
const DB_VERSION = 1;
const STORES = ['notebooks', 'sections', 'pages', 'contents'];

let db = null;
let memory = null; // IndexedDB 不能用時的替代
export let persistent = true;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of STORES) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

export async function init() {
  try {
    if (!globalThis.indexedDB) throw new Error('no indexedDB');
    db = await open();
  } catch (e) {
    console.warn('IndexedDB 無法使用，改用記憶體', e);
    persistent = false;
    memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }
  const all = await loadIndex();
  if (!all.notebooks.length) {
    const seed = seedData();
    await putMany(seed);
    return loadIndex();
  }
  return all;
}

async function getAll(store) {
  if (memory) return [...memory[store].values()].map(clone);
  return req(db.transaction(store).objectStore(store).getAll());
}

export async function loadIndex() {
  const [notebooks, sections, pages] = await Promise.all(['notebooks', 'sections', 'pages'].map(getAll));
  return { notebooks, sections, pages };
}

export async function getContent(pageId) {
  if (memory) return clone(memory.contents.get(pageId)) || null;
  return (await req(db.transaction('contents').objectStore('contents').get(pageId))) || null;
}

export async function put(store, value) {
  if (memory) { memory[store].set(value.id, clone(value)); return; }
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

// data: { notebooks?, sections?, pages?, contents? }，全部在同一個交易裡寫入
export async function putMany(data) {
  const names = STORES.filter((s) => data[s] && data[s].length);
  if (!names.length) return;
  if (memory) { for (const s of names) for (const v of data[s]) memory[s].set(v.id, clone(v)); return; }
  const tx = db.transaction(names, 'readwrite');
  for (const s of names) for (const v of data[s]) tx.objectStore(s).put(v);
  return done(tx);
}

// ids: { notebooks: [], sections: [], pages: [] }；頁面內容跟著頁面一起刪
export async function removeMany(ids) {
  const plan = { ...ids, contents: ids.pages || [] };
  const names = STORES.filter((s) => plan[s] && plan[s].length);
  if (!names.length) return;
  if (memory) { for (const s of names) for (const id of plan[s]) memory[s].delete(id); return; }
  const tx = db.transaction(names, 'readwrite');
  for (const s of names) for (const id of plan[s]) tx.objectStore(s).delete(id);
  return done(tx);
}

export async function exportAll() {
  const [notebooks, sections, pages, contents] = await Promise.all(STORES.map(getAll));
  return { app: 'folio', version: 1, exportedAt: new Date().toISOString(), notebooks, sections, pages, contents };
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

// 要求瀏覽器不要自動清掉資料（iPad 加入主畫面後通常會同意）
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* 不支援就算了 */ }
  return false;
}
