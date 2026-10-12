// 很小的 zip 讀取器：.pptx 其實是一個 zip 壓縮檔，裡面是一堆 XML 和圖片。
// 用瀏覽器內建的 DecompressionStream 解壓縮，不需要額外的函式庫。

export async function openZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 從檔尾往前找「中央目錄結尾」(End of Central Directory)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 檔');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error('檔案太大（zip64）目前不支援');
  const entries = new Map();
  const utf8 = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目錄損壞');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (view.getUint32(e.local, true) !== 0x04034b50) throw new Error('zip 檔案損壞');
    const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
    const data = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error('不支援的壓縮方式');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    async text(name) {
      const b = await read(name);
      return b ? utf8.decode(b) : null;
    },
  };
}
