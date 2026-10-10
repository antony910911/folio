// 匯出成 PowerPoint 和 Word。
// PowerPoint：畫布的版面照原樣擺，文字框變成可以編輯的文字方塊，手寫變成透明背景的圖片。
// Word：依閱讀順序由上到下排，文字變成段落，手寫變成插入的圖片（螢光筆不放，因為 Word 的文字位置會變）。

import { strokeBounds } from './ink.js';
import { clusterBoxes, htmlToParagraphs, planSlides, readingOrder, fitWidth, listPrefix } from './layout.js';
import { pageDisplayTitle } from './model.js';
import { sanitizeHtml, formatDate } from './editor.js';
import { renderStrokes, canvasToBlob, measureTextHeight } from './inkrender.js';
import { loadPptx, loadDocx } from './vendor.js';
import { treeToOutline } from './mindmap.js';
import { measureMindmap, branchColor } from './mindmap-view.js';

const FONT = 'Microsoft JhengHei';
const TEXT_COLOR = '1D2330';
const MUTED_COLOR = '7A8291';
const SLIDE = { w: 13.333, h: 7.5, margin: 0.45 };
const WORD_MAX_IMAGE_W = 620; // A4／Letter 內文寬度大約 6.5 英吋
const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// 一頁拆成可以排版的區塊：標題、日期、圖片、文字框、一群一群的手寫
// getAsset(id) → { blob, w, h } | null
async function buildBlocks(page, items, { highlighter, getAsset }) {
  const blocks = [
    { kind: 'title', x: 64, y: 40, w: 640, h: 44, text: pageDisplayTitle(page) },
    { kind: 'date', x: 64, y: 96, w: 640, h: 20, text: formatDate(page.createdAt).replace(/\s+/g, ' ') },
  ];
  for (const it of items) {
    if (it.type !== 'text') continue;
    const html = sanitizeHtml(it.html);
    const paragraphs = htmlToParagraphs(html);
    if (!paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) continue;
    blocks.push({ kind: 'text', x: it.x, y: it.y, w: it.w, h: measureTextHeight(html, it.w), paragraphs });
  }
  for (const it of items) {
    if (it.type !== 'mindmap') continue;
    const layout = measureMindmap(it);
    const b = layout.bounds;
    blocks.push({ kind: 'mindmap', x: it.x + b.x, y: it.y + b.y, w: b.w, h: b.h, ox: it.x, oy: it.y, layout, root: it.root });
  }
  for (const it of items) {
    if (it.type !== 'image') continue;
    const asset = await getAsset(it.asset);
    if (asset) blocks.push({ kind: 'image', x: it.x, y: it.y, w: it.w, h: it.h, blob: asset.blob });
  }
  const strokes = items.filter((it) => it.type === 'stroke' && (highlighter || it.tool !== 'highlighter'));
  const clusters = clusterBoxes(strokes.map((s) => ({ id: s.id, ...strokeBounds(s) })), 40);
  for (const c of clusters) {
    const set = new Set(c.ids);
    const { canvas, bounds } = renderStrokes(strokes.filter((s) => set.has(s.id)), { scale: 2.5, pad: 4 });
    blocks.push({ kind: 'ink', canvas, ...bounds });
  }
  return blocks;
}

// ---------- PowerPoint ----------
function pptxRuns(paragraphs) {
  const out = [];
  paragraphs.forEach((p, pi) => {
    // 縮排用全形空白，PowerPoint 裡看起來最穩定
    const prefix = '\u3000'.repeat(p.depth || 0) + listPrefix(p);
    const runs = p.runs.length ? p.runs : [{ text: ' ' }];
    runs.forEach((r, ri) => {
      const options = { breakLine: ri === runs.length - 1 && pi < paragraphs.length - 1 };
      if (r.b) options.bold = true;
      if (r.i) options.italic = true;
      if (r.u) options.underline = { style: 'sng' };
      if (r.s || p.checked) options.strike = 'sngStrike';
      if (p.checked) options.color = '8A92A0';
      out.push({ text: (ri === 0 ? prefix : '') + r.text, options });
    });
  });
  return out;
}

// entries: [{ page, items }]
export async function exportPptx(entries, title, getAsset) {
  const PptxGenJS = await loadPptx();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = 'Folio';
  for (const { page, items } of entries) {
    const blocks = await buildBlocks(page, items, { highlighter: true, getAsset });
    const { scale, slides } = planSlides(blocks, SLIDE);
    const pt = (px) => Math.max(6, Math.round(px * scale * 72 * 10) / 10);
    for (const [si, s] of slides.entries()) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      // 疊放順序跟畫面上一樣：匯入的圖片 → 手寫 → 文字
      for (const b of s.blocks.filter((x) => x.kind === 'image')) {
        slide.addImage({ data: await blobToDataUrl(b.blob), x: b.sx, y: b.sy, w: b.sw, h: b.sh });
      }
      for (const b of s.blocks.filter((x) => x.kind === 'ink')) {
        slide.addImage({ data: b.canvas.toDataURL('image/png'), x: b.sx, y: b.sy, w: b.sw, h: b.sh });
      }
      for (const b of s.blocks.filter((x) => x.kind === 'mindmap')) addMindmapShapes(pptx, slide, b, scale, pt);
      for (const b of s.blocks) {
        if (b.kind === 'title' || b.kind === 'date') {
          const isTitle = b.kind === 'title';
          slide.addText(isTitle && si > 0 ? `${b.text}（續）` : b.text, {
            x: b.sx, y: b.sy, w: b.sw, h: b.sh,
            fontFace: FONT, fontSize: pt(isTitle ? 30 : 13), bold: isTitle,
            color: isTitle ? TEXT_COLOR : MUTED_COLOR, valign: 'top', margin: 0,
          });
        } else if (b.kind === 'text') {
          slide.addText(pptxRuns(b.paragraphs), {
            x: b.sx, y: b.sy, w: b.sw, h: b.sh,
            fontFace: FONT, fontSize: pt(16), color: TEXT_COLOR,
            valign: 'top', margin: Math.max(1, pt(6) / 2), lineSpacingMultiple: 1.2,
          });
        }
      }
    }
  }
  const blob = await pptx.write({ outputType: 'blob' });
  return new Blob([blob], { type: MIME.pptx });
}

// 心智圖用 PowerPoint 的圖形畫：連線是直線，節點是圓角矩形，文字可以直接改
function addMindmapShapes(pptx, slide, b, scale, pt) {
  const X = (px) => b.sx + (b.ox + px - b.x) * scale;
  const Y = (px) => b.sy + (b.oy + px - b.y) * scale;
  const hex = (c) => c.replace('#', '').toUpperCase();
  for (const e of b.layout.edges) {
    const x1 = X(e.x1), y1 = Y(e.y1), x2 = X(e.x2), y2 = Y(e.y2);
    slide.addShape(pptx.ShapeType.line, {
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(0.001, Math.abs(x2 - x1)), h: Math.max(0.001, Math.abs(y2 - y1)),
      flipV: (x2 - x1) * (y2 - y1) < 0,
      line: { color: hex(branchColor(e.branch)), width: e.depth === 1 ? 2 : 1.25 },
    });
  }
  for (const n of b.layout.nodes) {
    const color = hex(branchColor(n.branch));
    const fill = n.depth === 0 ? color : n.depth === 1 ? tint(color, 0.13) : 'FFFFFF';
    slide.addText(n.node.text, {
      x: X(n.x), y: Y(n.y), w: n.w * scale, h: n.h * scale,
      shape: pptx.ShapeType.roundRect, rectRadius: 0.08,
      fill: { color: fill }, line: { color: n.depth >= 2 ? tint(color, 0.45) : color, width: 1 },
      fontFace: FONT, fontSize: pt(n.depth === 0 ? 19 : n.depth === 1 ? 16 : 15), bold: n.depth <= 1,
      color: n.depth === 0 ? 'FFFFFF' : TEXT_COLOR, align: 'center', valign: 'middle', margin: 1,
    });
  }
}

// 把顏色和白色混合（amount 是原色的比例）
function tint(hex, amount) {
  const n = parseInt(hex, 16);
  const mix = (v) => Math.round(v * amount + 255 * (1 - amount)).toString(16).padStart(2, '0');
  return (mix((n >> 16) & 255) + mix((n >> 8) & 255) + mix(n & 255)).toUpperCase();
}

// ---------- Word ----------
export async function exportDocx(entries, title, getAsset) {
  const d = await loadDocx();
  const sections = [];
  for (const { page, items } of entries) {
    const blocks = await buildBlocks(page, items, { highlighter: false, getAsset });
    const head = blocks.filter((b) => b.kind === 'title' || b.kind === 'date');
    const body = readingOrder(blocks.filter((b) => b.kind !== 'title' && b.kind !== 'date'));
    const children = [
      new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, children: [new d.TextRun(head[0].text)] }),
      new d.Paragraph({ spacing: { after: 240 }, children: [new d.TextRun({ text: head[1].text, color: MUTED_COLOR, size: 18 })] }),
    ];
    for (const b of body) {
      if (b.kind === 'text') {
        for (const p of b.paragraphs) {
          const runs = p.runs.map((r) => new d.TextRun({
            text: r.text, bold: r.b, italics: r.i, strike: r.s || p.checked, underline: r.u ? {} : undefined,
            color: p.checked ? '8A92A0' : undefined,
          }));
          if (p.list === 'ol') runs.unshift(new d.TextRun(`${p.index}. `));
          if (p.list === 'check') runs.unshift(new d.TextRun({ text: p.checked ? '☑ ' : '☐ ', color: p.checked ? 'D98B2B' : undefined }));
          children.push(new d.Paragraph({
            children: runs,
            bullet: p.list === 'ul' ? { level: Math.min(8, p.depth || 0) } : undefined,
            indent: p.list && p.list !== 'ul' && p.depth ? { left: 360 * p.depth } : undefined,
          }));
        }
        children.push(new d.Paragraph({ children: [] }));
      } else if (b.kind === 'mindmap') {
        // Word 裡用大綱：中心主題是粗體，分支是多層項目符號
        for (const row of treeToOutline(b.root)) {
          if (row.depth === 0) children.push(new d.Paragraph({ children: [new d.TextRun({ text: row.text, bold: true, size: 26 })] }));
          else children.push(new d.Paragraph({ children: [new d.TextRun(row.text)], bullet: { level: Math.min(8, row.depth - 1) } }));
        }
        children.push(new d.Paragraph({ children: [] }));
      } else if (b.kind === 'ink' || b.kind === 'image') {
        const blob = b.kind === 'ink' ? await canvasToBlob(b.canvas) : b.blob;
        const size = fitWidth(b.w, b.h, WORD_MAX_IMAGE_W);
        const type = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/gif' ? 'gif' : 'png';
        children.push(new d.Paragraph({
          children: [new d.ImageRun({ type, data: new Uint8Array(await blob.arrayBuffer()), transformation: { width: size.w, height: size.h } })],
        }));
      }
    }
    sections.push({ properties: {}, children });
  }
  const doc = new d.Document({
    creator: 'Folio',
    title,
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } },
        heading1: { run: { font: FONT, size: 36, bold: true, color: TEXT_COLOR }, paragraph: { spacing: { after: 60 } } },
      },
    },
    sections,
  });
  const blob = await d.Packer.toBlob(doc);
  return new Blob([blob], { type: MIME.docx });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- 存檔 ----------
// 回傳 'saved' | 'declined' | 'needs_tap'（iPad 上等太久，分享選單要使用者再點一次才能開）
export async function saveFile(blob, filename) {
  if (globalThis.claude && typeof globalThis.claude.use === 'function') {
    const downloads = await globalThis.claude.use('downloads').catch(() => null);
    if (downloads) {
      try {
        await downloads.save({ filename, data: blob });
        return 'saved';
      } catch (e) {
        if (e && e.code === 'declined') return 'declined';
        if (e && e.code === 'rate_limited') throw new Error('已經有一個儲存視窗開著了。');
        throw new Error('這裡不能儲存檔案。');
      }
    }
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return 'saved';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'declined';
        if (e && e.name === 'NotAllowedError') return 'needs_tap';
        throw e;
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'saved';
}

export function safeFilename(name) {
  return (name || 'Folio').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Folio';
}
