import { describe, expect, it } from 'vitest';
import { applyConditionPatch, splitConditionFragments, stripConditionFragmentIds } from './conditionPatch';
import { deriveMemory, finalizeDelta } from './apply';
import type { STMessage } from '@/st/context';
import type { StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: 'Eileen', is_user: false, is_system: false, mes: 'Một đoạn cốt truyện xảy ra rõ ràng.',
  extra: { bbs_leaf: { id: `cond-${++seq}`, text: 'Tóm tắt cốt truyện', delta, createdAt: seq, swipe: 0, v: 1 } },
});

describe('conditionPatch cắt mảnh tình trạng', () => {
  it('Cắt theo chấm phẩy/dấu chấm/xuống dòng, dấu phẩy không cắt', () => {
    expect(splitConditionFragments('Cánh tay bị thương, cố định bằng nẹp, tạm không xách được vật nặng；tự thuật còn cần nghỉ dưỡng vài ngày。Đầu gối trái trầy xước'))
      .toEqual(['Cánh tay bị thương, cố định bằng nẹp, tạm không xách được vật nặng', 'tự thuật còn cần nghỉ dưỡng vài ngày', 'Đầu gối trái trầy xước']);
  });

  it('Tiền tố [cN] chép từ bản lưu cũ vào không tính là nội dung, nhiều tầng cũng bóc sạch', () => {
    expect(splitConditionFragments('[c1] [c1] Cánh tay bị thương；【c2】Cần nghỉ dưỡng')).toEqual(['Cánh tay bị thương', 'Cần nghỉ dưỡng']);
    expect(stripConditionFragmentIds('[c1] Cánh tay bị thương；[c2] [c2] Cần nghỉ dưỡng')).toBe('Cánh tay bị thương；Cần nghỉ dưỡng');
    // Ngoặc vuông thông thường trong chính văn giữ nguyên
    expect(stripConditionFragmentIds('Cánh tay bị thương[nhẹ]；Cần nghỉ dưỡng')).toBe('Cánh tay bị thương[nhẹ]；Cần nghỉ dưỡng');
  });
});

describe('applyConditionPatch', () => {
  it('replace chỉ sửa mã số chỉ định, mảnh cũ không liệt kê được giữ nguyên', () => {
    const next = applyConditionPatch('Cánh tay bị thương, cố định bằng nẹp；tự thuật còn cần nghỉ dưỡng vài ngày；Đầu gối trái trầy xước', {
      replace: [{ id: 'c2', text: 'Nghỉ dưỡng kết thúc, có thể hoạt động bình thường' }],
    });
    expect(next).toBe('Cánh tay bị thương, cố định bằng nẹp；Nghỉ dưỡng kết thúc, có thể hoạt động bình thường；Đầu gối trái trầy xước');
  });

  it('replace chuỗi rỗng xóa mảnh đó, add nối thêm vào cuối', () => {
    const next = applyConditionPatch('Cánh tay bị thương；Đầu gối trái trầy xước', {
      replace: [{ id: 'c1', text: '' }],
      add: [{ text: 'Mới bong gân cổ chân' }],
    });
    expect(next).toBe('Đầu gối trái trầy xước；Mới bong gân cổ chân');
  });

  it('Sau khi xóa sạch toàn bộ mảnh thì trả về undefined', () => {
    expect(applyConditionPatch('Cánh tay bị thương', { replace: [{ id: 'c1', text: '' }] })).toBeUndefined();
  });

  it('Cùng một bản vá xóa hai đoạn: mã số tính theo trước khi áp dụng, không bị lệch vị trí vì mục trước bị xóa', () => {
    const next = applyConditionPatch('Cánh tay bị thương, cố định bằng nẹp；Cần nghỉ dưỡng ba ngày；Đầu gối trái trầy xước', {
      replace: [{ id: 'c1', text: '' }, { id: 'c3', text: '' }],
    });
    expect(next).toBe('Cần nghỉ dưỡng ba ngày');
  });

  it('Xóa một đoạn + sửa một đoạn: sửa đúng c2 gốc, c3 giữ nguyên', () => {
    const next = applyConditionPatch('Cánh tay bị thương, cố định bằng nẹp；Cần nghỉ dưỡng ba ngày；Đầu gối trái trầy xước', {
      replace: [{ id: 'c1', text: '' }, { id: 'c2', text: 'Nghỉ dưỡng kết thúc, có thể xách vật nhẹ' }],
    });
    expect(next).toBe('Nghỉ dưỡng kết thúc, có thể xách vật nhẹ；Đầu gối trái trầy xước');
  });

  it('Mã số vượt quá giới hạn không ảnh hưởng các mảnh khác', () => {
    expect(applyConditionPatch('Cánh tay bị thương；Cần nghỉ dưỡng ba ngày', { replace: [{ id: 'c9', text: '' }] })).toBe('Cánh tay bị thương；Cần nghỉ dưỡng ba ngày');
  });

  it('text có dấu chấm tách theo mảnh, trùng lặp hoàn toàn không gắn thêm lần hai', () => {
    const next = applyConditionPatch('Cánh tay bị thương；Cần nghỉ dưỡng', { add: [{ text: 'Cần nghỉ dưỡng' }, { text: 'Đầu gối trái trầy xước。Chỉ để lại sẹo' }] });
    expect(next).toBe('Cánh tay bị thương；Cần nghỉ dưỡng；Đầu gối trái trầy xước；Chỉ để lại sẹo');
  });
});

describe('Đầu ra mới đổi lại thành ghi đè toàn văn', () => {
  it('Mô hình có đưa thêm conditionPatch cũng không nhận, không lưu nguyên si vào kho', () => {
    expect(finalizeDelta({ protagonist: { conditionPatch: { add: [{ text: 'Mới bong gân cổ chân' }] } } } as never, []).protagonist).toBeUndefined();
    const out = finalizeDelta({ npcs: { update: [{ name: 'Eileen', conditionPatch: { replace: [{ id: 'c1', text: '' }] } }] } } as never, []);
    expect(out.npcs?.update?.[0]?.conditionPatch).toBeUndefined();
  });

  it('condition đưa toàn văn tức là ghi đè cả đoạn', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: 'Cánh tay bị thương；Cần nghỉ dưỡng ba ngày' } }),
      message(finalizeDelta({ protagonist: { condition: 'Cánh tay bị thương；Bong gân cổ chân' } } as never, [])),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('Cánh tay bị thương；Bong gân cổ chân');
  });
});

describe('conditionPatch của bản lưu cũ vẫn phát lại bình thường', () => {
  it('Khi nhân vật chính đã có thương tích thì cập nhật cục bộ theo mã số, không ghi đè cả đoạn', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: 'Cánh tay bị thương, cố định bằng nẹp；tự thuật còn cần nghỉ dưỡng vài ngày' } }),
      message({ protagonist: { conditionPatch: { replace: [{ id: 'c2', text: 'Nghỉ dưỡng kết thúc, có thể hoạt động bình thường' }] } } }),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('Cánh tay bị thương, cố định bằng nẹp；Nghỉ dưỡng kết thúc, có thể hoạt động bình thường');
  });

  it('Khi NPC đã có thương tích thì cập nhật cục bộ, đồng thời giữ lại hạn chế của nhân vật khác', () => {
    const chat: STMessage[] = [
      message({ npcs: { add: [{ name: 'Eileen', condition: 'Vai trái trúng tên；Không thể giương cung' }] } }),
      message({ npcs: { update: [{ name: 'Eileen', conditionPatch: { replace: [{ id: 'c2', text: 'Đã có thể giương cung nhẹ' }] } }] } }),
    ];
    const npc = deriveMemory(chat).npcs.find(n => n.name === 'Eileen');
    expect(npc?.condition).toBe('Vai trái trúng tên；Đã có thể giương cung nhẹ');
  });

  it('Lá đưa đồng thời cả toàn văn lẫn bản vá, lấy toàn văn làm chuẩn', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: 'Cánh tay bị thương；Cần nghỉ dưỡng ba ngày；Đầu gối trái trầy xước' } }),
      message({ protagonist: { condition: 'Cánh tay đã bình phục；Bong gân cổ chân', conditionPatch: { replace: [{ id: 'c2', text: 'Nghỉ dưỡng kết thúc' }] } } }),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('Cánh tay đã bình phục；Bong gân cổ chân');
  });

  it('Mã số bị chép lẫn vào condition, khi phát lại sẽ bóc bỏ', () => {
    const chat: STMessage[] = [message({ npcs: { add: [{ name: 'Eileen', condition: '[c1] Vai trái trúng tên；[c2] Không thể giương cung' }] } })];
    expect(deriveMemory(chat).npcs[0].condition).toBe('Vai trái trúng tên；Không thể giương cung');
  });
});

describe('Định vị NPC không còn yêu cầu locationEvidence', () => {
  const npcLoc = (extra: Record<string, unknown> = {}) =>
    ({ npcs: { update: [{ name: 'Eileen', location: 'Tháp chuông', ...extra }] } } as never);

  it('Định vị không kèm bằng chứng vẫn nhận bình thường', () => {
    const out = finalizeDelta(npcLoc(), []);
    expect(out.npcs?.update?.[0].location).toBe('Tháp chuông');
  });

  it('locationEvidence đưa thừa theo thói quen cũ không lưu vào kho', () => {
    const out = finalizeDelta(npcLoc({ locationEvidence: 'Cô bước vào tháp chuông' }), []);
    expect(out.npcs?.update?.[0].location).toBe('Tháp chuông');
    expect(out.npcs?.update?.[0]).not.toHaveProperty('locationEvidence');
  });

  it('location rỗng (không rõ hướng đi) → xóa', () => {
    const out = finalizeDelta({ npcs: { update: [{ name: 'Eileen', location: '' }] } } as never, []);
    expect(out.npcs?.update?.[0].location).toBe('');
  });
});

describe('scenes tạo điểm rộng, mô tả nghiêm', () => {
  it('add không kèm desc vẫn tạo nút, cấp trung gian tự động tạo bù', () => {
    const out = finalizeDelta({ scenes: { add: [{ path: ['Vương đô', 'Khu thành Tây', 'Quán trọ Quy Nhạn'] }] } } as never, []);
    expect(out.scenes?.add).toEqual([{ path: ['Vương đô', 'Khu thành Tây', 'Quán trọ Quy Nhạn'] }]);
    const scenes = deriveMemory([message(out)]).scenes;
    expect(scenes.map(s => s.path.join('/')).sort()).toEqual(['Vương đô', 'Vương đô/Khu thành Tây', 'Vương đô/Khu thành Tây/Quán trọ Quy Nhạn']);
    expect(scenes.every(s => !s.desc)).toBe(true);
  });

  it('update đưa chuỗi rỗng → xóa mô tả điền sai, giữ lại nút', () => {
    const chat: STMessage[] = [
      message({ scenes: { add: [{ path: ['Bến tàu'], desc: 'Hôm nay trời mưa, rất đông người' }] } }),
      message(finalizeDelta({ scenes: { update: [{ path: ['Bến tàu'], desc: '' }] } } as never, [])),
    ];
    const scenes = deriveMemory(chat).scenes;
    expect(scenes).toHaveLength(1);
    expect(scenes[0].desc).toBeUndefined();
  });

  it('add không ghi đè mô tả đã có, update mới ghi đè', () => {
    const chat: STMessage[] = [
      message({ scenes: { add: [{ path: ['Bến tàu'], desc: 'Bến tàu chở hàng phía tây thành' }] } }),
      message({ scenes: { add: [{ path: ['Bến tàu'] }, { path: ['Bến tàu'], desc: 'Một cách nói khác' }] } }),
    ];
    expect(deriveMemory(chat).scenes[0].desc).toBe('Bến tàu chở hàng phía tây thành');
    chat.push(message({ scenes: { update: [{ path: ['Bến tàu'], desc: 'Bến tàu chở hàng phía tây thành, sau bị thiêu hủy' }] } }));
    expect(deriveMemory(chat).scenes[0].desc).toBe('Bến tàu chở hàng phía tây thành, sau bị thiêu hủy');
  });

  it('update không kèm desc → không có việc gì để làm, hủy bỏ', () => {
    const out = finalizeDelta({ scenes: { update: [{ path: ['Bến tàu'] }] } } as never, []);
    expect(out.scenes).toBeUndefined();
  });

  it('update chuỗi rỗng lên địa điểm không tồn tại → không tự dưng tạo điểm', () => {
    expect(deriveMemory([message({ scenes: { update: [{ path: ['Bến tàu'], desc: '' }] } })]).scenes).toHaveLength(0);
  });
});

describe('plans.update', () => {
  it('finalizeDelta dịch số thứ tự ngắn thành id ổn định', () => {
    const out = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/5' }] } } as never,
      [{ id: 'plan:leaf#0' }],
    );
    expect(out.plans?.update).toEqual([{ id: 'plan:leaf#0', targetTime: '1988/10/5' }]);
  });

  it('locationPath: [] tường minh xóa mốc neo cũ, không kế thừa trực thuộc cũ', () => {
    const out = finalizeDelta({ location: 'in transit', locationPath: [] } as never, []);
    expect(out.locationPath).toEqual([]);
  });

  it('Khi không có location thì locationPath rỗng đứng riêng không xóa mốc neo, đường dẫn hợp lệ vẫn lưu bình thường', () => {
    for (const locationPath of [[], null, '']) {
      expect(finalizeDelta({ locationPath } as never, []).locationPath).toBeUndefined();
    }
    expect(finalizeDelta({ locationPath: ['Vương thành', 'Tháp chuông'] } as never, []).locationPath).toEqual(['Vương thành', 'Tháp chuông']);
    const anchored = message({ location: 'Tháp chuông', locationPath: ['Vương thành', 'Tháp chuông'] });
    const derived = deriveMemory([anchored, message(finalizeDelta({ locationPath: [] } as never, []))]);
    expect(derived.state.locationPath).toEqual(['Vương thành', 'Tháp chuông']);
  });

  it('Sau khi dời lịch thì ghi đè targetTime, giữ nguyên content cũ', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: 'Ba ngày sau quyết đấu', targetTime: '1988/10/1' }] } });
    const opened = deriveMemory([first]).plans;
    const finalized = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/9' }] } } as never,
      opened,
    );
    const derived = deriveMemory([first, message(finalized)]);
    expect(derived.plans[0].targetTime).toBe('1988/10/9');
    expect(derived.plans[0].content).toBe('Ba ngày sau quyết đấu');
  });
});
