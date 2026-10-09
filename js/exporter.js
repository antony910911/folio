// 匯出成 PowerPoint 和 Word。
// PowerPoint：畫布的版面照原樣擺，文字框變成可以編輯的文字方塊，手寫變成透明背景的圖片。
// Word：依閱讀順序由上到下排，文字變成段落，手寫變成插入的圖片（螢光筆不放，因為 Word 的文字位置會變）。

import { strokeBounds } from './ink.js';
import { clusterBoxes, htmlToParagraphs, planSlides, readingOrder, fitWidth } from './layout.js';
import { pageDisplayTitle } from './model.js';
import { sanitizeHtml, formatDate } from './editor.js';
import { renderStrokes, canvasToBlob, measureTextHeight } from './inkrender.js';
import { loadPptx, loadDocx } from './vendor.js';

const FONT = 'Microsoft JhengHei';
const TEXT_COLOR = '1D2330';
const MUTED_COLOR = '7A8291';
const SLIDE = { w: 13.333, h: 7.5, margin: 0.45 };
const WORD_MAX_IMAGE_W = 620; // A4／Letter 內文寬度大約 6.5 英吋
const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// 一頁拆成可以排版的區塊：標題、日期、文字框、一群一群的手寫
function buildBlocks(page, items, { highlighter }) {
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
    const prefix = p.list === 'ul' ? '• ' : p.list === 'ol' ? `${p.index}. ` : '';
    const runs = p.runs.length ? p.runs : [{ text: ' ' }];
    runs.forEach((r, ri) => {
      const options = { breakLine: ri === runs.length - 1 && pi < paragraphs.length - 1 };
      if (r.b) options.bold = true;
      if (r.i) options.italic = true;
      if (r.u) options.underline = { style: 'sng' };
      if (r.s) options.strike = 'sngStrike';
      out.push({ text: (ri === 0 ? prefix : '') + r.text, options });
    });
  });
  return out;
}

// entries: [{ page, items }]
export async function exportPptx(entries, title) {
  const PptxGenJS = await loadPptx();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = 'Folio';
  for (const { page, items } of entries) {
    const blocks = buildBlocks(page, items, { highlighter: true });
    const { scale, slides } = planSlides(blocks, SLIDE);
    const pt = (px) => Math.max(6, Math.round(px * scale * 72 * 10) / 10);
    slides.forEach((s, si) => {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      // 手寫圖片放最下層，文字疊在上面，跟畫面上一樣
      for (const b of s.blocks.filter((x) => x.kind === 'ink')) {
        slide.addImage({ data: b.canvas.toDataURL('image/png'), x: b.sx, y: b.sy, w: b.sw, h: b.sh });
      }
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
    });
  }
  const blob = await pptx.write({ outputType: 'blob' });
  return new Blob([blob], { type: MIME.pptx });
}

// ---------- Word ----------
export async function exportDocx(entries, title) {
  const d = await loadDocx();
  const sections = [];
  for (const { page, items } of entries) {
    const blocks = buildBlocks(page, items, { highlighter: false });
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
            text: r.text, bold: r.b, italics: r.i, strike: r.s, underline: r.u ? {} : undefined,
          }));
          if (p.list === 'ol') runs.unshift(new d.TextRun(`${p.index}. `));
          children.push(new d.Paragraph({ children: runs, bullet: p.list === 'ul' ? { level: 0 } : undefined }));
        }
        children.push(new d.Paragraph({ children: [] }));
      } else if (b.kind === 'ink') {
        const blob = await canvasToBlob(b.canvas);
        const size = fitWidth(b.w, b.h, WORD_MAX_IMAGE_W);
        children.push(new d.Paragraph({
          children: [new d.ImageRun({ type: 'png', data: new Uint8Array(await blob.arrayBuffer()), transformation: { width: size.w, height: size.h } })],
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
