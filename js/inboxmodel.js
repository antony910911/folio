// 收件匣：讓 Claude、ChatGPT 這類工具把資料送進 Folio（伺服器的 /api/inbox 用這裡的函式）。
// AI 最常寫的是 Markdown，這裡把它轉成文字框用的 HTML。
// 只會產生文字框允許的標籤（b、i、s、div、br、ul、ol、li 和勾選清單的 class），其他都當成文字。

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 行內格式：**粗體**、*斜體*、~~刪除線~~、`程式碼`、[文字](網址)
export function inlineMd(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  // 連結：文字框不能放連結，改成「文字（網址）」，網址還是看得到、可以複製
  s = s.replace(/!?\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, t, u) => (t && t !== u ? `${t}（${u}）` : u));
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`);
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, (_, pre, t) => `${pre}<i>${t}</i>`);
  s = s.replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, (_, pre, t) => `${pre}<i>${t}</i>`);
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => esc(codes[Number(i)]));
  return s;
}

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;

export function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const stack = []; // 目前開著的清單：{ tag, check, indent }
  let inCode = false;
  let blank = false;

  const closeLists = (toDepth = 0) => {
    while (stack.length > toDepth) {
      const l = stack.pop();
      out.push('</li>', `</${l.tag}>`);
    }
  };
  const line = (html) => {
    closeLists();
    if (blank && out.length) out.push('<div><br></div>');
    blank = false;
    out.push(`<div>${html || '<br>'}</div>`);
  };

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) { line(esc(raw.replace(/\t/g, '  ')) || '<br>'); continue; }
    if (!raw.trim()) { blank = true; continue; }

    const m = raw.match(LIST);
    if (m) {
      const indent = m[1].replace(/\t/g, '  ').length;
      const ordered = /\d/.test(m[2]);
      const check = m[3] != null;
      const tag = ordered && !check ? 'ol' : 'ul';
      // 縮排比上一層深就開新的一層；淺就收回去
      while (stack.length && indent < stack[stack.length - 1].indent) {
        const l = stack.pop();
        out.push('</li>', `</${l.tag}>`);
      }
      const top = stack[stack.length - 1];
      if (top && indent > top.indent && stack.length < 6) {
        stack.push({ tag, check, indent });
        out.push(check ? '<ul class="checklist">' : `<${tag}>`);
      } else if (top && top.tag === tag && top.check === check) {
        out.push('</li>');
      } else {
        if (top) { stack.pop(); out.push('</li>', `</${top.tag}>`); }
        if (!stack.length && blank && out.length) out.push('<div><br></div>');
        stack.push({ tag, check, indent });
        out.push(check ? '<ul class="checklist">' : `<${tag}>`);
      }
      blank = false;
      out.push(check && m[3].toLowerCase() === 'x' ? '<li class="done">' : '<li>', inlineMd(m[4]) || '<br>');
      continue;
    }

    const h = raw.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) { line(`<b>${inlineMd(h[1])}</b>`); continue; }
    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) { line(`<i>${inlineMd(q[1])}</i>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { line('──────────'); continue; }
    // 表格：每一列變成一行，欄位用「｜」隔開；分隔線那列跳過
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
      line(raw.trim().slice(1, -1).split('|').map((c) => inlineMd(c.trim())).join('｜'));
      continue;
    }
    line(inlineMd(raw.trim()));
  }
  closeLists();
  return out.join('');
}

// 檢查送進來的資料，回傳整理好的 { title, html, section, source } 或 { error }
export function parseInboxRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'bad_json' };
  const title = String(body.title ?? '').trim().slice(0, 200);
  const content = String(body.content ?? body.markdown ?? body.text ?? '');
  if (!title && !content.trim()) return { error: 'empty' };
  if (content.length > 200_000) return { error: 'too_large' };
  const section = String(body.section ?? '').trim().slice(0, 60) || 'AI 匯入';
  const source = String(body.source ?? '').trim().slice(0, 500);
  let html = markdownToHtml(content);
  if (source) html = `<div><i>來源：${esc(source)}</i></div><div><br></div>` + html;
  return { title: title || '未命名', html: html || '<div><br></div>', section, source };
}

export const INBOX_NOTEBOOK = '收件匣';
