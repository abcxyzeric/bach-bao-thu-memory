import type { ProtagonistDelta } from './types';

/**
 * Gộp bản vá hồ sơ nhân vật chính vào bản vá hiện có của cùng một lá.
 *
 * Tuổi tác là một giá trị nguyên tử hai trường (age + ageTime): bên gọi viết rõ age, nhưng không viết ageTime,
 * biểu thị đây là "tuổi mới ngay thời khắc này", mốc neo cũ bắt buộc phải gỡ bỏ cùng lúc, sau đó do tầng phát lại bù vào bằng thời gian câu chuyện của lá này.
 * Phép trải đối tượng (object spread) thông thường không thể biểu đạt việc xóa, từng vì thế mà làm tuổi mới tiếp tục áp mốc neo cũ.
 */
export function mergeProtagonistDelta(
  current: ProtagonistDelta | undefined,
  patch: ProtagonistDelta,
): ProtagonistDelta {
  const merged: ProtagonistDelta = { ...(current ?? {}), ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'age') && !Object.prototype.hasOwnProperty.call(patch, 'ageTime')) {
    delete merged.ageTime;
  }
  // condition là văn bản kiểu ghi đè. Bản vá lần này một khi đã đưa ra condition (gồm cả chuỗi rỗng = xóa trống), bản vá phân đoạn còn sót trong cùng lá
  // bắt buộc phải hủy bỏ cùng lúc —— nếu không khi phát lại sẽ ghi văn bản mới trước, rồi lại áp một lượt bản vá theo đánh số cũ, lưu thủ công nhìn như "không có hiệu lực"
  // mà phân đoạn cũ cứ bị add/replace quay trở lại (ngày càng dài). Thứ tự gộp bản vá ở trước, condition ở sau không giải quyết được,
  // chỉ có thể xóa tường minh tại đây.
  if (Object.prototype.hasOwnProperty.call(patch, 'condition')) {
    delete merged.conditionPatch;
  }
  return merged;
}
