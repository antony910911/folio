// 線條圖示，24×24，顏色跟著文字色。
const wrap = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  sidebar: wrap('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>'),
  select: wrap('<path d="M6 4l12 7.2-5.4 1.2L10 18z"/><path d="M12.6 12.4l3.6 5"/>'),
  hand: wrap('<path d="M8 12V6.5a1.5 1.5 0 013 0V11"/><path d="M11 10.5V5a1.5 1.5 0 013 0v5.5"/><path d="M14 10.5V6.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.6a5 5 0 01-4-2L4 14.4a1.6 1.6 0 012.4-2L8 14"/>'),
  pen: wrap('<path d="M15.5 4.5l4 4L9 19l-5 1 1-5z"/><path d="M13.5 6.5l4 4"/>'),
  highlighter: wrap('<path d="M14 4l6 6-7.5 7.5h-3L6.5 14.5v-3z"/><path d="M6.5 14.5L4 20h5l.5-2.5"/>'),
  eraser: wrap('<path d="M8.5 19.5L4 15a1.5 1.5 0 010-2.1L12.9 4a1.5 1.5 0 012.1 0l5 5a1.5 1.5 0 010 2.1l-8.4 8.4z"/><path d="M8.5 19.5H20"/><path d="M9.5 7.5l7 7"/>'),
  text: wrap('<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9.5 19h5"/>'),
  undo: wrap('<path d="M9 7L4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 010 11h-2" transform="translate(0 -3)"/>'),
  redo: wrap('<path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5H10a5.5 5.5 0 000 11h2" transform="translate(0 -3)"/>'),
  more: wrap('<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  chevron: wrap('<path d="M8 10l4 4 4-4"/>'),
  book: wrap('<path d="M5 4.5h11a2 2 0 012 2v13H7a2 2 0 01-2-2z"/><path d="M5 17.5a2 2 0 012-2h11"/>'),
  check: wrap('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  mindmap: wrap('<rect x="9" y="9.5" width="6" height="5" rx="1.5"/><rect x="2.5" y="3.5" width="5" height="4" rx="1.2"/><rect x="16.5" y="3.5" width="5" height="4" rx="1.2"/><rect x="16.5" y="16.5" width="5" height="4" rx="1.2"/><path d="M9 11c-2 0-2-5.5-3.5-5.5M15 11c2 0 2-5.5 3.5-5.5M15 13c2 0 2 5.5 3.5 5.5"/>'),
  insert: wrap('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5L7 19"/>'),
};
