// Folio 主程式：側邊欄（筆記本 › 分區 › 頁面）、工具列、選單、存檔。

import * as store from './store.js';
import {
  createNotebook, createSection, createPage, emptyContent, sortByOrder, moveInOrder, cascadeIds,
  pageDisplayTitle, validateBackup, parsePageRange, SECTION_COLORS, BACKGROUNDS,
} from './model.js';
import { createEditor, formatDate } from './editor.js';
import { icons } from './icons.js';
import { strokeBounds } from './ink.js';
import { clusterBoxes } from './layout.js';
import { renderStrokes, canvasToBlob } from './inkrender.js';
import { exportPptx, exportDocx, saveFile, safeFilename } from './exporter.js';
import { recognize, backend, getApiKey, setApiKey } from './recognize.js';
import { fileKind, openPdf, prepareImage } from './importer.js';

const PEN_COLORS = ['#1f2a44', '#d9534f', '#2f6fd8', '#2f9e6e', '#8a5cd1'];
const HL_COLORS = ['#f5d33b', '#86d46b', '#6cc4f0', '#f59bc4', '#f5a65b'];
const PEN_SIZES = [1.5, 3, 5.5];
const HL_SIZES = [12, 18, 28];
const BG_LABELS = { blank: '空白', ruled: '橫線', grid: '方格', dots: '點點' };
const TOOLS = [
  ['select', '選取', 'V'], ['hand', '平移', 'H'], ['pen', '筆', 'P'],
  ['highlighter', '螢光筆', 'M'], ['eraser', '橡皮擦', 'E'], ['text', '文字', 'T'],
];

const state = {
  notebooks: [],
  sections: [],
  pages: [],
  notebookId: null,
  sectionId: null,
  pageId: null,
};

// ---------- 偏好設定（存在 localStorage，讀不到就用預設） ----------
const PREFS_KEY = 'folio.prefs';
let prefs = {
  tool: 'pen',
  pen: { color: PEN_COLORS[0], size: PEN_SIZES[1] },
  highlighter: { color: HL_COLORS[0], size: HL_SIZES[1] },
  eraserSize: 12,
  penOnly: false,
  sidebar: true,
  last: {},
};
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* 用預設值 */ }
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 存不了就算了 */ }
}

// ---------- 畫面骨架 ----------
const app = document.getElementById('app');
app.innerHTML = `
  <aside class="sidebar" id="sidebar">
    <button class="nb-switch" id="nb-switch" type="button">
      <span class="nb-icon">${icons.book}</span>
      <span class="nb-name" id="nb-name"></span>
      <span class="nb-chev">${icons.chevron}</span>
    </button>
    <div class="cols">
      <nav class="col sections" aria-label="分區">
        <div class="col-head"><span>分區</span><button type="button" class="icon-btn small" id="add-section" title="新增分區" aria-label="新增分區">${icons.plus}</button></div>
        <ul class="list" id="section-list"></ul>
      </nav>
      <nav class="col pages" aria-label="頁面">
        <div class="col-head"><span id="pages-head">頁面</span></div>
        <ul class="list" id="page-list"></ul>
        <button type="button" class="add-page" id="add-page">${icons.plus}<span>新增頁面</span></button>
      </nav>
    </div>
    <div class="side-foot" id="side-foot"></div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">
    <header class="toolbar" id="toolbar">
      <button type="button" class="icon-btn" id="toggle-sidebar" title="顯示／隱藏側邊欄" aria-label="顯示或隱藏側邊欄">${icons.sidebar}</button>
      <div class="tool-group" id="tools" role="toolbar" aria-label="工具"></div>
      <div class="tool-opts" id="tool-opts"></div>
      <button type="button" class="icon-btn" id="insert" title="插入 PDF 或圖片" aria-label="插入 PDF 或圖片">${icons.insert}</button>
      <div class="spacer"></div>
      <button type="button" class="icon-btn" id="undo" title="復原 (⌘Z)" aria-label="復原">${icons.undo}</button>
      <button type="button" class="icon-btn" id="redo" title="重做 (⇧⌘Z)" aria-label="重做">${icons.redo}</button>
      <button type="button" class="zoom-btn" id="zoom" title="縮放比例，點一下回到 100%">100%</button>
      <button type="button" class="icon-btn" id="more" title="更多" aria-label="更多">${icons.more}</button>
    </header>
    <div class="editor-wrap">
      <div id="editor"></div>
      <div class="empty" id="empty" hidden>
        <p class="empty-title">這個分區還沒有頁面</p>
        <button type="button" class="primary" id="empty-add">新增頁面</button>
      </div>
    </div>
  </main>
  <div class="menu" id="menu" role="menu" hidden></div>
  <dialog class="dlg" id="dlg"><form method="dialog" id="dlg-form"></form></dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <input type="file" id="import-file" accept="application/json,.json" hidden>
  <input type="file" id="insert-file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,.pptx,.ppt,.key" multiple hidden>`;

const $ = (id) => document.getElementById(id);
const editorEl = $('editor');

// ---------- 編輯器 ----------
const saveTimers = new Map();
const pendingContent = new Map();
const pendingPages = new Set();

function scheduleSave() {
  clearTimeout(saveTimers.get('all'));
  saveTimers.set('all', setTimeout(flush, 400));
}

async function flush() {
  clearTimeout(saveTimers.get('all'));
  const contents = [...pendingContent.values()].map((c) => JSON.parse(JSON.stringify(c)));
  const pages = [...pendingPages].map((id) => state.pages.find((p) => p.id === id)).filter(Boolean);
  pendingContent.clear();
  pendingPages.clear();
  if (!contents.length && !pages.length) return;
  try {
    await store.putMany({ contents, pages });
  } catch (e) {
    console.error(e);
    toast('存檔失敗，請匯出備份後重新整理。');
  }
}

// 圖片 id → 物件網址（同一張圖只讀一次）
const assetUrls = new Map();
function assetUrl(id) {
  if (!assetUrls.has(id)) {
    assetUrls.set(id, store.getAsset(id).then((a) => (a ? URL.createObjectURL(a.blob) : null)).catch(() => null));
  }
  return assetUrls.get(id);
}

const editor = createEditor(editorEl, {
  assetUrl,
  onChange(page, content) {
    pendingContent.set(page.id, content);
    pendingPages.add(page.id);
    scheduleSave();
    updatePageRow(page);
  },
  onTitle(page) {
    pendingPages.add(page.id);
    scheduleSave();
    updatePageRow(page);
  },
  onHistory({ canUndo, canRedo }) {
    $('undo').disabled = !canUndo;
    $('redo').disabled = !canRedo;
  },
  onZoom(z) {
    $('zoom').textContent = Math.round(z * 100) + '%';
  },
  onInkToText(strokes) {
    inkToText(strokes);
  },
  onPenDetected() {
    prefs.penOnly = true;
    savePrefs();
    toast('偵測到 Apple Pencil：手指改成捲動頁面，只有筆會寫字。可以在「⋯」裡關掉。');
  },
});
editor.setPrefs({ pen: prefs.pen, highlighter: prefs.highlighter, eraserSize: prefs.eraserSize, penOnly: prefs.penOnly });

window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('pagehide', flush);

// ---------- 工具列 ----------
function renderTools() {
  $('tools').innerHTML = TOOLS.map(([id, label, key]) =>
    `<button type="button" class="tool${prefs.tool === id ? ' on' : ''}" data-tool="${id}" title="${label} (${key})" aria-label="${label}" aria-pressed="${prefs.tool === id}">${icons[id]}</button>`).join('');
  renderToolOpts();
}

function renderToolOpts() {
  const t = prefs.tool;
  const el = $('tool-opts');
  if (t !== 'pen' && t !== 'highlighter') { el.innerHTML = ''; return; }
  const cur = prefs[t];
  const colors = t === 'pen' ? PEN_COLORS : HL_COLORS;
  const sizes = t === 'pen' ? PEN_SIZES : HL_SIZES;
  el.innerHTML = `
    <div class="swatches" role="group" aria-label="顏色">${colors.map((c) =>
      `<button type="button" class="swatch${cur.color === c ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="顏色 ${c}"></button>`).join('')}</div>
    <div class="sizes" role="group" aria-label="粗細">${sizes.map((s, i) =>
      `<button type="button" class="size${cur.size === s ? ' on' : ''}" data-size="${s}" aria-label="粗細 ${i + 1}"><i style="--d:${[4, 7, 11][i]}px;--c:${cur.color}"></i></button>`).join('')}</div>`;
}

function setTool(t) {
  prefs.tool = t;
  savePrefs();
  editor.setTool(t);
  renderTools();
}

$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

$('tool-opts').addEventListener('click', (e) => {
  const t = prefs.tool;
  const c = e.target.closest('[data-color]');
  const s = e.target.closest('[data-size]');
  if (c) prefs[t] = { ...prefs[t], color: c.dataset.color };
  if (s) prefs[t] = { ...prefs[t], size: Number(s.dataset.size) };
  if (!c && !s) return;
  savePrefs();
  editor.setPrefs({ [t]: prefs[t] });
  renderToolOpts();
});

$('undo').addEventListener('click', () => editor.undo());
$('redo').addEventListener('click', () => editor.redo());
$('zoom').addEventListener('click', () => editor.resetZoom());

$('more').addEventListener('click', (e) => {
  const page = editor.page;
  openMenu(e.currentTarget, [
    { heading: '頁面背景' },
    { row: BACKGROUNDS.map((bg) => ({ label: BG_LABELS[bg], on: page && page.background === bg, action: () => editor.setBackground(bg), disabled: !page })) },
    { sep: true },
    { label: '只用 Apple Pencil 寫字', hint: '手指只負責捲動', check: prefs.penOnly, action: togglePenOnly },
    { label: '放大', action: () => editor.zoomBy(1.25) },
    { label: '縮小', action: () => editor.zoomBy(0.8) },
    { sep: true },
    { label: '插入 PDF 或圖片…', hint: '簡報請先另存成 PDF', action: () => $('insert-file').click(), disabled: !page },
    { sep: true },
    { heading: '手寫辨識' },
    { label: '整頁手寫轉文字', hint: '只轉這一頁的筆跡，螢光筆不算', action: () => inkToText(editor.penStrokes()), disabled: !page },
    { label: '手寫辨識設定…', action: openRecognizeSettings },
    { sep: true },
    { heading: '匯出' },
    { label: 'PowerPoint：這一頁', action: () => runExport('pptx', 'page'), disabled: !page },
    { label: 'PowerPoint：整個分區', action: () => runExport('pptx', 'section'), disabled: !state.sectionId },
    { label: 'Word：這一頁', action: () => runExport('docx', 'page'), disabled: !page },
    { label: 'Word：整個分區', action: () => runExport('docx', 'section'), disabled: !state.sectionId },
    { label: '備份檔', hint: '可以匯入到其他裝置', action: exportBackup },
    { label: '匯入備份…', action: () => $('import-file').click() },
  ]);
});

function togglePenOnly() {
  prefs.penOnly = !prefs.penOnly;
  savePrefs();
  editor.setPrefs({ penOnly: prefs.penOnly });
  toast(prefs.penOnly ? '手指改成捲動頁面，只有 Apple Pencil 會寫字。' : '手指也可以寫字了。');
}

// ---------- 側邊欄 ----------
function sectionsOf(nbId) { return sortByOrder(state.sections.filter((s) => s.notebookId === nbId)); }
function pagesOf(scId) { return sortByOrder(state.pages.filter((p) => p.sectionId === scId)); }

function renderSidebar() {
  const nb = state.notebooks.find((n) => n.id === state.notebookId);
  $('nb-name').textContent = nb ? nb.name : '';
  const sections = sectionsOf(state.notebookId);
  $('section-list').innerHTML = sections.map((s) => `
    <li class="row section-row${s.id === state.sectionId ? ' on' : ''}" data-id="${s.id}" style="--sc:${s.color}">
      <button type="button" class="row-main" data-open-section="${s.id}"><span class="tab"></span><span class="row-label">${esc(s.name)}</span></button>
      <button type="button" class="row-more" data-section-menu="${s.id}" aria-label="分區選項">${icons.more}</button>
    </li>`).join('') || '<li class="hint">還沒有分區</li>';
  const sc = state.sections.find((s) => s.id === state.sectionId);
  $('pages-head').textContent = sc ? sc.name : '頁面';
  $('sidebar').style.setProperty('--sc', sc ? sc.color : 'var(--accent)');
  const pages = sc ? pagesOf(sc.id) : [];
  $('page-list').innerHTML = pages.map((p) => pageRowHtml(p)).join('') || '<li class="hint">沒有頁面</li>';
  $('add-page').disabled = !sc;
  $('side-foot').innerHTML = store.persistent
    ? '<span class="dot"></span>存在這台裝置'
    : '<span class="dot warn"></span>這個瀏覽器不能存資料，關掉就會消失';
}

function pageRowHtml(p) {
  return `<li class="row page-row${p.id === state.pageId ? ' on' : ''}" data-id="${p.id}">
      <button type="button" class="row-main" data-open-page="${p.id}"><span class="row-label">${esc(pageDisplayTitle(p))}</span><span class="row-date">${shortDate(p.updatedAt)}</span></button>
      <button type="button" class="row-more" data-page-menu="${p.id}" aria-label="頁面選項">${icons.more}</button>
    </li>`;
}

function updatePageRow(page) {
  const row = $('page-list').querySelector(`[data-id="${page.id}"]`);
  if (!row) return;
  row.querySelector('.row-label').textContent = pageDisplayTitle(page);
  row.querySelector('.row-date').textContent = shortDate(page.updatedAt);
}

$('section-list').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-section]');
  const menu = e.target.closest('[data-section-menu]');
  if (open) openSection(open.dataset.openSection);
  if (menu) sectionMenu(menu, menu.dataset.sectionMenu);
});

$('page-list').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-page]');
  const menu = e.target.closest('[data-page-menu]');
  if (open) { openPage(open.dataset.openPage); closeDrawerIfNarrow(); }
  if (menu) pageMenu(menu, menu.dataset.pageMenu);
});

$('nb-switch').addEventListener('click', (e) => {
  const list = sortByOrder(state.notebooks);
  openMenu(e.currentTarget, [
    ...list.map((n) => ({ label: n.name, check: n.id === state.notebookId, action: () => openNotebook(n.id) })),
    { sep: true },
    { label: '新增筆記本…', action: addNotebook },
    { label: '重新命名這本…', action: renameNotebook },
    { label: '刪除這本…', danger: true, action: deleteNotebook, disabled: state.notebooks.length < 2 },
  ]);
});

$('add-section').addEventListener('click', addSection);
$('add-page').addEventListener('click', addPage);
$('empty-add').addEventListener('click', addPage);

$('toggle-sidebar').addEventListener('click', () => {
  prefs.sidebar = !isSidebarOpen();
  savePrefs();
  applySidebar();
});
$('scrim').addEventListener('click', () => { prefs.sidebar = false; savePrefs(); applySidebar(); });

const narrow = window.matchMedia('(max-width: 899px)');
function isSidebarOpen() { return document.body.classList.contains('sidebar-open'); }
function applySidebar() {
  document.body.classList.toggle('sidebar-open', !!prefs.sidebar);
}
function closeDrawerIfNarrow() {
  if (narrow.matches && prefs.sidebar) { prefs.sidebar = false; savePrefs(); applySidebar(); }
}

// ---------- 開啟 ----------
function openNotebook(id) {
  state.notebookId = id;
  const sections = sectionsOf(id);
  const last = prefs.last[id];
  const sc = sections.find((s) => s.id === last) || sections[0];
  if (sc) openSection(sc.id); else { state.sectionId = null; state.pageId = null; showPage(null); renderSidebar(); }
}

function openSection(id) {
  const sc = state.sections.find((s) => s.id === id);
  if (!sc) return;
  state.notebookId = sc.notebookId;
  state.sectionId = id;
  prefs.last[sc.notebookId] = id;
  const pages = pagesOf(id);
  const pg = pages.find((p) => p.id === prefs.last[id]) || pages[0];
  if (pg) openPage(pg.id); else { state.pageId = null; showPage(null); renderSidebar(); savePrefs(); }
}

async function openPage(id) {
  const page = state.pages.find((p) => p.id === id);
  if (!page) return;
  await flush();
  state.pageId = id;
  state.sectionId = page.sectionId;
  prefs.last[page.sectionId] = id;
  prefs.lastPage = id;
  savePrefs();
  renderSidebar();
  const content = (await store.getContent(id)) || emptyContent(id);
  if (state.pageId !== id) return; // 讀取期間又切到別頁
  showPage(page, content);
}

function showPage(page, content) {
  $('empty').hidden = !!page || !state.sectionId;
  editorEl.hidden = !page;
  if (page) editor.load(page, content);
}

// ---------- 新增、改名、刪除 ----------
async function addNotebook() {
  const name = await askText({ title: '新增筆記本', value: '', placeholder: '筆記本名稱', ok: '建立' });
  if (name == null) return;
  const nb = createNotebook(name.trim(), state.notebooks);
  const sc = createSection(nb.id, '新分區', []);
  const pg = createPage(sc.id, []);
  state.notebooks.push(nb);
  state.sections.push(sc);
  state.pages.push(pg);
  await store.putMany({ notebooks: [nb], sections: [sc], pages: [pg], contents: [emptyContent(pg.id)] });
  openNotebook(nb.id);
}

async function renameNotebook() {
  const nb = state.notebooks.find((n) => n.id === state.notebookId);
  const name = await askText({ title: '重新命名筆記本', value: nb.name, ok: '儲存' });
  if (name == null || !name.trim()) return;
  nb.name = name.trim();
  nb.updatedAt = Date.now();
  await store.put('notebooks', nb);
  renderSidebar();
}

async function deleteNotebook() {
  const nb = state.notebooks.find((n) => n.id === state.notebookId);
  const ids = cascadeIds(state, 'notebook', nb.id);
  const ok = await askConfirm({ title: `刪除「${nb.name}」？`, message: `裡面的 ${ids.sections.length} 個分區、${ids.pages.length} 個頁面會一起刪除，無法復原。`, ok: '刪除', danger: true });
  if (!ok) return;
  await removeIds(ids);
  openNotebook(sortByOrder(state.notebooks)[0].id);
}

async function addSection() {
  if (!state.notebookId) return;
  const name = await askText({ title: '新增分區', value: '', placeholder: '分區名稱', ok: '建立' });
  if (name == null) return;
  const sc = createSection(state.notebookId, name.trim(), sectionsOf(state.notebookId));
  const pg = createPage(sc.id, []);
  state.sections.push(sc);
  state.pages.push(pg);
  await store.putMany({ sections: [sc], pages: [pg], contents: [emptyContent(pg.id)] });
  openSection(sc.id);
}

function sectionMenu(anchor, id) {
  const sc = state.sections.find((s) => s.id === id);
  openMenu(anchor, [
    { label: '重新命名…', action: () => renameSection(sc) },
    { heading: '顏色' },
    { row: SECTION_COLORS.map((c) => ({ swatch: c, on: sc.color === c, action: () => recolorSection(sc, c) })) },
    { sep: true },
    { label: '上移', action: () => reorder('sections', sectionsOf(sc.notebookId), id, -1) },
    { label: '下移', action: () => reorder('sections', sectionsOf(sc.notebookId), id, 1) },
    { sep: true },
    { label: '刪除分區…', danger: true, action: () => deleteSection(sc) },
  ]);
}

async function renameSection(sc) {
  const name = await askText({ title: '重新命名分區', value: sc.name, ok: '儲存' });
  if (name == null || !name.trim()) return;
  sc.name = name.trim();
  sc.updatedAt = Date.now();
  await store.put('sections', sc);
  renderSidebar();
}

async function recolorSection(sc, color) {
  sc.color = color;
  sc.updatedAt = Date.now();
  await store.put('sections', sc);
  renderSidebar();
}

async function deleteSection(sc) {
  const ids = cascadeIds(state, 'section', sc.id);
  const ok = await askConfirm({ title: `刪除「${sc.name}」？`, message: `裡面的 ${ids.pages.length} 個頁面會一起刪除，無法復原。`, ok: '刪除', danger: true });
  if (!ok) return;
  await removeIds(ids);
  if (state.sectionId === sc.id) openNotebook(state.notebookId); else renderSidebar();
}

async function addPage() {
  if (!state.sectionId) return;
  await flush();
  const pg = createPage(state.sectionId, pagesOf(state.sectionId));
  state.pages.push(pg);
  await store.putMany({ pages: [pg], contents: [emptyContent(pg.id)] });
  await openPage(pg.id);
  closeDrawerIfNarrow();
  editor.focusTitle();
}

function pageMenu(anchor, id) {
  const pg = state.pages.find((p) => p.id === id);
  const others = sectionsOf(state.notebookId).filter((s) => s.id !== pg.sectionId);
  openMenu(anchor, [
    { label: '上移', action: () => reorder('pages', pagesOf(pg.sectionId), id, -1) },
    { label: '下移', action: () => reorder('pages', pagesOf(pg.sectionId), id, 1) },
    ...(others.length ? [{ heading: '移到分區' }, ...others.map((s) => ({ label: s.name, swatchDot: s.color, action: () => movePage(pg, s.id) }))] : []),
    { sep: true },
    { label: '刪除頁面…', danger: true, action: () => deletePage(pg) },
  ]);
}

async function movePage(pg, sectionId) {
  await flush();
  pg.sectionId = sectionId;
  pg.order = pagesOf(sectionId).reduce((m, p) => Math.max(m, p.order), 0) + 1;
  pg.updatedAt = Date.now();
  await store.put('pages', pg);
  toast(`已移到「${state.sections.find((s) => s.id === sectionId).name}」`);
  if (state.pageId === pg.id) openSection(sectionId); else renderSidebar();
}

async function deletePage(pg) {
  const ok = await askConfirm({ title: `刪除「${pageDisplayTitle(pg)}」？`, message: '刪除後無法復原。', ok: '刪除', danger: true });
  if (!ok) return;
  const list = pagesOf(pg.sectionId);
  const idx = list.findIndex((p) => p.id === pg.id);
  pendingContent.delete(pg.id);
  pendingPages.delete(pg.id);
  await removeIds({ pages: [pg.id] });
  if (state.pageId === pg.id) {
    const next = list[idx + 1] || list[idx - 1];
    if (next) openPage(next.id); else { state.pageId = null; showPage(null); renderSidebar(); }
  } else {
    renderSidebar();
  }
}

async function removeIds(ids) {
  for (const id of ids.pages || []) { pendingContent.delete(id); pendingPages.delete(id); }
  await store.removeMany(ids);
  const drop = (list, del) => list.filter((x) => !(del || []).includes(x.id));
  state.notebooks = drop(state.notebooks, ids.notebooks);
  state.sections = drop(state.sections, ids.sections);
  state.pages = drop(state.pages, ids.pages);
}

async function reorder(storeName, list, id, delta) {
  const changed = moveInOrder(list, id, delta);
  if (!changed.length) return;
  const all = state[storeName];
  for (const c of changed) Object.assign(all.find((x) => x.id === c.id), { order: c.order });
  await store.putMany({ [storeName]: changed });
  renderSidebar();
}

// ---------- 備份 ----------
async function exportBackup() {
  await flush();
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  await deliver(blob, `folio-備份-${new Date().toISOString().slice(0, 10)}.json`);
}

// ---------- 匯出 PowerPoint／Word ----------
let exporting = false;
async function runExport(kind, scope) {
  if (exporting) return;
  exporting = true;
  try {
    await flush();
    const sc = state.sections.find((x) => x.id === state.sectionId);
    const pages = scope === 'page' ? [editor.page] : pagesOf(state.sectionId);
    if (!pages.length || !pages[0]) { toast('這個分區沒有頁面。'); return; }
    toast(kind === 'pptx' ? '正在產生 PowerPoint…' : '正在產生 Word…', { sticky: true });
    const entries = [];
    for (const p of pages) {
      const c = await store.getContent(p.id);
      entries.push({ page: p, items: c ? c.items : [] });
    }
    const title = scope === 'page' ? pageDisplayTitle(pages[0]) : sc.name;
    const getAsset = (id) => store.getAsset(id);
    const blob = kind === 'pptx' ? await exportPptx(entries, title, getAsset) : await exportDocx(entries, title, getAsset);
    await deliver(blob, `${safeFilename(title)}.${kind}`);
  } catch (e) {
    console.error(e);
    toast(e && e.message ? e.message : '匯出失敗，請再試一次。');
  } finally {
    exporting = false;
  }
}

async function deliver(blob, filename) {
  try {
    const result = await saveFile(blob, filename);
    if (result === 'saved') toast(`已匯出「${filename}」`);
    else if (result === 'needs_tap') toastAction('檔案準備好了。', '儲存', () => deliver(blob, filename));
    else hideToast();
  } catch (e) {
    toast(e && e.message ? e.message : '存檔失敗。');
  }
}

// ---------- 手寫辨識 ----------
let recognizing = false;
async function inkToText(strokes) {
  if (recognizing) return;
  const page = editor.page;
  if (!page) return;
  if (!strokes.length) { toast('沒有可以辨識的手寫筆跡。'); return; }
  if (!(await backend())) { openRecognizeSettings(); return; }
  recognizing = true;
  editor.setBusy(true);
  const clusters = clusterBoxes(strokes.map((st) => ({ id: st.id, ...strokeBounds(st) })), 28);
  toast(clusters.length > 1 ? `辨識中…（${clusters.length} 段）` : '辨識中…', { sticky: true });
  const results = [];
  let empty = 0;
  let firstError = null;
  try {
    await mapLimit(clusters, 2, async (c) => {
      const set = new Set(c.ids);
      try {
        const { canvas } = renderStrokes(strokes.filter((st) => set.has(st.id)), { scale: 3, background: '#ffffff', pad: 16, maxSide: 1568 });
        const text = await recognize(await canvasToBlob(canvas));
        if (text) results.push({ ids: c.ids, x: c.x, y: c.y, w: c.w, text });
        else empty++;
      } catch (e) {
        console.error(e);
        firstError = firstError || e;
      }
    });
  } finally {
    recognizing = false;
    editor.setBusy(false);
  }
  const applied = results.length > 0 && editor.applyInkToText(page.id, results);
  const notes = [];
  if (applied) notes.push(`已轉成文字${results.length > 1 ? `（${results.length} 段）` : ''}，按復原可以換回手寫。`);
  else if (results.length) notes.push('辨識完成時已經換到別頁，所以沒有套用。');
  if (empty) notes.push(`有 ${empty} 段看不出文字，保留原本的筆跡。`);
  if (firstError) notes.push(firstError.message || '有部分辨識失敗。');
  toast(notes.join(' '));
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < list.length) await fn(list[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

async function openRecognizeSettings() {
  const mode = await backend();
  const account = mode === 'account';
  dlgForm.innerHTML = `
    <h2 class="dlg-title">手寫辨識設定</h2>
    <p class="dlg-msg">辨識時，選取的手寫筆跡會做成圖片，傳給 Claude 讀成文字，再換成文字框。</p>
    ${account ? '<p class="dlg-note">現在是在 claude.ai 裡開啟，會直接用你的 Claude 帳號辨識，不需要金鑰。第一次辨識時會先問你是否允許。</p>' : `
    <label class="dlg-label" for="dlg-key">Anthropic API 金鑰</label>
    <input class="dlg-input" id="dlg-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…">
    <p class="dlg-hint">到 console.anthropic.com 申請。費用從你的 API 帳戶扣，金鑰只存在這台裝置。清空後儲存就會刪除。</p>`}
    <p class="dlg-hint">iPad 也可以用內建的「隨手寫」：在文字框裡直接用 Apple Pencil 寫字，系統會轉成文字。</p>
    <div class="dlg-actions">${account ? '' : '<button type="button" class="ghost" id="dlg-cancel">取消</button>'}<button class="primary" value="ok">${account ? '知道了' : '儲存'}</button></div>`;
  if (account) {
    dlgForm.insertAdjacentHTML('beforeend', '<button type="button" id="dlg-cancel" hidden></button>');
    await showDialog(() => true, () => dlgForm.querySelector('[value=ok]').focus());
    return;
  }
  const input = $('dlg-key');
  input.value = getApiKey();
  const key = await showDialog(() => input.value, () => input.focus());
  if (key == null) return;
  setApiKey(key);
  toast(key.trim() ? '已儲存 API 金鑰。' : '已刪除 API 金鑰。');
}

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let raw;
  try { raw = JSON.parse(await file.text()); } catch { toast('讀不懂這個檔案，請選 Folio 匯出的 .json 備份。'); return; }
  const res = validateBackup(raw);
  if (!res.ok) { toast(res.error); return; }
  const { notebooks, pages } = res.data;
  const ok = await askConfirm({ title: '匯入備份？', message: `會加入 ${notebooks.length} 本筆記本、${pages.length} 個頁面。id 相同的頁面會被備份的版本取代。`, ok: '匯入' });
  if (!ok) return;
  await flush();
  await store.putMany({ ...res.data, assets: store.unpackAssets(res.data.assets) });
  Object.assign(state, await store.loadIndex());
  openNotebook(notebooks[0].id);
  toast('匯入完成。');
});

// ---------- 插入 PDF、圖片 ----------
let importing = false;

$('insert').addEventListener('click', () => {
  if (!editor.page) { toast('請先新增一個頁面。'); return; }
  $('insert-file').click();
});
$('insert-file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  handleFiles(files, 'below');
});

// 貼上截圖
document.addEventListener('paste', (e) => {
  if (editor.isTyping() || dlg.open) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => fileKind(f) === 'image' || fileKind(f) === 'pdf');
  if (!files.length) return;
  e.preventDefault();
  handleFiles(files, 'view');
});

// 拖放檔案到頁面上
let dragDepth = 0;
editorEl.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  editorEl.classList.add('dropping');
});
editorEl.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
editorEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) editorEl.classList.remove('dropping');
});
editorEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  editorEl.classList.remove('dropping');
  handleFiles([...e.dataTransfer.files], 'view');
});

async function handleFiles(files, at) {
  if (!files.length) return;
  if (!editor.page) { toast('請先新增一個頁面。'); return; }
  if (importing) { toast('還在匯入上一個檔案，請稍等。'); return; }
  const kinds = files.map(fileKind);
  if (kinds.includes('slides')) {
    toast('PowerPoint／Keynote 檔請先另存成 PDF 再匯入。PowerPoint：檔案 › 匯出 › PDF；Keynote：檔案 › 輸出為 › PDF。');
    return;
  }
  if (kinds.includes('heic')) { toast('HEIC 照片目前不支援，請先轉成 JPEG（iPad 上「拷貝」再貼上通常就會自動轉）。'); return; }
  if (kinds.includes('other')) { toast('只能匯入 PDF 或圖片（PNG、JPEG、WebP、GIF）。'); return; }
  importing = true;
  try {
    const images = files.filter((f, i) => kinds[i] === 'image');
    if (images.length) await importImages(images, at);
    for (const f of files.filter((f, i) => kinds[i] === 'pdf')) await importPdf(f);
  } catch (e) {
    console.error(e);
    toast(e && e.message ? `匯入失敗：${e.message}` : '匯入失敗，請再試一次。');
  } finally {
    importing = false;
  }
}

async function saveAsset(prepared) {
  const asset = { id: newAssetId(), blob: prepared.blob, w: prepared.w, h: prepared.h };
  await store.putAsset(asset);
  return asset.id;
}

function newAssetId() {
  return 'as_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2) + Date.now().toString(36));
}

async function importImages(files, at) {
  toast('正在匯入圖片…', { sticky: true });
  const list = [];
  for (const f of files) {
    const prepared = await prepareImage(f);
    list.push({ asset: await saveAsset(prepared), ...prepared.display });
  }
  editor.insertImages(list, { at: files.length > 1 ? 'below' : at });
  toast(files.length > 1 ? `已插入 ${files.length} 張圖片。` : '已插入圖片。');
}

async function importPdf(file) {
  toast('正在讀取 PDF…', { sticky: true });
  let pdf;
  try {
    pdf = await openPdf(file);
  } catch (e) {
    console.error(e);
    if (e && e.name === 'PasswordException') throw new Error('這個 PDF 有密碼保護，請先移除密碼。');
    throw new Error('讀不懂這個 PDF。');
  }
  try {
    hideToast();
    const choice = await askPdfOptions(file.name, pdf.count);
    if (!choice) return;
    const pageNumbers = parsePageRange(choice.range, pdf.count);
    if (!pageNumbers) { toast('頁數範圍看不懂，請寫成像「1-5, 8」這樣。'); return; }
    const rendered = [];
    for (const [i, n] of pageNumbers.entries()) {
      toast(`正在匯入第 ${i + 1} / ${pageNumbers.length} 頁…`, { sticky: true });
      const r = await pdf.render(n);
      rendered.push({ n, asset: await saveAsset(r), ...r.display });
    }
    const base = file.name.replace(/\.pdf$/i, '');
    if (choice.mode === 'here') {
      editor.insertImages(rendered.map(({ asset, w, h }) => ({ asset, w, h })), { at: 'below' });
      toast(`已插入 ${rendered.length} 頁，可以直接在上面寫字。`);
    } else {
      await flush();
      const siblings = pagesOf(state.sectionId);
      const newPages = [];
      const contents = [];
      for (const r of rendered) {
        const pg = { ...createPage(state.sectionId, [...siblings, ...newPages]), title: `${base} 第 ${r.n} 頁`, background: 'blank' };
        newPages.push(pg);
        contents.push({ id: pg.id, items: [{ id: 'i_' + pg.id.slice(3), type: 'image', x: 64, y: 150, w: r.w, h: r.h, asset: r.asset }] });
      }
      state.pages.push(...newPages);
      await store.putMany({ pages: newPages, contents });
      await openPage(newPages[0].id);
      toast(`已建立 ${newPages.length} 個頁面。`);
    }
  } finally {
    pdf.destroy();
  }
}

function askPdfOptions(name, count) {
  dlgForm.innerHTML = `
    <h2 class="dlg-title">匯入「${esc(name)}」</h2>
    <p class="dlg-msg">共 ${count} 頁。每一頁會變成一張圖片，可以直接用筆在上面寫。</p>
    <div class="import-opts" role="radiogroup" aria-label="放在哪裡">
      <label class="import-opt"><input type="radio" name="pdf-mode" value="here" checked><span>全部放在這一頁<small>由上往下排，適合邊看簡報邊寫筆記</small></span></label>
      <label class="import-opt"><input type="radio" name="pdf-mode" value="pages"><span>每一頁建立一個新頁面<small>頁面標題是「檔名 第 n 頁」</small></span></label>
    </div>
    <label class="dlg-label" for="dlg-range">頁數範圍</label>
    <input class="dlg-input" id="dlg-range" autocomplete="off" placeholder="全部，或像 1-5, 8">
    ${count > 40 ? '<p class="dlg-hint">頁數很多時，匯入會花一點時間，也會佔用比較多儲存空間。</p>' : ''}
    <div class="dlg-actions"><button type="button" class="ghost" id="dlg-cancel">取消</button><button class="primary" value="ok">匯入</button></div>`;
  return showDialog(
    () => ({ mode: dlgForm.querySelector('[name=pdf-mode]:checked').value, range: $('dlg-range').value }),
    () => dlgForm.querySelector('[value=ok]').focus(),
  );
}

// ---------- 選單 ----------
const menu = $('menu');
let menuCleanup = null;

function openMenu(anchor, entries) {
  closeMenu();
  menu.innerHTML = '';
  for (const en of entries) {
    if (en.sep) { menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); continue; }
    if (en.heading) { menu.insertAdjacentHTML('beforeend', `<div class="menu-heading">${esc(en.heading)}</div>`); continue; }
    if (en.row) {
      const row = document.createElement('div');
      row.className = 'menu-row';
      for (const it of en.row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = (it.swatch ? 'menu-swatch' : 'menu-chip') + (it.on ? ' on' : '');
        if (it.swatch) { b.style.setProperty('--c', it.swatch); b.setAttribute('aria-label', '顏色'); } else b.textContent = it.label;
        b.disabled = !!it.disabled;
        b.addEventListener('click', () => { closeMenu(); it.action(); });
        row.appendChild(b);
      }
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (en.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.disabled = !!en.disabled;
    b.innerHTML = `<span class="mi-check">${en.check ? icons.check : ''}</span>${en.swatchDot ? `<span class="mi-dot" style="--c:${en.swatchDot}"></span>` : ''}<span class="mi-label">${esc(en.label)}${en.hint ? `<small>${esc(en.hint)}</small>` : ''}</span>`;
    b.addEventListener('click', () => { closeMenu(); en.action(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.left));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
  };
  menu.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}

function closeMenu() {
  menu.hidden = true;
  if (menuCleanup) menuCleanup();
  menuCleanup = null;
}

// ---------- 對話框（不用 prompt/confirm，在 iPad 主畫面 App 裡也能用） ----------
const dlg = $('dlg');
const dlgForm = $('dlg-form');

function askText({ title, value = '', placeholder = '', ok = '確定' }) {
  dlgForm.innerHTML = `
    <h2 class="dlg-title">${esc(title)}</h2>
    <input class="dlg-input" id="dlg-input" autocomplete="off" placeholder="${esc(placeholder)}">
    <div class="dlg-actions"><button type="button" class="ghost" value="cancel" id="dlg-cancel">取消</button><button class="primary" value="ok">${esc(ok)}</button></div>`;
  const input = $('dlg-input');
  input.value = value;
  return showDialog(() => input.value, () => { input.focus(); input.select(); });
}

function askConfirm({ title, message, ok = '確定', danger = false }) {
  dlgForm.innerHTML = `
    <h2 class="dlg-title">${esc(title)}</h2>
    <p class="dlg-msg">${esc(message)}</p>
    <div class="dlg-actions"><button type="button" class="ghost" value="cancel" id="dlg-cancel">取消</button><button class="${danger ? 'danger-btn' : 'primary'}" value="ok">${esc(ok)}</button></div>`;
  return showDialog(() => true, () => dlgForm.querySelector('[value=ok]').focus());
}

function showDialog(result, onOpen) {
  return new Promise((resolve) => {
    const finish = (val) => {
      dlg.removeEventListener('close', onClose);
      resolve(val);
    };
    const onClose = () => finish(dlg.returnValue === 'ok' ? result() : null);
    dlg.addEventListener('close', onClose);
    $('dlg-cancel').addEventListener('click', () => dlg.close('cancel'));
    dlg.returnValue = '';
    dlg.showModal();
    onOpen();
  });
}

// ---------- 提示 ----------
let toastTimer = null;
function toast(msg, { sticky = false } = {}) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('has-action');
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(hideToast, Math.min(8000, 2400 + msg.length * 60));
}

function toastAction(msg, label, fn) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => { hideToast(); fn(); });
  t.append(span, b);
  t.classList.add('show', 'has-action');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 15000);
}

function hideToast() {
  $('toast').classList.remove('show', 'has-action');
}

// ---------- 鍵盤快速鍵 ----------
window.addEventListener('keydown', (e) => {
  if (dlg.open || !menu.hidden) return;
  if (e.key === 'Escape' && !editor.isTyping()) { editor.clearSelection(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (editor.isTyping()) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSelection(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && editor.hasSelection()) { e.preventDefault(); editor.deleteSelection(); return; }
  if (mod || e.altKey) return;
  const t = TOOLS.find(([, , key]) => key === e.key.toUpperCase());
  if (t) setTool(t[0]);
});

// ---------- 小工具 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatDate(ts).slice(-5);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- 啟動 ----------
async function boot() {
  Object.assign(state, await store.init());
  store.gcAssets().catch(() => { /* 清不掉下次再清 */ });
  store.requestPersist();
  if (narrow.matches) prefs.sidebar = false; // 手機上側邊欄預設收起來
  applySidebar();
  editor.setTool(prefs.tool);
  renderTools();
  const lastPage = state.pages.find((p) => p.id === prefs.lastPage);
  if (lastPage) {
    const sc = state.sections.find((s) => s.id === lastPage.sectionId);
    state.notebookId = sc.notebookId;
    openPage(lastPage.id);
  } else {
    openNotebook(sortByOrder(state.notebooks)[0].id);
  }
}

boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 預覽環境不支援，不影響使用 */ });
}
