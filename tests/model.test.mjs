import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotebook, createSection, createPage, nextOrder, sortByOrder, moveInOrder,
  cascadeIds, validateBackup, isValidItem, seedData, pageDisplayTitle, SECTION_COLORS,
} from '../js/model.js';

test('新項目排在最後，分區顏色輪流', () => {
  const nb = createNotebook('A');
  const s1 = createSection(nb.id, 'x', []);
  const s2 = createSection(nb.id, 'y', [s1]);
  assert.equal(s2.order, s1.order + 1);
  assert.equal(s1.color, SECTION_COLORS[0]);
  assert.equal(s2.color, SECTION_COLORS[1]);
  assert.equal(nextOrder([]), 1);
});

test('沒有標題的頁面顯示「未命名頁面」', () => {
  assert.equal(pageDisplayTitle(createPage('s', [])), '未命名頁面');
  assert.equal(pageDisplayTitle({ title: ' 會議 ' }), '會議');
});

test('上移下移交換 order，邊界不動', () => {
  const list = [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 }];
  const ch = moveInOrder(list, 'b', -1);
  assert.deepEqual(ch.map((x) => [x.id, x.order]), [['b', 1], ['a', 2]]);
  assert.deepEqual(moveInOrder(list, 'a', -1), []);
  assert.deepEqual(moveInOrder(list, 'c', 1), []);
});

test('order 重複時也能交換', () => {
  const list = [{ id: 'a', order: 1, createdAt: 1 }, { id: 'b', order: 1, createdAt: 2 }];
  const ch = moveInOrder(list, 'b', -1);
  const merged = sortByOrder(list.map((x) => ch.find((c) => c.id === x.id) || x));
  assert.deepEqual(merged.map((x) => x.id), ['b', 'a']);
});

test('刪除筆記本連帶分區和頁面', () => {
  const db = {
    sections: [{ id: 's1', notebookId: 'n1' }, { id: 's2', notebookId: 'n2' }],
    pages: [{ id: 'p1', sectionId: 's1' }, { id: 'p2', sectionId: 's2' }],
  };
  assert.deepEqual(cascadeIds(db, 'notebook', 'n1'), { notebooks: ['n1'], sections: ['s1'], pages: ['p1'] });
  assert.deepEqual(cascadeIds(db, 'section', 's2'), { notebooks: [], sections: ['s2'], pages: ['p2'] });
  assert.deepEqual(cascadeIds(db, 'page', 'p1'), { notebooks: [], sections: [], pages: ['p1'] });
});

test('示範資料本身是合法備份', () => {
  const seed = seedData();
  const res = validateBackup({ app: 'folio', version: 1, ...seed });
  assert.ok(res.ok);
  assert.equal(res.data.contents[0].items.length, seed.contents[0].items.length);
});

test('備份檢查：丟掉孤兒和壞資料', () => {
  const raw = {
    app: 'folio', version: 1,
    notebooks: [{ id: 'n1', name: 'A' }],
    sections: [{ id: 's1', notebookId: 'n1' }, { id: 's9', notebookId: 'missing' }],
    pages: [{ id: 'p1', sectionId: 's1' }, { id: 'p9', sectionId: 's9' }],
    contents: [{ id: 'p1', items: [
      { id: 'a', type: 'stroke', points: [[1, 2, 0.5]] },
      { id: 'b', type: 'stroke', points: [[1, 'x']] },
      { id: 'c', type: 'text', x: 1, y: 2, w: 100, html: 'hi' },
      { id: 'd', type: 'script' },
    ] }],
  };
  const res = validateBackup(raw);
  assert.ok(res.ok);
  assert.deepEqual(res.data.sections.map((s) => s.id), ['s1']);
  assert.deepEqual(res.data.pages.map((p) => p.id), ['p1']);
  assert.deepEqual(res.data.contents[0].items.map((i) => i.id), ['a', 'c']);
});

test('備份檢查：拒絕不是 Folio 的檔案或較新版本', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({ app: 'other' }).ok, false);
  assert.equal(validateBackup({ app: 'folio', version: 99, notebooks: [{ id: 'a' }] }).ok, false);
  assert.equal(validateBackup({ app: 'folio', version: 1, notebooks: [] }).ok, false);
});

test('項目格式檢查', () => {
  assert.ok(isValidItem({ id: 'a', type: 'text', x: 0, y: 0, w: 10, html: '' }));
  assert.ok(!isValidItem({ id: 'a', type: 'text', x: 0, y: 0, w: Infinity, html: '' }));
  assert.ok(!isValidItem({ id: 'a', type: 'stroke', points: [] }));
});

test('頁數範圍', async () => {
  const { parsePageRange } = await import('../js/model.js');
  assert.deepEqual(parsePageRange('', 3), [1, 2, 3]);
  assert.deepEqual(parsePageRange('1-3, 5', 10), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRange('8-', 10), [8, 9, 10]);
  assert.deepEqual(parsePageRange('-2', 10), [1, 2]);
  assert.deepEqual(parsePageRange('2～4，2', 10), [2, 3, 4]);
  assert.deepEqual(parsePageRange('9-20', 10), [9, 10]);
  assert.equal(parsePageRange('5-2', 10), null);
  assert.equal(parsePageRange('abc', 10), null);
  assert.equal(parsePageRange('0', 10), null);
  assert.equal(parsePageRange('20', 10), null);
});

test('備份檢查：圖片要有對應的檔案才保留', () => {
  const raw = {
    app: 'folio', version: 2,
    notebooks: [{ id: 'n1' }], sections: [{ id: 's1', notebookId: 'n1' }], pages: [{ id: 'p1', sectionId: 's1' }],
    contents: [{ id: 'p1', items: [
      { id: 'a', type: 'image', x: 0, y: 0, w: 10, h: 10, asset: 'as1' },
      { id: 'b', type: 'image', x: 0, y: 0, w: 10, h: 10, asset: 'missing' },
      { id: 'c', type: 'image', x: 0, y: 0, w: 0, h: 10, asset: 'as1' },
    ] }],
    assets: [{ id: 'as1', type: 'image/jpeg', w: 100, h: 50, data: 'AAAA' }, { id: 'bad', type: 'text/html', w: 1, h: 1, data: 'x' }],
  };
  const res = validateBackup(raw);
  assert.ok(res.ok);
  assert.deepEqual(res.data.contents[0].items.map((i) => i.id), ['a']);
  assert.deepEqual(res.data.assets.map((a) => a.id), ['as1']);
});
