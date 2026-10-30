import { describe, expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { sanitizeCarryMessage } from './carryover';

describe('Tạo cuộc trò chuyện mới mang theo các tầng trong cửa sổ', () => {
  it('Tham chiếu kết thúc/cập nhật/mở lại/xóa đối với kế hoạch cũ trong cửa sổ được đổi sang trỏ tới id mới trên lá hạt giống', () => {
    const m = {
      name: 'Eileen', is_user: false, is_system: true, mes: 'Cốt truyện.',
      extra: { bbs_hidden: true, bbs_leaf: { id: 'w1', text: 'Tóm tắt', createdAt: 1, swipe: 0, v: 1, delta: { plans: {
        resolve: ['plan:old#0', { id: 'plan:old#1', outcome: 'done' }],
        update: [{ id: 'plan:old#2', content: 'Dời lịch' }],
        reopen: ['plan:old#3'],
        remove: ['plan:w0#0'],
      } } } },
    } as unknown as STMessage;
    const planIds = new Map([0, 1, 2, 3].map(i => [`plan:old#${i}`, `plan:seed#${i}`]));
    const out = sanitizeCarryMessage(m, new Map(), planIds);
    expect(out.extra?.bbs_leaf?.delta.plans).toEqual({
      resolve: ['plan:seed#0', { id: 'plan:seed#1', outcome: 'done' }],
      update: [{ id: 'plan:seed#2', content: 'Dời lịch' }],
      reopen: ['plan:seed#3'],
      // ID kế hoạch tự thêm mới trong cửa sổ không nằm trong ánh xạ, giữ nguyên không đổi
      remove: ['plan:w0#0'],
    });
    // Sao chép sâu: lá của cuộc trò chuyện nguồn không bị sửa đổi
    expect(m.extra?.bbs_leaf?.delta.plans?.update?.[0].id).toBe('plan:old#2');
  });
});
