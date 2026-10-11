// 匯出 PDF：把每一頁筆記照畫面上的樣子畫到畫布上（手寫、文字框、勾選清單、心智圖、匯入的圖片），
// 再切成 A4、包成 PDF。每一頁筆記從新的一張 A4 開始；太長的頁面會在空白處切開。

import { strokeBounds, strokeOutline } from './ink.js';
import { clusterBoxes, htmlToParagraphs } from './layout.js';
import { pageDisplayTitle } from './model.js';
import { sanitizeHtml, formatDate, inkOptions } from './editor.js';
import { measureTextHeight } from './inkrender.js';
import { measureMindmap, branchColor } from './mindmap-view.js';
import { edgePath } from './mindmap.js';
import { wrapRuns, pageBreaks, buildPdf, A4 } from './pdfmodel.js';

// 和畫面上的文字框、心智圖同一套字型（css 的 --note-font），換行才會一樣
const FONT = '"Noto Sans TC", -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';
const TITLE_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
const INK = '#1d2330';
const MUTED = '#8a92a0';
const RES = 2; // 畫布每個頁面 px 畫幾個像素
const MAX_CANVAS_W = 2400;

const fontFor = (size, run = {}, weight) => `${run.i ? 'italic ' : ''}${weight || (run.b ? 700 : 400)} ${size}px ${FONT}`;

// ---------- 收集一頁要畫的東西 ----------
async function collect(page, items, getAsset) {
  const draws = [];
  const blocks = [];
  // 標題和日期（位置和畫面上一樣）
  blocks.push({ x: 64, y: 40, w: 640, h: 72 });
  draws.push({ z: 4, fn: (ctx) => drawHeader(ctx, page) });

  for (const it of items) {
    if (it.type === 'text') {
      const html = sanitizeHtml(it.html);
      const h = measureTextHeight(html, it.w);
      const paras = htmlToParagraphs(html);
      // 每一行各算一個區塊，長文字框分頁時切在行與行之間
      const rows = textRows(measureCtx(), it, paras);
      if (rows.length) for (const y of rows) blocks.push({ x: it.x, y: y + 4, w: it.w, h: LINE_H - 8 }); // 上下留空隙，切點才不會一路往上推
      else blocks.push({ x: it.x, y: it.y, w: it.w, h });
      draws.push({ z: 3, fn: (ctx) => drawText(ctx, it, paras) });
    } else if (it.type === 'image') {
      const asset = await getAsset(it.asset);
      if (!asset) continue;
      const bitmap = await createImageBitmap(asset.blob);
      blocks.push({ x: it.x, y: it.y, w: it.w, h: it.h });
      draws.push({ z: 0, fn: (ctx) => ctx.drawImage(bitmap, it.x, it.y, it.w, it.h) });
    } else if (it.type === 'mindmap') {
      const layout = measureMindmap(it);
      const b = layout.bounds;
      blocks.push({ x: it.x + b.x, y: it.y + b.y, w: b.w, h: b.h });
      draws.push({ z: 1, fn: (ctx) => drawMindmap(ctx, it, layout) });
    }
  }
  const strokes = items.filter((it) => it.type === 'stroke');
  for (const c of clusterBoxes(strokes.map((s) => ({ id: s.id, ...strokeBounds(s) })), 24)) blocks.push(c.bounds);
  // 螢光筆在筆跡下面
  draws.push({ z: 2, fn: (ctx) => {
    for (const s of [...strokes.filter((x) => x.tool === 'highlighter'), ...strokes.filter((x) => x.tool !== 'highlighter')]) {
      ctx.globalAlpha = s.tool === 'highlighter' ? 0.38 : 1;
      ctx.fillStyle = s.color;
      ctx.fill(new Path2D(strokeOutline(s.points, inkOptions(s))));
    }
    ctx.globalAlpha = 1;
  } });
  draws.sort((a, b) => a.z - b.z);
  return { draws, blocks };
}

function drawHeader(ctx, page) {
  ctx.fillStyle = INK;
  ctx.font = `600 30px ${TITLE_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText(pageDisplayTitle(page), 64, 46);
  ctx.fillStyle = '#c9d0db';
  ctx.fillRect(64, 84, 640, 1);
  ctx.fillStyle = '#7a8291';
  ctx.font = `400 13px ${TITLE_FONT}`;
  ctx.fillText(formatDate(page.createdAt).replace(/\s+/g, ' '), 64, 98);
}

// 文字框：照 CSS 的排法（內距、行高 1.6、清單縮排、勾選圓圈）
const LINE_H = 16 * 1.6;
let mctx = null;
const measureCtx = () => (mctx ||= document.createElement('canvas').getContext('2d'));

// 文字框每一行的 y（和 drawText 用一樣的斷行）
function textRows(ctx, it, paras) {
  const rows = [];
  let y = it.y + 3;
  for (const p of paras) {
    const indent = p.list === 'check' ? 24 * (p.depth || 0) + 30 : p.list ? 16 * 1.4 * ((p.depth || 0) + 1) : 0;
    const runs = p.runs.length ? p.runs : [{ text: '' }];
    const n = wrapRuns(runs, it.w - 14 - indent, (text, run) => { ctx.font = fontFor(16, run); return ctx.measureText(text).width; }).length;
    for (let i = 0; i < n; i++) { rows.push(y); y += LINE_H; }
  }
  return rows;
}

function drawText(ctx, it, paras) {
  const size = 16;
  const lineH = LINE_H;
  const left = it.x + 7;
  const width = it.w - 14;
  let y = it.y + 3;
  ctx.textBaseline = 'middle';
  for (const p of paras) {
    let indent = 0;
    if (p.list === 'check') indent = 24 * (p.depth || 0) + 30;
    else if (p.list) indent = size * 1.4 * ((p.depth || 0) + 1);
    const color = p.checked ? MUTED : INK;
    if (p.list === 'check') {
      const cx = left + indent - 30 + 3 + 9.5;
      const cy = y + 3 + 9.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      if (p.checked) {
        ctx.fillStyle = '#d98b2b';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - 4.3, cy + 0.3);
        ctx.lineTo(cx - 1.3, cy + 3.3);
        ctx.lineTo(cx + 4.5, cy - 3.5);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#a9b1bf';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } else if (p.list) {
      ctx.fillStyle = color;
      ctx.font = fontFor(size);
      const mark = p.list === 'ol' ? `${p.index}.` : '•';
      ctx.textAlign = 'right';
      ctx.fillText(mark, left + indent - 6, y + lineH / 2);
      ctx.textAlign = 'left';
    }
    const runs = p.runs.length ? p.runs : [{ text: '' }];
    const lines = wrapRuns(runs, width - indent, (text, run) => { ctx.font = fontFor(size, run); return ctx.measureText(text).width; });
    for (const line of lines) {
      for (const seg of line) {
        ctx.font = fontFor(size, seg.run);
        ctx.fillStyle = color;
        const x = left + indent + seg.x;
        ctx.fillText(seg.text, x, y + lineH / 2);
        if (seg.run.u) ctx.fillRect(x, y + lineH / 2 + size * 0.5, seg.w, 1);
        if (seg.run.s || p.checked) {
          ctx.fillStyle = p.checked ? '#b4bac5' : color;
          ctx.fillRect(x, y + lineH / 2, seg.w, 1.2);
        }
      }
      y += lineH;
    }
  }
}

// 心智圖：和畫面一樣的節點樣式和 S 形連線
function drawMindmap(ctx, it, layout) {
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.lineCap = 'round';
  for (const e of layout.edges) {
    ctx.strokeStyle = branchColor(e.branch);
    ctx.lineWidth = e.depth === 1 ? 2.5 : 1.8;
    ctx.stroke(new Path2D(edgePath(e)));
  }
  for (const n of layout.nodes) {
    const color = branchColor(n.branch);
    const style = n.depth === 0
      ? { fill: color, stroke: color, text: '#ffffff', size: 19, weight: 700, px: 18, py: 10, r: 12 }
      : n.depth === 1
        ? { fill: mix(color, 0.13), stroke: color, text: INK, size: 16, weight: 600, px: 13, py: 6, r: 10 }
        : { fill: '#ffffff', stroke: mix(color, 0.45), text: INK, size: 15, weight: 400, px: 11, py: 5, r: 8 };
    ctx.beginPath();
    roundRect(ctx, n.x + 0.75, n.y + 0.75, n.w - 1.5, n.h - 1.5, style.r);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = style.stroke;
    ctx.stroke();
    ctx.fillStyle = style.text;
    ctx.textBaseline = 'middle';
    const lh = style.size * 1.4;
    // 畫面上排成一行的節點就照一行畫（畫布量的字寬和網頁會差一點點）
    const domLines = Math.max(1, Math.round((n.h - style.py * 2 - 3) / lh));
    const lines = domLines === 1 ? [[{ text: n.node.text }]]
      : wrapRuns([{ text: n.node.text }], n.w - style.px * 2 - 3 + 2, (text) => { ctx.font = fontFor(style.size, {}, style.weight); return ctx.measureText(text).width; });
    lines.forEach((line, i) => {
      ctx.font = fontFor(style.size, {}, style.weight);
      ctx.fillText(line.map((s) => s.text).join(''), n.x + style.px + 1.5, n.y + style.py + 1.5 + lh * i + lh / 2);
    });
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mix(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.round(v * amount + 255 * (1 - amount));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

// 頁面格線（可選）：橫線、方格、點點，和畫面上的間距一樣
function drawBackground(ctx, bg, x0, y0, x1, y1) {
  ctx.fillStyle = '#d9e3f2';
  if (bg === 'ruled') {
    for (let y = 136 + 31; y < y1; y += 32) if (y >= y0) ctx.fillRect(x0, y, x1 - x0, 1);
  } else if (bg === 'grid') {
    for (let y = Math.floor(y0 / 24) * 24; y < y1; y += 24) ctx.fillRect(x0, y, x1 - x0, 1);
    for (let x = Math.floor(x0 / 24) * 24; x < x1; x += 24) ctx.fillRect(x, y0, 1, y1 - y0);
  } else if (bg === 'dots') {
    ctx.fillStyle = '#c3d1e8';
    for (let y = Math.floor(y0 / 24) * 24 + 12; y < y1; y += 24) {
      for (let x = Math.floor(x0 / 24) * 24 + 12; x < x1; x += 24) { ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

// ---------- 一頁筆記 → 幾張 A4 ----------
async function renderPage(page, items, getAsset, { background }) {
  const { draws, blocks } = await collect(page, items, getAsset);
  const pad = 24;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const contentW = maxX - minX;
  const usableW = A4.w - A4.margin * 2;
  const usableH = A4.h - A4.margin * 2;
  const k = Math.min(0.75, usableW / contentW); // 每 px 幾點；窄的內容照原尺寸（96 dpi）
  const bandH = usableH / k;
  const res = Math.min(RES, MAX_CANVAS_W / contentW);
  const out = [];
  for (const [y0, y1] of pageBreaks(blocks, minY, maxY, bandH)) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(contentW * res);
    canvas.height = Math.max(1, Math.ceil((y1 - y0) * res));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(res, 0, 0, res, -minX * res, -y0 * res);
    ctx.save();
    ctx.beginPath();
    ctx.rect(minX, y0, contentW, y1 - y0);
    ctx.clip();
    if (background) drawBackground(ctx, page.background, minX, y0, maxX, y1);
    for (const d of draws) { ctx.save(); d.fn(ctx); ctx.restore(); }
    ctx.restore();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const w = contentW * k;
    const h = (y1 - y0) * k;
    out.push({ jpeg, width: canvas.width, height: canvas.height, pageW: A4.w, pageH: A4.h, x: A4.margin + (usableW - w) / 2, y: A4.h - A4.margin - h, w, h });
    canvas.width = canvas.height = 0; // iPad 的畫布記憶體有限，用完就放掉
  }
  return out;
}

// entries: [{ page, items }]；onProgress(i, total)
// 網路字型是依用到的字分批下載的：先把這幾頁會用到的字都載好，畫布上才不會變成別的字型
async function loadFonts(entries) {
  if (!document.fonts || !document.fonts.load) return;
  let text = '';
  const walk = (n) => { text += n.text; n.children.forEach(walk); };
  for (const { items } of entries) {
    for (const it of items) {
      if (it.type === 'text') text += it.html.replace(/<[^>]*>/g, '');
      else if (it.type === 'mindmap') walk(it.root);
    }
  }
  const chars = [...new Set(text)].join('') || 'a';
  try {
    await Promise.race([
      Promise.all([400, 600, 700].map((w) => document.fonts.load(`${w} 16px "Noto Sans TC"`, chars))),
      new Promise((r) => setTimeout(r, 8000)), // 離線或很慢時不要卡住，用系統字型
    ]);
  } catch { /* 用系統字型 */ }
}

export async function exportPdf(entries, title, getAsset, { background = false, onProgress } = {}) {
  await loadFonts(entries);
  const pages = [];
  for (const [i, { page, items }] of entries.entries()) {
    if (onProgress) onProgress(i + 1, entries.length);
    pages.push(...(await renderPage(page, items, getAsset, { background })));
  }
  return new Blob([buildPdf(pages, { title })], { type: 'application/pdf' });
}
