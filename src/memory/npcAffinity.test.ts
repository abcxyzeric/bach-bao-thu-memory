import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { classifyNpcPresence, deriveMemory, editLeafFull, editNpc, finalizeDelta, setNpcFollow, upsertNpc } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { affinityLevelFromInput, applyNpcAffinity, cleanNpcAffinityLevel, fmtNpcAffinity, fmtNpcSummaryList, NPC_AFFINITY_BRIEFING, NPC_AFFINITY_FIELDS } from './npcRelations';
import { buildSummaryPrompt, RULE_NPC_AFFINITY } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type NpcAffinity, type NpcDelta, type StoredDelta, type SummaryDelta } from './types';

const name = 'Eileen';
const initial: NpcDelta = { name, affinityInner: 1, affinityOuter: -1, affinityNote: 'Để tâm,nhưng lấy vẻ lạnh nhạt che giấu', personality: 'Mạnh miệng、bênh người mình' };
const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: 'Character', is_user: false, is_system: false, mes: 'Một đoạn cốt truyện xảy ra rõ ràng.',
  extra: { bbs_leaf: { id: `affinity-${++seq}`, text: 'Tóm tắt cốt truyện', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const base = () => message({ npcs: { add: [{ ...initial }] } });
const patch = (values: Omit<NpcDelta, 'name'>) => message({ npcs: { update: [{ name, ...values }] } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'User', name2: 'Character',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'affinity-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.npcs = true;
  settings.apiSettings.injection.npcAffinity = true;
  settings.apiSettings.injection.scenes = true;
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

describe('Mức định tính và chưa rõ', () => {
  it.each([-2, -1, 0, 1, 2, null] as const)('Giữ lại giá trị hợp lệ %s', value => {
    expect(cleanNpcAffinityLevel(value)).toBe(value);
    const delta = finalizeDelta({ npcs: { add: [{ name, affinityInner: value }] } }, []);
    expect(deriveMemory([message(delta)]).npcs[0].affinityInner).toBe(value);
  });
  it.each([undefined, -3, 3, 50, 0.5, NaN, Infinity, '1', '', true, false, {}, []])('Từ chối giá trị phi pháp %j, không được chuyển thành trung tính hoặc cực trị', value => {
    expect(cleanNpcAffinityLevel(value)).toBeUndefined();
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: value }] } } as unknown as SummaryDelta, []);
    expect(deriveMemory([base(), message(delta)]).npcs[0]).toMatchObject(initial);
  });
  it('Giá trị rỗng của hộp thả xuống là chưa rõ, số không là trung tính; nhân vật cũ không tự dưng sinh bản ghi', () => {
    expect(affinityLevelFromInput('')).toBeNull();
    expect(affinityLevelFromInput('0')).toBe(0);
    expect(affinityLevelFromInput('-2')).toBe(-2);
    expect(fmtNpcAffinity({})).toBe('');
    expect(fmtNpcAffinity({ affinityInner: 0, affinityOuter: null })).toBe('Hảo cảm nội tâm:Không rõ yêu ghét;Thái độ bên ngoài:Chưa rõ');
    expect(deriveMemory([message({ npcs: { add: [{ name }] } })]).npcs[0].affinityInner).toBeUndefined();
  });
  it('Tầng chỉ hiển thị trường thực sự được cung cấp, xóa trống giải thích có thể nhìn thấy', () => {
    expect(fmtNpcAffinity({ affinityInner: 2 }, true)).toBe('Hảo cảm nội tâm:Tình cảm sâu đậm');
    expect(fmtNpcAffinity({ affinityOuter: null }, true)).toBe('Thái độ bên ngoài:Chưa rõ');
    expect(fmtNpcAffinity({ affinityNote: '' }, true)).toBe('Giải thích hảo cảm:Xóa trống');
    expect(fmtNpcAffinity({ affinityNote: 'Ngoài mặt khách sáo\nNội tâm không tin tưởng' }, true)).toBe('Giải thích:Ngoài mặt khách sáo Nội tâm không tin tưởng');
  });
});

describe('Bản vá nhân vật độc lập, ghi đè tuyệt đối, có thể quay lui', () => {
  it.each([
    [{ affinityInner: 2 }, 2, -1],
    [{ affinityOuter: 1 }, 1, 1],
    [{ affinityInner: -2, affinityOuter: 2 }, -2, 2],
    [{ affinityInner: null }, null, -1],
    [{ affinityOuter: 0 }, 1, 0],
    [{ title: 'Chưởng quầy' }, 1, -1],
  ] as const)('Bản vá %j không liên động phía bên kia', (values, inner, outer) => {
    const chat = [base(), patch(values)];
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ affinityInner: inner, affinityOuter: outer, affinityNote: initial.affinityNote });
    expect(deriveMemory(chat)).toEqual(deriveMemory(chat));
  });
  it('Khi không có bản vá hảo cảm, nhiều lượt tương tác thông thường giữ nguyên mức và giải thích, không ngầm cộng dồn', () => {
    const chat = [base(), ...Array.from({ length: 25 }, () => message({}))];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    expect(deriveMemory([...chat, patch({ affinityInner: 1 }), patch({ affinityInner: 1 })]).npcs[0].affinityInner).toBe(1);
  });
  it('add trùng lặp chỉ bù chỗ khuyết, không ghi đè mức và giải thích đã xác lập', () => {
    const chat = [base(), message({ npcs: { add: [{ name, affinityInner: -2, affinityOuter: 2, affinityNote: 'Không được ghi đè' }] } })];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    const target: NpcAffinity = { affinityInner: null, affinityOuter: 0 };
    applyNpcAffinity(target, { affinityInner: 1, affinityOuter: 2 }, true);
    expect(target).toEqual({ affinityInner: 1, affinityOuter: 0 });
  });
  it('Rút về chưa rõ và xóa trống giải thích sau khi lưu qua JSON vẫn có hiệu lực', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: null, affinityNote: '' }] } }, []);
    const npc = deriveMemory([base(), message(JSON.parse(JSON.stringify(delta)))]).npcs[0];
    expect(npc).toMatchObject({ affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('Điểm cắt của bỏ qua, xóa, đổi swipe và tóm tắt lại đều không làm rò rỉ hảo cảm tương lai', () => {
    const changed = patch({ affinityInner: 2, affinityOuter: 2 });
    const chat = [base(), changed];
    expect(deriveMemory(chat, 1).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = true;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = false;
    changed.swipe_id = 1;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    delete changed.extra!.bbs_leaf;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
  });
  it('Thêm mới/hiệu chỉnh/đổi tên nhân vật qua lại giữ nguyên cả hai phía, chỉnh sửa không liên quan không ghi bản vá hảo cảm', () => {
    const chat = [message(), message()];
    useChat(chat);
    expect(upsertNpc(initial)).toBe(true);
    expect(editNpc(name, { title: 'Thân phận mới' })).toBe(true);
    const unrelated = chat[1].extra!.bbs_leaf!.delta.npcs!.update!.at(-1)!;
    expect(unrelated.affinityInner).toBeUndefined();
    expect(unrelated.affinityOuter).toBeUndefined();
    expect(editNpc(name, { name: 'Tên mới' })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ name: 'Tên mới', affinityInner: 1, affinityOuter: -1, affinityNote: initial.affinityNote });
    expect(editNpc('Tên mới', { name, affinityInner: null, affinityNote: '' })).toBe(true);
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ name, affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('Chỉnh sửa tầng có thể xóa trống giải thích mà không biến phía bên kia chưa cung cấp thành chưa rõ', () => {
    const chat = [base(), patch({ affinityInner: 2, affinityNote: 'Căn cứ mới' })];
    useChat(chat);
    const delta: StoredDelta = { npcs: { update: [{ name, affinityInner: 0, affinityNote: '' }] } };
    expect(editLeafFull(1, { text: 'Tóm tắt cốt truyện', timeStart: '', timeEnd: '', delta })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 0, affinityOuter: -1, affinityNote: '' });
  });
});

describe('Đồng bộ rời trường và đối chiếu có mặt', () => {
  const sceneLeaf = () => message({
    location: 'Căn phòng', locationPath: ['Thành', 'Quán trọ', 'Căn phòng'],
    scenes: { add: [{ path: ['Thành'], desc: 'Thành phố' }, { path: ['Thành', 'Quán trọ'], desc: 'Quán trọ' }, { path: ['Thành', 'Quán trọ', 'Căn phòng'], desc: 'Căn phòng' }, { path: ['Thành', 'Quán trọ', 'Nhà bếp'], desc: 'Nhà bếp' }] },
    npcs: { add: [
      { name: 'Đầu bếp', location: 'Nhà bếp' },
      { name: 'Bạn đồng hành', follow: true },
      { name: 'Khách phương xa', location: 'Phương xa' },
    ] },
  });
  const at = (mem: ReturnType<typeof deriveMemory>, n: string) => mem.npcs.find(x => x.name === n)!;

  it('Chuỗi rỗng xóa bỏ địa điểm cũ (không rõ nơi ở), không còn phán đoán có mặt; qua lại JSON giữ nguyên ngữ nghĩa xóa trống', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name: 'Đầu bếp', follow: false, location: '' }] } }, []);
    const chat = [sceneLeaf(), message(JSON.parse(JSON.stringify(delta)))];
    const mem = deriveMemory(chat);
    expect(at(mem, 'Đầu bếp')).toMatchObject({ follow: false });
    expect(at(mem, 'Đầu bếp').location).toBeUndefined();
    expect(classifyNpcPresence(at(mem, 'Đầu bếp'), mem.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('absent');
    // Đối chiếu: khách phương xa chưa xóa trống vẫn phán đoán vắng mặt theo địa điểm, bạn đồng hành luôn có mặt
    expect(classifyNpcPresence(at(mem, 'Khách phương xa'), mem.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('absent');
    expect(classifyNpcPresence(at(mem, 'Bạn đồng hành'), mem.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('present');
    // Nhân vật đi cùng tiện tay viết location rỗng (không viết tường minh follow) không được hủy đi cùng: chuỗi rỗng chỉ xóa địa điểm
    const guard = deriveMemory([sceneLeaf(), message(JSON.parse(JSON.stringify(finalizeDelta({ npcs: { update: [{ name: 'Bạn đồng hành', location: '' }] } }, []))))]);
    expect(at(guard, 'Bạn đồng hành').follow).toBe(true);
    expect(at(guard, 'Bạn đồng hành').location).toBeUndefined();
    expect(classifyNpcPresence(at(guard, 'Bạn đồng hành'), guard.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('present');
    // Muốn rời đội bắt buộc viết tường minh follow:false; lúc này cho dù không kèm location, địa điểm bị xóa khi đi cùng trước đó cũng khiến họ được phán đoán vắng mặt
    const left = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: 'Bạn đồng hành', follow: false, location: '' }] } })]);
    expect(classifyNpcPresence(at(left, 'Bạn đồng hành'), left.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('absent');
    const leftNoLoc = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: 'Bạn đồng hành', follow: false }] } })]);
    expect(classifyNpcPresence(at(leftNoLoc, 'Bạn đồng hành'), leftNoLoc.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('absent');
    // Khi trong cùng một bản vá xuất hiện rõ ràng cả follow:true lẫn location rỗng, đi cùng được ưu tiên (không bị chuỗi rỗng hủy ngược lại)
    const keep = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: 'Đầu bếp', follow: true, location: '' }] } })]);
    expect(classifyNpcPresence(at(keep, 'Đầu bếp'), keep.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('present');
  });
  it('Lược bỏ location giữ nguyên giá trị cũ, không được coi việc chưa cung cấp là xóa trống', () => {
    const chat = [sceneLeaf(), message({ npcs: { update: [{ name: 'Đầu bếp', follow: false }] } })];
    expect(at(deriveMemory(chat), 'Đầu bếp').location).toBe('Nhà bếp');
  });
  it('Chỉnh sửa thủ công giá trị rỗng ở cuối = không rõ nơi ở; đổi tên kế thừa nơi ở; hủy đi cùng không xóa nhầm vị trí', () => {
    const chat = [message(), message()];
    useChat(chat);
    expect(upsertNpc({ name, location: 'Quán trọ' })).toBe(true);
    expect(memory.npcs[0].location).toBe('Quán trọ');
    expect(editNpc(name, { location: '' })).toBe(true);
    expect(memory.npcs[0].location).toBeUndefined();
    expect(editNpc(name, { location: 'Nhà bếp' })).toBe(true);
    expect(editNpc(name, { name: 'Tên mới' })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ name: 'Tên mới', location: 'Nhà bếp' });
    expect(setNpcFollow('Tên mới', false)).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ follow: false, location: 'Nhà bếp' });
    expect(editNpc('Tên mới', { location: '' })).toBe(true);
    expect(memory.npcs[0].location).toBeUndefined();
  });
  it('Danh sách tóm tắt gắn nhãn có mặt theo trạng thái trước tầng này, rời trường chưa rõ hướng đi gắn nhãn không rõ nơi ở', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [sceneLeaf(), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: 'Đầu bếp rời khỏi phòng nhưng không nói đi đâu.', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { update: [{ name: 'Đầu bếp', follow: false, location: '' }] },
    }));
    await summarizeFloor(1);
    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(material).toContain('Đầu bếp〔Cùng khu vực〕'); // Đầu bếp ở nhà bếp: so với nút hiện tại của nhân vật chính (Căn phòng) là cùng khu vực
    expect(material).toContain('Bạn đồng hành〔Có mặt〕 [Đi cùng]');
    expect(material).toContain('Khách phương xa〔Vắng mặt〕');
    expect(memory.npcs.find(n => n.name === 'Đầu bếp')?.location).toBeUndefined();
    expect(classifyNpcPresence(memory.npcs.find(n => n.name === 'Đầu bếp')!, memory.scenes, 'Căn phòng', ['Thành', 'Quán trọ', 'Căn phòng'])).toBe('absent');
  });
});

describe('Kết xuất nhãn có mặt trong danh sách', () => {
  it('Khi có presence thì kết xuất nhãn; mặc định giữ định dạng cũ, không đưa vào không rõ nơi ở', () => {
    const npc = { ...initial };
    expect(fmtNpcSummaryList([{ ...npc, presence: 'present', follow: true }])).toContain('〔Có mặt〕 [Đi cùng]');
    expect(fmtNpcSummaryList([{ ...npc, presence: 'nearby', location: 'Nhà bếp' }])).toContain('〔Cùng khu vực〕 [Ở:Nhà bếp]');
    expect(fmtNpcSummaryList([{ ...npc, presence: 'absent' }])).toContain('〔Vắng mặt〕 [Không rõ nơi ở]');
    for (const mark of ['〔Có mặt〕', '〔Cùng khu vực〕', '〔Vắng mặt〕', 'Không rõ nơi ở']) {
      expect(fmtNpcSummaryList([npc])).not.toContain(mark);
    }
  });
});

const promptArgs: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User', char: 'Character', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [initial], openPlans: [], resolvedPlans: [],
  history: 'Sự thật trước đó', content: 'Lần này chỉ là trò chuyện bình thường', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
describe('Ranh giới từ nhắc của tóm tắt và đối thoại chính', () => {
  it.each(['', 'CUSTOM {{content}}', 'CUSTOM {{npcs_block}} {{content}}'])('Mẫu tóm tắt mặc định và tùy chỉnh đều có giao thức và mốc cơ sở trước đó: %s', custom => {
    settings.apiSettings.prompts.summary = custom;
    const prompt = buildSummaryPrompt(promptArgs);
    expect(prompt.system).toContain('【Quy tắc hảo cảm nội tâm và thái độ bên ngoài】');
    expect(prompt.system).not.toContain(initial.affinityNote);
    expect(prompt.user).toContain(fmtNpcSummaryList([initial]));
    expect(prompt.user.split('Ước lượng hảo cảm và thái độ với nhân vật chính[')).toHaveLength(2);
    expect(prompt.user).toContain('Tính cách:Mạnh miệng、bênh người mình');
  });
  it('Nêu rõ mặc định ổn định, trong ngoài độc lập, giải thích ổn định và ước lượng không được trở thành sự thật', () => {
    for (const contract of ['【Mặc định giữ nguyên, vượt bậc mới cập nhật】', '【Trong và ngoài hoàn toàn độc lập】', '【Giải thích cũng phải ổn định】', 'không phải mỗi lượt đều chấm điểm lại',
      'cả hai phía và lời giải thích đều lược bỏ', 'nghiêm cấm dùng lượng tăng giảm', 'nghiêm cấm mỗi lượt lại nâng cấp từ ngữ tu từ', 'đừng mặc định điền 0', 'không được chép nó vào `summary`/`relation`/`ties`/`personality`']) {
      expect(RULE_NPC_AFFINITY).toContain(contract);
    }
    // Ước lượng là tổng kết quá khứ, không phải giới hạn trần: ngăn mô hình chính coi bậc cũ là lệnh cấm làm đóng băng sự phát triển quan hệ
    expect(NPC_AFFINITY_BRIEFING).toContain('không phải giới hạn trần hay lệnh cấm đối với lượt này');
  });
  it('Chữ bậc trong quy tắc khớp với bậc trên giao diện', () => {
    // Quy tắc hảo cảm cắt từ summary.txt, dòng bậc viết cố định trong tệp; sửa NPC_AFFINITY_LABELS phải đồng bộ ở đó
    for (const f of NPC_AFFINITY_FIELDS) {
      const levels = f.options.filter(o => o.value !== '').map(o => `${o.value}=${o.label}`).join(';');
      expect(RULE_NPC_AFFINITY).toContain(`${f.label}(${f.key}):${levels}`);
    }
  });
  it('Bốn mức trạng thái có mặt đều tiêm hảo cảm độc lập, nơi xa lược bỏ giải thích và giữ vững góc nhìn nhân vật', () => {
    const chat = [message({
      location: 'Căn phòng', locationPath: ['Thành', 'Quán trọ', 'Căn phòng'],
      scenes: { add: [{ path: ['Thành'], desc: 'Thành phố' }, { path: ['Thành', 'Quán trọ'], desc: 'Quán trọ' },
        { path: ['Thành', 'Quán trọ', 'Căn phòng'], desc: 'Căn phòng' }, { path: ['Thành', 'Quán trọ', 'Nhà bếp'], desc: 'Nhà bếp' }] },
      npcs: { add: [
        { ...initial, important: true },
        { name: 'Bạn đồng hành', affinityInner: null, affinityOuter: 1, follow: true },
        { name: 'Đầu bếp', affinityInner: -1, affinityOuter: 1, affinityNote: 'Giữ lễ phép', location: 'Nhà bếp' },
        { name: 'Khách phương xa', affinityInner: -2, affinityOuter: 2, affinityNote: 'Giải thích nơi xa không được tiêm', location: 'Phương xa' },
      ] },
    })];
    useChat(chat);
    const text = inject.buildStateInjectionText();
    expect(text.split(NPC_AFFINITY_BRIEFING)).toHaveLength(2);
    expect(text).toContain('Hảo cảm nội tâm:Chưa rõ;Thái độ bên ngoài:Thân thiện gần gũi');
    expect(text).toContain('Hảo cảm nội tâm:Không thích;Thái độ bên ngoài:Thân thiện gần gũi;Giải thích:Giữ lễ phép');
    expect(text).toContain('Hảo cảm nội tâm:Phản cảm mãnh liệt;Thái độ bên ngoài:Gần gũi rõ rệt, thể hiện tích cực');
    expect(text).not.toContain('Giải thích nơi xa không được tiêm');
    expect(text).toContain('không đại diện cho việc nhân vật chính hay nhân vật khác biết chuyện');
  });
  it('Sau khi tắt「Ước lượng hảo cảm nhân vật」thì danh sách vẫn gửi như thường, hảo cảm không tiêm; tài liệu tóm tắt vẫn giữ lại hảo cảm', () => {
    useChat([base()]);
    expect(inject.buildStateInjectionText()).toContain('Ước lượng hảo cảm');
    settings.apiSettings.injection.npcAffinity = false;
    const text = inject.buildStateInjectionText();
    expect(text).toContain('Danh sách NPC');
    expect(text).toContain(name);
    expect(text).not.toContain('hảo cảm');
    expect(text).not.toContain('ước lượng định tính 5 mức');
    // Danh sách tóm tắt của API phụ không bị công tắc này ảnh hưởng: việc ghi chép luôn diễn ra bình thường
    expect(buildSummaryPrompt(promptArgs).user).toContain('Ước lượng hảo cảm và thái độ với nhân vật chính[');
    settings.apiSettings.injection.npcAffinity = true;
    expect(inject.buildStateInjectionText()).toContain('Ước lượng hảo cảm');
  });
  it('Nhân vật cũ không có bản ghi hảo cảm thì không tiêm thêm gì, tắt tiêm/chế độ chỉ tóm tắt vẫn có hiệu lực', () => {
    useChat([message({ npcs: { add: [{ name }] } })]);
    expect(inject.buildStateInjectionText()).not.toContain('Hảo cảm');
    useChat([base()]);
    settings.apiSettings.injection.npcs = false;
    expect(inject.buildStateInjectionText()).not.toContain('Hảo cảm nội tâm');
    settings.apiSettings.injection.npcs = true;
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
  });
});

describe('Cổng tóm tắt thực tế và kế thừa xuyên cuộc trò chuyện', () => {
  it('Tóm tắt dùng mốc cơ sở cũ, phân tích cập nhật một phía của AI, lượt tiếp theo không đổi thì giữ nguyên', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [base(), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: 'Lúc nguy cấp cô chọn cứu giúp, nhưng vẫn mạnh miệng.', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { update: [{ name, affinityInner: 2, affinityNote: 'Cứu giúp thể hiện sự để tâm sâu sắc hơn, bên ngoài vẫn lạnh nhạt' }] },
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('Hảo cảm nội tâm:Có thiện cảm;Thái độ bên ngoài:Lạnh nhạt xa cách');
    expect(request).toContain('Tính cách:Mạnh miệng、bênh người mình');
    expect(chat[1].extra!.bbs_leaf!.delta.npcs!.update![0].affinityOuter).toBeUndefined();
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1 });
    const third = message(); delete third.extra!.bbs_leaf; chat.push(third);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: 'Cùng uống trà.', timeStart: '2026/9/13 10:05', timeEnd: '2026/9/13 10:10' }));
    await summarizeFloor(2);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1, affinityNote: 'Cứu giúp thể hiện sự để tâm sâu sắc hơn, bên ngoài vẫn lạnh nhạt' });
  });
  it('Tạo cuộc trò chuyện mới mang theo dữ liệu giữ nguyên chưa rõ/trung tính trước cửa sổ và cập nhật một phía trong cửa sổ, không sửa cuộc trò chuyện nguồn', async () => {
    settings.apiSettings.keepRecent = 1;
    const chat = [message({ npcs: { add: [{ name, affinityInner: null, affinityOuter: 0, affinityNote: 'Chưa rõ nội tâm' }] } }), patch({ affinityOuter: 1 })];
    const source = useChat(chat);
    const before = JSON.stringify(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'affinity-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => {
      vi.mocked(context.getContext).mockReturnValue(target);
    });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(JSON.stringify(chat)).toBe(before);
    expect(target.chat[0].extra!.bbs_leaf!.delta.npcs!.add![0]).toMatchObject({ name, affinityInner: null, affinityOuter: 0, affinityNote: 'Chưa rõ nội tâm' });
    expect(deriveMemory(target.chat).npcs[0]).toMatchObject({ affinityInner: null, affinityOuter: 1, affinityNote: 'Chưa rõ nội tâm' });
  });
});
