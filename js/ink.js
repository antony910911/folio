// 筆跡幾何：把筆的取樣點變成有粗細變化的外框，以及橡皮擦和框選用的碰撞判斷。
// 這裡只放純函式，不碰 DOM，方便用 node 測試。
// 一個取樣點是 [x, y, pressure]，pressure 介於 0 到 1。

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;

// 讓手抖的取樣點順一點：每個點往前一個點的方向拉一些。
export function streamline(points, amount = 0.45) {
  if (points.length < 3) return points.map((p) => [...p]);
  const out = [[...points[0]]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    const t = 1 - amount;
    const q = [lerp(prev[0], p[0], t), lerp(prev[1], p[1], t), p[2]];
    // 太近的點沒有資訊量，跳過
    if (Math.hypot(q[0] - prev[0], q[1] - prev[1]) < 0.4 && i < points.length - 1) continue;
    out.push(q);
  }
  // 最後一點用原始位置，筆畫才會畫到筆尖離開的地方
  const last = points[points.length - 1];
  out[out.length - 1] = [last[0], last[1], last[2]];
  return out;
}

// 筆壓轉成半徑。thinning 越大，筆壓對粗細的影響越大；0 就是固定粗細（螢光筆）。
export function radiusFor(size, pressure, thinning) {
  return Math.max(0.35, (size / 2) * (1 + thinning * (2 * clamp(pressure, 0, 1) - 1)));
}

function circlePath(x, y, r) {
  return `M${r2(x - r)},${r2(y)}a${r2(r)},${r2(r)} 0 1,0 ${r2(r * 2)},0a${r2(r)},${r2(r)} 0 1,0 ${r2(-r * 2)},0Z`;
}

// 回傳 SVG path 的 d 字串：左右兩條邊線加上圓頭。
export function strokeOutline(points, { size = 3, thinning = 0.6, smoothing = 0.45 } = {}) {
  if (!points.length) return '';
  const pts = streamline(points, smoothing);
  if (pts.length === 1 || pathLength(pts) < 0.5) {
    const p = pts[0];
    return circlePath(p[0], p[1], radiusFor(size, p[2], thinning));
  }
  // 半徑也平滑，避免筆壓跳動造成鋸齒
  const radii = [];
  let rPrev = radiusFor(size, pts[0][2], thinning);
  for (const p of pts) {
    rPrev = lerp(rPrev, radiusFor(size, p[2], thinning), 0.5);
    radii.push(rPrev);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = radii[i];
    left.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    right.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
  }
  const rEnd = radii[radii.length - 1];
  const rStart = radii[0];
  let d = `M${r2(left[0][0])},${r2(left[0][1])}`;
  d += smoothThrough(left);
  const re = right[right.length - 1];
  d += `A${r2(rEnd)},${r2(rEnd)} 0 0,0 ${r2(re[0])},${r2(re[1])}`;
  const rev = right.slice().reverse();
  d += smoothThrough(rev);
  d += `A${r2(rStart)},${r2(rStart)} 0 0,0 ${r2(left[0][0])},${r2(left[0][1])}Z`;
  return d;
}

// 用二次曲線經過各點的中點，線條會比直接連折線順。
function smoothThrough(line) {
  if (line.length === 1) return '';
  let d = '';
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i];
    const n = line[i + 1];
    d += `Q${r2(p[0])},${r2(p[1])} ${r2((p[0] + n[0]) / 2)},${r2((p[1] + n[1]) / 2)}`;
  }
  const last = line[line.length - 1];
  d += `L${r2(last[0])},${r2(last[1])}`;
  return d;
}

export function pathLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return total;
}

// 滑鼠和手指沒有筆壓：用速度模擬，寫得快線條細一點。
export function simulatedPressure(prevPressure, distance) {
  const target = clamp(1 - distance / 28, 0.25, 0.85);
  return prevPressure == null ? 0.5 : lerp(prevPressure, target, 0.3);
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 橡皮擦：點 (x, y) 半徑 radius 內有沒有碰到這條筆畫。
export function strokeHit(stroke, x, y, radius) {
  const pts = stroke.points;
  const reach = radius + stroke.size / 2;
  const b = strokeBounds(stroke);
  if (x < b.x - radius || x > b.x + b.w + radius || y < b.y - radius || y > b.y + b.h + radius) return false;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
  }
  return false;
}

export function strokeBounds(stroke) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = stroke.size / 2 + 1;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// 框選：一半以上的取樣點在框內就算選到，斜斜框到一角不會誤選。
export function strokeInRect(stroke, rect) {
  if (!rectsIntersect(strokeBounds(stroke), rect)) return false;
  let inside = 0;
  for (const [x, y] of stroke.points) if (pointInRect(x, y, rect)) inside++;
  return inside / stroke.points.length >= 0.5;
}

export function unionBounds(list) {
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 從兩個角落點得到正規化的矩形（往左上拖也行）。
export function rectFromPoints(ax, ay, bx, by) {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

// 存檔前把座標縮成兩位小數，資料小很多。
export function compactPoints(points) {
  return points.map(([x, y, p]) => [r2(x), r2(y), Math.round(clamp(p, 0, 1) * 100) / 100]);
}

export function translateStroke(stroke, dx, dy) {
  return { ...stroke, points: stroke.points.map(([x, y, p]) => [r2(x + dx), r2(y + dy), p]) };
}
