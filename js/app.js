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
import { exportPdf } from './pdfexport.js';
import { recognize, backend, getApiKey, setApiKey } from './recognize.js';
import { fileKind, openPdf, prepareImage } from './importer.js';
import * as sync from './sync.js';
import { makeLock, checkLock, isLocked, pickNotebook } from './lock.js';

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
  checkedToBottom: false,
  sidebar: true,
  viewLock: false, // 鎖定畫面：只能捲動和縮放
  lockFab: null, // 懸浮鎖定按鈕：null = 觸控裝置預設顯示
  fabPos: null, // { side: 'left' | 'right', y: 0~1 }
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
      <div class="resizer" id="resize-cols" role="separator" aria-orientation="vertical" aria-label="調整分區欄寬度" title="拖曳調整寬度，點兩下還原"></div>
    </div>
    <div class="resizer edge" id="resize-side" role="separator" aria-orientation="vertical" aria-label="調整側邊欄寬度" title="拖曳調整寬度，點兩下還原"></div>
    <button type="button" class="side-foot" id="side-foot"></button>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">
    <header class="toolbar" id="toolbar">
      <button type="button" class="icon-btn" id="toggle-sidebar" title="顯示／隱藏側邊欄" aria-label="顯示或隱藏側邊欄">${icons.sidebar}</button>
      <div class="tool-group" id="tools" role="toolbar" aria-label="工具"></div>
      <div class="tool-opts" id="tool-opts"></div>
      <button type="button" class="icon-btn" id="insert" title="插入 PDF 或圖片" aria-label="插入 PDF 或圖片">${icons.insert}</button>
      <button type="button" class="icon-btn" id="mindmap" title="新增心智圖" aria-label="新增心智圖">${icons.mindmap}</button>
      <button type="button" class="icon-btn" id="checklist" title="勾選清單" aria-label="勾選清單">${icons.checklist}</button>
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
      <div class="locked" id="locked" hidden>
        <div class="locked-icon">${icons.lock}</div>
        <p class="locked-title" id="locked-title"></p>
        <form class="unlock-form" id="unlock-form" autocomplete="off">
          <input type="password" class="dlg-input" id="unlock-code" placeholder="密碼" aria-label="筆記本密碼" autocomplete="off">
          <button class="primary">解鎖</button>
        </form>
        <p class="locked-msg" id="locked-msg">切換 App 或關掉螢幕後會自動再鎖上。</p>
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
  // 已經被刪掉的頁面（例如在另一台裝置上刪的）不要再存回去
  const contents = [...pendingContent.values()].filter((c) => state.pages.some((p) => p.id === c.id)).map((c) => JSON.parse(JSON.stringify(c)));
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
    const p = (async () => {
      // 這台裝置還沒有的圖片（別台裝置匯入的）從同步伺服器下載
      const a = (await store.getAsset(id).catch(() => null)) || (await sync.fetchAsset(id));
      return a ? URL.createObjectURL(a.blob) : null;
    })();
    assetUrls.set(id, p);
    p.then((url) => { if (!url) assetUrls.delete(id); }); // 拿不到的下次再試
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
  onNotice(msg) {
    toast(msg);
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
editor.setPrefs({ pen: prefs.pen, highlighter: prefs.highlighter, eraserSize: prefs.eraserSize, penOnly: prefs.penOnly, checkedToBottom: prefs.checkedToBottom });

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

// 「⋯」設定面板：圖示分門別類排好。開關類的按了不關面板，直接看到狀態變化
$('more').addEventListener('click', (e) => {
  openPanel(e.currentTarget, () => {
    const page = editor.page;
    const noPage = !page;
    return [
      {
        title: '頁面',
        tiles: [
          ...BACKGROUNDS.map((bg) => ({ bg, label: BG_LABELS[bg], on: page && page.background === bg, disabled: noPage, stay: true, action: () => editor.setBackground(bg) })),
          { icon: 'insert', label: '插入 PDF／圖片', disabled: noPage, action: () => $('insert-file').click() },
        ],
      },
      {
        title: '手寫',
        tiles: [
          { icon: 'penOnly', label: '只用 Pencil 寫字', sub: '手指捲動', on: prefs.penOnly, stay: true, action: togglePenOnly },
          { icon: 'ink2text', label: '整頁轉文字', disabled: noPage, action: () => inkToText(editor.penStrokes()) },
          { icon: 'sliders', label: '辨識設定', action: openRecognizeSettings },
        ],
      },
      {
        title: '清單與檢視',
        tiles: [
          { icon: prefs.viewLock ? 'lock' : 'unlock', label: '鎖定畫面', sub: prefs.viewLock ? '只能捲動、縮放' : '防止誤觸', on: prefs.viewLock, disabled: noPage, stay: true, action: () => setViewLock(!prefs.viewLock) },
          { icon: 'fab', label: '懸浮鎖定按鈕', sub: '可以拖到任何位置', on: fabEnabled(), stay: true, action: toggleFab },
          { icon: 'sortDone', label: '打勾的移到最下面', on: prefs.checkedToBottom, stay: true, action: toggleCheckedToBottom },
          { icon: 'zoomIn', label: '放大', disabled: noPage, stay: true, action: () => editor.zoomBy(1.25) },
          { icon: 'zoomOut', label: '縮小', disabled: noPage, stay: true, action: () => editor.zoomBy(0.8) },
        ],
      },
      {
        title: '匯出',
        tiles: [
          { icon: 'pdf', label: 'PDF', sub: '選擇頁面', disabled: !state.sectionId, action: openPdfExport },
          { icon: 'slides', label: 'PowerPoint', sub: '這一頁', disabled: noPage, action: () => runExport('pptx', 'page') },
          { icon: 'slides', label: 'PowerPoint', sub: '整個分區', disabled: !state.sectionId, action: () => runExport('pptx', 'section') },
          { icon: 'doc', label: 'Word', sub: '這一頁', disabled: noPage, action: () => runExport('docx', 'page') },
          { icon: 'doc', label: 'Word', sub: '整個分區', disabled: !state.sectionId, action: () => runExport('docx', 'section') },
        ],
      },
      {
        title: '資料與同步',
        tiles: [
          { icon: 'cloud', label: '跨裝置同步', sub: syncHint(), on: sync.getConfig().enabled, action: openSyncSettings },
          { icon: 'download', label: '匯出備份', action: exportBackup },
          { icon: 'upload', label: '匯入備份', action: () => $('import-file').click() },
        ],
      },
    ];
  }, versionLine);
});

// 版本和字型狀態：各台裝置版面對不起來時，先確認是不是都更新到同一版
const APP_VERSION = 'v20';
function versionLine() {
  const font = !document.fonts || !document.fonts.check ? '' : document.fonts.check('16px "Noto Sans TC"', '筆記')
    ? '筆記字型已載入' : '筆記字型還沒載入（正在用系統字型，換行可能和其他裝置不同）';
  return `Folio ${APP_VERSION}${font ? ' · ' + font : ''}`;
}

function togglePenOnly() {
  prefs.penOnly = !prefs.penOnly;
  savePrefs();
  editor.setPrefs({ penOnly: prefs.penOnly });
  toast(prefs.penOnly ? '只有 Apple Pencil 會寫字，手指用來捲動。' : '手指也可以寫字了。');
}

// ---------- 側邊欄 ----------
function sectionsOf(nbId) { return sortByOrder(state.sections.filter((s) => s.notebookId === nbId)); }
function pagesOf(scId) { return sortByOrder(state.pages.filter((p) => p.sectionId === scId)); }

function renderSidebar() {
  const nb = state.notebooks.find((n) => n.id === state.notebookId);
  $('nb-name').textContent = nb ? nb.name : '';
  const locked = isLocked(nb, unlocked);
  $('nb-switch').classList.toggle('is-locked', locked);
  $('add-section').disabled = locked;
  if (locked) {
    // 上鎖中：分區和頁面的名稱也不顯示
    $('section-list').innerHTML = '<li class="hint">已上鎖</li>';
    $('pages-head').textContent = '頁面';
    $('sidebar').style.setProperty('--sc', 'var(--accent)');
    $('page-list').innerHTML = '';
    $('add-page').disabled = true;
    renderSyncStatus();
    return;
  }
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
  renderSyncStatus();
}

function renderSyncStatus(st = sync.getStatus()) {
  const foot = $('side-foot');
  if (!store.persistent) {
    foot.innerHTML = '<span class="dot warn"></span>這個瀏覽器不能存資料，關掉就會消失';
    return;
  }
  const time = st.at ? new Date(st.at).toTimeString().slice(0, 5) : '';
  const text = {
    off: ['', '存在這台裝置 · 開啟跨裝置同步'],
    idle: ['ok', time ? `已同步 · ${time}` : '已同步'],
    syncing: ['busy', '同步中…'],
    offline: ['warn-soft', '離線中，連上網後會自動同步'],
    unauthorized: ['warn', '同步密碼不對，點這裡重新設定'],
    error: ['warn', st.message || '同步失敗，稍後會再試'],
  }[st.state] || ['', ''];
  foot.innerHTML = `<span class="dot ${text[0]}"></span><span>${esc(text[1])}</span>`;
}

$('side-foot').addEventListener('click', () => openSyncSettings());

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

// 側邊欄的點擊：手指和 Pencil 在放開的那一下就算數。
// iOS 有時會把第一下當成「滑鼠移過去」而不送出 click，變成要點兩下才打得開
function onTap(el, handler) {
  let down = null;
  let swallowUntil = 0;
  el.addEventListener('pointerdown', (e) => {
    down = e.pointerType === 'mouse' ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target };
  });
  el.addEventListener('pointercancel', () => { down = null; });
  el.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    swallowUntil = Date.now() + 700; // 之後瀏覽器補送的 click 不要再處理一次
    handler(d.target);
  });
  el.addEventListener('click', (e) => {
    if (Date.now() < swallowUntil) return;
    handler(e.target);
  });
}

onTap($('section-list'), (target) => {
  const open = target.closest('[data-open-section]');
  const menu = target.closest('[data-section-menu]');
  if (menu) sectionMenu(menu, menu.dataset.sectionMenu);
  else if (open) openSection(open.dataset.openSection);
});

onTap($('page-list'), (target) => {
  const open = target.closest('[data-open-page]');
  const menu = target.closest('[data-page-menu]');
  if (menu) pageMenu(menu, menu.dataset.pageMenu);
  else if (open) { openPage(open.dataset.openPage); closeDrawerIfNarrow(); }
});

$('nb-switch').addEventListener('click', (e) => {
  const list = visibleNotebooks();
  const cur = currentNotebook();
  const locked = isLocked(cur, unlocked);
  const hiddenCount = state.notebooks.filter((n) => n.hidden).length;
  const othersVisible = state.notebooks.some((n) => n.id !== cur?.id && !n.hidden);
  const status = (n) => [n.hidden ? '已隱藏' : '', n.lock ? (unlocked.has(n.id) ? '已解鎖' : '已上鎖') : ''].filter(Boolean).join(' · ');
  openMenu(e.currentTarget, [
    ...list.map((n) => ({ label: n.name, hint: status(n), check: n.id === state.notebookId, action: () => openNotebook(n.id) })),
    { sep: true },
    { label: '新增筆記本…', action: addNotebook },
    { label: '調整筆記本順序…', action: arrangeNotebooks, disabled: list.length < 2 },
    { label: '重新命名這本…', action: renameNotebook, disabled: locked },
    { sep: true },
    cur && cur.hidden
      ? { label: '取消隱藏這本', action: () => setHidden(cur, false) }
      : { label: '隱藏這本', hint: othersVisible ? '不會出現在筆記本清單' : '至少要留一本沒隱藏的', action: () => setHidden(cur, true), disabled: !cur || !othersVisible },
    cur && cur.lock
      ? { label: '移除這本的密碼…', action: () => removeLock(cur), disabled: locked }
      : { label: '幫這本設密碼…', hint: '打開時要輸入密碼', action: () => setLock(cur), disabled: !cur },
    ...(hiddenCount ? [revealHidden
      ? { label: '再次隱藏筆記本', action: lockNow }
      : { label: `顯示隱藏的筆記本（${hiddenCount}）`, action: showHidden }] : []),
    ...(unlocked.size ? [{ label: '立即上鎖', hint: '鎖上剛剛解鎖的筆記本', action: lockNow }] : []),
    { sep: true },
    { label: '刪除這本…', danger: true, action: deleteNotebook, disabled: state.notebooks.length < 2 || locked },
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
// ---------- 側邊欄寬度：拖曳分隔線調整，點兩下還原 ----------
const SIDE_W = { def: 380, min: 260, max: 720 };
const SEC_W = { def: 150, min: 90, minPages: 130 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function applyWidths() {
  const root = document.documentElement.style;
  const side = clamp(prefs.sideW || SIDE_W.def, SIDE_W.min, SIDE_W.max);
  // 窄螢幕是抽屜，最多佔畫面 88%
  root.setProperty('--sidebar-w', narrow.matches ? `min(${side}px, 88vw)` : `${side}px`);
  const sideNow = $('sidebar').getBoundingClientRect().width || side;
  const sec = clamp(prefs.secW || (narrow.matches ? 140 : SEC_W.def), SEC_W.min, Math.max(SEC_W.min, sideNow - SEC_W.minPages));
  root.setProperty('--sec-w', `${sec}px`);
}
function dragResize(handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    handle.classList.add('active');
    const startX = e.clientX;
    const start = onMove.start();
    const move = (ev) => onMove.move(start + ev.clientX - startX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      handle.classList.remove('active');
      savePrefs();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
dragResize($('resize-cols'), {
  start: () => $('sidebar').querySelector('.col.sections').getBoundingClientRect().width,
  move: (w) => { prefs.secW = Math.round(w); applyWidths(); },
});
dragResize($('resize-side'), {
  start: () => $('sidebar').getBoundingClientRect().width,
  move: (w) => {
    prefs.sideW = Math.round(clamp(w, SIDE_W.min, SIDE_W.max));
    // 側邊欄縮窄時分區欄跟著縮，頁面欄至少留一點寬度
    if (prefs.secW) prefs.secW = Math.min(prefs.secW, prefs.sideW - SEC_W.minPages);
    applyWidths();
  },
});
$('resize-cols').addEventListener('dblclick', () => { delete prefs.secW; savePrefs(); applyWidths(); });
$('resize-side').addEventListener('dblclick', () => { delete prefs.sideW; delete prefs.secW; savePrefs(); applyWidths(); });
narrow.addEventListener('change', applyWidths);
applyWidths();

function closeDrawerIfNarrow() {
  if (narrow.matches && prefs.sidebar) { prefs.sidebar = false; savePrefs(); applySidebar(); }
}

// ---------- 開啟 ----------
function openNotebook(id) {
  const nb = state.notebooks.find((n) => n.id === id);
  if (isLocked(nb, unlocked)) { showLocked(nb); return; }
  state.notebookId = id;
  const sections = sectionsOf(id);
  const last = prefs.last[id];
  const sc = sections.find((s) => s.id === last) || sections[0];
  if (sc) openSection(sc.id); else { state.sectionId = null; state.pageId = null; showPage(null); renderSidebar(); }
}

function openSection(id) {
  const sc = state.sections.find((s) => s.id === id);
  if (!sc) return;
  const nb = state.notebooks.find((n) => n.id === sc.notebookId);
  if (isLocked(nb, unlocked)) { showLocked(nb); return; }
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
  const sc0 = state.sections.find((s) => s.id === page.sectionId);
  const nb0 = sc0 && state.notebooks.find((n) => n.id === sc0.notebookId);
  if (isLocked(nb0, unlocked)) { showLocked(nb0); return; }
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
  $('locked').hidden = true;
  $('empty').hidden = !!page || !state.sectionId;
  editorEl.hidden = !page;
  if (page) editor.load(page, content);
  renderFab();
}

// ---------- 鎖定畫面＋懸浮按鈕（像 iPhone 的輔助觸控，可以拖到任何位置） ----------
const coarse = window.matchMedia('(pointer: coarse)');
function fabEnabled() { return prefs.lockFab == null ? coarse.matches : prefs.lockFab; }

function setViewLock(on) {
  prefs.viewLock = !!on;
  savePrefs();
  editor.setReadOnly(prefs.viewLock);
  document.body.classList.toggle('view-locked', prefs.viewLock);
  renderFab();
  toast(prefs.viewLock ? '已鎖定畫面：只能捲動和縮放，不會點到內容。' : '已解除鎖定，可以編輯了。');
}

function toggleFab() {
  prefs.lockFab = !fabEnabled();
  savePrefs();
  renderFab();
}

const fab = document.createElement('button');
fab.type = 'button';
fab.className = 'lock-fab';
document.body.appendChild(fab);
const FAB_SIZE = 52;
let fabIdle = null;

function renderFab() {
  fab.hidden = !fabEnabled() || editorEl.hidden;
  fab.innerHTML = prefs.viewLock ? icons.lock : icons.unlock;
  fab.classList.toggle('on', prefs.viewLock);
  fab.setAttribute('aria-pressed', String(prefs.viewLock));
  fab.setAttribute('aria-label', prefs.viewLock ? '解除鎖定畫面' : '鎖定畫面');
  fab.title = prefs.viewLock ? '點一下解除鎖定（拖曳可以移動按鈕）' : '點一下鎖定畫面（拖曳可以移動按鈕）';
  if (!fab.hidden) placeFab();
  wakeFab();
}

function placeFab() {
  const pos = prefs.fabPos || { side: 'right', y: 0.72 };
  const margin = 12;
  const x = pos.side === 'left' ? margin : window.innerWidth - FAB_SIZE - margin;
  const y = Math.min(window.innerHeight - FAB_SIZE - 24, Math.max(64, pos.y * window.innerHeight));
  fab.style.left = x + 'px';
  fab.style.top = y + 'px';
}

// 一陣子沒碰就變淡，比較不擋畫面
function wakeFab() {
  fab.classList.remove('idle');
  clearTimeout(fabIdle);
  fabIdle = setTimeout(() => fab.classList.add('idle'), 2500);
}

fab.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  fab.setPointerCapture(e.pointerId);
  wakeFab();
  const r = fab.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  let moved = false;
  const sx = e.clientX;
  const sy = e.clientY;
  fab.classList.add('dragging');
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
    moved = true;
    fab.style.left = Math.min(window.innerWidth - FAB_SIZE, Math.max(0, ev.clientX - dx)) + 'px';
    fab.style.top = Math.min(window.innerHeight - FAB_SIZE, Math.max(0, ev.clientY - dy)) + 'px';
  };
  const up = (ev) => {
    fab.removeEventListener('pointermove', move);
    fab.removeEventListener('pointerup', up);
    fab.removeEventListener('pointercancel', up);
    fab.classList.remove('dragging');
    if (!moved) {
      if (ev.type === 'pointerup') setViewLock(!prefs.viewLock);
      return;
    }
    // 放開後貼到比較近的左邊或右邊
    const b = fab.getBoundingClientRect();
    prefs.fabPos = { side: b.left + FAB_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right', y: b.top / window.innerHeight };
    savePrefs();
    placeFab();
    wakeFab();
  };
  fab.addEventListener('pointermove', move);
  fab.addEventListener('pointerup', up);
  fab.addEventListener('pointercancel', up);
});
fab.addEventListener('click', (e) => e.preventDefault()); // 鍵盤操作（Enter／空白鍵）才走這裡
fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewLock(!prefs.viewLock); } });
window.addEventListener('resize', () => { if (!fab.hidden) placeFab(); });

// 鎖定中按了畫筆、插入、復原這些會改內容的按鈕：先自動解除鎖定
$('toolbar').addEventListener('click', (e) => {
  if (!prefs.viewLock) return;
  const b = e.target.closest('button');
  if (!b || ['toggle-sidebar', 'more', 'zoom'].includes(b.id)) return;
  setViewLock(false);
}, true);

// ---------- 隱藏、上鎖 ----------
// unlocked、revealHidden 只存在記憶體：重新整理、切換 App 或關掉螢幕就會恢復成鎖上、隱藏
const unlocked = new Set();
let revealHidden = false;

function currentNotebook() { return state.notebooks.find((n) => n.id === state.notebookId); }
function visibleNotebooks() { return sortByOrder(state.notebooks).filter((n) => !n.hidden || revealHidden || n.id === state.notebookId); }
function defaultNotebookId() { return pickNotebook(sortByOrder(state.notebooks), { unlocked, revealHidden })?.id; }

async function showLocked(nb) {
  await flush();
  state.notebookId = nb.id;
  state.sectionId = null;
  state.pageId = null;
  editorEl.hidden = true;
  $('empty').hidden = true;
  $('locked').hidden = false;
  renderFab();
  $('locked-title').textContent = `「${nb.name}」已上鎖`;
  $('unlock-code').value = '';
  renderSidebar();
  if (!narrow.matches) $('unlock-code').focus({ preventScroll: true });
}

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nb = currentNotebook();
  const code = $('unlock-code').value;
  if (!nb || !code) return;
  if (!(await checkLock(nb.lock, code))) {
    $('unlock-code').value = '';
    $('unlock-code').focus();
    toast('密碼不對。');
    return;
  }
  unlocked.add(nb.id);
  $('unlock-code').blur();
  openNotebook(nb.id);
});

// 不在畫面上的時候（切 App、關螢幕、換分頁）全部鎖回去
function lockNow() {
  const had = unlocked.size || revealHidden;
  unlocked.clear();
  revealHidden = false;
  const cur = currentNotebook();
  if (cur && (cur.lock || cur.hidden)) {
    const id = defaultNotebookId();
    if (id) openNotebook(id);
  } else {
    renderSidebar();
  }
  return had;
}
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') lockNow(); });

async function showHidden() {
  revealHidden = true;
  toast('隱藏的筆記本會先顯示在清單裡，切換 App 或關掉螢幕後會再隱藏。');
}

async function setHidden(nb, hidden) {
  if (hidden) nb.hidden = true; else delete nb.hidden;
  nb.updatedAt = Date.now();
  await store.put('notebooks', nb);
  if (hidden) {
    revealHidden = false;
    toast(`已隱藏「${nb.name}」。要找回來：點筆記本名稱 › 顯示隱藏的筆記本。`);
    openNotebook(defaultNotebookId());
  } else {
    renderSidebar();
  }
}

async function setLock(nb) {
  dlgForm.innerHTML = `
    <h2 class="dlg-title">幫「${esc(nb.name)}」設密碼</h2>
    <p class="dlg-msg">打開這本時要輸入密碼。切換 App、關掉螢幕或換分頁後會自動鎖上。密碼會同步到其他裝置。</p>
    <input type="password" class="dlg-input" id="lock-a" placeholder="密碼（至少 4 個字）" autocomplete="new-password">
    <input type="password" class="dlg-input" id="lock-b" placeholder="再輸入一次" autocomplete="new-password" style="margin-top:8px">
    <p class="dlg-hint" style="margin-top:10px">請記好密碼，忘記的話 Folio 裡打不開這本（資料不會消失，「匯出備份」的檔案裡還有）。這是防止別人看到用的，筆記內容本身沒有加密。</p>
    <div class="dlg-actions"><button type="button" class="ghost" id="dlg-cancel">取消</button><button class="primary" value="ok">設定密碼</button></div>`;
  const res = await showDialog(() => ({ a: $('lock-a').value, b: $('lock-b').value }), () => $('lock-a').focus());
  if (!res) return;
  if ([...res.a].length < 4) { toast('密碼至少要 4 個字。'); return; }
  if (res.a !== res.b) { toast('兩次輸入的密碼不一樣，請再設一次。'); return; }
  nb.lock = await makeLock(res.a);
  nb.updatedAt = Date.now();
  await store.put('notebooks', nb);
  unlocked.add(nb.id); // 剛設好先不鎖，離開畫面後才鎖
  renderSidebar();
  toast(`已幫「${nb.name}」設密碼。切換 App 或按「立即上鎖」就會鎖上。`);
}

async function removeLock(nb) {
  const ok = await askConfirm({ title: `移除「${nb.name}」的密碼？`, message: '之後打開這本不用再輸入密碼，其他裝置也一樣。', ok: '移除密碼' });
  if (!ok) return;
  delete nb.lock;
  nb.updatedAt = Date.now();
  await store.put('notebooks', nb);
  unlocked.delete(nb.id);
  renderSidebar();
  toast('已移除密碼。');
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
  openNotebook(defaultNotebookId());
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

// 調整筆記本順序：一個清單，每本旁邊有上移、下移，按了馬上生效
function arrangeNotebooks() {
  const render = () => {
    const list = visibleNotebooks();
    $('arrange-list').innerHTML = list.map((n, i) => `
      <li class="arrange-row${n.id === state.notebookId ? ' current' : ''}">
        <span class="arrange-name">${icons.book}<span>${esc(n.name)}</span></span>
        <button type="button" class="icon-btn small" data-move="${n.id}" data-delta="-1" aria-label="上移「${esc(n.name)}」" ${i === 0 ? 'disabled' : ''}>${icons.chevron}</button>
        <button type="button" class="icon-btn small down" data-move="${n.id}" data-delta="1" aria-label="下移「${esc(n.name)}」" ${i === list.length - 1 ? 'disabled' : ''}>${icons.chevron}</button>
      </li>`).join('');
  };
  dlgForm.innerHTML = `
    <h2 class="dlg-title">調整筆記本順序</h2>
    <p class="dlg-msg">按箭頭上下移動。順序也會同步到其他裝置。</p>
    <ul class="arrange-list" id="arrange-list"></ul>
    <div class="dlg-actions"><button type="button" id="dlg-cancel" hidden></button><button class="primary" value="ok">完成</button></div>`;
  render();
  $('arrange-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-move]');
    if (!b || b.disabled) return;
    await reorder('notebooks', visibleNotebooks(), b.dataset.move, Number(b.dataset.delta));
    render();
    // 移動後焦點留在同一本的按鈕上，方便連續按
    const again = $('arrange-list').querySelector(`[data-move="${b.dataset.move}"][data-delta="${b.dataset.delta}"]`);
    (again && !again.disabled ? again : $('arrange-list').querySelector(`[data-move="${b.dataset.move}"]:not([disabled])`))?.focus();
  });
  showDialog(() => true, () => dlgForm.querySelector('[value=ok]').focus());
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

// ---------- 匯出 PDF ----------
// 勾選分區裡要輸出的頁面，每頁照畫面的樣子畫成 A4
async function openPdfExport() {
  if (exporting) return;
  const sc = state.sections.find((x) => x.id === state.sectionId);
  const pages = pagesOf(state.sectionId);
  if (!sc || !pages.length) { toast('這個分區沒有頁面。'); return; }
  dlgForm.innerHTML = `
    <h2 class="dlg-title">匯出 PDF</h2>
    <p class="dlg-msg">勾選要放進 PDF 的頁面（${esc(sc.name)}）。</p>
    <label class="pdf-all"><input type="checkbox" id="pdf-all" checked><span>全選</span></label>
    <div class="pdf-pages">${pages.map((p) => `
      <label class="pdf-page${p.id === state.pageId ? ' current' : ''}"><input type="checkbox" name="pdf-page" value="${esc(p.id)}" checked><span>${esc(pageDisplayTitle(p))}</span><small>${p.id === state.pageId ? '目前這頁' : esc(shortDate(p.updatedAt))}</small></label>`).join('')}
    </div>
    <label class="pdf-opt"><input type="checkbox" id="pdf-bg"><span>保留頁面的格線</span></label>
    <div class="dlg-actions"><button type="button" class="ghost" id="dlg-cancel">取消</button><button class="primary" value="ok" id="pdf-ok">匯出 PDF</button></div>`;
  const boxes = [...dlgForm.querySelectorAll('[name=pdf-page]')];
  const all = $('pdf-all');
  const refresh = () => {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    $('pdf-ok').disabled = n === 0;
    $('pdf-ok').textContent = n ? `匯出 PDF（${n} 頁）` : '匯出 PDF';
  };
  all.addEventListener('change', () => { for (const b of boxes) b.checked = all.checked; refresh(); });
  for (const b of boxes) b.addEventListener('change', refresh);
  refresh();
  const choice = await showDialog(
    () => ({ ids: boxes.filter((b) => b.checked).map((b) => b.value), background: $('pdf-bg').checked }),
    () => $('pdf-ok').focus(),
  );
  if (!choice || !choice.ids.length) return;
  exporting = true;
  try {
    await flush();
    const chosen = pages.filter((p) => choice.ids.includes(p.id));
    toast('正在產生 PDF…', { sticky: true });
    const entries = [];
    for (const p of chosen) {
      const c = await store.getContent(p.id);
      entries.push({ page: p, items: c ? c.items : [] });
    }
    const title = chosen.length === 1 ? pageDisplayTitle(chosen[0]) : sc.name;
    const blob = await exportPdf(entries, title, (id) => store.getAsset(id), {
      background: choice.background,
      onProgress: (i, n) => toast(`正在產生 PDF…（${i}/${n}）`, { sticky: true }),
    });
    await deliver(blob, `${safeFilename(title)}.pdf`);
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

// ---------- 跨裝置同步 ----------
function syncHint() {
  const st = sync.getStatus().state;
  return { off: '未開啟', idle: '已開啟', syncing: '同步中', offline: '離線中', unauthorized: '密碼不對', error: '有問題' }[st] || '';
}

// claude.ai 的預覽連不到外部伺服器
const inPreview = !!(globalThis.claude && typeof globalThis.claude.use === 'function');

async function openSyncSettings() {
  if (inPreview) {
    await askConfirm({ title: '預覽版不能同步', message: '請在你部署到 Cloudflare 的網址開啟 Folio，再到這裡設定跨裝置同步。', ok: '知道了' });
    return;
  }
  const cfg = sync.getConfig();
  const st = sync.getStatus();
  const pending = await sync.pendingCount();
  const statusText = cfg.enabled
    ? ({ idle: '已開啟，資料是最新的。', syncing: '正在同步…', offline: '目前離線，連上網後會自動同步。', unauthorized: '同步密碼不對，請重新輸入。', error: st.message || '同步時發生問題，稍後會再試。' }[st.state] || '已開啟。') + (pending ? `（還有 ${pending} 筆變更等著送出）` : '')
    : '開啟後，這台裝置的筆記會和其他裝置自動同步。每台裝置都要輸入同一組同步密碼。';
  dlgForm.innerHTML = `
    <h2 class="dlg-title">跨裝置同步</h2>
    <p class="dlg-msg">${esc(statusText)}</p>
    <label class="dlg-label" for="sync-token">同步密碼</label>
    <input class="dlg-input" id="sync-token" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="和 Cloudflare 上設定的 SYNC_TOKEN 一樣">
    <label class="dlg-show"><input type="checkbox" id="sync-show"> 顯示密碼</label>
    <details class="dlg-more"><summary>進階：同步伺服器網址</summary>
      <input class="dlg-input" id="sync-url" autocomplete="off" spellcheck="false" placeholder="留空＝目前這個網址">
    </details>
    <div class="dlg-actions">
      ${cfg.enabled ? '<button type="button" class="ghost danger-text" data-close="disable">停用同步</button><span class="spacer"></span><button type="button" class="ghost" data-close="now">立即同步</button><button type="submit" class="primary" value="save">儲存</button>' : '<button type="button" class="ghost" id="dlg-cancel">取消</button><button type="submit" class="primary" value="enable">開啟同步</button>'}
    </div>`;
  if (cfg.enabled) dlgForm.insertAdjacentHTML('beforeend', '<button type="button" id="dlg-cancel" hidden></button>');
  // 這兩個不是送出按鈕：在密碼欄按 Enter 只會儲存，不會誤按到停用
  for (const b of dlgForm.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close(b.dataset.close));
  $('sync-token').value = cfg.token;
  $('sync-show').addEventListener('change', (e) => { $('sync-token').type = e.target.checked ? 'text' : 'password'; });
  $('sync-url').value = cfg.url;
  const choice = await showDialogChoice(() => ({ token: $('sync-token').value.trim(), url: $('sync-url').value.trim() }));
  if (!choice) return;
  const { action, value } = choice;
  if (action === 'disable') {
    const ok = await askConfirm({ title: '停用同步？', message: '這台裝置的筆記會保留，但之後的修改不會再同步。雲端上的資料不會被刪除。', ok: '停用' });
    if (ok) { await sync.disable(); toast('已停用同步。'); }
    return;
  }
  if (action === 'now') { sync.syncNow(); return; }
  if (value.token.length < 8) {
    toast('同步密碼至少要 8 個字。');
    return;
  }
  if (action === 'save' && value.token === cfg.token && value.url === cfg.url) return;
  toast('正在連線…', { sticky: true });
  const res = await sync.probe(value.url, value.token);
  if (!res.ok) {
    toast({
      unauthorized: '同步密碼和 Cloudflare 上的 SYNC_TOKEN 不一樣。可以勾「顯示密碼」檢查大小寫。',
      offline: '連不上同步伺服器。請確認網路，或是不是在 Folio 自己的網址（workers.dev）開啟的。',
      not_configured: 'Cloudflare 上的 SYNC_TOKEN 不見了。請到 Variables and Secrets 重新新增，類型選「Secret」（設成 Text 的話，每次更新都可能被清掉）。',
    }[res.code] || `連線失敗（${res.code}），請稍後再試。`);
    return;
  }
  let mode = 'upload';
  if (res.records > 0 && action === 'enable') {
    mode = await askSyncMode();
    if (!mode) { hideToast(); return; }
  } else if (action === 'save') {
    mode = 'merge';
  }
  toast('正在同步…', { sticky: true });
  try {
    await flush();
    await sync.enable(value.url, value.token, mode);
    await reloadFromStore();
    toast(mode === 'replace' ? '已換成雲端的筆記。' : '已開啟同步。');
  } catch (e) {
    console.error(e);
    toast(`開啟同步時出錯：${e && e.message ? e.message : e}。請截圖給開發者。`);
  }
}

function askSyncMode() {
  dlgForm.innerHTML = `
    <h2 class="dlg-title">雲端已經有筆記了</h2>
    <p class="dlg-msg">這台裝置要怎麼處理？</p>
    <div class="import-opts" role="radiogroup">
      <label class="import-opt"><input type="radio" name="sync-mode" value="replace" checked><span>使用雲端的筆記<small>這台裝置目前的內容會被雲端的取代。新裝置選這個。</small></span></label>
      <label class="import-opt"><input type="radio" name="sync-mode" value="merge"><span>合併兩邊<small>兩邊的筆記都保留。同名的筆記本會出現兩本。</small></span></label>
    </div>
    <div class="dlg-actions"><button type="button" class="ghost" id="dlg-cancel">取消</button><button class="primary" value="ok">繼續</button></div>`;
  return showDialog(() => dlgForm.querySelector('[name=sync-mode]:checked').value, () => dlgForm.querySelector('[value=ok]').focus());
}

// 對話框有好幾個按鈕時：回傳 { action, value }，取消回傳 null
function showDialogChoice(read) {
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = dlg.returnValue;
      resolve(v && v !== 'cancel' ? { action: v, value: read() } : null);
    };
    dlg.addEventListener('close', onClose);
    $('dlg-cancel').addEventListener('click', () => dlg.close('cancel'));
    dlg.returnValue = '';
    dlg.showModal();
    $('sync-token').focus();
  });
}

// 別台裝置的變更寫進本機之後：更新側邊欄，打開的那頁換成新內容
async function onRemoteApplied({ structure, pages }) {
  if (structure) await reloadIndex();
  // 別台裝置剛幫這本設了密碼
  const cur = currentNotebook();
  if (state.pageId && isLocked(cur, unlocked)) { showLocked(cur); return; }
  if (state.pageId && pages.has(state.pageId)) {
    const page = state.pages.find((p) => p.id === state.pageId);
    const content = await store.getContent(state.pageId);
    if (page && content) editor.replaceItems(page, content.items);
  }
  renderSidebar();
}

// 重新讀清單，但保留原本的物件（編輯器手上拿的頁面物件不能換掉）
async function reloadIndex() {
  const fresh = await store.loadIndex();
  for (const kind of ['notebooks', 'sections', 'pages']) {
    const old = new Map(state[kind].map((x) => [x.id, x]));
    state[kind] = fresh[kind].map((x) => (old.has(x.id) ? Object.assign(old.get(x.id), x) : x));
  }
  if (state.pageId && !state.pages.some((p) => p.id === state.pageId)) {
    toast('這一頁在另一台裝置上被刪除了。');
    state.pageId = null;
    const sc = state.sections.find((x) => x.id === state.sectionId);
    if (sc) openSection(sc.id); else if (state.notebooks.length) openNotebook(defaultNotebookId()); else showPage(null);
  } else if (state.notebookId && !state.notebooks.some((n) => n.id === state.notebookId) && state.notebooks.length) {
    openNotebook(defaultNotebookId());
  }
}

async function reloadFromStore() {
  const fresh = await store.loadIndex();
  Object.assign(state, fresh);
  if (!state.notebooks.length) {
    // 雲端是空的又選了取代：放一份示範內容，不要留下空白畫面
    Object.assign(state, await store.init());
  }
  openLast();
}

// ---------- 插入 PDF、圖片 ----------
let importing = false;

// 按清單按鈕時不要讓正在打字的文字框失去焦點（要把游標那幾行變成清單）
$('checklist').addEventListener('pointerdown', (e) => e.preventDefault());
$('checklist').addEventListener('click', () => {
  if (!editor.page) { toast('請先新增一個頁面。'); return; }
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tb-body');
  // 用畫筆時新增的清單要能直接打字，先切到文字工具
  if (!typing && ['pen', 'highlighter', 'eraser', 'hand'].includes(prefs.tool)) setTool('text');
  editor.toggleChecklist();
});

function toggleCheckedToBottom() {
  prefs.checkedToBottom = !prefs.checkedToBottom;
  savePrefs();
  editor.setPrefs({ checkedToBottom: prefs.checkedToBottom });
  toast(prefs.checkedToBottom ? '打勾的項目會移到清單最下面。' : '打勾的項目會留在原位。');
}

$('mindmap').addEventListener('click', () => {
  if (!editor.page) { toast('請先新增一個頁面。'); return; }
  if (prefs.tool !== 'select' && prefs.tool !== 'text') setTool('select');
  editor.insertMindmap();
});

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
  const asset = { id: await newAssetId(prepared.blob), blob: prepared.blob, w: prepared.w, h: prepared.h };
  await store.putAsset(asset);
  return asset.id;
}

// 圖片 id 用內容的雜湊：同一張圖不管匯入幾次、在哪台裝置，都只存一份、只上傳一次
async function newAssetId(blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return 'as_' + [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

// ---------- 圖示面板 ----------
const panel = document.createElement('div');
panel.className = 'panel';
panel.id = 'panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-label', '設定');
panel.hidden = true;
document.body.appendChild(panel);
let panelCleanup = null;

function openPanel(anchor, build, foot) {
  closeMenu();
  closePanel();
  let groups = [];
  const render = () => {
    groups = build();
    panel.innerHTML = groups.map((g, gi) => `
      <section class="panel-group">
        <h3>${esc(g.title)}</h3>
        <div class="tiles">${g.tiles.map((t, ti) => `
          <button type="button" class="tile${t.on ? ' on' : ''}" data-g="${gi}" data-t="${ti}" ${t.disabled ? 'disabled' : ''} ${t.on != null ? `aria-pressed="${!!t.on}"` : ''}>
            ${t.bg ? `<span class="bg-swatch" data-bg="${t.bg}"></span>` : icons[t.icon]}
            <span class="tile-label">${esc(t.label)}</span>
            ${t.sub ? `<span class="tile-sub">${esc(t.sub)}</span>` : ''}
          </button>`).join('')}
        </div>
      </section>`).join('') + (foot ? `<p class="panel-foot">${esc(foot())}</p>` : '');
  };
  render();
  panel.onclick = (e) => {
    const b = e.target.closest('.tile');
    if (!b || b.disabled) return;
    const t = groups[b.dataset.g].tiles[b.dataset.t];
    if (t.stay) {
      t.action();
      render();
      panel.querySelector(`[data-g="${b.dataset.g}"][data-t="${b.dataset.t}"]`)?.focus();
    } else {
      closePanel();
      t.action();
    }
  };
  panel.hidden = false;
  const r = anchor.getBoundingClientRect();
  if (window.innerWidth >= 600) {
    panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth)) + 'px';
    panel.style.top = r.bottom + 8 + 'px';
  } else {
    panel.style.left = '';
    panel.style.top = '';
  }
  const onDown = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) closePanel(); };
  const onKey = (e) => { if (e.key === 'Escape') closePanel(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
  panelCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
  };
  panel.querySelector('.tile:not([disabled])')?.focus({ preventScroll: true });
}

function closePanel() {
  panel.hidden = true;
  if (panelCleanup) panelCleanup();
  panelCleanup = null;
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
  if (dlg.open || !menu.hidden || !panel.hidden) return;
  if (e.key === 'Escape' && !editor.isTyping()) { editor.clearSelection(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (editor.isTyping()) return;
  if (prefs.viewLock) return; // 鎖定畫面時不接受會改內容的快速鍵
  if (!mod && editor.handleKey(e)) return;
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
  sync.init({
    canApply: (pages) => !(state.pageId && pages.has(state.pageId) && editor.isBusy()),
    beforeApply: flush,
    afterApply: onRemoteApplied,
    status: renderSyncStatus,
    assetArrived: (id) => { assetUrls.delete(id); editor.refreshAsset(id); },
  });
  store.requestPersist();
  if (narrow.matches) prefs.sidebar = false; // 手機上側邊欄預設收起來
  applySidebar();
  editor.setTool(prefs.tool);
  renderTools();
  editor.setReadOnly(prefs.viewLock);
  document.body.classList.toggle('view-locked', prefs.viewLock);
  openLast();
}

// 打開上次看的那頁；那本已上鎖或隱藏的話改開別本（上班打開 App 時不會直接出現）
function openLast() {
  const last = state.pages.find((p) => p.id === prefs.lastPage);
  const sc = last && state.sections.find((s) => s.id === last.sectionId);
  const nb = sc && state.notebooks.find((n) => n.id === sc.notebookId);
  if (nb && !nb.hidden && !nb.lock) {
    state.notebookId = nb.id;
    openPage(last.id);
  } else {
    openNotebook(defaultNotebookId());
  }
}

boot();

// iOS 的兩指捏合會把整個 App 放大（不管 user-scalable=no），放大後捲軸和工具列會跑出畫面。
// 筆記頁面的縮放是編輯器自己處理的，這裡只擋掉整頁縮放
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // iPad 上的 App 常常只是從背景叫回來、不會重新開：回到前景時順便檢查有沒有新版
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* 預覽環境不支援，不影響使用 */ });
  // 新版裝好了：先存檔再重新載入，各台裝置才會用同一版（同樣的字型和排版）
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadController || reloading) return;
    reloading = true;
    const reload = async () => { await flush(); location.reload(); };
    if (document.visibilityState === 'hidden' || !editor.isBusy()) reload();
    else toastAction('Folio 有新版本。', '重新載入', reload);
  });
}
