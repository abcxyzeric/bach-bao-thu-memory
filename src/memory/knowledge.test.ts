import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { addKnowledge, deriveMemory, editNpc, finalizeDelta, removeKnowledge, updateKnowledge } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { applyKnowledgeOps, cleanKnowledgeOps, finalizeKnowledge, fmtKnowledgeForSummary, fmtKnowledgeInjection, knowledgeId, selectKnowledgeForSummary } from './knowledge';
import { buildSummaryPrompt } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type MemKnowledge, type StoredDelta } from './types';

const original = {
  injection: { ...settings.apiSettings.injection },
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: 'Eileen', is_user: false, is_system: false, mes: 'Lâm Chu và Eileen đang nói chuyện trong quán trọ.',
  extra: { bbs_leaf: { id: `know-${++seq}`, text: 'Đối thoại quán trọ', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const entry = (subject: string, text: string, i = 0): MemKnowledge => ({ id: `know:t#${i}`, subject, text, createdAt: 1 });
const leafId = (m: STMessage) => m.extra!.bbs_leaf!.id;
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'Lâm Chu', name2: 'Eileen',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'know-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.knowledge = true;
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('Danh sách hiểu biết: dịch đầu ra AI', () => {
  it('Số thứ tự k dịch thành id ổn định, know: giữ nguyên, tra không thấy thì hủy bỏ; sửa xóa trước thêm mới sau', () => {
    const shown = [{ id: 'know:a#0' }, { id: 'know:a#1' }];
    const ops = finalizeKnowledge({
      add: [{ who: ' Eileen ', text: 'Khẳng định nhân vật chính là thương buôn' }, { who: 'alice', text: 'Nghe nói nhân vật chính biết y thuật' }],
      update: [{ id: 'k2', text: 'Biết được nhân vật chính thực chất là hoàng tử' }, { id: 'k9', text: 'Tra không thấy mục này' }, { id: 'know:b#3', text: 'Tham chiếu nguyên bản' }],
      remove: ['k1', 'kx'],
    }, shown, ['Eileen', 'Alice']);
    expect(ops).toEqual([
      { op: 'update', id: 'know:a#1', text: 'Biết được nhân vật chính thực chất là hoàng tử' },
      { op: 'update', id: 'know:b#3', text: 'Tham chiếu nguyên bản' },
      { op: 'remove', id: 'know:a#0' },
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn' },
      { op: 'add', subject: 'Alice', text: 'Nghe nói nhân vật chính biết y thuật' },
    ]);
  });
  it('who chỉ nhận danh sách: nhân vật chính, tra không thấy người này, văn bản rỗng thì hủy cả mục', () => {
    const ops = finalizeKnowledge({ add: [{ who: 'Lâm Chu', text: 'Bản thân' }, { who: 'Người qua đường', text: 'Ngoài danh sách' }, { who: 'Eileen', text: ' ' }] }, [], ['Eileen']);
    expect(ops).toEqual([]);
    expect(finalizeKnowledge('Viết bừa', [], ['Eileen'])).toEqual([]);
  });
  it('Chưa truyền ngữ cảnh = tính năng đang tắt thì hủy cả đoạn; đã truyền thì nhân vật mới xuất hiện ở tầng này cũng tính vào danh sách', () => {
    const raw = { npcs: { add: [{ name: 'Tiểu Hạ' }] }, knowledge: { add: [{ who: 'Tiểu Hạ', text: 'Nghe nói nhân vật chính biết y thuật' }] } };
    expect(finalizeDelta(raw, [], []).knowledge).toBeUndefined();
    expect(finalizeDelta(raw, [], [], { shown: [], npcNames: ['Eileen'] }).knowledge)
      .toEqual([{ op: 'add', subject: 'Tiểu Hạ', text: 'Nghe nói nhân vật chính biết y thuật' }]);
  });
});

describe('Danh sách hiểu biết: lưu trữ và phát lại', () => {
  it('Cùng nhân vật đồng nghĩa thì khử trùng lặp, khác nhân vật mỗi người ghi riêng; id = lá#số_thứ_tự_thao_tác', () => {
    const list: MemKnowledge[] = [];
    applyKnowledgeOps(list, [
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn' },
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn。' },
      { op: 'add', subject: 'Tiểu Hạ', text: 'Khẳng định nhân vật chính là thương buôn' },
    ], { id: 'L1', createdAt: 1, time: 'Ngày thứ nhất' });
    expect(list.map(k => [k.id, k.subject, k.createdTime])).toEqual([['know:L1#0', 'Eileen', 'Ngày thứ nhất'], ['know:L1#2', 'Tiểu Hạ', 'Ngày thứ nhất']]);
    // Xóa rồi ghi lại, sửa đến mức đụng câu với mục khác: đều áp dụng theo thứ tự nhật ký
    applyKnowledgeOps(list, [
      { op: 'remove', id: 'know:L1#0' },
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn' },
      { op: 'update', id: 'know:L1#2', subject: 'Eileen' },
    ], { id: 'L2', createdAt: 2, time: '' });
    expect(list.map(k => [k.id, k.subject])).toEqual([['know:L2#1', 'Eileen']]);
  });
  it('Làm sạch loại bỏ thao tác hỏng, giữ nguyên thứ tự gốc', () => {
    expect(cleanKnowledgeOps([
      { op: 'add', subject: ' Eileen ', text: ' Khẳng định nhân vật chính là thương buôn ' }, { op: 'add', subject: '', text: 'x' },
      { op: 'update', id: 'know:a#0' }, { op: 'update', id: 'know:a#0', text: 'Sửa' }, { op: 'remove' }, 'junk', { op: 'remove', id: 'know:a#1' },
    ])).toEqual([
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn' },
      { op: 'update', id: 'know:a#0', text: 'Sửa' },
      { op: 'remove', id: 'know:a#1' },
    ]);
  });
  it('deriveMemory phát lại bất biến (idempotent), điểm cắt không làm rò rỉ tương lai', () => {
    const first = message({ knowledge: [{ op: 'add', subject: 'Eileen', text: 'A' }, { op: 'add', subject: 'Eileen', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const second = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }] });
    const chat = [first, second];
    expect(deriveMemory(chat).knowledge.map(k => [k.id, k.text])).toEqual([[a, 'A2']]);
    expect(deriveMemory(JSON.parse(JSON.stringify(chat))).knowledge).toEqual(deriveMemory(chat).knowledge);
    expect(deriveMemory(chat, 1).knowledge.map(k => k.text)).toEqual(['A', 'B']);
  });
  it('Mục đã sửa được chuyển xuống cuối: khi tiêm chỉ gửi vài mục gần nhất, nhận thức được đính chính sẽ không bị coi là mục cũ mà cắt mất', () => {
    const first = message({ knowledge: [
      { op: 'add', subject: 'Eileen', text: 'Khẳng định nhân vật chính là thương buôn' }, { op: 'add', subject: 'Eileen', text: 'B' }, { op: 'add', subject: 'Eileen', text: 'C' },
    ] });
    const second = message({ knowledge: [{ op: 'update', id: knowledgeId(leafId(first), 0), text: 'Biết được nhân vật chính thực chất là hoàng tử' }] });
    const list = deriveMemory([first, second]).knowledge;
    expect(list.map(k => k.text)).toEqual(['B', 'C', 'Biết được nhân vật chính thực chất là hoàng tử']);
    expect(fmtKnowledgeInjection(list, ['Eileen'], 'Lâm Chu', 2)).toContain('Eileen:(còn 1 mục cũ hơn được lược bớt)\n  - C\n  - Biết được nhân vật chính thực chất là hoàng tử');
  });
  it('Thêm sửa xóa thủ công ghi vào lá mới nhất; đổi tên nhân vật danh sách cũng đi theo', () => {
    const chat = [message({ npcs: { add: [{ name: 'Eileen', important: true }] } }), message()];
    useChat(chat);
    expect(addKnowledge('Eileen', ' Khẳng định Lâm Chu là thương buôn ')).toBe(true);
    const id = memory.knowledge[0].id;
    expect(id).toBe(knowledgeId(leafId(chat[1]), 0));
    expect(memory.knowledge[0]).toMatchObject({ subject: 'Eileen', text: 'Khẳng định Lâm Chu là thương buôn' });
    expect(updateKnowledge(id, 'Biết được Lâm Chu thực chất là hoàng tử')).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, text: 'Biết được Lâm Chu thực chất là hoàng tử' });
    expect(editNpc('Eileen', { name: 'Ellie' })).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, subject: 'Ellie' });
    expect(removeKnowledge(id)).toBe(true);
    expect(memory.knowledge).toHaveLength(0);
    expect(addKnowledge('Ellie', '  ')).toBe(false);
  });
  it('Kế thừa: danh sách mang toàn bộ vào lá hạt giống, sửa đổi/xóa trong cửa sổ đổi id theo', async () => {
    settings.apiSettings.keepRecent = 1;
    const first = message({ npcs: { add: [{ name: 'Eileen', important: true }] },
      knowledge: [{ op: 'add', subject: 'Eileen', text: 'A' }, { op: 'add', subject: 'Eileen', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const last = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }, { op: 'add', subject: 'Eileen', text: 'C' }] });
    const chat = [first, message(), last];
    const source = useChat(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'know-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(target.chat[0].extra!.bbs_leaf!.delta.knowledge).toEqual([
      { op: 'add', subject: 'Eileen', text: 'A' }, { op: 'add', subject: 'Eileen', text: 'B' },
    ]);
    expect(deriveMemory(target.chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
  });
});

describe('Danh sách hiểu biết: từ nhắc và tiêm', () => {
  const args: Parameters<typeof buildSummaryPrompt>[0] = {
    user: 'Lâm Chu', char: 'Eileen', time: '', location: '', protagonist: {}, sceneFocus: null,
    lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [{ name: 'Eileen', important: true }],
    openPlans: [], resolvedPlans: [], history: '', content: 'Nói chuyện', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
  };
  const shown = [entry('Eileen', 'Khẳng định nhân vật chính là thương buôn'), entry('Tiểu Hạ', 'Nghe nói nhân vật chính biết y thuật', 1)];
  it('API phụ gom nhóm theo nhân vật, đánh số liên tục toàn cục', () => {
    const list = [entry('Tiểu Hạ', 'X'), entry('Eileen', 'Y', 1), entry('Người qua đường', 'Z', 2)];
    expect(selectKnowledgeForSummary(list, ['Eileen', 'Tiểu Hạ', 'Eileen']).map(k => k.text)).toEqual(['Y', 'X']);
    expect(fmtKnowledgeForSummary(shown)).toBe('  Eileen:\n    k1. Khẳng định nhân vật chính là thương buôn\n  Tiểu Hạ:\n    k2. Nghe nói nhân vật chính biết y thuật');
    expect(fmtKnowledgeForSummary([])).toBe('  (Không có)');
  });
  it('Mẫu tích hợp sẵn: bật mới mang quy tắc/trường/danh sách, tắt thì một chữ cũng không gửi; các macro đều triển khai', () => {
    const off = buildSummaryPrompt(args);
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    for (const p of [off, on]) expect(`${p.system}${p.user}`).not.toMatch(/\{\{\w+\}\}/);
    expect(`${off.system}${off.user}`).not.toContain('danh sách hiểu biết');
    expect(`${off.system}${off.user}`).not.toContain('"knowledge"');
    expect(on.system).toContain('【Quy tắc danh sách hiểu biết】');
    expect(on.system).toContain('"knowledge"');
    expect(on.user).toContain('k1. Khẳng định nhân vật chính là thương buôn');
    expect(on.user).toContain('k2. Nghe nói nhân vật chính biết y thuật');
  });
  it('Mẫu tùy chỉnh: khi bật thì bổ sung giao thức tương thích và tài liệu danh sách, khi tắt thì không bổ sung', () => {
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    expect(on.system).toContain('【Giao thức tương thích danh sách hiểu biết của Bách Bảo Thư】');
    expect(on.system).toContain('【Quy tắc danh sách hiểu biết】');
    expect(on.user).toContain('k1. Khẳng định nhân vật chính là thương buôn');
    const off = buildSummaryPrompt(args);
    expect(`${off.system}${off.user}`).not.toContain('danh sách hiểu biết');
  });
  it('Tiêm: khử trùng lặp, chưa có bản ghi cũng liệt kê, vượt giới hạn trần chỉ gửi vài mục gần nhất; không có nhân vật thì không gửi', () => {
    const list = [entry('Eileen', 'A'), entry('Eileen', 'B', 1), entry('Eileen', 'C', 2)];
    const text = fmtKnowledgeInjection(list, ['Eileen', 'Tiểu Hạ', 'Eileen'], 'Lâm Chu', 2);
    expect(text).toContain('Sự hiểu biết của nhân vật về Lâm Chu');
    expect(text).toContain('những điều vốn phải biết theo quan hệ với Lâm Chu, thì vẫn biết như thường');
    // Bản lưu cũ danh sách đang trống: những điều đã nói rõ trong cốt truyện vẫn tính là biết, tránh người quen cũ bị「mất trí nhớ」
    expect(text).toContain('trừ khi trong cốt truyện đã nói rõ nhân vật đó được biết');
    expect(text).toContain('Eileen:(còn 1 mục cũ hơn được lược bớt)\n  - B\n  - C');
    expect(text).toContain('Tiểu Hạ:Chưa có ghi chép');
    expect(text.match(/Eileen:/g)).toHaveLength(1);
    expect(fmtKnowledgeInjection(list, [], 'Lâm Chu')).toBe('');
  });
  it('Tiêm mô hình chính chỉ gửi cho nhân vật chính yếu và nhân vật có mặt, chịu sự kiểm soát của công tắc', () => {
    useChat([message({
      npcs: { add: [{ name: 'Eileen', important: true }, { name: 'Tiểu Hạ', follow: true }, { name: 'Người qua đường Giáp' }] },
      knowledge: [{ op: 'add', subject: 'Eileen', text: 'Khẳng định Lâm Chu là thương buôn' }, { op: 'add', subject: 'Người qua đường Giáp', text: 'Nghe nói Lâm Chu có tiền' }],
    })]);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('Eileen:\n  - Khẳng định Lâm Chu là thương buôn');
    expect(text).toContain('Tiểu Hạ:Chưa có ghi chép');
    expect(text).not.toContain('Nghe nói Lâm Chu có tiền');
    settings.apiSettings.injection.knowledge = false;
    expect(inject.buildStateInjectionText()).not.toContain('Sự hiểu biết của nhân vật về Lâm Chu');
  });
});

describe('Danh sách hiểu biết: nối dây tóm tắt thực tế', () => {
  const setup = () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [message({ npcs: { add: [{ name: 'Eileen', important: true }] },
      knowledge: [{ op: 'add', subject: 'Eileen', text: 'Khẳng định Lâm Chu là thương buôn' }] }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: 'Lâm Chu thú nhận với Eileen rằng bản thân thực chất là hoàng tử, và xưng tên.', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      knowledge: {
        update: [{ id: 'k1', text: 'Biết được Lâm Chu thực chất là hoàng tử, trước đây luôn bị giấu' }],
        add: [{ who: 'Eileen', text: 'Biết nhân vật chính tên là Lâm Chu' }, { who: 'Lâm Chu', text: 'Nhân vật chính không ghi chính mình' }, { who: 'Người qua đường', text: 'Ngoài danh sách không ghi' }],
      },
    }));
    return chat;
  };
  const requestText = () => vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
  it('API phụ nhìn thấy danh sách và quy tắc, mã số k lưu thành id ổn định, mục ngoài danh sách và nhân vật chính bị loại bỏ', async () => {
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).toContain('【Quy tắc danh sách hiểu biết】');
    expect(requestText()).toContain('k1. Khẳng định Lâm Chu là thương buôn');
    // Mục kiểm điểm của danh sách kiểm tra được gửi kèm theo công tắc
    expect(requestText()).toContain('Danh sách hiểu biết: Đối chiếu với「Hiểu biết của nhân vật về nhân vật chính」');
    expect(chat[1].extra!.bbs_leaf!.delta.knowledge).toEqual([
      { op: 'update', id: knowledgeId(leafId(chat[0]), 0), text: 'Biết được Lâm Chu thực chất là hoàng tử, trước đây luôn bị giấu' },
      { op: 'add', subject: 'Eileen', text: 'Biết nhân vật chính tên là Lâm Chu' },
    ]);
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['Biết được Lâm Chu thực chất là hoàng tử, trước đây luôn bị giấu', 'Biết nhân vật chính tên là Lâm Chu']);
  });
  it('Công tắc tắt: không gửi quy tắc và danh sách, AI có cố tình đưa cũng không ghi, danh sách đã có được giữ nguyên', async () => {
    settings.apiSettings.injection.knowledge = false;
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).not.toContain('Quy tắc danh sách hiểu biết');
    expect(requestText()).not.toContain('Khẳng định Lâm Chu là thương buôn');
    expect(chat[1].extra!.bbs_leaf!.delta.knowledge).toBeUndefined();
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['Khẳng định Lâm Chu là thương buôn']);
  });
  it('Điểm danh trong chính văn chỉ nhận tên từ hai ký tự trở lên: tên một ký tự hầu như đoạn nào cũng có thể trúng', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    second.mes = 'Lâm Chu và Tiểu Hạ đang nói chuyện trong quán trọ.';
    useChat([message({ npcs: { add: [{ name: 'Eileen', important: true }, { name: 'Tiểu Hạ' }, { name: 'u' }] },
      knowledge: [{ op: 'add', subject: 'Tiểu Hạ', text: 'Nghe nói nhân vật chính biết y thuật' }, { op: 'add', subject: 'u', text: 'Nghe nói nhân vật chính là ngư dân' }] }), second]);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: 'Lâm Chu và Tiểu Hạ trò chuyện phiếm.', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
    }));
    await summarizeFloor(1);
    expect(requestText()).toContain('Nghe nói nhân vật chính biết y thuật');
    expect(requestText()).not.toContain('Nghe nói nhân vật chính là ngư dân');
  });
});
