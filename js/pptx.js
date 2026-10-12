// 直接匯入 PowerPoint（.pptx）：在瀏覽器裡把每一張投影片畫成圖片，和 PDF 一樣放進頁面。
// 不用上傳到任何伺服器。支援：文字（大小、粗斜體、顏色、對齊、項目符號、行距、自動縮小）、
// 常見圖形、圖片（含裁切）、表格、群組、SmartArt、背景（純色、漸層、圖片）、
// 母片和版面配置的位置與文字樣式。圖表、動畫、影片不會畫（圖表會留一個灰框）。

import { openZip } from './zip.js';
import { wrapRuns } from './pdfmodel.js';

const RENDER_WIDTH = 1800;
const DISPLAY_WIDTH = 860;
const FALLBACK_FONT = '"Noto Sans TC", -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';

// ---------- XML 小工具（不管命名空間，只看標籤名稱） ----------
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
const attr = (el, name, d = null) => (el && el.hasAttribute(name) ? el.getAttribute(name) : d);
const num = (el, name, d = 0) => { const v = attr(el, name); return v == null ? d : Number(v); };
const descendants = (el, name) => (el ? [...el.getElementsByTagName('*')].filter((c) => c.localName === name) : []);

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml').documentElement;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ---------- 顏色 ----------
export function hexToRgb(hex) {
  const v = parseInt(hex, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
// 套用 lumMod、lumOff、tint、shade、alpha 這些修飾（值是 1/1000 百分比）
export function applyColorMods(rgb, mods) {
  let [r, g, b] = rgb;
  let a = 1;
  for (const [name, raw] of mods) {
    const v = raw / 100000;
    if (name === 'alpha') a = v;
    else if (name === 'tint') { r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; b = 255 - (255 - b) * v; }
    else if (name === 'shade') { r *= v; g *= v; b *= v; }
    else if (name === 'lumMod' || name === 'lumOff' || name === 'satMod') {
      const hsl = rgbToHsl([r, g, b]);
      if (name === 'lumMod') hsl[2] *= v;
      else if (name === 'lumOff') hsl[2] += v;
      else hsl[1] *= v;
      hsl[1] = Math.min(1, Math.max(0, hsl[1]));
      hsl[2] = Math.min(1, Math.max(0, hsl[2]));
      [r, g, b] = hslToRgb(hsl);
    }
  }
  const c = (x) => Math.round(Math.min(255, Math.max(0, x)));
  return a < 1 ? `rgba(${c(r)},${c(g)},${c(b)},${Math.round(a * 1000) / 1000})` : `rgb(${c(r)},${c(g)},${c(b)})`;
}

const PRESET_COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500' };

// 畫布座標用 EMU（1 吋 = 914400），字則換算成最後的像素大小再畫，避免超大字型
let K = 1;

// ---------- 主程式 ----------
export async function openPptx(file) {
  const zip = await openZip(await file.arrayBuffer());
  if (!zip.has('ppt/presentation.xml')) throw new Error('這不是 PowerPoint（.pptx）檔案。');
  const xmlCache = new Map();
  const xml = async (name) => {
    if (!xmlCache.has(name)) {
      const t = await zip.text(name);
      xmlCache.set(name, t ? parseXml(t) : null);
    }
    return xmlCache.get(name);
  };
  const relsCache = new Map();
  async function rels(part) {
    if (relsCache.has(part)) return relsCache.get(part);
    const dir = part.split('/').slice(0, -1).join('/');
    const base = part.split('/').pop();
    const doc = await xml(`${dir}/_rels/${base}.rels`);
    const map = new Map();
    for (const r of doc ? kids(doc, 'Relationship') : []) {
      const external = attr(r, 'TargetMode') === 'External';
      map.set(attr(r, 'Id'), { type: (attr(r, 'Type') || '').split('/').pop(), target: external ? null : resolvePath(part, attr(r, 'Target')) });
    }
    relsCache.set(part, map);
    return map;
  }
  const relOfType = (map, type) => [...map.values()].find((r) => r.type === type);

  const pres = await xml('ppt/presentation.xml');
  const sldSz = kid(pres, 'sldSz');
  const W = num(sldSz, 'cx', 9144000);
  const H = num(sldSz, 'cy', 5143500);
  const presRels = await rels('ppt/presentation.xml');
  const slideParts = kids(kid(pres, 'sldIdLst'), 'sldId').map((s) => presRels.get(attr(s, 'r:id') || [...s.attributes].find((a) => a.localName === 'id' && a.prefix === 'r')?.value)).filter(Boolean).map((r) => r.target);
  const defaultTextStyle = kid(pres, 'defaultTextStyle');

  const images = new Map();
  async function image(part) {
    if (!images.has(part)) {
      images.set(part, (async () => {
        const data = await zip.read(part);
        if (!data) return null;
        const ext = part.split('.').pop().toLowerCase();
        const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
        if (!type) return null; // EMF、WMF 瀏覽器畫不出來
        try {
          if (type === 'image/svg+xml') {
            const url = URL.createObjectURL(new Blob([data], { type }));
            const img = new Image();
            img.src = url;
            await img.decode();
            return img;
          }
          return await createImageBitmap(new Blob([data], { type }));
        } catch { return null; }
      })());
    }
    return images.get(part);
  }

  // 每張投影片的母片、版面配置、佈景主題
  async function context(slidePart) {
    const slide = await xml(slidePart);
    const sRels = await rels(slidePart);
    const layoutPart = relOfType(sRels, 'slideLayout')?.target;
    const layout = layoutPart ? await xml(layoutPart) : null;
    const lRels = layoutPart ? await rels(layoutPart) : new Map();
    const masterPart = relOfType(lRels, 'slideMaster')?.target;
    const master = masterPart ? await xml(masterPart) : null;
    const mRels = masterPart ? await rels(masterPart) : new Map();
    const themePart = relOfType(mRels, 'theme')?.target;
    const theme = themePart ? await xml(themePart) : null;
    const scheme = {};
    for (const c of kid(path(theme, 'themeElements', 'clrScheme'), 'dk1') ? [...path(theme, 'themeElements', 'clrScheme').children] : []) {
      const v = kid(c, 'srgbClr') ? attr(kid(c, 'srgbClr'), 'val') : attr(kid(c, 'sysClr'), 'lastClr');
      if (v) scheme[c.localName] = v;
    }
    const clrMap = {};
    const cm = kid(master, 'clrMap');
    for (const a of cm ? [...cm.attributes] : []) clrMap[a.localName] = a.value;
    const fontScheme = path(theme, 'themeElements', 'fontScheme');
    const fonts = {
      major: attr(path(fontScheme, 'majorFont', 'latin'), 'typeface'),
      majorEa: attr(path(fontScheme, 'majorFont', 'ea'), 'typeface'),
      minor: attr(path(fontScheme, 'minorFont', 'latin'), 'typeface'),
      minorEa: attr(path(fontScheme, 'minorFont', 'ea'), 'typeface'),
    };
    const fmt = path(theme, 'themeElements', 'fmtScheme');
    return { slide, slidePart, sRels, layout, layoutPart, lRels, master, masterPart, mRels, scheme, clrMap, fonts, fmt };
  }

  function colorOf(el, ctx, phClr) {
    if (!el) return null;
    const c = [...el.children].find((x) => /Clr$/.test(x.localName));
    if (!c) return null;
    let hex = null;
    if (c.localName === 'srgbClr') hex = attr(c, 'val');
    else if (c.localName === 'sysClr') hex = attr(c, 'lastClr') || (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000');
    else if (c.localName === 'prstClr') hex = PRESET_COLORS[attr(c, 'val')] || '000000';
    else if (c.localName === 'scrgbClr') hex = ['r', 'g', 'b'].map((k) => Math.round(num(c, k) / 100000 * 255).toString(16).padStart(2, '0')).join('');
    else if (c.localName === 'schemeClr') {
      let v = attr(c, 'val');
      if (v === 'phClr') { if (!phClr) return null; return applyColorMods(hexToRgb(phClr.replace('#', '')), [...c.children].map((m) => [m.localName, num(m, 'val')])); }
      v = ctx.clrMap[v] || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v] || v;
      hex = ctx.scheme[v] || '000000';
    }
    if (!hex) return null;
    return applyColorMods(hexToRgb(hex), [...c.children].map((m) => [m.localName, num(m, 'val')]));
  }
  // 主題裡某個角色的顏色（tx1、bg1…）
  function schemeColor(name, ctx) {
    const v = ctx.clrMap[name] || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[name] || name;
    return ctx.scheme[v] ? applyColorMods(hexToRgb(ctx.scheme[v]), []) : null;
  }
  // 回傳主題色的十六進位（給 style 參照的 phClr 用）
  function hexOf(el, ctx) {
    const css = colorOf(el, ctx);
    const m = css && css.match(/\d+(\.\d+)?/g);
    return m ? m.slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, '0')).join('') : null;
  }

  // ---------- 文字樣式的繼承 ----------
  function placeholderOf(sp) {
    const ph = path(sp, 'nvSpPr', 'nvPr', 'ph') || path(sp, 'nvPicPr', 'nvPr', 'ph') || path(sp, 'nvGraphicFramePr', 'nvPr', 'ph');
    if (!ph) return null;
    return { type: attr(ph, 'type', 'body'), idx: attr(ph, 'idx') };
  }
  function findPlaceholder(doc, ph) {
    if (!doc || !ph) return null;
    const shapes = descendants(kid(doc, 'cSld'), 'sp');
    const same = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t);
    return (ph.idx != null && shapes.find((s) => placeholderOf(s)?.idx === ph.idx))
      || shapes.find((s) => placeholderOf(s) && placeholderOf(s).type === ph.type)
      || shapes.find((s) => placeholderOf(s) && same(placeholderOf(s).type) === same(ph.type))
      || null;
  }
  // 由近到遠：圖形自己的 lstStyle → 版面配置的同位置 → 母片的同位置 → 母片的 txStyles → 簡報預設
  function styleChain(sp, ctx, level) {
    const lvl = `lvl${level + 1}pPr`;
    const out = [];
    const push = (el) => { const x = kid(el, lvl); if (x) out.push(x); };
    push(path(sp, 'txBody', 'lstStyle'));
    const ph = placeholderOf(sp);
    if (ph && ctx.doc !== 'master') {
      if (ctx.doc === 'slide') push(path(findPlaceholder(ctx.layout, ph), 'txBody', 'lstStyle'));
      push(path(findPlaceholder(ctx.master, ph), 'txBody', 'lstStyle'));
    }
    const tx = kid(ctx.master, 'txStyles');
    if (ph && /title/i.test(ph.type)) push(kid(tx, 'titleStyle'));
    else if (ph && !['dt', 'ftr', 'sldNum', 'hdr'].includes(ph.type)) push(kid(tx, 'bodyStyle'));
    else push(kid(tx, 'otherStyle'));
    push(defaultTextStyle);
    return out;
  }

  // ---------- 畫 ----------
  async function render(n) {
    const slidePart = slideParts[n - 1];
    const ctx0 = await context(slidePart);
    const k = RENDER_WIDTH / W;
    K = k;
    const cw = RENDER_WIDTH;
    const ch = Math.round(H * k);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, cw, ch);
    g.scale(k, k); // 之後全部用 EMU 座標

    await drawBackground(g, ctx0, W, H);
    const showMaster = (doc) => attr(doc, 'showMasterSp') !== '0';
    if (showMaster(ctx0.slide) && showMaster(ctx0.layout)) await drawTree(g, path(ctx0.master, 'cSld', 'spTree'), { ...ctx0, doc: 'master', rels: ctx0.mRels, part: ctx0.masterPart }, true);
    if (showMaster(ctx0.slide)) await drawTree(g, path(ctx0.layout, 'cSld', 'spTree'), { ...ctx0, doc: 'layout', rels: ctx0.lRels, part: ctx0.layoutPart }, true);
    await drawTree(g, path(ctx0.slide, 'cSld', 'spTree'), { ...ctx0, doc: 'slide', rels: ctx0.sRels, part: slidePart }, false);

    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生圖片'))), 'image/jpeg', 0.9));
    canvas.width = canvas.height = 0;
    return { blob, w: cw, h: ch, display: { w: DISPLAY_WIDTH, h: Math.round((ch * DISPLAY_WIDTH) / cw) } };
  }

  async function drawBackground(g, ctx, w, h) {
    for (const [doc, r] of [[ctx.slide, ctx.sRels], [ctx.layout, ctx.lRels], [ctx.master, ctx.mRels]]) {
      const bg = path(doc, 'cSld', 'bg');
      if (!bg) continue;
      const bgPr = kid(bg, 'bgPr');
      if (bgPr) { await paintFill(g, bgPr, { ...ctx, rels: r }, () => g.rect(0, 0, w, h), { x: 0, y: 0, w, h }); return; }
      const ref = kid(bg, 'bgRef');
      if (ref) {
        const c = colorOf(ref, ctx);
        if (c) { g.fillStyle = c; g.fillRect(0, 0, w, h); }
        return;
      }
    }
  }

  // 填色：純色、漸層、圖片、花紋；回傳有沒有畫
  async function paintFill(g, holder, ctx, shapePath, box, phClr) {
    const solid = kid(holder, 'solidFill');
    const grad = kid(holder, 'gradFill');
    const blip = kid(holder, 'blipFill');
    const patt = kid(holder, 'pattFill');
    if (kid(holder, 'noFill')) return false;
    g.beginPath();
    shapePath();
    if (solid) {
      const c = colorOf(solid, ctx, phClr);
      if (!c) return false;
      g.fillStyle = c;
      g.fill();
      return true;
    }
    if (grad) {
      const stops = kids(kid(grad, 'gsLst'), 'gs').map((s) => [num(s, 'pos') / 100000, colorOf(s, ctx, phClr)]).filter((s) => s[1]).sort((a, b) => a[0] - b[0]);
      if (!stops.length) return false;
      const lin = kid(grad, 'lin');
      let fill;
      if (kid(grad, 'path')) {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        fill = g.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(box.w, box.h) / 2);
      } else {
        const ang = ((lin ? num(lin, 'ang') : 0) / 60000) * Math.PI / 180;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const len = (Math.abs(box.w * Math.cos(ang)) + Math.abs(box.h * Math.sin(ang))) / 2;
        fill = g.createLinearGradient(cx - Math.cos(ang) * len, cy - Math.sin(ang) * len, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      }
      for (const [pos, c] of stops) fill.addColorStop(Math.min(1, Math.max(0, pos)), c);
      g.fillStyle = fill;
      g.fill();
      return true;
    }
    if (blip) {
      const img = await blipImage(blip, ctx);
      if (!img) return false;
      g.save();
      g.clip();
      drawCropped(g, img, kid(blip, 'srcRect'), box);
      g.restore();
      return true;
    }
    if (patt) {
      const c = colorOf(kid(patt, 'fgClr'), ctx, phClr);
      if (!c) return false;
      g.fillStyle = c;
      g.fill();
      return true;
    }
    return false;
  }

  async function blipImage(blipFill, ctx) {
    const blip = kid(blipFill, 'blip');
    const id = blip && ([...blip.attributes].find((a) => a.localName === 'embed')?.value);
    const rel = id && ctx.rels.get(id);
    return rel && rel.target ? image(rel.target) : null;
  }

  function drawCropped(g, img, srcRect, box) {
    const iw = img.width;
    const ih = img.height;
    const l = num(srcRect, 'l') / 100000;
    const t = num(srcRect, 't') / 100000;
    const r = num(srcRect, 'r') / 100000;
    const b = num(srcRect, 'b') / 100000;
    const sw = iw * (1 - l - r);
    const sh = ih * (1 - t - b);
    if (sw <= 0 || sh <= 0) return;
    g.drawImage(img, iw * l, ih * t, sw, sh, box.x, box.y, box.w, box.h);
  }

  // 圖形樹：sp、pic、grpSp、graphicFrame、cxnSp
  async function drawTree(g, tree, ctx, skipPlaceholders) {
    for (const el of tree ? [...tree.children] : []) {
      try {
        if (el.localName === 'AlternateContent') {
          const choice = kid(el, 'Fallback') || kid(el, 'Choice');
          if (choice) await drawTree(g, choice, ctx, skipPlaceholders);
          continue;
        }
        if (skipPlaceholders && placeholderOf(el)) continue;
        if (el.localName === 'sp' || el.localName === 'cxnSp') await drawShape(g, el, ctx);
        else if (el.localName === 'pic') await drawPicture(g, el, ctx);
        else if (el.localName === 'grpSp') await drawGroup(g, el, ctx, skipPlaceholders);
        else if (el.localName === 'graphicFrame') await drawFrame(g, el, ctx);
      } catch (e) {
        console.warn('投影片元素畫不出來', e);
      }
    }
  }

  function boxOf(x) {
    const off = kid(x, 'off');
    const ext = kid(x, 'ext');
    return {
      x: num(off, 'x'), y: num(off, 'y'), w: num(ext, 'cx'), h: num(ext, 'cy'),
      rot: num(x, 'rot') / 60000, flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1',
      chOff: kid(x, 'chOff'), chExt: kid(x, 'chExt'),
    };
  }

  function xfrmOf(el, ctx) {
    let x = path(el, 'spPr', 'xfrm') || path(el, 'grpSpPr', 'xfrm') || kid(el, 'xfrm');
    const ph = placeholderOf(el);
    if (!x && ph) {
      // 位置沒寫的話，跟版面配置或母片的同一個預留位置一樣
      const fromLayout = ctx.doc === 'slide' ? findPlaceholder(ctx.layout, ph) : null;
      x = path(fromLayout, 'spPr', 'xfrm') || path(findPlaceholder(ctx.master, ph), 'spPr', 'xfrm');
    }
    return x ? boxOf(x) : null;
  }

  function withTransform(g, b, fn) {
    g.save();
    if (b.rot || b.flipH || b.flipV) {
      g.translate(b.x + b.w / 2, b.y + b.h / 2);
      if (b.rot) g.rotate((b.rot * Math.PI) / 180);
      g.scale(b.flipH ? -1 : 1, b.flipV ? -1 : 1);
      g.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
    }
    return Promise.resolve(fn()).finally(() => g.restore());
  }

  async function drawGroup(g, el, ctx, skipPlaceholders) {
    const b = xfrmOf(el, ctx);
    if (!b) return drawTree(g, el, ctx, skipPlaceholders);
    await withTransform(g, b, async () => {
      const cx = num(b.chOff, 'x', b.x);
      const cy = num(b.chOff, 'y', b.y);
      const cw = num(b.chExt, 'cx', b.w) || 1;
      const chh = num(b.chExt, 'cy', b.h) || 1;
      g.translate(b.x, b.y);
      g.scale(b.w / cw, b.h / chh);
      g.translate(-cx, -cy);
      await drawTree(g, el, ctx, skipPlaceholders);
    });
  }

  // 外陰影（PowerPoint 最常見的效果）：畫布的陰影是螢幕像素，不跟著座標縮放，要自己乘上 K
  function shadowOf(spPr, style, ctx) {
    let sh = path(spPr, 'effectLst', 'outerShdw');
    if (!sh && !kid(spPr, 'effectLst')) {
      const ref = kid(style, 'effectRef');
      const idx = num(ref, 'idx', 0);
      if (idx > 0) sh = path(kids(path(ctx.fmt, 'effectStyleLst'), 'effectStyle')[idx - 1], 'effectLst', 'outerShdw');
    }
    if (!sh) return null;
    const color = colorOf(sh, ctx, hexOf(kid(style, 'effectRef'), ctx)) || 'rgba(0,0,0,0.35)';
    const dist = num(sh, 'dist', 0);
    const dir = (num(sh, 'dir', 0) / 60000) * Math.PI / 180;
    return { color, blur: num(sh, 'blurRad', 0), dx: Math.cos(dir) * dist, dy: Math.sin(dir) * dist };
  }
  function withShadow(g, sh, fn) {
    if (!sh) return fn();
    // 陰影位移要用畫布目前的縮放換算（群組裡的圖形也一樣）
    const m = g.getTransform();
    g.save();
    g.shadowColor = sh.color;
    g.shadowBlur = sh.blur * Math.hypot(m.a, m.b);
    g.shadowOffsetX = sh.dx * m.a + sh.dy * m.c;
    g.shadowOffsetY = sh.dx * m.b + sh.dy * m.d;
    try { return fn(); } finally { g.restore(); }
  }

  async function drawPicture(g, el, ctx) {
    const b = xfrmOf(el, ctx);
    if (!b) return;
    const blipFill = kid(el, 'blipFill');
    const img = await blipImage(blipFill, ctx);
    await withTransform(g, b, async () => {
      const sh = shadowOf(kid(el, 'spPr'), kid(el, 'style'), ctx);
      if (sh) withShadow(g, sh, () => { g.beginPath(); geometryPath(g, kid(el, 'spPr'), b); g.fillStyle = '#ffffff'; g.fill(); });
      g.save();
      g.beginPath();
      geometryPath(g, kid(el, 'spPr'), b);
      g.clip();
      if (img) drawCropped(g, img, kid(blipFill, 'srcRect'), b);
      else { g.fillStyle = '#e6e9ee'; g.fillRect(b.x, b.y, b.w, b.h); }
      g.restore();
      strokeLine(g, kid(el, 'spPr'), ctx, () => geometryPath(g, kid(el, 'spPr'), b), kid(el, 'style'));
    });
  }

  async function drawShape(g, el, ctx) {
    const b = xfrmOf(el, ctx);
    if (!b) return;
    const spPr = kid(el, 'spPr');
    const style = kid(el, 'style');
    await withTransform(g, b, async () => {
      const shapePath = () => geometryPath(g, spPr, b);
      const fillRef = kid(style, 'fillRef');
      const sh = shadowOf(spPr, style, ctx);
      const filled = sh ? await withShadow(g, sh, () => paintFill(g, spPr, ctx, shapePath, b)) : await paintFill(g, spPr, ctx, shapePath, b);
      if (!filled && !kid(spPr, 'noFill') && fillRef && num(fillRef, 'idx') > 0 && el.localName === 'sp') {
        const c = colorOf(fillRef, ctx);
        if (c) withShadow(g, sh, () => { g.beginPath(); shapePath(); g.fillStyle = c; g.fill(); });
      }
      strokeLine(g, spPr, ctx, shapePath, style, el.localName === 'cxnSp');
    });
    // 文字不跟著翻轉（PowerPoint 也是），只跟著旋轉
    const txBody = kid(el, 'txBody');
    if (txBody) {
      const tb = kid(el, 'txXfrm') ? boxOf(kid(el, 'txXfrm')) : b; // SmartArt 的文字有自己的位置
      await withTransform(g, { ...tb, flipH: false, flipV: false }, () => drawText(g, el, txBody, ctx, tb, style));
    }
  }

  function strokeLine(g, spPr, ctx, shapePath, style, isConnector = false) {
    const ln = kid(spPr, 'ln');
    if (kid(ln, 'noFill')) return;
    let color = colorOf(kid(ln, 'solidFill'), ctx);
    let width = num(ln, 'w', 0);
    const lnRef = kid(style, 'lnRef');
    if (!color && lnRef && num(lnRef, 'idx') > 0) {
      color = colorOf(lnRef, ctx);
      if (!width) width = num(kids(path(ctx.fmt, 'lnStyleLst'), 'ln')[num(lnRef, 'idx') - 1], 'w', 9525);
    }
    if (!color && ln && kid(ln, 'gradFill')) color = colorOf(kids(path(ln, 'gradFill', 'gsLst'), 'gs')[0], ctx);
    if (!color) return;
    g.beginPath();
    shapePath();
    g.strokeStyle = color;
    g.lineWidth = width || 12700;
    g.lineJoin = 'round';
    const dash = attr(kid(ln, 'prstDash'), 'val');
    g.setLineDash(dash && dash !== 'solid' ? [g.lineWidth * (dash.includes('sys') ? 1 : 3), g.lineWidth * 2] : []);
    g.stroke();
    g.setLineDash([]);
    // 箭頭
    if (isConnector || kid(ln, 'tailEnd') || kid(ln, 'headEnd')) drawArrowHeads(g, ln, spPr, color, g.lineWidth);
  }

  function drawArrowHeads(g, ln, spPr, color, lw) {
    const geo = attr(kid(spPr, 'prstGeom'), 'prst', 'line');
    if (!/line|Connector/.test(geo)) return;
    const x = xfrmLast;
    if (!x) return;
    const ends = [['headEnd', x.x, x.y, x.x + x.w, x.y + x.h], ['tailEnd', x.x + x.w, x.y + x.h, x.x, x.y]];
    for (const [name, px, py, fx, fy] of ends) {
      const e = kid(ln, name);
      const type = attr(e, 'type', 'none');
      if (!e || type === 'none') continue;
      const ang = Math.atan2(py - fy, px - fx);
      const size = lw * 3.5;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px - Math.cos(ang - 0.45) * size, py - Math.sin(ang - 0.45) * size);
      g.lineTo(px - Math.cos(ang + 0.45) * size, py - Math.sin(ang + 0.45) * size);
      g.closePath();
      g.fillStyle = color;
      g.fill();
    }
  }

  // ---------- 圖形的形狀 ----------
  let xfrmLast = null;
  function geometryPath(g, spPr, b) {
    xfrmLast = b;
    const { x, y, w, h } = b;
    const cust = kid(spPr, 'custGeom');
    if (cust) return customPath(g, cust, b);
    const prst = attr(kid(spPr, 'prstGeom'), 'prst', 'rect');
    const gd = {};
    for (const d of kids(path(spPr, 'prstGeom', 'avLst'), 'gd')) {
      const m = (attr(d, 'fmla') || '').match(/val (-?\d+)/);
      if (m) gd[attr(d, 'name')] = Number(m[1]);
    }
    const ss = Math.min(w, h);
    const adj = (name, d) => (gd[name] ?? d) / 100000;
    const poly = (pts) => { g.moveTo(x + pts[0][0] * w, y + pts[0][1] * h); for (const [px, py] of pts.slice(1)) g.lineTo(x + px * w, y + py * h); g.closePath(); };
    switch (prst) {
      case 'roundRect': {
        const r = Math.min(ss * adj('adj', 16667), w / 2, h / 2);
        roundRect(g, x, y, w, h, r);
        break;
      }
      case 'ellipse': g.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); break;
      case 'line': case 'straightConnector1': case 'bentConnector2': case 'bentConnector3': case 'curvedConnector3':
        g.moveTo(x, y); g.lineTo(x + w, y + h); break;
      case 'triangle': { const a = adj('adj', 50000); poly([[a, 0], [1, 1], [0, 1]]); break; }
      case 'rtTriangle': poly([[0, 0], [1, 1], [0, 1]]); break;
      case 'diamond': poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]); break;
      case 'parallelogram': { const a = Math.min(adj('adj', 25000) * ss / w, 1); poly([[a, 0], [1, 0], [1 - a, 1], [0, 1]]); break; }
      case 'trapezoid': { const a = Math.min(adj('adj', 25000) * ss / w, 0.5); poly([[a, 0], [1 - a, 0], [1, 1], [0, 1]]); break; }
      case 'pentagon': poly([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]); break;
      case 'hexagon': { const a = Math.min(adj('adj', 25000) * ss / w, 0.5); poly([[a, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [a, 1], [0, 0.5]]); break; }
      case 'octagon': { const a = adj('adj', 29289) * ss; const ax = a / w; const ay = a / h; poly([[ax, 0], [1 - ax, 0], [1, ay], [1, 1 - ay], [1 - ax, 1], [ax, 1], [0, 1 - ay], [0, ay]]); break; }
      case 'homePlate': { const a = Math.min(adj('adj', 50000) * ss / w, 1); poly([[0, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [0, 1]]); break; }
      case 'chevron': { const a = Math.min(adj('adj', 50000) * ss / w, 1); poly([[0, 0], [1 - a, 0], [1, 0.5], [1 - a, 1], [0, 1], [a, 0.5]]); break; }
      case 'rightArrow': { const a1 = adj('adj1', 50000); const a2 = Math.min(adj('adj2', 50000) * ss / w, 1); poly([[0, 0.5 - a1 / 2], [1 - a2, 0.5 - a1 / 2], [1 - a2, 0], [1, 0.5], [1 - a2, 1], [1 - a2, 0.5 + a1 / 2], [0, 0.5 + a1 / 2]]); break; }
      case 'leftArrow': { const a1 = adj('adj1', 50000); const a2 = Math.min(adj('adj2', 50000) * ss / w, 1); poly([[1, 0.5 - a1 / 2], [a2, 0.5 - a1 / 2], [a2, 0], [0, 0.5], [a2, 1], [a2, 0.5 + a1 / 2], [1, 0.5 + a1 / 2]]); break; }
      case 'upArrow': { const a1 = adj('adj1', 50000); const a2 = Math.min(adj('adj2', 50000) * ss / h, 1); poly([[0.5 - a1 / 2, 1], [0.5 - a1 / 2, a2], [0, a2], [0.5, 0], [1, a2], [0.5 + a1 / 2, a2], [0.5 + a1 / 2, 1]]); break; }
      case 'downArrow': { const a1 = adj('adj1', 50000); const a2 = Math.min(adj('adj2', 50000) * ss / h, 1); poly([[0.5 - a1 / 2, 0], [0.5 - a1 / 2, 1 - a2], [0, 1 - a2], [0.5, 1], [1, 1 - a2], [0.5 + a1 / 2, 1 - a2], [0.5 + a1 / 2, 0]]); break; }
      case 'round2SameRect': { const r = Math.min(ss * adj('adj1', 16667), w / 2, h / 2); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.arcTo(x, y, x + w, y, r); g.closePath(); break; }
      case 'snip1Rect': { const a = ss * adj('adj', 16667); g.moveTo(x, y); g.lineTo(x + w - a, y); g.lineTo(x + w, y + a); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath(); break; }
      case 'flowChartTerminator': roundRect(g, x, y, w, h, Math.min(w, h) / 2); break;
      case 'flowChartProcess': case 'rect': default: g.rect(x, y, w, h);
    }
  }

  function roundRect(g, x, y, w, h, r) {
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function customPath(g, cust, b) {
    for (const p of kids(kid(cust, 'pathLst'), 'path')) {
      const pw = num(p, 'w', b.w) || 1;
      const ph = num(p, 'h', b.h) || 1;
      const X = (v) => b.x + (v * b.w) / pw;
      const Y = (v) => b.y + (v * b.h) / ph;
      let cur = [0, 0];
      for (const c of p.children) {
        const pts = kids(c, 'pt').map((pt) => [num(pt, 'x'), num(pt, 'y')]);
        if (c.localName === 'moveTo') { cur = pts[0]; g.moveTo(X(cur[0]), Y(cur[1])); }
        else if (c.localName === 'lnTo') { cur = pts[0]; g.lineTo(X(cur[0]), Y(cur[1])); }
        else if (c.localName === 'cubicBezTo' && pts.length === 3) { g.bezierCurveTo(X(pts[0][0]), Y(pts[0][1]), X(pts[1][0]), Y(pts[1][1]), X(pts[2][0]), Y(pts[2][1])); cur = pts[2]; }
        else if (c.localName === 'quadBezTo' && pts.length === 2) { g.quadraticCurveTo(X(pts[0][0]), Y(pts[0][1]), X(pts[1][0]), Y(pts[1][1])); cur = pts[1]; }
        else if (c.localName === 'arcTo') {
          const wr = num(c, 'wR');
          const hr = num(c, 'hR');
          const st = (num(c, 'stAng') / 60000) * Math.PI / 180;
          const sw = (num(c, 'swAng') / 60000) * Math.PI / 180;
          const cx = cur[0] - wr * Math.cos(st);
          const cy = cur[1] - hr * Math.sin(st);
          const steps = Math.max(4, Math.ceil(Math.abs(sw) / 0.2));
          for (let i = 1; i <= steps; i++) {
            const a = st + (sw * i) / steps;
            cur = [cx + wr * Math.cos(a), cy + hr * Math.sin(a)];
            g.lineTo(X(cur[0]), Y(cur[1]));
          }
        } else if (c.localName === 'close') g.closePath();
      }
    }
  }

  // ---------- 文字 ----------
  function fontFamily(face, ctx) {
    if (!face) return FALLBACK_FONT;
    const map = { '+mj-lt': ctx.fonts.major, '+mn-lt': ctx.fonts.minor, '+mj-ea': ctx.fonts.majorEa || ctx.fonts.major, '+mn-ea': ctx.fonts.minorEa || ctx.fonts.minor };
    const f = face.startsWith('+') ? map[face] : face;
    return f ? `"${f.replace(/"/g, '')}", ${FALLBACK_FONT}` : FALLBACK_FONT;
  }

  // 依繼承順序找屬性：先找段落／文字自己的，再找樣式鏈
  function pick(list, fn) {
    for (const el of list) {
      if (!el) continue;
      const v = fn(el);
      if (v != null) return v;
    }
    return null;
  }

  async function drawText(g, sp, txBody, ctx, b, style) {
    const bodyPr = kid(txBody, 'bodyPr');
    const lIns = num(bodyPr, 'lIns', 91440);
    const rIns = num(bodyPr, 'rIns', 91440);
    const tIns = num(bodyPr, 'tIns', 45720);
    const bIns = num(bodyPr, 'bIns', 45720);
    const wrap = attr(bodyPr, 'wrap') !== 'none';
    const phBodies = [path(findPlaceholder(ctx.layout, placeholderOf(sp)), 'txBody', 'bodyPr'), path(findPlaceholder(ctx.master, placeholderOf(sp)), 'txBody', 'bodyPr')];
    // 自動調整：自己沒寫就用版面配置／母片的設定
    const fitHolder = [bodyPr, ...phBodies].find((e) => e && (kid(e, 'normAutofit') || kid(e, 'spAutoFit') || kid(e, 'noAutofit')));
    const fit = kid(fitHolder, 'normAutofit');
    const storedScale = fit && kid(bodyPr, 'normAutofit') ? num(fit, 'fontScale', 100000) / 100000 : 1;
    const storedReduce = fit && kid(bodyPr, 'normAutofit') ? num(fit, 'lnSpcReduction', 0) / 100000 : 0;
    const anchor = attr(bodyPr, 'anchor') || pick(phBodies, (e) => attr(e, 'anchor')) || 't';
    const boxW = b.w - lIns - rIns;
    const fontRefColor = colorOf(kid(style, 'fontRef'), ctx);

    const computeLines = (fontScale, lnReduce) => {
      const lines = [];
      let autoNum = {};
      for (const p of kids(txBody, 'p')) {
        const pPr = kid(p, 'pPr');
        const level = num(pPr, 'lvl', 0);
        const chain = [pPr, ...styleChain(sp, ctx, level)];
        const defR = chain.map((e) => kid(e, 'defRPr'));
        const algn = pick(chain, (e) => attr(e, 'algn')) || 'l';
        const marL = Number(pick(chain, (e) => attr(e, 'marL')) ?? 0);
        const indent = Number(pick(chain, (e) => attr(e, 'indent')) ?? 0);
        const lnSpcEl = pick(chain, (e) => kid(e, 'lnSpc'));
        const spcBefEl = pick(chain, (e) => kid(e, 'spcBef'));
        const spcAftEl = pick(chain, (e) => kid(e, 'spcAft'));

        const runs = [];
        let maxSize = 0;
        const runStyle = (rPr) => {
          const list = [rPr, ...defR];
          const size = Number(pick(list, (e) => attr(e, 'sz')) ?? 1800) / 100 * fontScale;
          const bold = pick(list, (e) => attr(e, 'b')) === '1';
          const italic = pick(list, (e) => attr(e, 'i')) === '1';
          const u = (pick(list, (e) => attr(e, 'u')) || 'none') !== 'none';
          const strike = (pick(list, (e) => attr(e, 'strike')) || 'noStrike') !== 'noStrike';
          const color = colorOf(pick(list, (e) => kid(e, 'solidFill')), ctx) || colorOf(pick(list, (e) => kid(e, 'gradFill') && kids(path(e, 'gradFill', 'gsLst'), 'gs')[0]), ctx) || fontRefColor || schemeColor('tx1', ctx) || '#000000';
          const face = pick(list, (e) => attr(kid(e, 'ea'), 'typeface')) || pick(list, (e) => attr(kid(e, 'latin'), 'typeface')) || (placeholderOf(sp) && /title/i.test(placeholderOf(sp).type) ? '+mj-lt' : '+mn-lt');
          const baseline = Number(pick(list, (e) => attr(e, 'baseline')) ?? 0);
          const cap = pick(list, (e) => attr(e, 'cap'));
          const pt = size * (baseline ? 0.7 : 1);
          return { size: size * 12700, pt, bold, italic, u, strike, color, family: fontFamily(face, ctx), baseline, cap, font: `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${pt * 12700 * K}px ${fontFamily(face, ctx)}` };
        };
        for (const r of p.children) {
          if (r.localName === 'r' || r.localName === 'fld') {
            const st = runStyle(kid(r, 'rPr'));
            let text = kid(r, 't')?.textContent ?? '';
            if (st.cap === 'all') text = text.toUpperCase();
            runs.push({ text, ...st });
            maxSize = Math.max(maxSize, st.size);
          } else if (r.localName === 'br') {
            const st = runStyle(kid(r, 'rPr'));
            runs.push({ text: '\n', ...st });
          }
        }
        if (!maxSize) maxSize = runStyle(kid(p, 'endParaRPr')).size;

        // 項目符號
        let bullet = null;
        const hasText = runs.some((r) => r.text.trim());
        const buNone = pick(chain, (e) => (kid(e, 'buNone') ? 'none' : kid(e, 'buChar') || kid(e, 'buAutoNum') ? 'set' : null));
        if (buNone === 'set' && hasText) {
          const buChar = pick(chain, (e) => kid(e, 'buChar'));
          const buAuto = pick(chain, (e) => kid(e, 'buAutoNum'));
          const first = runs.find((r) => r.text.trim()) || runs[0];
          const buSz = pick(chain, (e) => kid(e, 'buSzPct'));
          const buClr = pick(chain, (e) => kid(e, 'buClr'));
          const size = first.size * (buSz ? num(buSz, 'val') / 100000 : 1);
          let text = '•';
          if (buChar) text = attr(buChar, 'char', '•');
          if (buAuto && (!buChar || pick(chain, (e) => (kid(e, 'buAutoNum') ? 'a' : kid(e, 'buChar') ? 'c' : null)) === 'a')) {
            const key = `${level}`;
            autoNum[key] = (autoNum[key] || num(buAuto, 'startAt', 1) - 1) + 1;
            text = numberLabel(autoNum[key], attr(buAuto, 'type', 'arabicPeriod'));
          } else {
            autoNum = Object.fromEntries(Object.entries(autoNum).filter(([l]) => Number(l) < level));
          }
          const face = attr(pick(chain, (e) => kid(e, 'buFont')), 'typeface');
          const wingdings = face && /wingdings|symbol/i.test(face);
          if (wingdings) text = { 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', '§': '■', '·': '•', 'o': 'o' }[text] || '•';
          bullet = { text, color: buClr ? colorOf(buClr, ctx) : first.color, font: `400 ${size * K}px ${FALLBACK_FONT}` };
        }

        // 斷行
        const avail = wrap ? Math.max(1, boxW - marL) : Infinity;
        const segsByLine = [];
        let cur = [];
        for (const r of runs) {
          if (r.text === '\n') { segsByLine.push(cur); cur = []; continue; }
          cur.push(r);
        }
        segsByLine.push(cur);
        let firstLine = true;
        const lnPct = lnSpcEl && kid(lnSpcEl, 'spcPct') ? num(kid(lnSpcEl, 'spcPct'), 'val') / 100000 : 1;
        const lnPts = lnSpcEl && kid(lnSpcEl, 'spcPts') ? num(kid(lnSpcEl, 'spcPts'), 'val') / 100 * 12700 : null;
        const spc = (el, size) => (el && kid(el, 'spcPts') ? num(kid(el, 'spcPts'), 'val') / 100 * 12700 : el && kid(el, 'spcPct') ? num(kid(el, 'spcPct'), 'val') / 100000 * size * 1.2 : 0);
        const before = spc(spcBefEl, maxSize) * (1 - lnReduce);
        const after = spc(spcAftEl, maxSize) * (1 - lnReduce);
        let paraFirst = true;
        for (const segRuns of segsByLine) {
          const measure = (text, run) => { g.font = run.font; return g.measureText(text).width / K; };
          const wrapped = segRuns.length ? wrapRuns(segRuns, avail, measure) : [[]];
          for (const line of wrapped) {
            const size = Math.max(...line.map((s) => s.run.size), segRuns[0]?.size || maxSize);
            const height = lnPts != null ? lnPts : size * 1.2 * lnPct * (1 - lnReduce);
            lines.push({ segs: line, size, height, algn, marL, indent, bullet: paraFirst && firstLine ? bullet : null, before: paraFirst ? before : 0, after: 0, width: line.reduce((m, s) => Math.max(m, s.x + s.w), 0) });
            paraFirst = false;
          }
          firstLine = false;
        }
        if (lines.length) lines[lines.length - 1].after = after;
      }
      return lines;
    };
    let lines = computeLines(storedScale, storedReduce);
    const heightOf = (ls) => ls.reduce((sum, l) => sum + l.before + l.height + l.after, 0);
    // 「文字太多時縮小」：PowerPoint 存檔時通常記下縮小比例；沒記的話（例如其他程式產生的檔案）自己算
    if (fit && storedScale === 1 && heightOf(lines) > b.h - tIns - bIns) {
      for (let sc = 0.9; sc >= 0.4; sc -= 0.05) {
        lines = computeLines(sc, Math.min(0.2, (1 - sc) / 2));
        if (heightOf(lines) <= b.h - tIns - bIns) break;
      }
    }
    const total = lines.reduce((s, l) => s + l.before + l.height + l.after, 0);
    let y = b.y + tIns;
    const innerH = b.h - tIns - bIns;
    if (anchor === 'ctr') y += (innerH - total) / 2;
    else if (anchor === 'b') y += innerH - total;
    g.textBaseline = 'alphabetic';
    for (const l of lines) {
      y += l.before;
      const baseY = y + l.height - l.size * 0.25; // 行距加大時，多的空間在字的上方（和 PowerPoint 一樣）
      const left = b.x + lIns + l.marL;
      const avail = boxW - l.marL;
      let x0 = left;
      if (l.algn === 'ctr') x0 = left + (avail - l.width) / 2;
      else if (l.algn === 'r') x0 = left + avail - l.width;
      if (l.bullet) {
        g.font = l.bullet.font;
        g.fillStyle = l.bullet.color;
        textAt(g, l.bullet.text, b.x + lIns + l.marL + l.indent, baseY);
      }
      for (const s of l.segs) {
        const r = s.run;
        g.font = r.font;
        g.fillStyle = r.color;
        const shift = r.baseline ? -r.baseline / 100000 * r.size : 0;
        textAt(g, s.text, x0 + s.x, baseY + shift);
        if (r.u) g.fillRect(x0 + s.x, baseY + r.size * 0.12, s.w, Math.max(r.size * 0.06, 6000));
        if (r.strike) g.fillRect(x0 + s.x, baseY - r.size * 0.3, s.w, Math.max(r.size * 0.06, 6000));
      }
      y += l.height + l.after;
    }
  }

  // 在 EMU 座標寫字：先縮回像素比例，字型大小才是正常的像素值
  function textAt(g, text, x, y) {
    g.save();
    g.translate(x, y);
    g.scale(1 / K, 1 / K);
    g.fillText(text, 0, 0);
    g.restore();
  }

  function numberLabel(n, type) {
    const roman = (v) => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']].reduce((s, [k, r]) => { while (v >= k) { s += r; v -= k; } return s; }, '');
    const alpha = (v) => String.fromCharCode(96 + ((v - 1) % 26) + 1);
    let core = String(n);
    if (/^alphaLc/.test(type)) core = alpha(n);
    else if (/^alphaUc/.test(type)) core = alpha(n).toUpperCase();
    else if (/^romanLc/.test(type)) core = roman(n);
    else if (/^romanUc/.test(type)) core = roman(n).toUpperCase();
    else if (/^circleNum/.test(type)) core = String.fromCharCode(0x2460 + Math.min(n, 20) - 1);
    if (/ParenBoth$/.test(type)) return `(${core})`;
    if (/ParenR$/.test(type)) return `${core})`;
    if (/Plain$/.test(type) || /^circleNum/.test(type)) return core;
    return `${core}.`;
  }

  // ---------- 表格、圖表、SmartArt ----------
  async function drawFrame(g, el, ctx) {
    const b = xfrmOf(el, ctx);
    if (!b) return;
    const data = path(el, 'graphic', 'graphicData');
    const uri = attr(data, 'uri') || '';
    const tbl = kid(data, 'tbl');
    if (tbl) return drawTable(g, tbl, ctx, b);
    if (/diagram/.test(uri)) {
      // SmartArt：PowerPoint 會另外存一份畫好的圖形（drawing），照那份畫
      const relIds = kid(data, 'relIds');
      const dm = relIds && ([...relIds.attributes].find((a) => a.localName === 'dm')?.value);
      // 資料檔裡的 dataModelExt 指出這張 SmartArt 對應的是哪一份 drawing（一頁有好幾張時才不會拿錯）
      let drawingRel = null;
      const dmRel = dm && ctx.rels.get(dm);
      if (dmRel && dmRel.target) {
        const ext = descendants(await xml(dmRel.target), 'dataModelExt')[0];
        if (ext) drawingRel = ctx.rels.get(attr(ext, 'relId'));
      }
      drawingRel ||= [...ctx.rels.values()].find((r) => r.type === 'diagramDrawing' && r.target);
      if (drawingRel) {
        const doc = await xml(drawingRel.target);
        const tree = kid(doc, 'spTree');
        if (tree) {
          g.save();
          g.translate(b.x, b.y);
          await drawTree(g, tree, { ...ctx, rels: await rels(drawingRel.target), part: drawingRel.target, doc: 'drawing' }, false);
          g.restore();
          return;
        }
      }
    }
    if (/chart/.test(uri)) {
      const c = descendants(data, 'chart')[0];
      const id = c && [...c.attributes].find((a) => a.localName === 'id')?.value;
      const rel = id && ctx.rels.get(id);
      if (rel && rel.target && await drawChart(g, rel.target, ctx, b)) return;
    }
    // 畫不出來的：留一個灰框和說明
    g.save();
    g.fillStyle = '#f1f3f6';
    g.strokeStyle = '#c9d0db';
    g.lineWidth = 12700;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeRect(b.x, b.y, b.w, b.h);
    g.fillStyle = '#8a92a0';
    g.font = `400 ${Math.min(b.h / 8, 228600) * K}px ${FALLBACK_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    textAt(g, /chart/.test(uri) ? '（圖表：請另存 PDF 匯入才看得到）' : '（這個物件無法顯示）', b.x + b.w / 2, b.y + b.h / 2);
    g.restore();
  }

  // ---------- 圖表：用檔案裡存的數字自己畫（長條、橫條、折線、區域、圓餅、環圈） ----------
  async function drawChart(g, part, ctx, b) {
    const doc = await xml(part);
    const chart = kid(doc, 'chart');
    const plot = kid(chart, 'plotArea');
    if (!plot) return false;
    const groups = [...plot.children].filter((e) => /Chart$/.test(e.localName));
    const main = groups.find((e) => /^(bar|bar3D|line|line3D|area|area3D|pie|pie3D|doughnut|ofPie)Chart$/.test(e.localName));
    if (!main) return false;
    const kindOf = (el) => el.localName.replace(/3D/, '').replace(/Chart$/, '');
    const type = kindOf(main); // bar、line、area、pie、doughnut、ofPie
    const cache = (ref) => {
      const c = descendants(ref, 'strCache')[0] || descendants(ref, 'numCache')[0];
      if (!c) return [];
      const n = num(kid(c, 'ptCount'), 'val', 0);
      const out = new Array(n).fill('');
      for (const pt of kids(c, 'pt')) out[num(pt, 'idx')] = kid(pt, 'v')?.textContent ?? '';
      return out;
    };
    const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((a) => (ctx.scheme[a] ? `#${ctx.scheme[a]}` : null)).filter(Boolean);
    const palette = accents.length ? accents : ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
    const series = groups.filter((gr) => kindOf(gr) === type).flatMap((gr) => kids(gr, 'ser')).map((ser, i) => {
      const idx = num(kid(ser, 'idx'), 'val', i);
      const fillEl = path(ser, 'spPr', 'solidFill');
      const lineEl = path(ser, 'spPr', 'ln', 'solidFill');
      return {
        name: cache(kid(ser, 'tx')).join('') || `數列 ${i + 1}`,
        cats: cache(kid(ser, 'cat')),
        vals: cache(kid(ser, 'val')).map((v) => (v === '' ? null : Number(v))),
        color: colorOf(type === 'line' ? lineEl || fillEl : fillEl || lineEl, ctx) || palette[idx % palette.length],
        points: new Map(kids(ser, 'dPt').map((d) => [num(kid(d, 'idx'), 'val'), colorOf(path(d, 'spPr', 'solidFill'), ctx)])),
      };
    });
    if (!series.length) return false;
    const cats = series[0].cats.length ? series[0].cats : series[0].vals.map((_, i) => String(i + 1));
    const textColor = schemeColor('tx1', ctx) || '#404040';
    const pt = (v) => v * 12700;
    const font = (size, bold = false) => { g.font = `${bold ? 700 : 400} ${pt(size) * K}px ${FALLBACK_FONT}`; };
    const textW = (t) => g.measureText(t).width / K;
    const label = (t, x, y, align = 'center', base = 'middle') => { g.textAlign = align; g.textBaseline = base; textAt(g, t, x, y); };
    // 字的大小跟著圖表大小走，太小的圖表也看得清楚
    const unit = Math.max(10, Math.min(16, b.h / pt(1) / 17));

    g.save();
    g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
    const bg = colorOf(path(doc, 'spPr', 'solidFill'), ctx);
    if (bg) { g.fillStyle = bg; g.fillRect(b.x, b.y, b.w, b.h); }
    g.fillStyle = textColor;
    let top = b.y + pt(unit * 0.6);
    // 標題：有寫就用寫的；只有一個數列又沒刪掉標題時，用數列名稱
    const titleEl = kid(chart, 'title');
    const deleted = num(kid(chart, 'autoTitleDeleted'), 'val', 0) === 1;
    let title = titleEl ? descendants(titleEl, 't').map((t) => t.textContent).join('') : '';
    // 只有一個數列、標題沒被刪掉時，PowerPoint 會自動用數列名稱當標題
    if (!title && !deleted && series.length === 1) title = series[0].name;
    if (title) { font(unit * 1.3, true); label(title, b.x + b.w / 2, top + pt(unit * 0.8)); top += pt(unit * 2.2); }
    // 圖例
    const legendEl = kid(chart, 'legend');
    const isPie = type === 'pie' || type === 'doughnut' || type === 'ofPie';
    const legendItems = isPie ? cats.map((c, i) => [c, series[0].points.get(i) || palette[i % palette.length]]) : series.map((s) => [s.name, s.color]);
    let bottom = b.y + b.h - pt(unit * 0.6);
    let right = b.x + b.w - pt(unit);
    const legendPos = attr(kid(legendEl, 'legendPos'), 'val', 'r');
    if (legendEl && (isPie || series.length > 1)) {
      font(unit);
      const sw = pt(unit * 0.8);
      if (legendPos === 'b' || legendPos === 't') {
        const widths = legendItems.map(([n]) => sw + pt(unit * 0.4) + textW(n) + pt(unit * 1.2));
        let x = b.x + (b.w - widths.reduce((a, v) => a + v, 0)) / 2;
        const y = legendPos === 'b' ? bottom - pt(unit * 0.6) : top + pt(unit * 0.6);
        legendItems.forEach(([n, c], i) => { g.fillStyle = c; g.fillRect(x, y - sw / 2, sw, sw); g.fillStyle = textColor; label(n, x + sw + pt(unit * 0.4), y, 'left'); x += widths[i]; });
        if (legendPos === 'b') bottom -= pt(unit * 1.8); else top += pt(unit * 1.8);
      } else {
        const lw = Math.max(...legendItems.map(([n]) => textW(n))) + sw + pt(unit * 1.4);
        let y = b.y + b.h / 2 - (legendItems.length * pt(unit * 1.5)) / 2 + pt(unit * 0.75);
        const x = b.x + b.w - lw;
        for (const [n, c] of legendItems) { g.fillStyle = c; g.fillRect(x, y - sw / 2, sw, sw); g.fillStyle = textColor; label(n, x + sw + pt(unit * 0.4), y, 'left'); y += pt(unit * 1.5); }
        right = x - pt(unit);
      }
    }

    if (isPie) {
      const vals = series[0].vals.map((v) => Math.max(0, v || 0));
      const sum = vals.reduce((a, v) => a + v, 0) || 1;
      const cx = (b.x + right) / 2;
      const cy = (top + bottom) / 2;
      const r = Math.min(right - b.x, bottom - top) / 2 * 0.9;
      let a = -Math.PI / 2 + ((num(kid(main, 'firstSliceAng'), 'val', 0) * Math.PI) / 180);
      vals.forEach((v, i) => {
        const da = (v / sum) * Math.PI * 2;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a, a + da); g.closePath();
        g.fillStyle = series[0].points.get(i) || palette[i % palette.length]; g.fill();
        g.strokeStyle = '#ffffff'; g.lineWidth = pt(1.5); g.stroke();
        if (v / sum > 0.04) { font(unit, true); g.fillStyle = '#ffffff'; const m = a + da / 2; label(`${Math.round((v / sum) * 100)}%`, cx + Math.cos(m) * r * 0.62, cy + Math.sin(m) * r * 0.62); }
        a += da;
      });
      if (type === 'doughnut') { g.beginPath(); g.arc(cx, cy, r * num(kid(main, 'holeSize'), 'val', 50) / 100, 0, Math.PI * 2); g.fillStyle = bg || '#ffffff'; g.fill(); }
      g.restore();
      return true;
    }

    // 數值軸：取好看的刻度
    const horizontal = type === 'bar' && attr(kid(main, 'barDir'), 'val') === 'bar';
    const grouping = attr(kid(main, 'grouping'), 'val', 'clustered');
    const stacked = /stacked/i.test(grouping);
    const percent = /percent/i.test(grouping);
    let lo = 0;
    let hi = 0;
    cats.forEach((_, i) => {
      if (stacked) {
        const pos = series.reduce((a, s) => a + Math.max(0, s.vals[i] || 0), 0);
        const neg = series.reduce((a, s) => a + Math.min(0, s.vals[i] || 0), 0);
        hi = Math.max(hi, percent ? 100 : pos); lo = Math.min(lo, neg);
      } else for (const s of series) { const v = s.vals[i]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
    });
    if (hi === lo) hi = lo + 1;
    const rough = (hi - lo) / 5;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) || rough;
    hi = Math.ceil(hi / step) * step;
    lo = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    const fmt = (v) => (percent ? `${v}%` : Math.abs(v) >= 10000 ? v.toLocaleString() : String(v));
    font(unit);
    const valW = Math.max(...ticks.map((t) => textW(fmt(t)))) + pt(unit * 0.6);
    const catH = pt(unit * 1.8);
    const catW = Math.max(...cats.map((c) => textW(c))) + pt(unit * 0.8);
    const area = horizontal
      ? { x: b.x + pt(unit) + catW, y: top, w: right - (b.x + pt(unit) + catW), h: bottom - catH - top }
      : { x: b.x + pt(unit * 0.6) + valW, y: top, w: right - (b.x + pt(unit * 0.6) + valW), h: bottom - catH - top };
    if (area.w <= 0 || area.h <= 0) { g.restore(); return false; }
    const valPos = (v) => (horizontal ? area.x + ((v - lo) / (hi - lo)) * area.w : area.y + area.h - ((v - lo) / (hi - lo)) * area.h);
    // 格線和刻度
    g.strokeStyle = '#d9d9d9'; g.lineWidth = pt(0.75);
    font(unit); g.fillStyle = textColor;
    for (const t of ticks) {
      const p = valPos(t);
      g.beginPath();
      if (horizontal) { g.moveTo(p, area.y); g.lineTo(p, area.y + area.h); } else { g.moveTo(area.x, p); g.lineTo(area.x + area.w, p); }
      g.stroke();
      if (horizontal) label(fmt(t), p, area.y + area.h + catH / 2); else label(fmt(t), area.x - pt(unit * 0.4), p, 'right');
    }
    const n = cats.length;
    const slot = (horizontal ? area.h : area.w) / n;
    // 橫條圖的第一個類別在最下面（和 PowerPoint 一樣）
    const slotIndex = (i) => (horizontal ? n - 1 - i : i);
    cats.forEach((c, i) => {
      const mid = (horizontal ? area.y : area.x) + slot * (slotIndex(i) + 0.5);
      if (horizontal) label(c, area.x - pt(unit * 0.4), mid, 'right'); else label(c, mid, area.y + area.h + catH / 2);
    });
    const zero = valPos(Math.max(lo, Math.min(hi, 0)));
    if (type === 'bar') {
      const gap = num(kid(main, 'gapWidth'), 'val', 150) / 100;
      const groupW = slot / (1 + gap);
      const barW = stacked ? groupW : groupW / series.length;
      cats.forEach((_, i) => {
        let base = 0;
        let baseNeg = 0;
        const total = percent ? series.reduce((a, s) => a + Math.abs(s.vals[i] || 0), 0) || 1 : 1;
        series.forEach((s, si) => {
          let v = s.vals[i];
          if (v == null) return;
          if (percent) v = (v / total) * 100;
          const from = stacked ? (v >= 0 ? base : baseNeg) : 0;
          const to = from + v;
          if (stacked) { if (v >= 0) base = to; else baseNeg = to; }
          const start = (horizontal ? area.y : area.x) + slot * slotIndex(i) + (slot - groupW) / 2 + (stacked ? 0 : barW * si);
          const p1 = valPos(from);
          const p2 = valPos(to);
          g.fillStyle = s.points.get(i) || s.color;
          if (horizontal) g.fillRect(Math.min(p1, p2), start, Math.abs(p2 - p1), barW * 0.98);
          else g.fillRect(start, Math.min(p1, p2), barW * 0.98, Math.abs(p2 - p1));
        });
      });
    } else {
      // 折線、區域
      series.forEach((s) => {
        const pts = s.vals.map((v, i) => (v == null ? null : [area.x + slot * (i + 0.5), valPos(v)]));
        const valid = pts.filter(Boolean);
        if (!valid.length) return;
        if (type === 'area') {
          g.beginPath(); g.moveTo(valid[0][0], zero);
          for (const [x, y] of valid) g.lineTo(x, y);
          g.lineTo(valid[valid.length - 1][0], zero); g.closePath();
          g.globalAlpha = 0.7; g.fillStyle = s.color; g.fill(); g.globalAlpha = 1;
          return;
        }
        g.beginPath();
        valid.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = s.color; g.lineWidth = pt(2.25); g.lineJoin = 'round'; g.stroke();
        for (const [x, y] of valid) { g.beginPath(); g.arc(x, y, pt(3), 0, Math.PI * 2); g.fillStyle = s.color; g.fill(); }
      });
    }
    // 座標軸線
    g.strokeStyle = '#bfbfbf'; g.lineWidth = pt(0.75);
    g.beginPath();
    if (horizontal) { g.moveTo(zero, area.y); g.lineTo(zero, area.y + area.h); } else { g.moveTo(area.x, zero); g.lineTo(area.x + area.w, zero); }
    g.stroke();
    g.restore();
    return true;
  }

  async function drawTable(g, tbl, ctx, b) {
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(c, 'w'));
    const rows = kids(tbl, 'tr');
    const tblPr = kid(tbl, 'tblPr');
    const firstRow = attr(tblPr, 'firstRow') === '1';
    const bandRow = attr(tblPr, 'bandRow') === '1';
    const accent = ctx.scheme.accent1 || '4472C4';
    let y = b.y;
    for (const [ri, tr] of rows.entries()) {
      const h = num(tr, 'h');
      let x = b.x;
      let ci = 0;
      for (const tc of kids(tr, 'tc')) {
        const span = num(tc, 'gridSpan', 1);
        const w = cols.slice(ci, ci + span).reduce((s, v) => s + v, 0);
        ci += span;
        if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') { x += w; continue; }
        const rowSpan = num(tc, 'rowSpan', 1);
        const hh = rows.slice(ri, ri + rowSpan).reduce((s, r) => s + num(r, 'h'), 0) || h;
        const tcPr = kid(tc, 'tcPr');
        const box = { x, y, w, h: hh };
        const drewFill = await paintFill(g, tcPr, ctx, () => g.rect(x, y, w, hh), box);
        // 沒有指定顏色時，用最常見的表格樣式：標題列主題色、其他列淡色條紋
        if (!drewFill && !kid(tcPr, 'noFill')) {
          g.beginPath();
          g.rect(x, y, w, hh);
          if (firstRow && ri === 0) g.fillStyle = applyColorMods(hexToRgb(accent), []);
          else g.fillStyle = applyColorMods(hexToRgb(accent), [['lumMod', 20000], ['lumOff', 80000]]);
          if (bandRow && ri % 2 === (firstRow ? 0 : 1)) g.fillStyle = applyColorMods(hexToRgb(accent), [['lumMod', 40000], ['lumOff', 60000]]);
          g.fill();
        }
        // 框線
        let anyLine = false;
        for (const [side, x1, y1, x2, y2] of [['lnL', x, y, x, y + hh], ['lnR', x + w, y, x + w, y + hh], ['lnT', x, y, x + w, y], ['lnB', x, y + hh, x + w, y + hh]]) {
          const ln = kid(tcPr, side);
          const c = ln && !kid(ln, 'noFill') && colorOf(kid(ln, 'solidFill'), ctx);
          if (!c) continue;
          anyLine = true;
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
          g.strokeStyle = c; g.lineWidth = num(ln, 'w', 12700); g.stroke();
        }
        if (!anyLine) { g.strokeStyle = '#ffffff'; g.lineWidth = 12700; g.strokeRect(x, y, w, hh); }
        const txBody = kid(tc, 'txBody');
        if (txBody) {
          const fake = { localName: 'sp', children: [txBody] };
          const insets = { lIns: num(tcPr, 'marL', 91440), rIns: num(tcPr, 'marR', 91440), tIns: num(tcPr, 'marT', 45720), bIns: num(tcPr, 'marB', 45720) };
          const bodyPr = kid(txBody, 'bodyPr');
          for (const [kk, v] of Object.entries(insets)) if (bodyPr && !bodyPr.hasAttribute(kk)) bodyPr.setAttribute(kk, String(v));
          if (bodyPr && tcPr && attr(tcPr, 'anchor') && !bodyPr.hasAttribute('anchor')) bodyPr.setAttribute('anchor', attr(tcPr, 'anchor'));
          // 標題列預設白色粗體
          if (firstRow && ri === 0 && !drewFill) {
            for (const r of descendants(txBody, 'r')) {
              let rPr = kid(r, 'rPr');
              if (!rPr) { rPr = r.ownerDocument.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:rPr'); r.insertBefore(rPr, r.firstChild); }
              if (!rPr.hasAttribute('b')) rPr.setAttribute('b', '1');
              if (!kid(rPr, 'solidFill')) {
                const f = r.ownerDocument.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:solidFill');
                const c = r.ownerDocument.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:srgbClr');
                c.setAttribute('val', 'FFFFFF');
                f.appendChild(c);
                rPr.appendChild(f);
              }
            }
          }
          await drawText(g, fake, txBody, { ...ctx, doc: 'table' }, box, null);
        }
        x += w;
      }
      y += h;
    }
  }

  // 先載入投影片用到的字（網路字型是分批下載的）
  async function loadFonts() {
    if (!document.fonts || !document.fonts.load) return;
    let text = '';
    for (const part of slideParts) {
      const doc = await xml(part);
      for (const t of descendants(doc, 't')) text += t.textContent;
      if (text.length > 20000) break;
    }
    const chars = [...new Set(text)].join('') || 'a';
    try {
      await Promise.race([
        Promise.all([400, 700].map((w) => document.fonts.load(`${w} 16px "Noto Sans TC"`, chars))),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } catch { /* 用系統字型 */ }
  }
  await loadFonts();

  // 投影片標題（建立新頁面時當頁面標題）
  async function titleOf(n) {
    const doc = await xml(slideParts[n - 1]);
    const sp = descendants(doc, 'sp').find((x) => /title/i.test(placeholderOf(x)?.type || ''));
    const text = sp ? kids(kid(sp, 'txBody'), 'p').map((p) => descendants(p, 't').map((t) => t.textContent).join('')).join(' ').replace(/\s+/g, ' ').trim() : '';
    return text.slice(0, 80);
  }

  // ---------- 匯入前檢查：哪些東西畫不出來 ----------
  const fontCanvas = document.createElement('canvas').getContext('2d');
  function fontInstalled(name) {
    const sample = 'abcmmmWWWiii12345中文字體測試';
    return ['monospace', 'serif'].some((base) => {
      fontCanvas.font = `40px ${base}`;
      const w0 = fontCanvas.measureText(sample).width;
      fontCanvas.font = `40px "${name.replace(/"/g, '')}", ${base}`;
      return fontCanvas.measureText(sample).width !== w0;
    });
  }
  async function scan() {
    const found = new Map(); // 說明 → Set(投影片號碼)
    const add = (label, n) => { if (!found.has(label)) found.set(label, new Set()); found.get(label).add(n); };
    const fonts = new Map();
    for (const [i, part] of slideParts.entries()) {
      const n = i + 1;
      const ctx = await context(part);
      for (const [doc, r] of [[ctx.slide, ctx.sRels], [ctx.layout, ctx.lRels], [ctx.master, ctx.mRels]]) {
        if (!doc) continue;
        // 只看真的有被用到的圖片
        for (const blip of descendants(doc, 'blip')) {
          const id = [...blip.attributes].find((a) => a.localName === 'embed')?.value;
          const t = id && r.get(id)?.target;
          if (t && /\.(emf|wmf|tiff?)$/i.test(t)) add('EMF／WMF 圖片（常見於從 Word、Excel 複製過來的圖），會顯示成灰框', n);
        }
      }
      const doc = ctx.slide;
      for (const gd of descendants(doc, 'graphicData')) {
        const uri = attr(gd, 'uri') || '';
        if (/ole/i.test(uri)) add('內嵌物件（例如 Excel 表格、方程式）', n);
        if (/chart/.test(uri)) {
          const c = descendants(gd, 'chart')[0];
          const id = c && [...c.attributes].find((a) => a.localName === 'id')?.value;
          const target = id && ctx.sRels.get(id)?.target;
          const plot = target && path(await xml(target), 'chart', 'plotArea');
          const kinds = plot ? [...plot.children].filter((e) => /Chart$/.test(e.localName)).map((e) => e.localName) : [];
          if (!kinds.length || kinds.some((k) => !/^(bar|bar3D|line|line3D|area|area3D|pie|pie3D|doughnut|ofPie)Chart$/.test(k))) add('特殊圖表（散佈圖、雷達圖、組合圖等），會顯示成灰框', n);
        }
      }
      if (descendants(doc, 'prstTxWarp').some((w) => attr(w, 'prst') !== 'textNoShape')) add('文字藝術師（彎曲的文字）', n);
      if (descendants(doc, 'glow').length || descendants(doc, 'reflection').length || descendants(doc, 'sp3d').some((x) => x.children.length || x.attributes.length)) add('光暈、倒影、立體等特效', n);
      for (const f of [...descendants(doc, 'latin'), ...descendants(doc, 'ea')]) {
        const face = attr(f, 'typeface');
        if (face && !face.startsWith('+')) { if (!fonts.has(face)) fonts.set(face, new Set()); fonts.get(face).add(n); }
      }
      for (const face of [ctx.fonts.major, ctx.fonts.minor, ctx.fonts.majorEa, ctx.fonts.minorEa]) {
        if (face) { if (!fonts.has(face)) fonts.set(face, new Set()); fonts.get(face).add(n); }
      }
    }
    const missing = [...fonts.keys()].filter((f) => !fontInstalled(f));
    if (missing.length) {
      const slides = new Set(missing.flatMap((f) => [...fonts.get(f)]));
      found.set(`這台裝置沒有的字型（${missing.slice(0, 4).join('、')}${missing.length > 4 ? '…' : ''}），會換成思源黑體，換行位置可能不同`, slides);
    }
    return [...found].map(([label, set]) => ({ label, slides: [...set].sort((a, b) => a - b) }));
  }
  const warnings = await scan().catch((e) => { console.warn(e); return []; });

  return {
    count: slideParts.length,
    warnings,
    render,
    titleOf,
    destroy() {
      for (const p of images.values()) p.then((img) => img && img.close && img.close()).catch(() => {});
    },
  };
}
