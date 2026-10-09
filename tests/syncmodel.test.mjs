import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRev, parseRev, compareRev, createClock, keyFor, parseKey, hash, fingerprint,
  diffItems, applyItemChanges, shouldApply, batchRecords,
} from '../js/syncmodel.js';

test('rev 字串比大小就是時間先後', () => {
  const a = makeRev(1_000, 0, 'dev1');
  const b = makeRev(1_000, 1, 'dev0');
  const c = makeRev(2_000, 0, 'aaaa');
  assert.ok(a < b && b < c);
  assert.equal(compareRev(a, a), 0);
  assert.equal(compareRev('', a), -1);
  assert.deepEqual(parseRev(b), { ms: 1000, counter: 1, device: 'dev0' });
});

test('同一毫秒內連續產生的 rev 也是遞增', () => {
  const clock = createClock('d', null, () => 5000);
  const r = [clock.next(), clock.next(), clock.next()];
  assert.ok(r[0] < r[1] && r[1] < r[2]);
});

test('時鐘倒退時 rev 也不會變小', () => {
  let t = 5000;
  const clock = createClock('d', null, () => t);
  const a = clock.next();
  t = 1000;
  assert.ok(clock.next() > a);
});

test('看過別台裝置比較新的 rev 後，新的修改會比它大', () => {
  const clock = createClock('ipad', null, () => 1000);
  const remote = makeRev(9_000_000, 3, 'mac');
  clock.observe(remote);
  assert.ok(clock.next() > remote);
});

test('時鐘狀態可以存起來再接續', () => {
  const c1 = createClock('d', null, () => 7000);
  const last = c1.next();
  const c2 = createClock('d', c1.state(), () => 10);
  assert.ok(c2.next() > last);
});

test('key 的組成和解析', () => {
  assert.equal(keyFor.item('pg_1', 's_2'), 'it:pg_1:s_2');
  assert.deepEqual(parseKey('it:pg_1:s_2'), { kind: 'item', page: 'pg_1', id: 's_2' });
  assert.deepEqual(parseKey('nb:nb_9'), { kind: 'notebooks', id: 'nb_9' });
  assert.deepEqual(parseKey('as:as_x'), { kind: 'asset', id: 'as_x' });
  assert.equal(parseKey('zz:1'), null);
});

test('雜湊：內容一樣就一樣，不同就不同', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});

test('筆跡的指紋：移動、換色會變', () => {
  const s = { id: 's', type: 'stroke', tool: 'pen', color: '#000', size: 3, points: [[0, 0, 0.5], [10, 10, 0.5]] };
  assert.equal(fingerprint(s), fingerprint({ ...s }));
  assert.notEqual(fingerprint(s), fingerprint({ ...s, points: [[1, 0, 0.5], [11, 10, 0.5]] }));
  assert.notEqual(fingerprint(s), fingerprint({ ...s, color: '#f00' }));
  const t = { id: 't', type: 'text', x: 0, y: 0, w: 100, html: 'a' };
  assert.notEqual(fingerprint(t), fingerprint({ ...t, html: 'b' }));
});

test('比對一頁的項目：新增、修改、刪除', () => {
  const a = { id: 'a', type: 'text', x: 0, y: 0, w: 1, html: 'x' };
  const b = { id: 'b', type: 'text', x: 0, y: 0, w: 1, html: 'y' };
  const known = new Map([['a', fingerprint(a)], ['gone', 'zzz']]);
  const { upserts, deletes } = diffItems([a, { ...b }], known);
  assert.deepEqual(upserts.map((x) => x.id), ['b']);
  assert.deepEqual(deletes, ['gone']);
  const changed = diffItems([{ ...a, html: 'new' }], new Map([['a', fingerprint(a)]]));
  assert.deepEqual(changed.upserts.map((x) => x.id), ['a']);
});

test('套用遠端變更：就地換掉、新的加在後面、刪除', () => {
  const items = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const out = applyItemChanges(items, [
    { id: 'b', data: { id: 'b', v: 2 } },
    { id: 'd', data: { id: 'd', v: 1 } },
    { id: 'a', deleted: 1 },
  ]);
  assert.deepEqual(out, [{ id: 'b', v: 2 }, { id: 'c', v: 1 }, { id: 'd', v: 1 }]);
});

test('同一批裡先刪再新增，以最後一筆為準', () => {
  const out = applyItemChanges([{ id: 'a' }], [{ id: 'a', deleted: 1 }, { id: 'a', data: { id: 'a', back: true } }]);
  assert.deepEqual(out, [{ id: 'a', back: true }]);
});

test('只有比較新的遠端版本才套用', () => {
  const old = makeRev(1, 0, 'a');
  const neu = makeRev(2, 0, 'a');
  assert.ok(shouldApply(neu, old));
  assert.ok(!shouldApply(old, neu));
  assert.ok(!shouldApply(old, old));
  assert.ok(shouldApply(old, undefined));
});

test('分批：數量和大小都有上限', () => {
  const recs = Array.from({ length: 450 }, (_, i) => ({ key: 'k' + i, data: 'x'.repeat(100) }));
  const byCount = batchRecords(recs, { maxCount: 200 });
  assert.deepEqual(byCount.map((b) => b.length), [200, 200, 50]);
  const bySize = batchRecords(recs, { maxCount: 1000, maxBytes: 5000 });
  assert.ok(bySize.length > 1 && bySize.every((b) => JSON.stringify(b).length < 6000));
  // 單筆超過上限也要自己成一批，不能卡住
  assert.equal(batchRecords([{ data: 'x'.repeat(100) }], { maxBytes: 10 }).length, 1);
});
