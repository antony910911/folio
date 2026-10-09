// 心智圖的資料和排版。純函式，不碰 DOM。
// 心智圖是頁面上的一個項目：{ type: 'mindmap', x, y, root }，(x, y) 是中心主題左上角的位置，
// 加減節點時中心主題不會動，分支往左右長出去。
// 節點：{ id, text, children: [], collapsed? }

import { newId } from './model.js';

export const BRANCH_COLORS = ['#3d6fd8', '#d9534f', '#2f9e6e', '#d98b2b', '#8a5cd1', '#c2478f', '#2b9bb3', '#6b7280'];
export const HGAP = 44; // 父節點和子節點之間的水平距離
export const VGAP = 12; // 兄弟節點之間的垂直距離

export function newNode(text = '新主題', children = []) {
  return { id: newId('n_'), text, children };
}

export function defaultMindmap(x, y) {
  return {
    id: newId('m_'),
    type: 'mindmap',
    x: Math.round(x),
    y: Math.round(y),
    root: newNode('中心主題', [newNode('主題 1'), newNode('主題 2'), newNode('主題 3')]),
  };
}

// ---------- 樹的操作（都在傳進來的樹上直接改，呼叫的人負責先複製） ----------
export function findNode(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

export function findParent(root, id) {
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = findParent(c, id);
    if (hit) return hit;
  }
  return null;
}

export function addChild(root, parentId, text) {
  const parent = findNode(root, parentId);
  if (!parent) return null;
  const node = newNode(text);
  parent.children.push(node);
  parent.collapsed = false;
  return node.id;
}

// 在 id 後面加一個兄弟節點；中心主題沒有兄弟，就改加子節點
export function addSibling(root, id, text) {
  const parent = findParent(root, id);
  if (!parent) return addChild(root, id, text);
  const node = newNode(text);
  parent.children.splice(parent.children.findIndex((c) => c.id === id) + 1, 0, node);
  return node.id;
}

// 刪掉節點（連同子節點），回傳刪完後應該選取的節點 id
export function removeNode(root, id) {
  const parent = findParent(root, id);
  if (!parent) return null;
  const i = parent.children.findIndex((c) => c.id === id);
  parent.children.splice(i, 1);
  const next = parent.children[i] || parent.children[i - 1];
  return next ? next.id : parent.id;
}

export function moveSibling(root, id, delta) {
  const parent = findParent(root, id);
  if (!parent) return false;
  const i = parent.children.findIndex((c) => c.id === id);
  const j = i + delta;
  if (j < 0 || j >= parent.children.length) return false;
  [parent.children[i], parent.children[j]] = [parent.children[j], parent.children[i]];
  return true;
}

export function countNodes(node) {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

// ---------- 排版 ----------
// measure(node, depth) → { w, h }。回傳的座標以中心主題的左上角為 (0, 0)。
// 回傳 { nodes: [{ id, x, y, w, h, depth, branch, side, node }], edges: [{ from, to, branch, x1, y1, x2, y2, depth }], bounds }
export function layoutMindmap(root, measure) {
  const sizes = new Map();
  const size = (n, depth) => {
    if (!sizes.has(n.id)) sizes.set(n.id, measure(n, depth));
    return sizes.get(n.id);
  };
  const visibleChildren = (n) => (n.collapsed ? [] : n.children);
  const subtreeH = (n, depth) => {
    const own = size(n, depth).h;
    const kids = visibleChildren(n);
    if (!kids.length) return own;
    const block = kids.reduce((sum, c) => sum + subtreeH(c, depth + 1), 0) + VGAP * (kids.length - 1);
    return Math.max(own, block);
  };

  const nodes = [];
  const edges = [];
  const rootSize = size(root, 0);
  nodes.push({ id: root.id, x: 0, y: 0, w: rootSize.w, h: rootSize.h, depth: 0, branch: -1, side: 0, node: root });

  // 第一層分給左右兩邊：少的時候全部放右邊，多的時候讓兩邊高度差不多
  const firsts = visibleChildren(root);
  const heights = firsts.map((c) => subtreeH(c, 1));
  const total = heights.reduce((a, b) => a + b, 0);
  let right = firsts.length;
  if (firsts.length > 3) {
    let acc = 0;
    right = 0;
    while (right < firsts.length && acc + heights[right] / 2 < total / 2) acc += heights[right++];
    right = Math.max(1, Math.min(firsts.length - 1, right));
  }
  const sides = [
    { list: firsts.slice(0, right).map((n, i) => ({ n, branch: i })), side: 1 },
    { list: firsts.slice(right).map((n, i) => ({ n, branch: right + i })), side: -1 },
  ];

  const place = (n, depth, branch, side, anchorX, top, parentBox) => {
    const s = size(n, depth);
    const h = subtreeH(n, depth);
    const box = { id: n.id, x: side > 0 ? anchorX : anchorX - s.w, y: top + (h - s.h) / 2, w: s.w, h: s.h, depth, branch, side, node: n };
    nodes.push(box);
    edges.push({
      from: parentBox.id,
      to: n.id,
      branch,
      depth,
      x1: side > 0 ? parentBox.x + parentBox.w : parentBox.x,
      y1: parentBox.y + parentBox.h / 2,
      x2: side > 0 ? box.x : box.x + box.w,
      y2: box.y + box.h / 2,
    });
    const kids = visibleChildren(n);
    if (!kids.length) return;
    const block = kids.reduce((sum, c) => sum + subtreeH(c, depth + 1), 0) + VGAP * (kids.length - 1);
    let y = top + (h - block) / 2;
    const childX = side > 0 ? box.x + box.w + HGAP : box.x - HGAP;
    for (const c of kids) {
      place(c, depth + 1, branch, side, childX, y, box);
      y += subtreeH(c, depth + 1) + VGAP;
    }
  };

  const rootBox = nodes[0];
  for (const { list, side } of sides) {
    if (!list.length) continue;
    const block = list.reduce((sum, { n }) => sum + subtreeH(n, 1), 0) + VGAP * (list.length - 1);
    let y = rootSize.h / 2 - block / 2;
    const x = side > 0 ? rootSize.w + HGAP * 1.4 : -HGAP * 1.4;
    for (const { n, branch } of list) {
      place(n, 1, branch, side, x, y, rootBox);
      y += subtreeH(n, 1) + VGAP;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of nodes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { nodes, edges, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

// 連線：水平方向的 S 形曲線
export function edgePath(e) {
  const mid = (e.x1 + e.x2) / 2;
  return `M${e.x1},${e.y1} C${mid},${e.y1} ${mid},${e.y2} ${e.x2},${e.y2}`;
}

// ---------- 和大綱互轉 ----------
// lines: 文字陣列，用開頭的空白或項目符號判斷層級。第一行是中心主題。
export function outlineToTree(lines) {
  const rows = [];
  for (const raw of lines) {
    const m = raw.match(/^([ \t　 ]*)(?:[-*•‧·▪◦○●]|\d+[.)、]|[（(]?\d+[)）])?\s*(.*)$/);
    const text = (m ? m[2] : raw).trim();
    if (!text) continue;
    const indent = m ? [...m[1]].reduce((n, ch) => n + (ch === '\t' || ch === '　' ? 2 : 1), 0) : 0;
    rows.push({ text, indent });
  }
  if (!rows.length) return null;
  const root = newNode(rows[0].text);
  // 堆疊放 { node, indent }；縮排比上一層多才算子節點
  const stack = [{ node: root, indent: -1 }];
  for (const r of rows.slice(1)) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= r.indent) stack.pop();
    const node = newNode(r.text);
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent: r.indent });
  }
  return root;
}

// 心智圖轉大綱（匯出 Word 用）：[{ text, depth }]，收合的節點也包含
export function treeToOutline(root) {
  const out = [];
  const walk = (n, depth) => {
    out.push({ text: n.text, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

// 複製整棵樹並換掉所有 id（複製心智圖用）
export function cloneWithNewIds(node) {
  return { ...node, id: newId('n_'), children: node.children.map(cloneWithNewIds) };
}
