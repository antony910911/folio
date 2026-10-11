import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLock, checkLock, isLocked, pickNotebook } from '../js/lock.js';

test('密碼：對的才會過，雜湊裡沒有原本的密碼', async () => {
  const lock = await makeLock('上班不看1234');
  assert.equal(lock.hash.length, 64);
  assert.ok(!JSON.stringify(lock).includes('1234'));
  assert.equal(await checkLock(lock, '上班不看1234'), true);
  assert.equal(await checkLock(lock, '上班不看123'), false);
  assert.equal(await checkLock(null, 'x'), false);
  const again = await makeLock('上班不看1234');
  assert.notEqual(again.hash, lock.hash); // 每次的鹽不一樣
});

test('pickNotebook 跳過隱藏和上鎖的', () => {
  const nbs = [{ id: 'a', hidden: true }, { id: 'b', lock: {} }, { id: 'c' }];
  assert.equal(pickNotebook(nbs).id, 'c');
  assert.equal(pickNotebook(nbs, { unlocked: new Set(['b']) }).id, 'b');
  assert.equal(pickNotebook(nbs, { revealHidden: true }).id, 'a');
  assert.equal(pickNotebook([{ id: 'x', lock: {} }]).id, 'x');
  assert.equal(pickNotebook([{ id: 'h', hidden: true }]).id, 'h');
  assert.equal(isLocked({ id: 'b', lock: {} }, new Set()), true);
  assert.equal(isLocked({ id: 'b', lock: {} }, new Set(['b'])), false);
});
