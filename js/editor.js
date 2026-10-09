// 頁面編輯器：一張可以平移縮放的紙，上面有筆跡（SVG）和文字框（HTML）。
// 工具：select 選取、hand 平移、pen 筆、highlighter 螢光筆、eraser 橡皮擦、text 文字。
// 由下到上的圖層：圖片（匯入的 PDF、截圖）→ 筆跡 → 文字框，所以可以直接在投影片上寫字。

import {
  strokeOutline, simulatedPressure, strokeHit, strokeBounds, strokeInRect, unionBounds,
  rectFromPoints, rectsIntersect, pointInRect, rectContains, compactPoints, translateStroke,
} from './ink.js';
import { newId } from './model.js';
import { textToHtml } from './layout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAW_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
const MIN_Z = 0.25;
const MAX_Z = 4;
const HISTORY_LIMIT = 100;
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI']);

export function inkOptions(stroke) {
  if (stroke.tool === 'highlighter') return { size: stroke.size, thinning: 0, smoothing: 0.5 };
  return { size: stroke.size, thinning: 0.6, smoothing: 0.45 };
}

// 文字框只留基本格式，其他標籤拆掉、屬性全清，避免匯入的資料帶進奇怪的東西。
export function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
        if (!ALLOWED_TAGS.has(child.tagName)) {
          child.replaceWith(...child.childNodes);
        } else {
          for (const a of [...child.attributes]) child.removeAttribute(a.name);
        }
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

export function createEditor(viewport, hooks = {}) {
  const emit = (name, ...args) => hooks[name] && hooks[name](...args);

  viewport.classList.add('viewport');
  viewport.innerHTML = `
    <div class="surface">
      <div class="page-head">
        <input class="page-title" id="page-title" placeholder="頁面標題" autocomplete="off" aria-label="頁面標題">
        <div class="page-date"></div>
      </div>
      <div class="images"></div>
      <svg class="ink" xmlns="${SVG_NS}"></svg>
      <div class="texts"></div>
      <div class="sel-box" hidden><div class="sel-resize" hidden title="拖曳調整大小"></div></div>
      <div class="marquee" hidden></div>
    </div>
    <div class="selbar" hidden>
      <button type="button" data-act="ink2text">轉成文字</button>
      <button type="button" data-act="duplicate">複製</button>
      <button type="button" data-act="delete" class="danger">刪除</button>
    </div>
    <div class="eraser-cursor" hidden></div>`;

  const surface = viewport.querySelector('.surface');
  const svg = viewport.querySelector('.ink');
  const textLayer = viewport.querySelector('.texts');
  const imgLayer = viewport.querySelector('.images');
  const selResize = viewport.querySelector('.sel-resize');
  const titleInput = viewport.querySelector('.page-title');
  const dateEl = viewport.querySelector('.page-date');
  const selBox = viewport.querySelector('.sel-box');
  const marquee = viewport.querySelector('.marquee');
  const selbar = viewport.querySelector('.selbar');
  const eraserCursor = viewport.querySelector('.eraser-cursor');

  let page = null;
  let items = [];
  const els = new Map(); // id → DOM 元素
  let tool = 'pen';
  let prefs = {
    pen: { color: '#1f2a44', size: 3 },
    highlighter: { color: '#f5d33b', size: 18 },
    eraserSize: 12,
    penOnly: false,
  };
  let view = { x: 0, y: 0, z: 1 };
  const views = new Map(); // 每一頁記住上次看的位置
  let undoStack = [];
  let redoStack = [];
  let selection = new Set();
  let gesture = null; // 目前正在進行的單指／筆操作
  const touches = new Map();
  let pinch = null;
  let spaceDown = false;
  let surfaceSize = { w: 2400, h: 3200 };

  // ---------- 座標與視角 ----------
  function toPage(cx, cy) {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  }

  function clampView() {
    const r = viewport.getBoundingClientRect();
    const margin = 48;
    const maxX = margin;
    const maxY = margin;
    const minX = Math.min(maxX, r.width - surfaceSize.w * view.z - margin);
    const minY = Math.min(maxY, r.height - surfaceSize.h * view.z - margin);
    view.x = Math.min(maxX, Math.max(minX, view.x));
    view.y = Math.min(maxY, Math.max(minY, view.y));
  }

  function applyView() {
    clampView();
    surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    surface.style.setProperty('--z', view.z);
    if (page) views.set(page.id, { ...view });
    positionSelbar();
    emit('onZoom', view.z);
  }

  function zoomAt(cx, cy, z) {
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, z));
    const r = viewport.getBoundingClientRect();
    const px = (cx - r.left - view.x) / view.z;
    const py = (cy - r.top - view.y) / view.z;
    view.z = nz;
    view.x = cx - r.left - px * nz;
    view.y = cy - r.top - py * nz;
    applyView();
  }

  function updateSurfaceSize() {
    let maxX = 0;
    let maxY = 0;
    for (const it of items) {
      if (it.type === 'stroke') {
        const b = strokeBounds(it);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      } else {
        maxX = Math.max(maxX, it.x + it.w);
        maxY = Math.max(maxY, it.y + itemBounds(it).h);
      }
    }
    surfaceSize = {
      w: Math.max(1600, maxX + 800),
      h: Math.max(2400, maxY + 1200),
    };
    surface.style.width = surfaceSize.w + 'px';
    surface.style.height = surfaceSize.h + 'px';
    svg.setAttribute('width', surfaceSize.w);
    svg.setAttribute('height', surfaceSize.h);
  }

  // ---------- 繪製 ----------
  function strokeEl(it) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', strokeOutline(it.points, inkOptions(it)));
    path.setAttribute('fill', it.color);
    path.dataset.id = it.id;
    if (it.tool === 'highlighter') path.classList.add('hl');
    return path;
  }

  function textEl(it) {
    const box = document.createElement('div');
    box.className = 'textbox';
    box.dataset.id = it.id;
    box.style.left = it.x + 'px';
    box.style.top = it.y + 'px';
    box.style.width = it.w + 'px';
    box.innerHTML = `<div class="tb-handle" title="拖曳移動"></div><div class="tb-body" contenteditable="true" spellcheck="false"></div><div class="tb-resize" title="拖曳調整寬度"></div>`;
    box.querySelector('.tb-body').innerHTML = sanitizeHtml(it.html);
    return box;
  }

  function imageEl(it) {
    const img = document.createElement('img');
    img.className = 'pimg';
    img.dataset.id = it.id;
    img.alt = '';
    img.draggable = false;
    Object.assign(img.style, { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px' });
    if (hooks.assetUrl) {
      hooks.assetUrl(it.asset).then((url) => { if (url) img.src = url; else img.classList.add('missing'); });
    }
    return img;
  }

  function makeEl(it) {
    if (it.type === 'stroke') return strokeEl(it);
    if (it.type === 'image') return imageEl(it);
    return textEl(it);
  }

  function renderItem(it) {
    const el = makeEl(it);
    els.set(it.id, el);
    if (it.type === 'image') {
      imgLayer.appendChild(el);
    } else if (it.type === 'stroke') {
      // 螢光筆放在筆跡下面，寫在上面的字才不會被蓋住
      if (it.tool === 'highlighter') svg.insertBefore(el, svg.querySelector('path:not(.hl)'));
      else svg.appendChild(el);
    } else {
      textLayer.appendChild(el);
    }
    return el;
  }

  function renderAll() {
    svg.replaceChildren();
    textLayer.replaceChildren();
    imgLayer.replaceChildren();
    els.clear();
    for (const it of items) renderItem(it);
    updateSurfaceSize();
    renderSelection();
  }

  function removeItem(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) items.splice(i, 1);
    const el = els.get(id);
    if (el) el.remove();
    els.delete(id);
    selection.delete(id);
  }

  // ---------- 存檔與復原 ----------
  function snapshot() {
    return JSON.stringify(items);
  }

  function pushUndo(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    emitHistory();
  }

  function emitHistory() {
    emit('onHistory', { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  function commit() {
    if (!page) return;
    page.updatedAt = Date.now();
    updateSurfaceSize();
    emit('onChange', page, { id: page.id, items });
  }

  function undo() {
    if (!undoStack.length) return;
    blurText();
    redoStack.push(snapshot());
    items = JSON.parse(undoStack.pop());
    selection.clear();
    renderAll();
    commit();
    emitHistory();
  }

  function redo() {
    if (!redoStack.length) return;
    blurText();
    undoStack.push(snapshot());
    items = JSON.parse(redoStack.pop());
    selection.clear();
    renderAll();
    commit();
    emitHistory();
  }

  // ---------- 選取 ----------
  function itemBounds(it) {
    if (it.type === 'stroke') return strokeBounds(it);
    if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
    const el = els.get(it.id);
    return { x: it.x, y: it.y, w: it.w, h: el ? el.offsetHeight : 40 };
  }

  function selectionBounds() {
    const list = items.filter((it) => selection.has(it.id)).map(itemBounds);
    return unionBounds(list);
  }

  function renderSelection() {
    for (const [id, el] of els) el.classList.toggle('selected', selection.has(id));
    const b = selection.size ? selectionBounds() : null;
    if (!b) {
      selBox.hidden = true;
      selbar.hidden = true;
      emit('onSelection', 0);
      return;
    }
    const pad = 6;
    const only = selection.size === 1 ? items.find((it) => selection.has(it.id)) : null;
    selResize.hidden = !(only && only.type === 'image');
    selBox.hidden = false;
    Object.assign(selBox.style, { left: b.x - pad + 'px', top: b.y - pad + 'px', width: b.w + pad * 2 + 'px', height: b.h + pad * 2 + 'px', transform: '' });
    selbar.hidden = false;
    selbar.querySelector('[data-act="ink2text"]').hidden = !selectedPenStrokes().length;
    positionSelbar();
    emit('onSelection', selection.size);
  }

  function positionSelbar(dx = 0, dy = 0) {
    if (selbar.hidden) return;
    const b = selectionBounds();
    if (!b) return;
    const sx = (b.x + dx) * view.z + view.x;
    const sy = (b.y + dy) * view.z + view.y;
    const vw = viewport.clientWidth;
    const barW = selbar.offsetWidth || 140;
    const left = Math.min(vw - barW - 8, Math.max(8, sx));
    const top = sy - 52 < 8 ? (b.y + b.h + dy) * view.z + view.y + 14 : sy - 52;
    selbar.style.left = left + 'px';
    selbar.style.top = top + 'px';
  }

  function selectedPenStrokes() {
    return items.filter((it) => selection.has(it.id) && it.type === 'stroke' && it.tool !== 'highlighter');
  }

  // 手寫辨識的結果換掉原本的筆跡，整批算一步復原。results: [{ ids, x, y, w, text }]
  function applyInkToText(pageId, results) {
    if (!page || page.id !== pageId || !results.length) return false;
    blurText();
    const before = snapshot();
    const created = [];
    for (const r of results) {
      for (const id of r.ids) removeItem(id);
      const it = { id: newId('t_'), type: 'text', x: Math.round(r.x), y: Math.round(r.y), w: Math.max(160, Math.round(r.w + 24)), html: textToHtml(r.text) };
      items.push(it);
      renderItem(it);
      created.push(it.id);
    }
    setSelection(tool === 'select' ? created : []);
    pushUndo(before);
    commit();
    return true;
  }

  function setSelection(ids) {
    selection = new Set(ids);
    renderSelection();
  }

  function deleteSelection() {
    if (!selection.size) return;
    const before = snapshot();
    for (const id of [...selection]) removeItem(id);
    renderSelection();
    pushUndo(before);
    commit();
  }

  function duplicateSelection() {
    if (!selection.size) return;
    const before = snapshot();
    const copies = [];
    for (const it of items.filter((x) => selection.has(x.id))) {
      const copy = it.type === 'stroke'
        ? { ...translateStroke(it, 24, 24), id: newId('s_') }
        : { ...it, id: newId(it.type === 'image' ? 'i_' : 't_'), x: it.x + 24, y: it.y + 24 };
      copies.push(copy);
    }
    for (const c of copies) { items.push(c); renderItem(c); }
    setSelection(copies.map((c) => c.id));
    pushUndo(before);
    commit();
  }

  function moveSelectionPreview(dx, dy) {
    for (const id of selection) {
      const el = els.get(id);
      if (!el) continue;
      if (el instanceof SVGElement) el.setAttribute('transform', `translate(${dx} ${dy})`);
      else el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    selBox.style.transform = `translate(${dx}px, ${dy}px)`;
    positionSelbar(dx, dy);
  }

  function moveSelectionCommit(dx, dy, before) {
    items = items.map((it) => {
      if (!selection.has(it.id)) return it;
      if (it.type === 'stroke') return translateStroke(it, dx, dy);
      return { ...it, x: Math.round(it.x + dx), y: Math.round(it.y + dy) };
    });
    for (const id of selection) {
      const old = els.get(id);
      const it = items.find((x) => x.id === id);
      const el = makeEl(it);
      old.replaceWith(el);
      els.set(id, el);
    }
    renderSelection();
    pushUndo(before);
    commit();
  }

  // ---------- 文字框 ----------
  function blurText() {
    const a = document.activeElement;
    if (a && viewport.contains(a) && a.classList.contains('tb-body')) a.blur();
  }

  function createTextAt(x, y) {
    const it = { id: newId('t_'), type: 'text', x: Math.round(x - 8), y: Math.round(y - 22), w: 320, html: '' };
    items.push(it);
    const el = renderItem(it);
    el.dataset.fresh = '1';
    const body = el.querySelector('.tb-body');
    body.focus();
    setSelection([]);
  }

  // 文字框編輯：focus 時記下內容，離開時有改才加入復原紀錄
  let editBefore = null;
  textLayer.addEventListener('focusin', (e) => {
    const body = e.target.closest('.tb-body');
    if (!body) return;
    const box = body.closest('.textbox');
    box.classList.add('editing');
    if (box.dataset.fresh) {
      const copy = JSON.parse(snapshot());
      editBefore = JSON.stringify(copy.filter((x) => x.id !== box.dataset.id));
    } else {
      editBefore = snapshot();
    }
  });

  textLayer.addEventListener('input', (e) => {
    const body = e.target.closest('.tb-body');
    if (!body) return;
    const it = items.find((x) => x.id === body.closest('.textbox').dataset.id);
    if (!it) return;
    it.html = body.innerHTML;
    commit();
  });

  textLayer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest('.tb-body')) { e.preventDefault(); e.target.blur(); }
  });

  textLayer.addEventListener('focusout', (e) => {
    const body = e.target.closest('.tb-body');
    if (!body) return;
    const box = body.closest('.textbox');
    box.classList.remove('editing');
    const id = box.dataset.id;
    const it = items.find((x) => x.id === id);
    delete box.dataset.fresh;
    if (it && !body.textContent.trim()) {
      // 空的文字框不留
      removeItem(id);
      commit();
    }
    if (editBefore != null) pushUndo(editBefore);
    editBefore = null;
  });

  // 貼上只收純文字，格式和外部 HTML 不帶進來
  textLayer.addEventListener('paste', (e) => {
    if (!e.target.closest('.tb-body')) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // 拖曳文字框上方的橫條移動；右邊的把手調整寬度
  textLayer.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.tb-handle, .tb-resize');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const box = handle.closest('.textbox');
    const id = box.dataset.id;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    blurText();
    const start = toPage(e.clientX, e.clientY);
    const before = snapshot();
    const resizing = handle.classList.contains('tb-resize');
    let moved = false;
    try { handle.setPointerCapture(e.pointerId); } catch { /* 同上 */ }
    const onMove = (ev) => {
      const p = toPage(ev.clientX, ev.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!moved && Math.hypot(dx, dy) * view.z < 4) return;
      moved = true;
      if (resizing) {
        box.style.width = Math.max(120, Math.round(it.w + dx)) + 'px';
      } else if (selection.has(id)) {
        moveSelectionPreview(dx, dy);
      } else {
        box.style.transform = `translate(${dx}px, ${dy}px)`;
      }
    };
    const onUp = (ev) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      const p = toPage(ev.clientX, ev.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!moved) {
        setSelection([id]);
        return;
      }
      if (resizing) {
        it.w = Math.max(120, Math.round(it.w + dx));
        renderSelection();
        pushUndo(before);
        commit();
      } else if (selection.has(id)) {
        moveSelectionCommit(dx, dy, before);
      } else {
        setSelection([id]);
        moveSelectionCommit(dx, dy, before);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  // ---------- 指標事件 ----------
  function pressureOf(e, prev, dist) {
    if (e.pointerType === 'pen') return Math.max(0.05, e.pressure || 0.5);
    return simulatedPressure(prev, dist);
  }

  function startStroke(e) {
    const opts = tool === 'highlighter' ? prefs.highlighter : prefs.pen;
    const p = toPage(e.clientX, e.clientY);
    const stroke = { id: newId('s_'), type: 'stroke', tool, color: opts.color, size: opts.size, points: [[p.x, p.y, pressureOf(e, null, 0)]] };
    const el = strokeEl(stroke);
    el.classList.add('live');
    if (tool === 'highlighter') svg.insertBefore(el, svg.querySelector('path:not(.hl)'));
    else svg.appendChild(el);
    return { kind: 'stroke', stroke, el };
  }

  function extendStroke(g, e) {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (events.length ? events : [e])) {
      const p = toPage(ev.clientX, ev.clientY);
      const last = g.stroke.points[g.stroke.points.length - 1];
      const dist = Math.hypot(p.x - last[0], p.y - last[1]) * view.z;
      if (dist < 0.6) continue;
      g.stroke.points.push([p.x, p.y, pressureOf(ev, last[2], dist)]);
    }
    g.el.setAttribute('d', strokeOutline(g.stroke.points, inkOptions(g.stroke)));
  }

  function endStroke(g) {
    g.el.remove();
    const before = snapshot();
    const stroke = { ...g.stroke, points: compactPoints(g.stroke.points) };
    items.push(stroke);
    renderItem(stroke);
    pushUndo(before);
    commit();
  }

  function eraseAt(g, cx, cy) {
    const p = toPage(cx, cy);
    const radius = prefs.eraserSize / view.z;
    const from = g.last || p;
    const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / radius));
    for (let s = 1; s <= steps; s++) {
      const x = from.x + ((p.x - from.x) * s) / steps;
      const y = from.y + ((p.y - from.y) * s) / steps;
      for (const it of items.slice()) {
        if (it.type === 'stroke' && strokeHit(it, x, y, radius)) {
          removeItem(it.id);
          g.changed = true;
        }
      }
    }
    g.last = p;
  }

  function showEraser(cx, cy) {
    const r = viewport.getBoundingClientRect();
    const d = prefs.eraserSize * 2;
    eraserCursor.hidden = false;
    Object.assign(eraserCursor.style, { width: d + 'px', height: d + 'px', left: cx - r.left - d / 2 + 'px', top: cy - r.top - d / 2 + 'px' });
  }

  // 點一下選取：筆跡優先（寫在投影片上的字），再來才是底下的圖片
  function hitItemAt(p) {
    const radius = 8 / view.z;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'stroke' && strokeHit(it, p.x, p.y, radius)) return it;
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'image' && pointInRect(p.x, p.y, it)) return it;
    }
    return null;
  }

  function cancelGesture(g = gesture) {
    gesture = null;
    if (!g) return;
    if (g.kind === 'stroke') g.el.remove();
    if (g.kind === 'erase' && g.changed) { pushUndo(g.before); commit(); }
    if (g.kind === 'marquee') marquee.hidden = true;
    if (g.kind === 'move') moveSelectionPreview(0, 0);
    viewport.classList.remove('panning');
    eraserCursor.hidden = true;
  }

  function startPinch() {
    const [a, b] = [...touches.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view: { ...view },
    };
  }

  function updatePinch() {
    const [a, b] = [...touches.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = viewport.getBoundingClientRect();
    const z = Math.min(MAX_Z, Math.max(MIN_Z, pinch.view.z * (dist / pinch.dist)));
    const px = (pinch.mid.x - r.left - pinch.view.x) / pinch.view.z;
    const py = (pinch.mid.y - r.top - pinch.view.y) / pinch.view.z;
    view.z = z;
    view.x = mid.x - r.left - px * z;
    view.y = mid.y - r.top - py * z;
    applyView();
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.selbar')) return;
    const onText = e.target.closest('.textbox, .page-head');
    if (e.pointerType === 'pen' && !prefs.penOnly) {
      // 第一次用 Apple Pencil 寫字：之後手指只負責捲動
      prefs.penOnly = true;
      emit('onPenDetected');
    }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        cancelGesture();
        startPinch();
        return;
      }
      if (touches.size > 2) return;
    }
    if (onText && !DRAW_TOOLS.has(tool)) return; // 讓文字框自己處理（打字、選字）
    if (e.button === 2) return;
    // 擋掉觸控後補發的滑鼠事件，不然剛建立的文字框會馬上失去焦點
    e.preventDefault();

    const fingerPans = e.pointerType === 'touch' && prefs.penOnly;
    const wantsPan = tool === 'hand' || spaceDown || e.button === 1 || (fingerPans && DRAW_TOOLS.has(tool));
    blurText();
    try { viewport.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
    const start = { cx: e.clientX, cy: e.clientY, view: { ...view } };

    if (wantsPan) {
      gesture = { kind: 'pan', id: e.pointerId, start };
      viewport.classList.add('panning');
    } else if (tool === 'pen' || tool === 'highlighter') {
      gesture = { id: e.pointerId, ...startStroke(e) };
    } else if (tool === 'eraser') {
      gesture = { kind: 'erase', id: e.pointerId, before: snapshot(), changed: false };
      eraseAt(gesture, e.clientX, e.clientY);
      showEraser(e.clientX, e.clientY);
    } else if (tool === 'select' && e.target.closest('.sel-resize')) {
      const it = items.find((x) => selection.has(x.id));
      gesture = { kind: 'resize', id: e.pointerId, from: toPage(e.clientX, e.clientY), item: it, start: { w: it.w, h: it.h }, before: snapshot() };
    } else if (tool === 'select') {
      const p = toPage(e.clientX, e.clientY);
      const b = selection.size ? selectionBounds() : null;
      const slop = 10 / view.z;
      if (b && pointInRect(p.x, p.y, { x: b.x - slop, y: b.y - slop, w: b.w + slop * 2, h: b.h + slop * 2 })) {
        gesture = { kind: 'move', id: e.pointerId, from: p, before: snapshot() };
      } else if (fingerPans) {
        gesture = { kind: 'tap-or-pan', id: e.pointerId, start, from: p };
      } else {
        gesture = { kind: 'marquee', id: e.pointerId, from: p, start };
      }
    } else if (tool === 'text') {
      gesture = { kind: 'tap-or-pan', id: e.pointerId, start, from: toPage(e.clientX, e.clientY), canPan: e.pointerType === 'touch' };
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) { updatePinch(); return; }
    }
    if (tool === 'eraser' && e.pointerType !== 'touch' && !gesture) showEraser(e.clientX, e.clientY);
    if (!gesture || gesture.id !== e.pointerId) return;
    const g = gesture;
    if (g.kind === 'pan') {
      view.x = g.start.view.x + (e.clientX - g.start.cx);
      view.y = g.start.view.y + (e.clientY - g.start.cy);
      applyView();
    } else if (g.kind === 'stroke') {
      extendStroke(g, e);
    } else if (g.kind === 'erase') {
      eraseAt(g, e.clientX, e.clientY);
      showEraser(e.clientX, e.clientY);
    } else if (g.kind === 'move') {
      const p = toPage(e.clientX, e.clientY);
      g.dx = p.x - g.from.x;
      g.dy = p.y - g.from.y;
      moveSelectionPreview(g.dx, g.dy);
    } else if (g.kind === 'resize') {
      const p = toPage(e.clientX, e.clientY);
      const w = Math.max(60, g.start.w + (p.x - g.from.x));
      g.w = Math.round(w);
      g.h = Math.round((w * g.start.h) / g.start.w);
      const el = els.get(g.item.id);
      Object.assign(el.style, { width: g.w + 'px', height: g.h + 'px' });
      Object.assign(selBox.style, { width: g.w + 12 + 'px', height: g.h + 12 + 'px' });
    } else if (g.kind === 'marquee') {
      const p = toPage(e.clientX, e.clientY);
      const r = rectFromPoints(g.from.x, g.from.y, p.x, p.y);
      g.rect = r;
      if (Math.hypot(e.clientX - g.start.cx, e.clientY - g.start.cy) > 4) {
        marquee.hidden = false;
        Object.assign(marquee.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      }
    } else if (g.kind === 'tap-or-pan') {
      if (Math.hypot(e.clientX - g.start.cx, e.clientY - g.start.cy) > 8 && g.canPan !== false) {
        gesture = { kind: 'pan', id: g.id, start: g.start };
        viewport.classList.add('panning');
      }
    }
  });

  function endPointer(e, cancelled) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) pinch = null;
        return;
      }
    }
    if (!gesture || gesture.id !== e.pointerId) return;
    const g = gesture;
    gesture = null;
    viewport.classList.remove('panning');
    eraserCursor.hidden = tool !== 'eraser' || e.pointerType === 'touch';
    if (cancelled) {
      cancelGesture(g);
      return;
    }
    if (g.kind === 'stroke') {
      endStroke(g);
    } else if (g.kind === 'erase') {
      renderSelection();
      if (g.changed) { pushUndo(g.before); commit(); }
    } else if (g.kind === 'move') {
      if (g.dx || g.dy) moveSelectionCommit(g.dx || 0, g.dy || 0, g.before);
    } else if (g.kind === 'resize') {
      if (g.w) {
        Object.assign(g.item, { w: g.w, h: g.h });
        renderSelection();
        pushUndo(g.before);
        commit();
      }
    } else if (g.kind === 'marquee') {
      marquee.hidden = true;
      if (!g.rect || (g.rect.w * view.z < 4 && g.rect.h * view.z < 4)) {
        const hit = hitItemAt(g.from);
        setSelection(hit ? [hit.id] : []);
      } else {
        // 圖片要整張框進去才選，不然在投影片上框選筆跡會連圖片一起選到
        const ids = items.filter((it) => {
          if (it.type === 'stroke') return strokeInRect(it, g.rect);
          if (it.type === 'image') return rectContains(g.rect, it);
          return rectsIntersect(itemBounds(it), g.rect);
        }).map((it) => it.id);
        setSelection(ids);
      }
    } else if (g.kind === 'tap-or-pan') {
      if (tool === 'text') {
        createTextAt(g.from.x, g.from.y);
      } else {
        const hit = hitItemAt(g.from);
        setSelection(hit ? [hit.id] : []);
      }
    }
  }

  viewport.addEventListener('pointerup', (e) => endPointer(e, false));
  viewport.addEventListener('pointercancel', (e) => endPointer(e, true));
  viewport.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch' && !gesture) eraserCursor.hidden = true;
  });
  viewport.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tb-body, .page-title')) e.preventDefault();
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * 0.01));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      view.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      applyView();
    }
  }, { passive: false });

  // Safari 的觸控板捏合
  let gestureZ = 1;
  viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureZ = view.z; });
  viewport.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (touches.size) return; // iPad 上已經用 pointer 事件處理
    zoomAt(e.clientX, e.clientY, gestureZ * e.scale);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping()) { spaceDown = true; viewport.classList.add('can-pan'); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; viewport.classList.remove('can-pan'); }
  });
  window.addEventListener('resize', () => applyView());

  selbar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'delete') deleteSelection();
    if (act === 'duplicate') duplicateSelection();
    if (act === 'ink2text') emit('onInkToText', JSON.parse(JSON.stringify(selectedPenStrokes())));
  });

  titleInput.addEventListener('input', () => {
    if (!page) return;
    page.title = titleInput.value;
    page.updatedAt = Date.now();
    emit('onTitle', page);
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
  });

  function isTyping() {
    const a = document.activeElement;
    return a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }

  // ---------- 對外介面 ----------
  function load(p, content) {
    blurText();
    cancelGesture();
    page = p;
    items = (content && content.items ? content.items : []).map((x) => ({ ...x }));
    undoStack = [];
    redoStack = [];
    selection.clear();
    titleInput.value = page.title || '';
    dateEl.textContent = formatDate(page.createdAt);
    setBackground(page.background || 'ruled', false);
    renderAll();
    view = views.get(page.id) || { x: 0, y: 0, z: viewport.clientWidth < 700 ? 0.75 : 1 };
    applyView();
    emitHistory();
  }

  // 頁面目前內容的最下緣，新匯入的東西往下接
  function contentBottom() {
    let bottom = 120;
    for (const it of items) {
      const b = itemBounds(it);
      bottom = Math.max(bottom, b.y + b.h);
    }
    return bottom;
  }

  // list: [{ asset, w, h }]（w、h 是要顯示的大小）。at: 'below' 接在內容下面往下排；'view' 放在目前看到的地方。
  function insertImages(list, { at = 'below' } = {}) {
    if (!page || !list.length) return [];
    blurText();
    const before = snapshot();
    const created = [];
    let x = 64;
    let y = contentBottom() + 32;
    if (at === 'view') {
      const r = viewport.getBoundingClientRect();
      const c = toPage(r.left + r.width / 2, r.top + r.height / 2);
      x = Math.max(16, Math.round(c.x - list[0].w / 2));
      y = Math.max(16, Math.round(c.y - list[0].h / 2));
    }
    for (const img of list) {
      const it = { id: newId('i_'), type: 'image', x, y: Math.round(y), w: Math.round(img.w), h: Math.round(img.h), asset: img.asset };
      items.push(it);
      renderItem(it);
      created.push(it.id);
      y += img.h + 24;
    }
    // 圖片放在最底層：重新排一次 DOM 不需要，因為圖片有自己的圖層
    if (at === 'below') {
      const first = items.find((it) => it.id === created[0]);
      view.y = Math.min(48, -(first.y - 24) * view.z);
      applyView();
    }
    setSelection(tool === 'select' ? created : []);
    pushUndo(before);
    commit();
    return created;
  }

  function setTool(name) {
    if (tool === name) return;
    blurText();
    tool = name;
    viewport.dataset.tool = name;
    viewport.classList.toggle('mode-draw', DRAW_TOOLS.has(name));
    eraserCursor.hidden = true;
    if (name !== 'select') setSelection([]);
  }

  function setBackground(bg, save = true) {
    surface.dataset.bg = bg;
    if (page && save) {
      page.background = bg;
      page.updatedAt = Date.now();
      emit('onTitle', page);
    }
  }

  function setPrefs(next) {
    prefs = { ...prefs, ...next };
  }

  function zoomBy(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.z * factor);
  }

  function resetZoom() {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1);
  }

  function focusTitle() {
    titleInput.focus();
  }

  viewport.dataset.tool = tool;
  viewport.classList.add('mode-draw');

  return {
    load, setTool, setPrefs, setBackground, undo, redo, zoomBy, resetZoom, focusTitle,
    deleteSelection, duplicateSelection, isTyping,
    get tool() { return tool; },
    get prefs() { return prefs; },
    get page() { return page; },
    hasSelection: () => selection.size > 0,
    clearSelection: () => setSelection([]),
    applyInkToText,
    insertImages,
    penStrokes: () => JSON.parse(JSON.stringify(items.filter((it) => it.type === 'stroke' && it.tool !== 'highlighter'))),
    setBusy(busy) { selbar.classList.toggle('busy', busy); selbar.querySelector('[data-act="ink2text"]').disabled = busy; },
  };
}

export function formatDate(ts) {
  const d = new Date(ts || Date.now());
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd}  ${hh}:${mm}`;
}
