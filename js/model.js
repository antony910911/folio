// 資料模型：筆記本 › 分區 › 頁面。頁面的內容（筆跡、文字框）另外存，打開頁面時才讀。
// 純函式，不碰 DOM 和 IndexedDB。

export const SECTION_COLORS = ['#3d6fd8', '#d9534f', '#2f9e6e', '#d98b2b', '#8a5cd1', '#c2478f', '#2b9bb3', '#6b7280'];
export const BACKGROUNDS = ['blank', 'ruled', 'grid', 'dots'];
export const BACKUP_VERSION = 1;

export function newId(prefix = '') {
  const rnd = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix + rnd;
}

export function nextOrder(list) {
  return list.reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1;
}

export function sortByOrder(list) {
  return list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function createNotebook(name, siblings = [], now = Date.now()) {
  return { id: newId('nb_'), name: name || '未命名筆記本', order: nextOrder(siblings), createdAt: now, updatedAt: now };
}

export function createSection(notebookId, name, siblings = [], now = Date.now()) {
  const color = SECTION_COLORS[siblings.length % SECTION_COLORS.length];
  return { id: newId('sc_'), notebookId, name: name || '新分區', color, order: nextOrder(siblings), createdAt: now, updatedAt: now };
}

export function createPage(sectionId, siblings = [], now = Date.now()) {
  return { id: newId('pg_'), sectionId, title: '', background: 'ruled', order: nextOrder(siblings), createdAt: now, updatedAt: now };
}

export function emptyContent(pageId) {
  return { id: pageId, items: [] };
}

export function pageDisplayTitle(page) {
  return (page.title || '').trim() || '未命名頁面';
}

// 上移或下移一格，回傳需要更新 order 的項目。
export function moveInOrder(list, id, delta) {
  const sorted = sortByOrder(list);
  const i = sorted.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sorted.length) return [];
  const a = { ...sorted[i], order: sorted[j].order };
  const b = { ...sorted[j], order: sorted[i].order };
  if (a.order === b.order) b.order = a.order - delta; // 舊資料 order 重複時也能換
  return [a, b];
}

// 刪掉一本筆記本或一個分區時，連帶要刪的所有 id。
export function cascadeIds(db, kind, id) {
  const out = { notebooks: [], sections: [], pages: [] };
  if (kind === 'notebook') {
    out.notebooks.push(id);
    for (const s of db.sections) if (s.notebookId === id) out.sections.push(s.id);
  } else if (kind === 'section') {
    out.sections.push(id);
  } else if (kind === 'page') {
    out.pages.push(id);
    return out;
  }
  const sectionSet = new Set(out.sections);
  for (const p of db.pages) if (sectionSet.has(p.sectionId)) out.pages.push(p.id);
  return out;
}

// 匯入備份前檢查格式，丟掉壞掉的資料。回傳 { ok, data, error }。
export function validateBackup(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '檔案不是 Folio 備份。' };
  if (raw.app !== 'folio') return { ok: false, error: '檔案不是 Folio 備份。' };
  if (raw.version > BACKUP_VERSION) return { ok: false, error: '這個備份來自較新版本的 Folio，請先更新 App。' };
  const isObj = (x) => x && typeof x === 'object' && typeof x.id === 'string';
  const notebooks = (raw.notebooks || []).filter(isObj);
  const nbIds = new Set(notebooks.map((n) => n.id));
  const sections = (raw.sections || []).filter((s) => isObj(s) && nbIds.has(s.notebookId));
  const scIds = new Set(sections.map((s) => s.id));
  const pages = (raw.pages || []).filter((p) => isObj(p) && scIds.has(p.sectionId));
  const pgIds = new Set(pages.map((p) => p.id));
  const contents = (raw.contents || [])
    .filter((c) => isObj(c) && pgIds.has(c.id) && Array.isArray(c.items))
    .map((c) => ({ id: c.id, items: c.items.filter(isValidItem) }));
  if (!notebooks.length) return { ok: false, error: '備份裡沒有任何筆記本。' };
  return { ok: true, data: { notebooks, sections, pages, contents } };
}

export function isValidItem(it) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string') return false;
  if (it.type === 'stroke') {
    return Array.isArray(it.points) && it.points.length > 0
      && it.points.every((p) => Array.isArray(p) && p.length >= 2 && p.every((v) => typeof v === 'number' && isFinite(v)));
  }
  if (it.type === 'text') return [it.x, it.y, it.w].every((v) => typeof v === 'number' && isFinite(v)) && typeof it.html === 'string';
  return false;
}

// 第一次打開時的示範內容，讓畫面不是空的。
export function seedData(now = Date.now()) {
  const nb = createNotebook('我的筆記本', [], now);
  const s1 = createSection(nb.id, '快速筆記', [], now);
  const s2 = createSection(nb.id, '專案', [s1], now);
  const p1 = { ...createPage(s1.id, [], now), title: '歡迎使用 Folio' };
  const p2 = { ...createPage(s2.id, [], now), title: '會議記錄範本', background: 'grid' };
  const welcome = {
    id: p1.id,
    items: [
      { id: newId('t_'), type: 'text', x: 64, y: 156, w: 460, html: '<b>這是示範頁面，可以直接改或刪掉。</b>' },
      { id: newId('t_'), type: 'text', x: 64, y: 200, w: 460, html: '左邊是分區和頁面，跟 OneNote 一樣：筆記本 › 分區 › 頁面。' },
      { id: newId('t_'), type: 'text', x: 64, y: 268, w: 460, html: '<b>寫字</b>：選上方的「筆」，用 Apple Pencil 直接寫。用過 Pencil 後，手指會自動改成捲動頁面，手掌放在螢幕上也不會畫到。<br><b>打字</b>：選「文字」，點頁面任何位置就能新增文字框，拖曳上方的橫條可以移動。<br><b>選取</b>：用「選取」框住筆跡或文字框，可以移動、複製或刪除。<br><b>轉文字</b>：用「選取」框住手寫，點「轉成文字」。<br><b>匯出</b>：右上角「⋯」裡可以匯出 PowerPoint 或 Word。<br><b>縮放</b>：兩指捏合，電腦上按住 Ctrl 加滾輪。' },
      { id: newId('t_'), type: 'text', x: 600, y: 150, w: 280, html: '資料只存在這台裝置。換裝置前，先用右上角「⋯ › 備份檔」。跨裝置同步是下一步要做的功能。' },
      sampleStroke(),
    ],
  };
  return { notebooks: [nb], sections: [s1, s2], pages: [p1, p2], contents: [welcome, emptyContent(p2.id)] };
}

// 示範用的手寫底線，看得出筆壓粗細變化。
function sampleStroke() {
  const points = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    points.push([70 + t * 262, 188 + Math.sin(t * Math.PI * 3) * 2.5, Math.round((0.35 + Math.sin(t * Math.PI) * 0.6) * 100) / 100]);
  }
  return { id: newId('s_'), type: 'stroke', tool: 'pen', color: '#d9534f', size: 3, points };
}
