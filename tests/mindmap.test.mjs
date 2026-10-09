import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newNode, defaultMindmap, findNode, findParent, addChild, addSibling, removeNode, moveSibling, countNodes,
  layoutMindmap, edgePath, outlineToTree, treeToOutline, cloneWithNewIds, HGAP,
} from '../js/mindmap.js';
import { isValidTree, isValidItem } from '../js/model.js';

const measure = () => ({ w: 100, h: 30 });
const tree = () => {
  const r = newNode('root');
  r.id = 'r';
  r.children = ['a', 'b'].map((id) => ({ ...newNode(id), id }));
  return r;
};

test('新增子節點和兄弟節點', () => {
  const r = tree();
  const c = addChild(r, 'a', 'a1');
  assert.equal(findNode(r, 'a').children[0].id, c);
  const s = addSibling(r, 'a', 'a2');
  assert.deepEqual(r.children.map((x) => x.id), ['a', s, 'b']);
  // 中心主題沒有兄弟，改加子節點
  const k = addSibling(r, 'r', 'x');
  assert.equal(findParent(r, k).id, 'r');
});

test('加子節點會展開收合的節點', () => {
  const r = tree();
  findNode(r, 'a').collapsed = true;
  addChild(r, 'a', 'z');
  assert.equal(findNode(r, 'a').collapsed, false);
});

test('刪除節點後選取下一個、前一個或父節點', () => {
  const r = tree();
  assert.equal(removeNode(r, 'a'), 'b');
  assert.equal(removeNode(r, 'b'), 'r');
  assert.equal(removeNode(r, 'r'), null); // 中心主題不能刪
});

test('上下移動兄弟節點', () => {
  const r = tree();
  assert.ok(moveSibling(r, 'b', -1));
  assert.deepEqual(r.children.map((x) => x.id), ['b', 'a']);
  assert.ok(!moveSibling(r, 'b', -1));
});

test('預設心智圖有中心主題和三個分支', () => {
  const m = defaultMindmap(10, 20);
  assert.equal(countNodes(m.root), 4);
  assert.ok(isValidItem(m));
});

test('排版：少的時候全部在右邊，子節點垂直置中', () => {
  const r = tree();
  const { nodes, edges } = layoutMindmap(r, measure);
  const a = nodes.find((n) => n.id === 'a');
  const b = nodes.find((n) => n.id === 'b');
  assert.equal(a.side, 1);
  assert.ok(a.x >= 100 + HGAP);
  // 兩個子節點的中點和中心主題對齊
  assert.equal((a.y + b.y + 30) / 2, 15);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].x1, 100);
});

test('排版：多的時候分到左右兩邊，中心主題固定在原點', () => {
  const r = newNode('root');
  for (let i = 0; i < 6; i++) r.children.push(newNode('n' + i));
  const { nodes, bounds } = layoutMindmap(r, measure);
  const sides = nodes.filter((n) => n.depth === 1).map((n) => n.side);
  assert.deepEqual(sides, [1, 1, 1, -1, -1, -1]);
  assert.deepEqual([nodes[0].x, nodes[0].y], [0, 0]);
  assert.ok(bounds.x < 0);
  // 左邊的節點右緣在中心主題左邊
  for (const n of nodes.filter((n) => n.side < 0)) assert.ok(n.x + n.w <= -HGAP);
});

test('排版：節點不重疊', () => {
  const r = newNode('root');
  for (let i = 0; i < 5; i++) {
    const c = newNode('c' + i);
    for (let j = 0; j < i; j++) c.children.push(newNode(`c${i}-${j}`, [newNode('x')]));
    r.children.push(c);
  }
  const { nodes } = layoutMindmap(r, (n, d) => ({ w: 60 + d * 10, h: 24 + (n.text.length % 3) * 6 }));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.node.text} 和 ${b.node.text} 重疊`);
    }
  }
});

test('收合的節點不排子節點', () => {
  const r = tree();
  addChild(r, 'a', 'hidden');
  findNode(r, 'a').collapsed = true;
  assert.equal(layoutMindmap(r, measure).nodes.length, 3);
});

test('連線是 S 形曲線', () => {
  assert.equal(edgePath({ x1: 0, y1: 0, x2: 10, y2: 20 }), 'M0,0 C5,0 5,20 10,20');
});

test('大綱轉心智圖：縮排和項目符號', () => {
  const r = outlineToTree(['專案計畫', '• 目標', '  - 營收 +20%', '  - 新客戶', '• 時程', '\t1. 十月', '', '風險']);
  assert.equal(r.text, '專案計畫');
  assert.deepEqual(treeToOutline(r).map((x) => `${x.depth}:${x.text}`), [
    '0:專案計畫', '1:目標', '2:營收 +20%', '2:新客戶', '1:時程', '2:十月', '1:風險',
  ]);
  assert.equal(outlineToTree(['', '  ']), null);
});

test('全形空白也算縮排', () => {
  const r = outlineToTree(['主題', '分支', '　細節']);
  assert.equal(r.children[0].children[0].text, '細節');
});

test('複製會換掉所有 id', () => {
  const r = tree();
  const c = cloneWithNewIds(r);
  assert.notEqual(c.id, r.id);
  assert.notEqual(c.children[0].id, r.children[0].id);
  assert.equal(c.children[0].text, 'a');
});

test('樹的格式檢查', () => {
  assert.ok(isValidTree(tree()));
  assert.ok(!isValidTree({ id: 'x', text: 'a' }));
  assert.ok(!isValidTree({ id: 'x', text: 1, children: [] }));
  let deep = newNode('d');
  for (let i = 0; i < 40; i++) deep = newNode('d', [deep]);
  assert.ok(!isValidTree(deep));
});
