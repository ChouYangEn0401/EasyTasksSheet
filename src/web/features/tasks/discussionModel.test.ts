import { describe, expect, it } from 'vitest';
import { clearUserDrafts } from '../../lib/drafts.ts';
import {
  applyMention,
  draftKey,
  filterMentionCandidates,
  filterThreads,
  firstUnreadId,
  isNearBottom,
  loadDraft,
  mentionQueryAt,
  mergeReplies,
  orderThreads,
  saveDraft,
  scrollEdges,
  shouldCollapse,
  tokenizeBody,
  type CommentThread,
  type DraftStorage,
  type TaskComment,
} from './discussionModel.ts';

const known = new Set(['bob', 'alice.w', 'pm-lee']);

function comment(id: number, authorId: number | null, extra: Partial<TaskComment> = {}): TaskComment {
  return {
    id,
    taskId: 1,
    parentId: null,
    replyToId: null,
    authorId,
    body: `訊息 ${id}`,
    mentions: [],
    createdAt: id * 1000,
    updatedAt: id * 1000,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    threadResolvedAt: null,
    threadResolvedBy: null,
    ...extra,
  };
}

function thread(
  id: number,
  authorId: number,
  replies: TaskComment[] = [],
  extra: Partial<CommentThread> = {},
) {
  return {
    ...comment(id, authorId),
    replies,
    replyCount: replies.length,
    lastActivityAt: Math.max(id, ...replies.map((r) => r.id)) * 1000,
    ...extra,
  } as CommentThread;
}

describe('tokenizeBody：@提及與網址', () => {
  it('只把存在的帳號視為提及，email 與未知帳號保持文字', () => {
    expect(tokenizeBody('@bob 請看，x@bob.com 與 @nobody', known)).toEqual([
      { kind: 'mention', text: '@bob', username: 'bob' },
      { kind: 'text', text: ' 請看，x@bob.com 與 @nobody' },
    ]);
  });

  it('帳號可含 . 與 -，句尾標點不算帳號；大小寫不敏感', () => {
    expect(tokenizeBody('問 @Alice.W. 和 @pm-lee。', known)).toEqual([
      { kind: 'text', text: '問 ' },
      { kind: 'mention', text: '@Alice.W', username: 'alice.w' },
      { kind: 'text', text: '. 和 ' },
      { kind: 'mention', text: '@pm-lee', username: 'pm-lee' },
      { kind: 'text', text: '。' },
    ]);
  });

  it('網址自動連結並去掉尾端標點；不支援 javascript: 等其他協定', () => {
    expect(tokenizeBody('看 https://example.com/a?b=1)，或 javascript:alert(1)', known)).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ')，或 javascript:alert(1)' },
    ]);
  });

  it('保留換行與 HTML 字元為純文字', () => {
    expect(tokenizeBody('<b>粗體</b>\n第二行', known)).toEqual([
      { kind: 'text', text: '<b>粗體</b>\n第二行' },
    ]);
  });
});

describe('@ 選單', () => {
  const users = [
    { id: 1, username: 'bob', displayName: '王小明', isActive: true },
    { id: 2, username: 'alice', displayName: 'Alice', isActive: true },
    { id: 3, username: 'bobby', displayName: '停用者', isActive: false },
    { id: 4, username: 'lee', displayName: '李博文', isActive: true },
  ];

  it('mentionQueryAt：@ 需在行首或空白後，游標前才算', () => {
    expect(mentionQueryAt('嗨 @bo', 5)).toEqual({ start: 2, query: 'bo' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail@bo', 7)).toBeNull();
    expect(mentionQueryAt('@bob 好', 6)).toBeNull();
  });

  it('filterMentionCandidates：只列啟用成員，開頭相符優先，可用顯示名稱搜尋', () => {
    expect(filterMentionCandidates(users, 'bo').map((u) => u.id)).toEqual([1]);
    expect(filterMentionCandidates(users, '李').map((u) => u.id)).toEqual([4]);
    expect(filterMentionCandidates(users, 'l').map((u) => u.id)).toEqual([4, 2]);
    expect(filterMentionCandidates(users, '').map((u) => u.id)).toHaveLength(3);
    expect(filterMentionCandidates(users, '', 2)).toHaveLength(2);
  });

  it('applyMention：取代查詢字並補空白，回傳游標位置', () => {
    expect(applyMention('嗨 @bo', 2, 5, 'bob')).toEqual({ text: '嗨 @bob ', caret: 7 });
    expect(applyMention('@b 你好', 0, 2, 'bob')).toEqual({ text: '@bob 你好', caret: 5 });
  });
});

describe('草稿', () => {
  function memory(): DraftStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
      key: (i) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    };
  }

  it('以使用者 + 任務為單位保存、空白即刪除', () => {
    const s = memory();
    saveDraft(s, 1, 7, '還沒寫完');
    saveDraft(s, 1, 8, '另一個任務');
    expect(loadDraft(s, 1, 7)).toBe('還沒寫完');
    expect(loadDraft(s, 1, 8)).toBe('另一個任務');
    // 換人登入看不到別人的草稿
    expect(loadDraft(s, 2, 7)).toBe('');
    saveDraft(s, 1, 7, '   ');
    expect(s.data.has(draftKey(1, 7))).toBe(false);
    expect(loadDraft(s, 1, 7)).toBe('');
  });

  it('登出時清除該使用者的草稿（含舊版不分使用者的鍵），不動其他人與其他資料', () => {
    const s = memory();
    saveDraft(s, 1, 7, 'A 的草稿');
    saveDraft(s, 1, 9, 'A 的另一份');
    saveDraft(s, 2, 7, 'B 的草稿');
    s.setItem('tasks-sheets:discussion-draft:5', '舊版草稿');
    s.setItem('tasks-sheets:other', '其他設定');
    clearUserDrafts(s, 1);
    expect([...s.data.keys()].sort()).toEqual([draftKey(2, 7), 'tasks-sheets:other'].sort());
    expect(() => clearUserDrafts(null, 1)).not.toThrow();
  });

  it('storage 不可用或丟出例外時靜默略過', () => {
    expect(loadDraft(null, 1, 1)).toBe('');
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(loadDraft(broken, 1, 1)).toBe('');
    expect(() => saveDraft(broken, 1, 1, 'x')).not.toThrow();
  });
});
describe('未讀分隔線', () => {
  const ordered = [
    comment(1, 2),
    comment(2, 1),
    comment(3, 2, { deletedAt: 9 }),
    comment(4, 1),
    comment(5, 2),
  ];

  it('第一則「他人、未刪除、id 大於已讀位置」的訊息', () => {
    expect(firstUnreadId(ordered, 2, 1)).toBe(5);
    expect(firstUnreadId(ordered, 0, 1)).toBe(1);
  });

  it('從未讀過時，他人的第一則即為未讀；自己的訊息不算', () => {
    expect(firstUnreadId(ordered, null, 2)).toBe(2);
    expect(firstUnreadId([comment(1, 2)], null, 2)).toBeNull();
  });

  it('全部已讀時沒有分隔線', () => {
    expect(firstUnreadId(ordered, 5, 1)).toBeNull();
  });
});

describe('捲動判斷', () => {
  it('isNearBottom：距底部 48px 內視為在底部', () => {
    expect(isNearBottom({ scrollTop: 552, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }, 120)).toBe(true);
  });

  it('scrollEdges：頂端 / 底端是否還有內容', () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toEqual({
      top: false,
      bottom: true,
    });
    expect(scrollEdges({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toEqual({
      top: true,
      bottom: false,
    });
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toEqual({
      top: false,
      bottom: false,
    });
  });
});

describe('長訊息摺疊', () => {
  it('超過 8 行或很長的單段文字才摺疊', () => {
    expect(shouldCollapse(['一', '二', '三'].join('\n'))).toBe(false);
    expect(shouldCollapse(Array.from({ length: 9 }, (_, i) => `第 ${i} 行`).join('\n'))).toBe(true);
    expect(shouldCollapse('字'.repeat(600))).toBe(true);
  });
});

describe('討論串排序與篩選', () => {
  const me = 1;
  const a = thread(1, 2, [comment(5, 1, { parentId: 1 })]);
  const b = thread(2, 2, [], { threadResolvedAt: 100, threadResolvedBy: 2 });
  const c = thread(3, 3, [comment(4, 2, { parentId: 3, mentions: [me] })]);

  it('orderThreads：依最新活動舊→新（最新的在最下方），跨頁去重', () => {
    const pages = [
      { threads: [a, c], hasMore: true, nextBefore: 'x', lastReadCommentId: null },
      { threads: [c, b], hasMore: false, nextBefore: null, lastReadCommentId: null },
    ];
    expect(orderThreads(pages).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it('filterThreads：未解決 / 與我有關（我的訊息或提到我）', () => {
    expect(filterThreads([a, b, c], 'all', me)).toHaveLength(3);
    expect(filterThreads([a, b, c], 'open', me).map((t) => t.id)).toEqual([1, 3]);
    expect(filterThreads([a, b, c], 'mine', me).map((t) => t.id)).toEqual([1, 3]);
    expect(filterThreads([a, b, c], 'mine', null)).toEqual([]);
  });

  it('mergeReplies：較早載入與最新幾則合併、去重、依 id 排序', () => {
    const older = [comment(2, 1), comment(3, 1)];
    const latest = [comment(3, 1, { body: '新版' }), comment(4, 1)];
    const merged = mergeReplies(older, latest);
    expect(merged.map((r) => r.id)).toEqual([2, 3, 4]);
    expect(merged[1]?.body).toBe('新版');
  });
});
