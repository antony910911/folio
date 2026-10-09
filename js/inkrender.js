// 把筆跡畫成圖片：匯出時放進 PPT／Word，辨識時送給 Claude。
// 用和畫面一樣的外框演算法（Path2D 直接吃 SVG path），看起來和螢幕上一致。

import { strokeOutline, strokeBounds, unionBounds } from './ink.js';
import { inkOptions } from './editor.js';

// strokes: 筆跡陣列；opts.scale: 解析度倍率；opts.background: 背景色（不給就是透明）；opts.pad: 邊距 px
// 回傳 { canvas, bounds }，bounds 是這張圖對應的頁面範圍（含邊距）。
export function renderStrokes(strokes, { scale = 2, background = null, pad = 4, maxSide = 4096 } = {}) {
  const b = unionBounds(strokes.map(strokeBounds));
  const bounds = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const s = Math.min(scale, maxSide / Math.max(bounds.w, bounds.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bounds.w * s));
  canvas.height = Math.max(1, Math.ceil(bounds.h * s));
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(s, 0, 0, s, -bounds.x * s, -bounds.y * s);
  // 螢光筆先畫，跟畫面上的疊放順序一樣
  const ordered = [...strokes.filter((x) => x.tool === 'highlighter'), ...strokes.filter((x) => x.tool !== 'highlighter')];
  for (const st of ordered) {
    ctx.globalAlpha = st.tool === 'highlighter' ? 0.38 : 1;
    ctx.fillStyle = st.color;
    ctx.fill(new Path2D(strokeOutline(st.points, inkOptions(st))));
  }
  return { canvas, bounds };
}

export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生圖片'))), type));
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 量文字框實際高度（沒打開的頁面也要量，所以用一個藏起來的元素）
let measurer = null;
export function measureTextHeight(html, width) {
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.className = 'tb-body';
    measurer.setAttribute('aria-hidden', 'true');
    Object.assign(measurer.style, { position: 'absolute', left: '-99999px', top: '0', visibility: 'hidden' });
    document.body.appendChild(measurer);
  }
  measurer.style.width = width + 'px';
  measurer.innerHTML = html;
  return measurer.offsetHeight;
}
