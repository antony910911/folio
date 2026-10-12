import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, inlineMd, parseInboxRequest } from '../js/inboxmodel.js';

test('行內格式：粗體、斜體、刪除線、程式碼、連結', () => {
  assert.equal(inlineMd('**重點** 和 *斜體* 和 ~~刪掉~~'), '<b>重點</b> 和 <i>斜體</i> 和 <s>刪掉</s>');
  assert.equal(inlineMd('看 [新聞](https://a.com/x)'), '看 新聞（https://a.com/x）');
  assert.equal(inlineMd('`a<b>`'), 'a&lt;b&gt;');
  assert.equal(inlineMd('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(inlineMd('2*3*4 不是斜體'), '2*3*4 不是斜體');
});

test('標題、段落、空行', () => {
  assert.equal(markdownToHtml('# 今日重點\n\n第一段\n第二行'), '<div><b>今日重點</b></div><div><br></div><div>第一段</div><div>第二行</div>');
});

test('清單、勾選清單、巢狀', () => {
  assert.equal(markdownToHtml('- 一\n- 二'), '<ul><li>一</li><li>二</li></ul>');
  assert.equal(markdownToHtml('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>');
  assert.equal(markdownToHtml('- [ ] 待辦\n- [x] 完成'), '<ul class="checklist"><li>待辦</li><li class="done">完成</li></ul>');
  assert.equal(markdownToHtml('- 父\n  - 子\n- 父二'), '<ul><li>父<ul><li>子</li></ul></li><li>父二</li></ul>');
  assert.equal(markdownToHtml('文字\n- 項目\n文字'), '<div>文字</div><ul><li>項目</li></ul><div>文字</div>');
});

test('程式碼區塊、引用、分隔線、表格', () => {
  assert.equal(markdownToHtml('```\n<b>x</b>\n```'), '<div>&lt;b&gt;x&lt;/b&gt;</div>');
  assert.equal(markdownToHtml('> 引用'), '<div><i>引用</i></div>');
  assert.equal(markdownToHtml('---'), '<div>──────────</div>');
  assert.equal(markdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |'), '<div>A｜B</div><div>1｜2</div>');
});

test('parseInboxRequest：預設值、來源、限制', () => {
  const r = parseInboxRequest({ title: '新聞', content: '- a', source: 'https://x.com' });
  assert.equal(r.section, 'AI 匯入');
  assert.ok(r.html.startsWith('<div><i>來源：https://x.com</i></div>'));
  assert.equal(parseInboxRequest({}).error, 'empty');
  assert.equal(parseInboxRequest(null).error, 'bad_json');
  assert.equal(parseInboxRequest({ title: 't', content: 'x'.repeat(200_001) }).error, 'too_large');
  assert.equal(parseInboxRequest({ content: 'hi' }).title, '未命名');
});
