// 手寫辨識：把筆跡畫成圖片交給 Claude 讀。
// 兩種來源，依序嘗試：
// 1. 在 claude.ai 的預覽裡：用檢視者自己的 Claude 帳號（sample 功能），不需要金鑰。
// 2. 自己架的 App：用使用者在設定裡填的 Anthropic API 金鑰，金鑰只存在這台裝置。

import { loadAnthropic } from './vendor.js';
import { blobToBase64 } from './inkrender.js';

const KEY_STORAGE = 'folio.anthropicKey';
const MODEL = 'claude-opus-5-5';
const EMPTY = '[[無法辨識]]';

export const PROMPT = `這張圖是一段手寫筆記。請把上面的手寫內容逐字轉成文字。

- 只輸出轉好的文字，不要加任何說明、引號或 Markdown 格式。
- 照原本的寫法輸出：寫繁體就輸出繁體，寫英文就輸出英文，不要翻譯或改寫。
- 保留原本的換行。箭頭寫成 →，項目符號寫成 •。
- 看不清楚的字，依上下文選最可能的寫法。
- 如果圖上沒有可以辨識的文字，只輸出 ${EMPTY}`;

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* 存不了就算了，這次照樣能用 */ }
}

export class RecognizeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let samplePromise = null;
async function getSample() {
  if (!globalThis.claude || typeof globalThis.claude.use !== 'function') return null;
  if (!samplePromise) {
    samplePromise = globalThis.claude.use('sample').then(async (sample) => {
      if (!sample) return null;
      const limits = await sample.limits().catch(() => null);
      return limits && limits.images ? sample : null;
    }).catch(() => null);
  }
  return samplePromise;
}

// 目前會用哪一種方式辨識：'account' | 'apikey' | null
export async function backend() {
  if (await getSample()) return 'account';
  if (getApiKey()) return 'apikey';
  return null;
}

function clean(text) {
  const t = (text || '').trim();
  return t.includes(EMPTY) ? '' : t;
}

// blob: PNG 圖片。回傳辨識出的文字（可能是空字串）。
export async function recognize(blob) {
  const sample = await getSample();
  if (sample) return clean(await viaAccount(sample, blob));
  const key = getApiKey();
  if (!key) throw new RecognizeError('no_backend', '請先到「⋯ › 手寫辨識設定」填入 Anthropic API 金鑰。');
  return clean(await viaApi(key, blob));
}

async function viaAccount(sample, blob) {
  try {
    const { text } = await sample(PROMPT, { images: [blob] });
    return text;
  } catch (e) {
    const code = e && e.code;
    if (code === 'not_granted' || code === 'sampling_disabled' || code === 'images_unavailable') {
      throw new RecognizeError('denied', '沒有取得使用 Claude 的權限，所以無法辨識。');
    }
    if (code === 'rate_limited') throw new RecognizeError('rate_limited', '短時間內辨識太多次了，請稍等一下再試。');
    if (code === 'refused') throw new RecognizeError('refused', 'Claude 沒有辨識這段內容。');
    throw new RecognizeError('failed', '辨識失敗，請再試一次。');
  }
}

async function viaApi(apiKey, blob) {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = await blobToBase64(blob);
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // 逐字轉寫不需要深入思考
      output_config: { effort: 'low' },
      // 被安全機制擋下時，自動改用其他模型再試一次
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new RecognizeError('bad_key', 'API 金鑰無效，請到「手寫辨識設定」重新填寫。');
    if (e instanceof Anthropic.PermissionDeniedError) throw new RecognizeError('bad_key', '這把 API 金鑰沒有使用權限。');
    if (e instanceof Anthropic.RateLimitError) throw new RecognizeError('rate_limited', '短時間內辨識太多次了，請稍等一下再試。');
    if (e instanceof Anthropic.APIConnectionError) throw new RecognizeError('offline', '連不上 Claude，請確認網路連線。');
    if (e instanceof Anthropic.APIError) throw new RecognizeError('failed', `辨識失敗（${e.status ?? '錯誤'}），請再試一次。`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new RecognizeError('refused', 'Claude 沒有辨識這段內容。');
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
