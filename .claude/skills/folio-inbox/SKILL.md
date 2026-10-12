---
name: folio-inbox
description: 把整理好的資料存成 Folio 筆記的一頁（放進「收件匣」筆記本）。使用者說「存到 Folio」「放進我的筆記」「每天幫我整理…存起來」，或排程任務要把結果交給使用者時使用。需要環境變數 FOLIO_URL 和 FOLIO_INBOX_TOKEN。
---

# 存到 Folio 收件匣

Folio 的伺服器有一個收件匣入口：`POST $FOLIO_URL/api/inbox`。送過去的內容會變成「收件匣」筆記本裡的一頁，最新的在最上面，使用者的 iPad、手機、電腦幾秒內就會看到。

## 需要的設定

- `FOLIO_URL`：使用者的 Folio 網址，例如 `https://folio.amy.workers.dev`（結尾不要斜線）
- `FOLIO_INBOX_TOKEN`：收件匣鑰匙（Cloudflare 上的 `INBOX_TOKEN`）。只能新增頁面，不能讀筆記。

先確認兩個都有：`test -n "$FOLIO_URL" && test -n "$FOLIO_INBOX_TOKEN" && echo ok`。
缺的話不要叫使用者把鑰匙貼在對話裡；請他到雲端環境設定（對話標題列的環境選單 › Edit）加入環境變數，並把 Folio 的網域加進 Network access 的 Allowed domains，然後開一個新對話。

## 送出

用 Python 組 JSON（中文、引號、換行才不會出錯）：

```sh
python3 - <<'PY'
import json, os, urllib.request
note = {
    "title": "2026/10/12 AI 新聞重點",      # 簡短標題
    "section": "每日新聞",                  # 收件匣裡的分區，沒有會自動建立；不給就是「AI 匯入」
    "source": "https://example.com/article",  # 選填：主要來源
    "content": """# 三則重點

1. **標題一**：一兩句摘要。[原文](https://example.com/1)
2. **標題二**：……

- [ ] 想追蹤的事
""",
}
req = urllib.request.Request(
    os.environ["FOLIO_URL"].rstrip("/") + "/api/inbox",
    data=json.dumps(note, ensure_ascii=False).encode(),
    headers={"Authorization": "Bearer " + os.environ["FOLIO_INBOX_TOKEN"], "Content-Type": "application/json"},
    method="POST",
)
print(urllib.request.urlopen(req, timeout=30).read().decode())
PY
```

成功會回 `{"ok": true, "notebook": "收件匣", "section": "…", "page": "…"}`。

## 內容怎麼寫

- 用繁體中文，除非使用者要別的語言。
- `content` 用 Markdown，Folio 支援：`#` 標題（顯示成粗體）、`-` 清單、`1.` 編號、縮排兩格的子項目、`- [ ]`／`- [x]` 勾選清單、`**粗體**`、`*斜體*`、`~~刪除線~~`、`[文字](網址)`（顯示成「文字（網址）」）、`>` 引用、表格（每列變一行）。
- 不支援圖片和 HTML；不要放。
- 一頁一個主題。內容很多就分成幾頁各送一次，標題寫清楚日期和主題。
- 每個重點附上來源網址，方便使用者回去看原文。
- 送出前確認內容是真的查到的；查不到就寫「今天沒有找到相關資料」，不要編。

## 錯誤

| 回應 | 意思 | 怎麼辦 |
|---|---|---|
| 401 `unauthorized` | 收件匣鑰匙不對 | 請使用者確認環境變數和 Cloudflare 上的 `INBOX_TOKEN` 一樣 |
| 503 `inbox_not_configured` | Cloudflare 還沒設定 `INBOX_TOKEN` | 請使用者照 setup.html 第 10 步設定 |
| 400 `empty`／`too_large` | 沒有內容／超過 20 萬字 | 補內容或拆成幾頁 |
| 連線被擋（403、proxy、DNS） | 雲端環境的網路沒放行 Folio 的網域 | 請使用者把網域加進 Network access 的 Allowed domains |
