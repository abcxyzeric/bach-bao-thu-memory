import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { addLifeDetail, deriveMemory, editNpc, finalizeDelta, removeLifeDetail, removeNpc, updateLifeDetail } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { fmtLifeDetail, lifeDetailSubject, mergeLifeDetailsOp, sameLifeDetail } from './lifeDetails';
import { buildSummaryPrompt, fmtLifeDetails, RULE_LIFE_DETAILS } from './prompts';
import { selectLifeDetailsForInjection } from './select';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type MemLifeDetail, type StoredDelta, type SummaryDelta } from './types';

const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: 'Eileen', is_user: false, is_system: false, mes: 'Hai người đang thảo luận chuyện ăn bánh kếp.',
  extra: { bbs_leaf: { id: `life-${++seq}`, text: 'Thảo luận bữa sáng', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const detail = (subject?: string, text = 'Cho rằng bánh kếp không thêm bánh giòn thì không có linh hồn'): MemLifeDetail => ({
  id: `detail:${subject ?? 'legacy'}#0`, subject, text, topics: ['Ăn uống'], anchors: ['bánh kếp'], tier: 'active', createdAt: 1,
});
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'Lâm Chu', name2: 'Eileen',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'life-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.lifeDetails = true;
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
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('Hồ sơ đời sống lưu trữ và phát lại theo nhân vật', () => {
  it('Bản ghi cũ xử lý theo nhân vật chính, nhân vật chính mới cũ cùng văn bản thì khử trùng lặp; NPC cùng văn bản giữ riêng từng người và số thứ tự ổn định', () => {
    const leaf = message({ lifeDetails: { add: [detail(), detail('user'), detail('Eileen'), detail('Tiểu Hạ')] } });
    const before = JSON.stringify(leaf);
    const details = deriveMemory([leaf]).lifeDetails;
    expect(details.map(d => d.subject)).toEqual(['user', 'Eileen', 'Tiểu Hạ']);
    expect(details.map(d => d.id.split('#')[1])).toEqual(['0', '2', '3']);
    expect(deriveMemory(JSON.parse(JSON.stringify([leaf]))).lifeDetails).toEqual(details);
    expect(JSON.stringify(leaf)).toBe(before);
  });
  it('Văn bản chuẩn hóa của cùng một nhân vật thì khử trùng lặp nhưng không gộp các nhân vật khác nhau', () => {
    expect(sameLifeDetail(detail(' Alice ', 'Ngủ sớm。'), detail('alice', 'Ngủ sớm'))).toBe(true);
    expect(sameLifeDetail(detail(), detail('user'))).toBe(true);
    expect(sameLifeDetail(detail('Eileen'), detail('user'))).toBe(false);
  });
  it('Làm sạch subject, cập nhật nhân vật chỉ định theo mã số d, lược bỏ subject thì giữ nguyên', () => {
    const first = message({ lifeDetails: { add: [detail('user'), detail('Eileen')] } });
    const prior = deriveMemory([first]).lifeDetails;
    const delta = finalizeDelta({ lifeDetails: { update: [{ id: 'd2', text: 'Cũng chấp nhận không thêm bánh giòn' }] } }, [], prior);
    expect(delta.lifeDetails!.update![0]).toEqual({ id: prior[1].id, text: 'Cũng chấp nhận không thêm bánh giòn' });
    const details = deriveMemory([first, message(delta)]).lifeDetails;
    expect(details[0]).toEqual(prior[0]);
    expect(details[1]).toMatchObject({ subject: 'Eileen', text: 'Cũng chấp nhận không thêm bánh giòn' });
    const added = finalizeDelta({ lifeDetails: { add: [{ subject: ' Eileen ', text: 'Thích uống trà' }] } }, []);
    expect(added.lifeDetails!.add![0].subject).toBe('Eileen');
  });
  it.each(['', ' ', null, false, 42, [], {}])('subject phi pháp/rỗng %j không ghi đè nhân vật gốc', subject => {
    const first = message({ lifeDetails: { add: [detail('Eileen')] } });
    const prior = deriveMemory([first]).lifeDetails;
    const delta = finalizeDelta({ lifeDetails: { update: [{ id: 'd1', subject }] } } as SummaryDelta, [], prior);
    expect(delta.lifeDetails!.update![0]).not.toHaveProperty('subject');
    expect(deriveMemory([first, message(delta)]).lifeDetails[0].subject).toBe('Eileen');
  });
  it('Đính chính tường minh thành user, xóa tầng/đổi swipe/phát lại cắt ngắn đều khôi phục quyền sở hữu gốc', () => {
    const first = message({ lifeDetails: { add: [detail('Eileen')] } });
    const id = deriveMemory([first]).lifeDetails[0].id;
    const second = message({ lifeDetails: { update: [{ id, subject: 'user' }] } });
    expect(deriveMemory([first, second]).lifeDetails[0].subject).toBe('user');
    expect(deriveMemory([first, second], 1).lifeDetails[0].subject).toBe('Eileen');
    expect(deriveMemory([first]).lifeDetails[0].subject).toBe('Eileen');
    second.swipe_id = 1;
    expect(deriveMemory([first, second]).lifeDetails[0].subject).toBe('Eileen');
  });
});

describe('Sau khi xóa rồi thêm lại không được nhảy nhầm sang nhân vật khác', () => {
  it('Cùng lá khác nhân vật cùng văn bản sẽ không làm sống lại mục đã xóa; đúng nhân vật gốc thêm lại mới khôi phục id gốc', () => {
    const target: StoredDelta = { lifeDetails: { add: [detail('Eileen')], remove: ['detail:leaf#0'] } };
    mergeLifeDetailsOp(target, { add: [detail('user')] }, { leafId: 'leaf' });
    expect(target.lifeDetails!.remove).toEqual(['detail:leaf#0']);
    expect(target.lifeDetails!.add).toHaveLength(2);
    mergeLifeDetailsOp(target, { add: [detail('Eileen')] }, { leafId: 'leaf' });
    expect(target.lifeDetails!.remove).toBeUndefined();
    expect(target.lifeDetails!.add).toHaveLength(2);
    expect(target.lifeDetails!.add![0].subject).toBe('Eileen');
  });
  it('Khôi phục xuyên lá sử dụng quyền sở hữu đã cập nhật, giữ lại stable id và nhân vật', () => {
    const existing = detail('Eileen');
    const target: StoredDelta = { lifeDetails: { update: [{ id: existing.id, subject: 'Tiểu Hạ' }], remove: [existing.id] } };
    mergeLifeDetailsOp(target, { add: [detail('Eileen')] }, { leafId: 'next', existingDetails: [existing] });
    expect(target.lifeDetails!.remove).toEqual([existing.id]);
    mergeLifeDetailsOp(target, { add: [detail('Tiểu Hạ')] }, { leafId: 'next', existingDetails: [existing] });
    expect(target.lifeDetails!.remove).toBeUndefined();
    expect(target.lifeDetails!.update![0]).toMatchObject({ id: existing.id, subject: 'Tiểu Hạ', tier: 'active' });
    expect(target.lifeDetails!.add).toHaveLength(1);
  });
});

describe('Cổng thủ công và đổi tên NPC', () => {
  it('Có thể thêm, đính chính nhân vật, ghim đầu, xóa và thêm lại', () => {
    useChat([message()]);
    expect(addLifeDetail({ subject: 'Eileen', text: 'Uống trà không bỏ đường' })).toBe(true);
    const id = memory.lifeDetails[0].id;
    expect(updateLifeDetail(id, { subject: 'user', tier: 'pinned' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ subject: 'user', tier: 'pinned' });
    expect(removeLifeDetail(id)).toBe(true);
    expect(memory.lifeDetails).toHaveLength(0);
    expect(addLifeDetail({ subject: 'user', text: 'Uống trà không bỏ đường' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ id, subject: 'user', tier: 'active' });
  });
  it('Đổi tên nhân vật đồng bộ quyền sở hữu nhưng không động vào chính văn và nhân vật khác, xóa nhân vật vẫn giữ lại thói quen lịch sử', () => {
    const first = message({ npcs: { add: [{ name: 'Eileen', important: true }] },
      lifeDetails: { add: [detail('Eileen'), detail('user')] } });
    const chat = [first, message()];
    useChat(chat);
    const id = memory.lifeDetails[0].id;
    expect(editNpc('Eileen', { name: 'Ellie' })).toBe(true);
    expect(memory.lifeDetails[0]).toMatchObject({ id, subject: 'Ellie', text: detail().text });
    expect(memory.lifeDetails[1].subject).toBe('user');
    expect(deriveMemory(chat, 1).lifeDetails[0].subject).toBe('Eileen');
    expect(removeNpc('Ellie')).toBe(true);
    expect(memory.npcs).toHaveLength(0);
    expect(memory.lifeDetails[0].subject).toBe('Ellie');
  });
});

const promptArgs: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'Lâm Chu', char: 'Eileen', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [detail(), detail('Eileen')], items: [], itemLog: [], scenes: [], npcs: [{ name: 'Eileen', important: true }],
  openPlans: [], resolvedPlans: [], history: '', content: 'Ăn sáng', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
describe('Mỗi chi tiết đời sống đều có chủ ngữ rõ ràng', () => {
  it('Trang giao diện/tóm tắt dùng chung kết xuất họ tên đầy đủ, bản ghi cũ hiển thị nhân vật chính, không đoán nhân vật từ văn bản', () => {
    expect(lifeDetailSubject(detail())).toBe('user');
    expect(fmtLifeDetail(detail(), 'Lâm Chu')).toBe(`Lâm Chu：${detail().text}`);
    expect(fmtLifeDetail(detail('Eileen'), 'Lâm Chu')).toBe(`Eileen：${detail().text}`);
    expect(fmtLifeDetails(promptArgs.lifeDetails, 'Lâm Chu')).toContain(`d2. [Dài hạn] Eileen：${detail().text}`);
  });
  it.each(['', 'CUSTOM {{content}}', 'CUSTOM {{lifedetails_block}} {{content}}'])('Mẫu mặc định/tùy chỉnh mang giao thức nhân vật và hồ sơ cũ đầy đủ: %s', custom => {
    settings.apiSettings.prompts.summary = custom;
    const prompt = buildSummaryPrompt(promptArgs);
    expect(prompt.system).toContain('Mỗi mục `add` bắt buộc phải kèm theo `subject`');
    expect(prompt.system).toContain('nhân vật chính viết cố định giá trị chuỗi `"user"`');
    expect(prompt.system).toContain('nhân vật chính yếu');
    expect(prompt.system).not.toContain('Chi tiết của NPC không ghi ở đây');
    expect(prompt.user.split(`Lâm Chu：${detail().text}`)).toHaveLength(2);
    expect(prompt.user.split(`Eileen：${detail().text}`)).toHaveLength(2);
    expect(prompt.user).toContain('d2.');
    expect(prompt.user).toContain('★ Eileen');
  });
  it('Chỉ trích xuất sự thật rõ ràng, không suy diễn từ hành vi đơn lẻ, mặc định không ghi và không ghi đè lẫn nhau', () => {
    for (const rule of ['Chủ ngữ không rõ thà không ghi', 'Nghiêm cấm suy diễn sở thích và nội tâm từ hành vi/giọng điệu', 'ăn bánh kếp một lần không đồng nghĩa với thích ăn bánh kếp',
      '【Mặc định không ghi】', 'các nhân vật khác nhau dù câu chữ giống hệt nhau cũng không gộp làm một', 'không được lấy sở thích của người khác để ghi đè lên mục của bản thân nhân vật đó', 'Ước lượng hảo cảm và thái độ không viết ở đây']) {
      expect(RULE_LIFE_DETAILS).toContain(rule);
    }
  });
  it('Tiêm mô hình chính đánh dấu nhân vật từng mục, chịu sự kiểm soát của công tắc hồ sơ đời sống và chế độ chỉ tóm tắt', () => {
    useChat([message({ lifeDetails: { add: [detail(), detail('Eileen')] } })]);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('[Hồ sơ nhỏ đời sống · Theo nhân vật]');
    expect(text).toContain(`Lâm Chu：${detail().text}`);
    expect(text).toContain(`Eileen：${detail().text}`);
    expect(text).toContain('không được trộn lẫn');
    expect(text).toContain('không có nghĩa các nhân vật khác đã biết');
    settings.apiSettings.injection.lifeDetails = false;
    expect(inject.buildStateInjectionText()).not.toContain(detail().text);
    settings.apiSettings.injection.lifeDetails = true;
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
  });
  it('Vẫn chỉ kích hoạt theo từ khóa, chủ đề không liên quan không nhồi hồ sơ đời sống nhân vật vào', () => {
    const details = [detail('user'), detail('Eileen')];
    expect(selectLifeDetailsForInjection(details, 'Trời mưa rồi', '')).toEqual([]);
    expect(selectLifeDetailsForInjection(details, 'Muốn mua bánh kếp', '')).toEqual(details);
    details[1].tier = 'pinned';
    expect(selectLifeDetailsForInjection(details, 'Trời mưa rồi', '')).toEqual([details[1]]);
  });
});

describe('Tóm tắt thực tế và kế thừa xuyên cuộc trò chuyện', () => {
  it('Tóm tắt nhận được bản ghi cũ có chủ ngữ, phân tích quyền sở hữu nhân vật mới của AI và đính chính bản ghi cũ', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [message({ lifeDetails: { add: [detail()] } }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: 'Eileen nói bản thân uống trà không bỏ đường, Lâm Chu đính chính khẩu vị.', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { add: [{ name: 'Eileen', important: true }] },
      lifeDetails: { add: [{ subject: 'Eileen', text: 'Uống trà không bỏ đường', topics: ['Ăn uống'], anchors: ['trà'] }],
        update: [{ id: 'd1', text: 'Bánh kếp có thể không thêm bánh giòn' }] },
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain(`Lâm Chu：${detail().text}`);
    expect(chat[1].extra!.bbs_leaf!.delta.lifeDetails!.add![0].subject).toBe('Eileen');
    expect(memory.lifeDetails.map(d => [d.subject, d.text])).toEqual([
      ['user', 'Bánh kếp có thể không thêm bánh giòn'], ['Eileen', 'Uống trà không bỏ đường'],
    ]);
  });
  it('Kế thừa giữ lại hạt giống và nhân vật cập nhật trong cửa sổ, tầng cấp ổn định, cuộc trò chuyện nguồn không bị ảnh hưởng', async () => {
    settings.apiSettings.keepRecent = 1;
    const first = message({ lifeDetails: { add: [detail('user'), detail('Eileen'), detail('Tiểu Hạ'), detail('A Hòa')] } });
    const ids = deriveMemory([first]).lifeDetails.map(d => d.id);
    const last = message({ lifeDetails: {
      add: [detail('Tiểu Thanh')],
      update: [{ id: ids[1], subject: 'Ellie', text: 'Khẩu vị đã đính chính' }], archive: [ids[2]], remove: [ids[3]],
    } });
    const ownId = `detail:${last.extra!.bbs_leaf!.id}#0`;
    last.extra!.bbs_leaf!.delta.lifeDetails!.update!.push({ id: ownId, text: 'Thích vị chua' });
    const chat = [first, message({ lifeDetails: { update: [{ id: ids[1], tier: 'pinned' }] } }), last];
    const source = useChat(chat);
    const before = JSON.stringify(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'life-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(JSON.stringify(chat)).toBe(before);
    const carried = deriveMemory(target.chat).lifeDetails;
    expect(carried.map(d => [d.subject, d.tier])).toEqual([['user', 'active'], ['Ellie', 'pinned'], ['Tiểu Hạ', 'archive'], ['Tiểu Thanh', 'active']]);
    expect(carried[1].text).toBe('Khẩu vị đã đính chính');
    expect(carried[3]).toMatchObject({ id: ownId, text: 'Thích vị chua' });
    expect(target.chat[0].extra!.bbs_leaf!.delta.lifeDetails!.add!.map(d => d.subject)).toEqual(['user', 'Eileen', 'Tiểu Hạ', 'A Hòa']);
  });
});
