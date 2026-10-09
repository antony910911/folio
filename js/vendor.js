// 第三方函式庫在用到時才載入，平常開 App 不會變慢。
// 檔案放在 vendor/，加入主畫面後離線也能匯出。預覽版會用 FOLIO_VENDOR 改成 CDN 網址。

const LOCAL = {
  pptx: 'vendor/pptxgen-4.0.1.bundle.js',
  docx: 'vendor/docx-9.7.2.iife.js',
  anthropic: 'vendor/anthropic-sdk-0.128.0.mjs',
};

function urlFor(name) {
  const override = globalThis.FOLIO_VENDOR && globalThis.FOLIO_VENDOR[name];
  return new URL(override || LOCAL[name], document.baseURI).href;
}

const loaded = new Map();

function loadScript(name, globalName) {
  if (!loaded.has(name)) {
    loaded.set(name, new Promise((resolve, reject) => {
      if (globalThis[globalName]) { resolve(globalThis[globalName]); return; }
      const s = document.createElement('script');
      s.src = urlFor(name);
      s.onload = () => (globalThis[globalName] ? resolve(globalThis[globalName]) : reject(new Error(`${name} 載入失敗`)));
      s.onerror = () => { loaded.delete(name); reject(new Error(`${name} 載入失敗，請確認網路連線後再試一次。`)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(name);
}

export const loadPptx = () => loadScript('pptx', 'PptxGenJS');
export const loadDocx = () => loadScript('docx', 'docx');

export async function loadAnthropic() {
  if (!loaded.has('anthropic')) loaded.set('anthropic', import(urlFor('anthropic')).then((m) => m.default));
  return loaded.get('anthropic');
}
