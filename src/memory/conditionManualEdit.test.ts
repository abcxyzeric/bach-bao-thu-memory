import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, editNpc, editPlan, editSceneDesc, finalizeDelta, getLeaf, reparentScene, setProtagonist } from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: 'Eileen', is_user: false, is_system: false, mes: 'Một đoạn cốt truyện.',
  extra: { bbs_leaf: { id: `manual-${++seq}`, text: 'Tóm tắt', delta, createdAt: seq, swipe: 0, v: 1 } },
});
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'Lâm Chu', name2: 'Eileen',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'manual-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const originalVector = settings.apiSettings.vector.enabled;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.vector.enabled = originalVector;
});

describe('Khi ghi đè thủ công trạng thái nhân vật chính thì conditionPatch cũ bắt buộc phải phế bỏ', () => {
  // Khi cùng một đối tượng đưa đồng thời cả condition lẫn bản vá thì tầng làm sạch đã lấy toàn văn làm chuẩn, nên bản vá đặt ở tầng sau (hình thái của bản lưu cũ)
  it('Lá AI mang bản vá, sau khi sửa thủ công thì lấy giá trị thủ công làm chuẩn', () => {
    const ctx = useChat([
      message({ protagonist: { condition: 'Cánh tay bị thương, cố định bằng nẹp；tự thuật còn cần nghỉ dưỡng ba ngày' } }),
      message({ protagonist: { conditionPatch: { add: [{ text: 'Mới bong gân cổ chân' }] } } }),
    ]);
    expect(memory.protagonist.condition).toBe('Cánh tay bị thương, cố định bằng nẹp；tự thuật còn cần nghỉ dưỡng ba ngày；Mới bong gân cổ chân');
    expect(setProtagonist({ condition: 'Cánh tay bị thương, đã hồi phục' })).toBe(true);
    expect(memory.protagonist.condition).toBe('Cánh tay bị thương, đã hồi phục');
    // Phát lại (chứ không chỉ trong bộ nhớ) cũng không được cộng bản vá cũ quay lại
    expect(deriveMemory(ctx.chat).protagonist.condition).toBe('Cánh tay bị thương, đã hồi phục');
  });

  it('Khi xóa trống trạng thái thì bản vá không được làm sống lại mảnh cũ', () => {
    useChat([
      message({ protagonist: { condition: 'Cánh tay bị thương；Cần nghỉ dưỡng' } }),
      message({ protagonist: { conditionPatch: { add: [{ text: 'Mới bong gân cổ chân' }] } } }),
    ]);
    expect(setProtagonist({ condition: '' })).toBe(true);
    expect(memory.protagonist.condition).toBeUndefined();
  });
});

describe('Tầng tức thời của NPC hỗ trợ xóa trống thủ công', () => {
  it('Xóa trống condition / outfit có hiệu lực', () => {
    useChat([message({ npcs: { add: [{ name: 'Eileen', condition: 'Vai trái trúng tên；Không thể giương cung', outfit: 'Áo choàng nhuốm máu' }] } })]);
    expect(memory.npcs[0].condition).toBe('Vai trái trúng tên；Không thể giương cung');
    expect(editNpc('Eileen', { condition: '', outfit: '' })).toBe(true);
    expect(memory.npcs[0].condition).toBeUndefined();
    expect(memory.npcs[0].outfit).toBeUndefined();
  });
});

describe('Tầng hồ sơ NPC chuỗi rỗng = xóa', () => {
  const ARCHIVE = { gender: 'Nữ', age: '19', relation: 'Sư tỷ của Lâm Chu', ties: 'Là người quen cũ với chủ quán', title: 'Chưởng quầy quán trọ', desc: 'Tóc bạc dài ngang eo', personality: 'Hay tỏ ra mạnh mẽ' };

  it('AI dùng chuỗi rỗng xóa bỏ ngoại hình/quan hệ/thân phận điền sai; giới tính không hướng dẫn xóa khi đưa chuỗi rỗng chỉ coi là giữ chỗ', () => {
    const clear = finalizeDelta({ npcs: { update: [{ name: 'Eileen', desc: '', relation: '', title: '', gender: '' }] } }, []);
    const npc = deriveMemory([
      message({ npcs: { add: [{ name: 'Eileen', ...ARCHIVE }] } }),
      message(JSON.parse(JSON.stringify(clear))),
    ]).npcs[0];
    expect(npc.desc).toBeUndefined();
    expect(npc.relation).toBeUndefined();
    expect(npc.title).toBeUndefined();
    expect(npc.gender).toBe('Nữ');
  });

  it('Xóa trống thủ công toàn bộ trường hồ sơ (kể cả tuổi) có hiệu lực, phát lại cũng có hiệu lực tương tự', () => {
    const ctx = useChat([message({ npcs: { add: [{ name: 'Eileen', ...ARCHIVE }] } })]);
    expect(editNpc('Eileen', { gender: '', age: '', relation: '', ties: '', title: '', desc: '', personality: '' })).toBe(true);
    for (const npc of [memory.npcs[0], deriveMemory(ctx.chat).npcs[0]]) {
      for (const key of ['gender', 'age', 'ageTime', 'relation', 'ties', 'title', 'desc', 'personality'] as const) {
        expect(npc[key]).toBeUndefined();
      }
    }
  });
});

describe('Mô tả địa điểm có thể xóa trống thủ công', () => {
  it('Xóa trống chỉ xóa mô tả, giữ nguyên nút; khi đổi cấp trên xóa trống cũng có hiệu lực tương tự', () => {
    const ctx = useChat([message({ scenes: { ops: [
      { op: 'add', path: ['Vương đô'], desc: 'Thủ đô vương quốc' },
      { op: 'add', path: ['Vương đô', 'Quán rượu'], desc: 'Quán rượu nhỏ ồn ào' },
      { op: 'add', path: ['Bến cảng'], desc: 'Bến tàu ven biển' },
    ] } })]);
    expect(editSceneDesc(['Vương đô'], '')).toBe(true);
    // Khi đổi cấp trên xóa trống: xóa và reparent ghi cùng một đợt, không bị chuyển cây mà chưa xóa được
    expect(reparentScene(['Vương đô', 'Quán rượu'], ['Bến cảng', 'Quán rượu'], { 'Quán rượu': '' })).toBe(true);
    expect(getLeaf(ctx.chat[0])!.delta.scenes!.ops!.slice(-2).map(o => o.op)).toEqual(['reparent', 'update']);
    for (const scenes of [memory.scenes, deriveMemory(ctx.chat).scenes]) {
      const capital = scenes.find(s => s.name === 'Vương đô');
      const tavern = scenes.find(s => s.name === 'Quán rượu');
      expect(capital).toBeDefined();
      expect(capital?.desc).toBeUndefined();
      expect(tavern?.path).toEqual(['Bến cảng', 'Quán rượu']);
      expect(tavern?.desc).toBeUndefined();
    }
  });
});

describe('Chỉnh sửa kế hoạch thủ công không bị AI update ở các tầng sau ghi đè mất', () => {
  it('Sau khi sửa nội dung/thời hạn, cả bộ nhớ lẫn phát lại đều lấy giá trị thủ công làm chuẩn; hai lần sửa liên tiếp không triệt tiêu lẫn nhau', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: 'Ba ngày sau quyết đấu', targetTime: '1988/10/1' }] } });
    const pid = `plan:${getLeaf(first)!.id}#0`;
    const ctx = useChat([first, message({ plans: { update: [{ id: pid, content: 'Năm ngày sau quyết đấu', targetTime: '1988/10/3' }] } })]);
    expect(memory.plans[0].content).toBe('Năm ngày sau quyết đấu');

    expect(editPlan(pid, { content: 'Bảy ngày sau quyết đấu', targetTime: '1988/10/7' })).toBe(true);
    expect(memory.plans[0].content).toBe('Bảy ngày sau quyết đấu');
    expect(memory.plans[0].targetTime).toBe('1988/10/7');

    expect(editPlan(pid, { content: 'Bảy ngày sau quyết đấu', targetTime: '1988/10/8' })).toBe(true);
    const replayed = deriveMemory(ctx.chat).plans[0];
    expect(replayed.content).toBe('Bảy ngày sau quyết đấu');
    expect(replayed.targetTime).toBe('1988/10/8');
  });

  it('Khi không có update phía sau thì chỉ sửa tại chỗ, không nối thêm update vào lá mới nhất', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: 'Ba ngày sau quyết đấu' }] } });
    const ctx = useChat([first]);
    expect(editPlan(`plan:${getLeaf(first)!.id}#0`, { content: 'Năm ngày sau quyết đấu', targetTime: '' })).toBe(true);
    expect(memory.plans[0].content).toBe('Năm ngày sau quyết đấu');
    expect(getLeaf(ctx.chat[0])!.delta.plans?.update).toBeUndefined();
  });
});
