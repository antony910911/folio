import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapRuns, pageBreaks, buildPdf } from '../js/pdfmodel.js';

// 量寬度：每個字 10px，英文字母 6px
const measure = (t) => [...t].reduce((w, ch) => w + (/[\x00-\x7f]/.test(ch) ? 6 : 10), 0);
const text = (lines) => lines.map((l) => l.map((s) => s.text).join(''));

test('中文每個字都能斷行', () => {
  const lines = wrapRuns([{ text: '一二三四五六七八九十' }], 45, measure);
  assert.deepEqual(text(lines), ['一二三四', '五六七八', '九十']);
});

test('英文以單字為單位斷行，行首不留空白', () => {
  const lines = wrapRuns([{ text: 'hello world foo' }], 70, measure);
  assert.deepEqual(text(lines), ['hello world', 'foo']);
});

test('比一行還長的單字會被拆開', () => {
  const lines = wrapRuns([{ text: 'abcdefghij' }], 30, measure);
  assert.deepEqual(text(lines), ['abcde', 'fghij']);
});

test('不同格式的片段保留各自的樣式和位置', () => {
  const lines = wrapRuns([{ text: '粗體', b: true }, { text: '一般' }], 100, measure);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].map((s) => [s.text, !!s.run.b, s.x]), [['粗', true, 0], ['體', true, 10], ['一', false, 20], ['般', false, 30]]);
});

test('分頁：短的內容只有一頁', () => {
  assert.deepEqual(pageBreaks([{ y: 50, h: 100 }], 0, 500, 1000), [[0, 500]]);
});

test('分頁：切點落在區塊中間時往上移', () => {
  const bands = pageBreaks([{ y: 100, h: 50 }, { y: 900, h: 200 }], 0, 1500, 1000);
  assert.equal(bands[0][1], 894);
  assert.deepEqual(bands.map((b) => b[0]), [0, 894]);
  // 每個區塊都完整落在某一頁
  for (const b of [{ y: 100, h: 50 }, { y: 900, h: 200 }]) {
    assert.ok(bands.some(([s, e]) => b.y >= s && b.y + b.h <= e));
  }
});

test('分頁：比一整頁還高的區塊只好切開', () => {
  const bands = pageBreaks([{ y: 50, h: 2500 }], 0, 2600, 1000);
  assert.deepEqual(bands, [[0, 1000], [1000, 2000], [2000, 2600]]);
});

test('PDF：結構正確，xref 的位置對得上', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const page = { jpeg, width: 10, height: 20, pageW: 595.28, pageH: 841.89, x: 36, y: 400, w: 100, h: 200 };
  const pdf = buildPdf([page, page], { title: '我的筆記' });
  const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 2/);
  assert.match(s, /\/Title <FEFF621176847B468A18>/);
  const startxref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 9);
  offsets.forEach((off, i) => assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
});

test('wrapRuns 避頭尾：句號不會跑到行首', () => {
  const lines = wrapRuns([{ text: '一二三四。' }], 4, (t) => [...t].length);
  assert.deepEqual(lines.map((l) => l.map((x) => x.text).join('')), ['一二三', '四。']);
  const open = wrapRuns([{ text: '一二三「四」' }], 4, (t) => [...t].length);
  assert.deepEqual(open.map((l) => l.map((x) => x.text).join('')), ['一二三', '「四」']);
});
