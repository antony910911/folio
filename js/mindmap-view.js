// 把心智圖畫到頁面上：節點是 HTML（可以換行、可以直接編輯文字），連線是 SVG。
// 先量每個節點的大小，再排版、定位。已經存在的節點元素會重複使用，編輯中的文字才不會被打斷。

import { layoutMindmap, edgePath, BRANCH_COLORS } from './mindmap.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROOT_COLOR = '#1f2a44';

export function branchColor(branch) {
  return branch < 0 ? ROOT_COLOR : BRANCH_COLORS[branch % BRANCH_COLORS.length];
}

// container 是 div.mindmap；回傳排版結果（座標以中心主題左上角為原點）
export function renderMindmap(container, item, { selectedId = null } = {}) {
  let svg = container.querySelector(':scope > svg');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('mm-edges');
    container.prepend(svg);
  }
  const existing = new Map([...container.querySelectorAll(':scope > .mm-node')].map((el) => [el.dataset.node, el]));
  const keep = new Set();
  const sizes = new Map();

  // 第一輪：建立或更新看得到的節點，量大小
  const visit = (n, depth, branch) => {
    let el = existing.get(n.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.node = n.id;
      el.innerHTML = '<span class="mm-text"></span><span class="mm-fold"></span>';
      container.appendChild(el);
    }
    keep.add(n.id);
    el.className = `mm-node d${Math.min(depth, 2)}${n.id === selectedId ? ' sel' : ''}`;
    el.style.setProperty('--c', branchColor(branch));
    const text = el.firstChild;
    if (!text.isContentEditable && text.textContent !== n.text) text.textContent = n.text;
    const fold = el.lastChild;
    fold.textContent = n.collapsed && n.children.length ? String(countHidden(n)) : '';
    fold.hidden = !fold.textContent;
    sizes.set(n.id, { w: el.offsetWidth, h: el.offsetHeight });
    if (!n.collapsed) n.children.forEach((c, i) => visit(c, depth + 1, depth === 0 ? i : branch));
  };
  visit(item.root, 0, -1);
  for (const [id, el] of existing) if (!keep.has(id)) el.remove();

  // 第二輪：排版、定位
  const layout = layoutMindmap(item.root, (n) => sizes.get(n.id));
  for (const b of layout.nodes) {
    const el = container.querySelector(`:scope > .mm-node[data-node="${b.id}"]`);
    el.style.transform = `translate(${b.x}px, ${b.y}px)`;
    el.classList.toggle('left', b.side < 0);
  }
  const pad = 4;
  const { x, y, w, h } = layout.bounds;
  Object.assign(svg.style, { left: x - pad + 'px', top: y - pad + 'px' });
  svg.setAttribute('width', w + pad * 2);
  svg.setAttribute('height', h + pad * 2);
  svg.setAttribute('viewBox', `${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}`);
  svg.replaceChildren(...layout.edges.map((e) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', edgePath(e));
    p.setAttribute('stroke', branchColor(e.branch));
    p.setAttribute('stroke-width', e.depth === 1 ? 2.5 : 1.8);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-linecap', 'round');
    return p;
  }));
  return layout;
}

function countHidden(n) {
  return n.children.reduce((sum, c) => sum + 1 + countHidden(c), 0);
}

// 匯出時量沒打開的頁面：在畫面外畫一份再拿掉
let host = null;
export function measureMindmap(item) {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'absolute', left: '-100000px', top: '0', visibility: 'hidden' });
    host.style.setProperty('--z', '1');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'mindmap';
  host.appendChild(el);
  const layout = renderMindmap(el, { ...item, root: expandAll(item.root) });
  el.remove();
  return layout;
}

// 匯出時收合的分支也要畫出來
function expandAll(n) {
  return { ...n, collapsed: false, children: n.children.map(expandAll) };
}
