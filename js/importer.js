// 匯入 PDF 和圖片：PDF 的每一頁畫成圖片（PDF.js），存成頁面上的圖片，可以直接在上面寫字。
// PowerPoint／Keynote 請先另存成 PDF；瀏覽器沒辦法準確畫出 .pptx。

import { loadPdfjs, urlFor } from './vendor.js';

export const DISPLAY_WIDTH = 860; // 投影片在頁面上的寬度（px）
const RENDER_WIDTH = 1800; // 實際畫圖的寬度，放大看也清楚
const MAX_IMAGE_SIDE = 2400;

export function fileKind(file) {
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type) || /\.(png|jpe?g|webp|gif)$/.test(name)) return 'image';
  if (/\.(pptx?|key|odp)$/.test(name)) return 'slides';
  if (/^image\/hei[cf]$/.test(file.type) || /\.hei[cf]$/.test(name)) return 'heic';
  return 'other';
}

export async function openPdf(file) {
  const pdfjs = await loadPdfjs();
  const base = urlFor('pdfjsBase');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    isEvalSupported: false,
  });
  const doc = await task.promise;
  return {
    count: doc.numPages,
    // 回傳 { blob, w, h }（圖片像素）以及 display（頁面上的大小）
    async render(n) {
      const page = await doc.getPage(n);
      const base1 = page.getViewport({ scale: 1 });
      const scale = Math.min(4, RENDER_WIDTH / base1.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      const blob = await toBlob(canvas, 'image/jpeg', 0.9);
      canvas.width = canvas.height = 0; // iPad 的畫布記憶體有限，用完馬上釋放
      return { blob, w: Math.ceil(vp.width), h: Math.ceil(vp.height), display: displaySize(vp.width, vp.height, DISPLAY_WIDTH) };
    },
    destroy: () => task.destroy(),
  };
}

// 圖片：太大就縮小，回傳 { blob, w, h, display }
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  let { width: w, height: h } = bitmap;
  let blob = file;
  if (Math.max(w, h) > MAX_IMAGE_SIDE) {
    const k = MAX_IMAGE_SIDE / Math.max(w, h);
    w = Math.round(w * k);
    h = Math.round(h * k);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    blob = await toBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
  } else if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    blob = new Blob([file], { type: 'image/png' });
  }
  bitmap.close && bitmap.close();
  // 高解析度螢幕的截圖用一半大小顯示，看起來才是原本的尺寸
  const shown = w > 1000 ? w / 2 : w;
  return { blob, w, h, display: displaySize(w, h, Math.min(DISPLAY_WIDTH, shown)) };
}

export function displaySize(w, h, targetW) {
  return { w: Math.round(targetW), h: Math.round((h * targetW) / w) };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生圖片'))), type, quality));
}
