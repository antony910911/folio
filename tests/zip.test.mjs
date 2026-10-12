import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openZip } from '../js/zip.js';

test('openZip 讀得出壓縮和未壓縮的檔案（含中文檔名）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-zip-'));
  const file = join(dir, 't.zip');
  execFileSync('python3', ['-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr(zipfile.ZipInfo('ppt/slides/slide1.xml'), '<p>投影片 ' + 'x' * 5000 + '</p>', compress_type=zipfile.ZIP_DEFLATED)
    z.writestr(zipfile.ZipInfo('媒體/圖.bin'), bytes(range(256)), compress_type=zipfile.ZIP_STORED)
`, file]);
  const zip = await openZip(readFileSync(file));
  assert.deepEqual(zip.names().sort(), ['ppt/slides/slide1.xml', '媒體/圖.bin'].sort());
  const xml = await zip.text('ppt/slides/slide1.xml');
  assert.ok(xml.startsWith('<p>投影片 xxx') && xml.length === 5011);
  const bin = await zip.read('媒體/圖.bin');
  assert.equal(bin.length, 256);
  assert.equal(bin[255], 255);
  assert.equal(await zip.read('nope'), null);
});

test('openZip 拒絕不是 zip 的檔案', async () => {
  await assert.rejects(openZip(new TextEncoder().encode('hello world, not a zip file at all')), /zip/);
});

test('pptx 顏色修飾：lumMod／lumOff、tint、shade、alpha', async () => {
  const { applyColorMods, hexToRgb } = await import('../js/pptx.js');
  assert.deepEqual(hexToRgb('4472C4'), [0x44, 0x72, 0xc4]);
  assert.equal(applyColorMods([255, 0, 0], []), 'rgb(255,0,0)');
  assert.equal(applyColorMods([0, 0, 0], [['lumMod', 50000], ['lumOff', 50000]]), 'rgb(128,128,128)');
  assert.equal(applyColorMods([0, 0, 0], [['tint', 25000]]), 'rgb(191,191,191)');
  assert.equal(applyColorMods([200, 100, 50], [['shade', 50000]]), 'rgb(100,50,25)');
  assert.equal(applyColorMods([10, 20, 30], [['alpha', 50000]]), 'rgba(10,20,30,0.5)');
});
