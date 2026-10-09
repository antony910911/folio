// 把整個 App 打包成單一 HTML（CSS、JS 全部內嵌），用來在不能放多個檔案的地方預覽。
// 用法：node tools/build-preview.mjs  → 輸出 dist/folio-preview.html
// 每個模組包成一個函式，import/export 換成物件存取；export 一律用 getter，`export let` 才會拿到最新值。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['icons', 'ink', 'model', 'layout', 'mindmap', 'store', 'syncmodel', 'sync', 'mindmap-view', 'editor', 'inkrender', 'vendor', 'recognize', 'exporter', 'importer', 'app']; // 被依賴的在前面

const ident = (name) => '__' + name.replace(/[^\w]/g, '_');

function bundleModule(name) {
  let src = readFileSync(join(root, 'js', name + '.js'), 'utf8');
  src = src.replace(/import\s+([\s\S]*?)\s+from\s+'\.\/([\w-]+)\.js';/g, (_, what, mod) => {
    if (!ORDER.includes(mod)) throw new Error(`未知模組 ${mod}`);
    if (ORDER.indexOf(mod) > ORDER.indexOf(name)) throw new Error(`${name}.js 用到後面才載入的 ${mod}.js，請調整 ORDER`);
    const star = what.match(/^\*\s+as\s+(\w+)$/);
    return star ? `const ${star[1]} = ${ident(mod)};` : `const ${what} = ${ident(mod)};`;
  });
  if (/\bimport\s/.test(src.replace(/\/\/.*$/gm, ''))) throw new Error(`${name}.js 有無法處理的 import`);
  const names = [];
  src = src.replace(/export\s+((?:async\s+)?function\s+(\w+)|class\s+(\w+)|(?:const|let)\s+(\w+))/g, (_, decl, fn, cls, v) => {
    names.push(fn || cls || v);
    return decl;
  });
  if (/^\s*export\s/m.test(src)) throw new Error(`${name}.js 有無法處理的 export`);
  const exportsObj = names.map((n) => `get ${n}() { return ${n}; }`).join(', ');
  return `const ${ident(name)} = (() => {\n${src}\nreturn { ${exportsObj} };\n})();`;
}

const css = readFileSync(join(root, 'css', 'app.css'), 'utf8');
const js = ORDER.map(bundleModule).join('\n\n');
const html = `<title>Folio</title>
<meta name="description" content="自己的筆記本：分區、頁面、Apple Pencil 手寫和自由擺放的文字框">
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
// 預覽環境只能從 CDN 載入外部程式，匯出用的函式庫改從 jsDelivr 拿（版本和 vendor/ 裡的相同）
globalThis.FOLIO_VENDOR = {
  pptx: 'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js',
  docx: 'https://cdn.jsdelivr.net/npm/docx@9.7.2/dist/index.iife.js',
  pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/legacy/build/pdf.min.mjs',
  pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/legacy/build/pdf.worker.min.mjs',
  pdfjsBase: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/',
};
${js}
</script>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'folio-preview.html');
writeFileSync(out, html);
console.log(`已輸出 ${out}（${(html.length / 1024).toFixed(0)} KB）`);
