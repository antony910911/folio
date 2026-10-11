// 匯出 PDF 用的純函式（可以用 node 測試）：
// - wrapRuns：把有格式的文字依寬度斷行（中文每個字都能斷，英文以單字為單位）
// - pageBreaks：一頁筆記太長時，決定在哪裡切成好幾張 A4，盡量不切到字
// - buildPdf：把每一頁的 JPEG 包成 PDF 檔（不需要任何函式庫）

// ---------- 斷行 ----------
// runs: [{ text, ...樣式 }]；measure(text, run) 回傳寬度；回傳 [[{ text, run, x, w }]]（每一行的片段）
export function wrapRuns(runs, maxWidth, measure) {
  const tokens = [];
  for (const run of runs) {
    // 英文單字、數字、連續空白各算一個；其他（中日韓文字、標點）一個字一個
    // 避頭尾：「。」「，」這類標點黏在前一個字後面，「（」「「」黏在後一個字前面，不會單獨跑到行首或留在行尾
    for (const m of run.text.matchAll(/[A-Za-z0-9_\-'’.,:;!?@#$%&*+=/\\()[\]{}<>"~^|]+[、。，．！？）」』】〉》：；…]*|\s+|[「『（【〈《]*[\s\S][、。，．！？）」』】〉》：；…ー]*/gu)) tokens.push({ text: m[0], run });
  }
  const lines = [[]];
  let x = 0;
  const push = (text, run) => {
    const w = measure(text, run);
    lines[lines.length - 1].push({ text, run, x, w });
    x += w;
  };
  for (const t of tokens) {
    const isSpace = /^\s+$/.test(t.text);
    const w = measure(t.text, t.run);
    if (x + w <= maxWidth || (x === 0 && !isSpace && w <= maxWidth)) {
      if (!(isSpace && x === 0)) push(t.text, t.run);
      continue;
    }
    if (isSpace) { lines.push([]); x = 0; continue; } // 行尾的空白直接換行
    if (w > maxWidth) {
      // 比一整行還長的英文單字：一個字一個字斷
      for (const ch of t.text) {
        const cw = measure(ch, t.run);
        if (x + cw > maxWidth && x > 0) { lines.push([]); x = 0; }
        push(ch, t.run);
      }
      continue;
    }
    lines.push([]);
    x = 0;
    push(t.text, t.run);
  }
  return lines;
}

// ---------- 分頁 ----------
// blocks: [{ y, h }]（頁面座標）；top、bottom：內容的上下界；bandH：一張 A4 放得下的高度
// 回傳 [[start, end]]。切點落在某個區塊中間時，改切在那個區塊上面（除非區塊比一整張還高）
export function pageBreaks(blocks, top, bottom, bandH) {
  const bands = [];
  let start = top;
  let guard = 0;
  while (bottom - start > bandH && guard++ < 1000) {
    let end = start + bandH;
    for (let i = 0; i < 50; i++) {
      const crossing = blocks.filter((b) => b.y < end && b.y + b.h > end);
      if (!crossing.length) break;
      const above = Math.min(...crossing.map((b) => b.y)) - 6;
      if (above <= start + bandH * 0.25) break; // 往上移太多會留下大片空白，就直接切
      end = above;
    }
    bands.push([start, end]);
    start = end;
  }
  bands.push([start, bottom]);
  return bands;
}

// ---------- PDF ----------
const enc = new TextEncoder();

// PDF 字串：非 ASCII 用 UTF-16BE 十六進位
function pdfText(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, (c) => '\\' + c) + ')';
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return '<' + hex + '>';
}

// pages: [{ jpeg: Uint8Array, width, height（圖片像素）, pageW, pageH（點）, x, y, w, h（圖片在頁面上的位置，點，原點左下） }]
export function buildPdf(pages, { title = 'Folio' } = {}) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const write = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (num, body) => {
    offsets[num] = length;
    write(`${num} 0 obj\n`);
    for (const part of body) write(part);
    write('\nendobj\n');
  };
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二進位註解：告訴其他程式這是二進位檔
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`]);
  obj(3, [`<< /Title ${pdfText(title)} /Producer (Folio) >>`]);
  pages.forEach((p, i) => {
    const pageNum = 4 + i * 3;
    const f = (n) => (Math.round(n * 100) / 100).toString();
    const content = `q ${f(p.w)} 0 0 ${f(p.h)} ${f(p.x)} ${f(p.y)} cm /Im0 Do Q`;
    obj(pageNum, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.pageW)} ${f(p.pageH)}] /Resources << /XObject << /Im0 ${pageNum + 2} 0 R >> >> /Contents ${pageNum + 1} 0 R >>`]);
    obj(pageNum + 1, [`<< /Length ${enc.encode(content).length} >>\nstream\n`, content, '\nendstream']);
    obj(pageNum + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    ]);
  });
  const count = 4 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  write(table);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const A4 = { w: 595.28, h: 841.89, margin: 36 };
