import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterBoxes, readingOrder, htmlToParagraphs, paragraphsToText, textToHtml, planSlides, fitWidth,
} from '../js/layout.js';

const box = (id, x, y, w = 20, h = 20) => ({ id, x, y, w, h });

test('相鄰的筆畫合成一群，遠的分開', () => {
  const c = clusterBoxes([box('a', 0, 0), box('b', 30, 0), box('c', 300, 0), box('d', 0, 300)], 24);
  assert.equal(c.length, 3);
  assert.deepEqual(c[0].ids.sort(), ['a', 'b']);
  assert.deepEqual(c.map((x) => x.ids.length), [2, 1, 1]);
});

test('鏈狀相連的筆畫會串成同一群', () => {
  const c = clusterBoxes([box('a', 0, 0), box('b', 35, 0), box('c', 70, 0)], 24);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].bounds, { x: 0, y: 0, w: 90, h: 20 });
});

test('合併後外框碰到別群也會合起來', () => {
  // a、b 合併後的外框跨過 c 的上方
  const c = clusterBoxes([box('a', 0, 0, 20, 100), box('b', 30, 0, 200, 20), box('c', 120, 40)], 24);
  assert.equal(c.length, 1);
});

test('閱讀順序：同一列由左到右，再往下', () => {
  const order = readingOrder([
    { id: 'right', x: 500, y: 105, w: 100, h: 40 },
    { id: 'left', x: 50, y: 100, w: 100, h: 40 },
    { id: 'below', x: 0, y: 300, w: 100, h: 40 },
  ]).map((b) => b.id);
  assert.deepEqual(order, ['left', 'right', 'below']);
});

test('同一列裡上下疊著的照上下排（字在底線前面）', () => {
  const order = readingOrder([
    { id: 'underline', x: 62, y: 180, w: 270, h: 16 },
    { id: 'text', x: 64, y: 156, w: 460, h: 60 },
  ]).map((b) => b.id);
  assert.deepEqual(order, ['text', 'underline']);
});

test('HTML 轉段落：格式、換行、div', () => {
  const p = htmlToParagraphs('<b>粗</b>體 &amp; 字<br>第二行<div>第三行</div><div><br></div><div><i>斜</i></div>');
  assert.deepEqual(p.map((x) => x.runs.map((r) => r.text).join('')), ['粗體 & 字', '第二行', '第三行', '', '斜']);
  assert.deepEqual(p[0].runs[0], { text: '粗', b: true, i: false, u: false, s: false });
  assert.equal(p[0].runs[1].b, false);
  assert.equal(p[4].runs[0].i, true);
});

test('HTML 轉段落：清單', () => {
  const p = htmlToParagraphs('<ol><li>一</li><li>二</li></ol><ul><li>點</li></ul>');
  assert.equal(paragraphsToText(p), '1. 一\n2. 二\n• 點');
});

test('結尾的空行會被去掉；空字串回傳空陣列', () => {
  assert.equal(htmlToParagraphs('文字<br><br>').length, 1);
  assert.equal(htmlToParagraphs('一<br><br>二').length, 3);
  assert.equal(htmlToParagraphs('文字<div><br></div>').length, 1);
  assert.deepEqual(htmlToParagraphs(''), []);
});

test('純文字轉 HTML 會跳脫並保留換行', () => {
  assert.equal(textToHtml('a < b\n第二行\n'), 'a &lt; b<br>第二行');
});

test('投影片：窄內容照原尺寸，不切頁', () => {
  const { scale, slides } = planSlides([box('a', 64, 40, 600, 100), box('b', 64, 200, 300, 100)], { w: 13.333, h: 7.5, margin: 0.5 });
  assert.equal(scale, 1 / 96);
  assert.equal(slides.length, 1);
  assert.equal(slides[0].blocks[0].sx, 0.5);
  assert.equal(slides[0].blocks[0].sy, 0.5);
});

test('投影片：太寬會縮小，太長會切成好幾張', () => {
  const blocks = [box('a', 0, 0, 2400, 100), box('b', 0, 2000, 100, 100), box('c', 0, 4000, 100, 100)];
  const { scale, slides } = planSlides(blocks, { w: 13.333, h: 7.5, margin: 0.5 });
  assert.ok(Math.abs(scale - 12.333 / 2400) < 1e-9);
  // 縮小後一張放得下約 1265px 高，三個區塊相隔 2000px，各自一張
  assert.equal(slides.length, 3);
  for (const s of slides) for (const b of s.blocks) {
    assert.ok(b.sy >= 0.5 - 1e-9 && b.sy + b.sh <= 7.5 - 0.5 + 1e-9, `${b.id} 超出投影片`);
  }
});

test('空白頁也有一張投影片', () => {
  assert.equal(planSlides([], { w: 10, h: 5, margin: 0.5 }).slides.length, 1);
});

test('圖片縮到指定寬度', () => {
  assert.deepEqual(fitWidth(1200, 300, 600), { w: 600, h: 150 });
  assert.deepEqual(fitWidth(100, 50, 600), { w: 100, h: 50 });
});

test('勾選清單：打勾狀態和縮排層級', async () => {
  const { htmlToParagraphs, paragraphsToText } = await import('../js/layout.js');
  const p = htmlToParagraphs('<div>購物</div><ul class="checklist"><li>牛奶</li><li class="done">雞蛋<ul class="checklist"><li class="done">有機的</li></ul></li><li>麵包</li></ul>');
  assert.deepEqual(p.map((x) => [x.list, x.checked, x.depth, x.runs.map((r) => r.text).join('')]), [
    [null, false, 0, '購物'], ['check', false, 0, '牛奶'], ['check', true, 0, '雞蛋'], ['check', true, 1, '有機的'], ['check', false, 0, '麵包'],
  ]);
  assert.equal(paragraphsToText(p), '購物\n☐ 牛奶\n☑ 雞蛋\n  ☑ 有機的\n☐ 麵包');
});

test('一般項目清單不會被當成勾選清單', async () => {
  const { htmlToParagraphs } = await import('../js/layout.js');
  const p = htmlToParagraphs('<ul><li class="done">a</li></ul>');
  assert.equal(p[0].list, 'ul');
  assert.equal(p[0].checked, false);
});

test('整個文字框轉成勾選清單，再轉回來', async () => {
  const { htmlToParagraphs, toggleChecklistHtml } = await import('../js/layout.js');
  const html = toggleChecklistHtml(htmlToParagraphs('<b>牛奶</b><div>雞蛋 &amp; 麵包</div><div><br></div>'));
  assert.equal(html, '<ul class="checklist"><li><b>牛奶</b></li><li>雞蛋 &amp; 麵包</li></ul>');
  const back = toggleChecklistHtml(htmlToParagraphs(html));
  assert.equal(back, '<div><b>牛奶</b></div><div>雞蛋 &amp; 麵包</div>');
  assert.equal(toggleChecklistHtml([]), '<ul class="checklist"><li><br></li></ul>');
});

test('打勾的項目轉換時保留狀態', async () => {
  const { htmlToParagraphs, toggleChecklistHtml } = await import('../js/layout.js');
  const html = toggleChecklistHtml(htmlToParagraphs('<ul><li>a</li></ul><ul class="checklist"><li class="done">b</li></ul>'));
  assert.equal(html, '<ul class="checklist"><li>a</li><li class="done">b</li></ul>');
});
