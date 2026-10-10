// 匯出和手寫辨識共用的版面計算。純函式，不碰 DOM，方便測試。
// 單位都是頁面上的 px（1px = 1/96 英吋）。

import { rectsIntersect, unionBounds } from './ink.js';

// 把彼此靠近（間距小於 gap）的方框分成一群。用來把手寫筆畫合成一段一段的字。
// boxes: [{ id, x, y, w, h }]；回傳 [{ ids, bounds }]，依位置由上到下排序。
export function clusterBoxes(boxes, gap = 24) {
  const parent = boxes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const half = gap / 2;
  const grown = boxes.map((b) => ({ x: b.x - half, y: b.y - half, w: b.w + gap, h: b.h + gap }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsIntersect(grown[i], grown[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  boxes.forEach((b, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(b);
  });
  // 合併後的外框可能又碰到別群，再合一次直到穩定
  let clusters = [...groups.values()].map((list) => ({ ids: list.map((b) => b.id), bounds: unionBounds(list) }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i].bounds;
        const b = clusters[j].bounds;
        if (rectsIntersect({ x: a.x - half, y: a.y - half, w: a.w + gap, h: a.h + gap }, { x: b.x - half, y: b.y - half, w: b.w + gap, h: b.h + gap })) {
          clusters[i] = { ids: [...clusters[i].ids, ...clusters[j].ids], bounds: unionBounds([a, b]) };
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return readingOrder(clusters.map((c) => ({ ...c, ...c.bounds })));
}

// 閱讀順序：由上到下；高度上大半重疊的算同一列，同一列由左到右。
// blocks: [{ x, y, w, h, ... }]，回傳排序後的新陣列。
export function readingOrder(blocks) {
  const sorted = blocks.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const b of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const overlap = Math.min(row.bottom, b.y + b.h) - Math.max(row.top, b.y);
      if (overlap > 0.5 * Math.min(row.bottom - row.top, b.h)) {
        row.items.push(b);
        row.top = Math.min(row.top, b.y);
        row.bottom = Math.max(row.bottom, b.y + b.h);
        continue;
      }
    }
    rows.push({ top: b.y, bottom: b.y + b.h, items: [b] });
  }
  // 同一列裡左右並排的由左到右；上下疊著的（例如字和底下的底線）由上到下
  const hOverlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 * Math.min(a.w, b.w);
  return rows.flatMap((r) => r.items.sort((a, b) => (hOverlap(a, b) ? a.y - b.y : a.x - b.x)));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// 文字框的 HTML（已經過 sanitizeHtml，只剩基本標籤）轉成段落和格式片段。
// 回傳 [{ runs: [{ text, b, i, u, s }], list: null | 'ul' | 'ol' | 'check', index, depth, checked }]
// 勾選清單是 <ul class="checklist">，打勾的項目是 <li class="done">；depth 是清單的縮排層級（0 開始）
export function htmlToParagraphs(html) {
  const paragraphs = [];
  let runs = [];
  let listItem = null;
  const style = { b: 0, i: 0, u: 0, s: 0 };
  const lists = [];
  const TAG_STYLE = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's' };
  const flush = (force = false) => {
    if (runs.length || force) {
      paragraphs.push({
        runs,
        list: listItem ? listItem.type : null,
        index: listItem ? listItem.index : 0,
        depth: listItem ? listItem.depth : 0,
        checked: !!(listItem && listItem.checked),
      });
    }
    runs = [];
    listItem = null;
  };
  const re = /<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[3] != null) {
      const text = decodeEntities(m[3]).replace(/[\r\n\t]+/g, ' ');
      if (!text) continue;
      const fmt = { b: style.b > 0, i: style.i > 0, u: style.u > 0, s: style.s > 0 };
      const last = runs[runs.length - 1];
      if (last && last.b === fmt.b && last.i === fmt.i && last.u === fmt.u && last.s === fmt.s) last.text += text;
      else runs.push({ text, ...fmt });
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (TAG_STYLE[tag]) {
      style[TAG_STYLE[tag]] = Math.max(0, style[TAG_STYLE[tag]] + (closing ? -1 : 1));
    } else if (tag === 'br') {
      flush(true);
    } else if (tag === 'ul' || tag === 'ol') {
      if (runs.length) flush();
      const type = tag === 'ul' && hasClass(m[0], 'checklist') ? 'check' : tag;
      if (closing) lists.pop(); else lists.push({ type, count: 0 });
    } else if (tag === 'li') {
      if (runs.length) flush();
      if (!closing) {
        const list = lists[lists.length - 1];
        if (list) {
          list.count++;
          listItem = { type: list.type, index: list.count, depth: lists.length - 1, checked: list.type === 'check' && hasClass(m[0], 'done') };
        }
      }
    } else if (tag === 'div' || tag === 'p') {
      if (runs.length) flush();
    }
  }
  if (runs.length) flush();
  // 結尾的空段落沒有意義
  while (paragraphs.length && !paragraphs[paragraphs.length - 1].runs.length) paragraphs.pop();
  return paragraphs;
}

function hasClass(tag, name) {
  const m = tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return !!m && (m[1] ?? m[2] ?? m[3]).split(/\s+/).includes(name);
}

// 段落前面的符號：• 項目、1. 編號、☐ ☑ 勾選清單
export function listPrefix(p) {
  if (p.list === 'ul') return '• ';
  if (p.list === 'ol') return `${p.index}. `;
  if (p.list === 'check') return p.checked ? '☑ ' : '☐ ';
  return '';
}

export function paragraphsToText(paragraphs) {
  return paragraphs.map((p) => '  '.repeat(p.depth || 0) + listPrefix(p) + p.runs.map((r) => r.text).join('')).join('\n');
}

// 整個文字框轉成勾選清單（每一行一項）；如果已經全部是勾選清單，就轉回一般文字
export function toggleChecklistHtml(paragraphs) {
  const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const runsHtml = (runs) => runs.map((r) => {
    let h = esc(r.text);
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.s) h = `<s>${h}</s>`;
    return h;
  }).join('');
  const lines = paragraphs.filter((p) => p.runs.some((r) => r.text.trim()));
  if (!lines.length) return '<ul class="checklist"><li><br></li></ul>';
  if (lines.every((p) => p.list === 'check')) return lines.map((p) => `<div>${runsHtml(p.runs)}</div>`).join('');
  return '<ul class="checklist">' + lines.map((p) => `<li${p.checked ? ' class="done"' : ''}>${runsHtml(p.runs)}</li>`).join('') + '</ul>';
}

// 純文字轉成文字框用的 HTML（手寫辨識的結果用）
export function textToHtml(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return text.trim().split(/\r?\n/).map(esc).join('<br>');
}

// 把一頁的內容切成幾張投影片。
// blocks: [{ x, y, w, h, ... }]（頁面座標）；slide: { w, h, margin }（英吋）
// 內容比投影片窄就照原尺寸（96px = 1 英吋），太寬就整體縮小；太長就依投影片高度往下切。
// 回傳 { scale, slides: [{ top, blocks: [{ ...block, sx, sy, sw, sh }] }] }，s* 是投影片上的英吋。
export function planSlides(blocks, slide) {
  if (!blocks.length) return { scale: 1 / 96, slides: [{ top: 0, blocks: [] }] };
  const content = unionBounds(blocks);
  const usableW = slide.w - slide.margin * 2;
  const usableH = slide.h - slide.margin * 2;
  const scale = Math.min(1 / 96, usableW / content.w); // 每 px 幾英吋
  const bandH = usableH / scale; // 一張投影片放得下的頁面高度（px）
  const slides = [];
  const sorted = blocks.slice().sort((a, b) => a.y - b.y);
  for (const b of sorted) {
    let s = slides[slides.length - 1];
    // 換下一張：這個區塊的底部超出目前這張，而且它不是這張的第一個
    if (!s || (b.y + Math.min(b.h, bandH) > s.top + bandH && s.blocks.length)) {
      s = { top: s ? b.y : content.y, blocks: [] };
      slides.push(s);
    }
    s.blocks.push(b);
  }
  for (const s of slides) {
    s.blocks = s.blocks.map((b) => ({
      ...b,
      sx: slide.margin + (b.x - content.x) * scale,
      sy: slide.margin + (b.y - s.top) * scale,
      sw: b.w * scale,
      sh: b.h * scale,
    }));
  }
  return { scale, slides };
}

// 圖片縮到不超過 maxW（px），維持比例
export function fitWidth(w, h, maxW) {
  if (w <= maxW) return { w: Math.round(w), h: Math.round(h) };
  return { w: Math.round(maxW), h: Math.round((h * maxW) / w) };
}
