// 筆記本密碼：只存加鹽的 PBKDF2 雜湊，不存密碼本身。雜湊跟著筆記本一起同步，每台裝置用同一組密碼。
// 這是「不讓旁邊的人看到、避免誤觸」用的；筆記內容本身沒有加密。

const ITERATIONS = 150000;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function derive(code, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(code.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256);
  return hex(bits);
}

export async function makeLock(code) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { v: 1, salt, iterations: ITERATIONS, hash: await derive(code, salt, ITERATIONS) };
}

export async function checkLock(lock, code) {
  if (!lock || typeof lock.salt !== 'string' || typeof lock.hash !== 'string') return false;
  return (await derive(code, lock.salt, lock.iterations || ITERATIONS)) === lock.hash;
}

export function isLocked(nb, unlocked) {
  return !!(nb && nb.lock) && !unlocked.has(nb.id);
}

// 打開 App 或目前這本不能看時，要切到哪一本：優先沒隱藏、沒上鎖的
export function pickNotebook(notebooks, { unlocked = new Set(), revealHidden = false } = {}) {
  const visible = notebooks.filter((n) => !n.hidden || revealHidden);
  return visible.find((n) => !isLocked(n, unlocked)) || visible[0] || notebooks[0] || null;
}
