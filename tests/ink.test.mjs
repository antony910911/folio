import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strokeOutline, radiusFor, strokeHit, strokeBounds, strokeInRect, rectFromPoints,
  compactPoints, translateStroke, simulatedPressure, unionBounds, distToSegment,
} from '../js/ink.js';

const line = (n = 20) => Array.from({ length: n }, (_, i) => [10 + i * 5, 50, 0.5]);

test('一個點畫成圓點', () => {
  const d = strokeOutline([[10, 10, 0.5]], { size: 4 });
  assert.match(d, /^M8,10a2,2/);
});

test('外框是封閉路徑，沒有 NaN', () => {
  const d = strokeOutline(line(), { size: 3 });
  assert.ok(d.startsWith('M') && d.endsWith('Z'));
  assert.ok(!d.includes('NaN'));
});

test('原地重複的點不會產生 NaN', () => {
  const d = strokeOutline([[5, 5, 0.5], [5, 5, 0.6], [5, 5, 0.7]], { size: 3 });
  assert.ok(!d.includes('NaN'));
});

test('筆壓越大越粗；thinning 為 0 時固定粗細', () => {
  assert.ok(radiusFor(4, 1, 0.6) > radiusFor(4, 0.2, 0.6));
  assert.equal(radiusFor(10, 0.1, 0), radiusFor(10, 0.9, 0));
  assert.ok(radiusFor(1, 0, 1) >= 0.35);
});

test('橡皮擦碰撞', () => {
  const s = { points: line(), size: 4 };
  assert.ok(strokeHit(s, 40, 53, 2));
  assert.ok(!strokeHit(s, 40, 70, 2));
  assert.ok(!strokeHit(s, 400, 50, 2));
});

test('單點筆畫也擦得到', () => {
  assert.ok(strokeHit({ points: [[10, 10, 0.5]], size: 4 }, 12, 10, 1));
});

test('框選需要一半以上的點在框內', () => {
  const s = { points: line(), size: 2 };
  assert.ok(strokeInRect(s, { x: 0, y: 0, w: 200, h: 100 }));
  assert.ok(!strokeInRect(s, { x: 0, y: 0, w: 30, h: 100 }));
});

test('邊界與合併', () => {
  const b = strokeBounds({ points: [[0, 0], [10, 20]], size: 2 });
  assert.deepEqual(b, { x: -2, y: -2, w: 14, h: 24 });
  assert.deepEqual(unionBounds([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: -5, w: 1, h: 1 }]), { x: 0, y: -5, w: 6, h: 6 });
  assert.equal(unionBounds([]), null);
});

test('反方向拖曳也能得到正規化矩形', () => {
  assert.deepEqual(rectFromPoints(10, 10, 0, 4), { x: 0, y: 4, w: 10, h: 6 });
});

test('壓縮座標、平移', () => {
  assert.deepEqual(compactPoints([[1.23456, 2.34567, 0.77777]]), [[1.23, 2.35, 0.78]]);
  const t = translateStroke({ id: 'a', points: [[1, 1, 0.5]] }, 2, 3);
  assert.deepEqual(t.points, [[3, 4, 0.5]]);
});

test('模擬筆壓維持在範圍內', () => {
  let p = null;
  for (const dist of [0, 100, 0, 3, 50]) {
    p = simulatedPressure(p, dist);
    assert.ok(p >= 0.25 && p <= 0.85);
  }
});

test('點到線段距離', () => {
  assert.equal(distToSegment(5, 5, 0, 0, 10, 0), 5);
  assert.equal(distToSegment(-3, 4, 0, 0, 10, 0), 5);
  assert.equal(distToSegment(3, 4, 0, 0, 0, 0), 5);
});
