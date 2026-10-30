/**
 * Bản vá cục bộ tình trạng/thương tích (conditionPatch) —— chỉ dùng để phát lại bản lưu cũ.
 *
 * Bản v0.17 từng để mô hình sửa cục bộ condition theo các phân đoạn đánh số (c1, c2…). Trạng thái thường chỉ có vài mục, giao thức này mang lại lợi ích nhỏ,
 * định dạng phức tạp, mô hình dễ viết sai, đánh số đưa nguyên vào kho còn bị lệch vị trí khi các tầng phía trước biến động, nên đã đổi về ghi đè toàn văn giống như outfit.
 * Trong lá của các bản lưu cũ vẫn còn lưu bản vá, ở đây giữ lại logic cắt đoạn và áp dụng để chúng vẫn phát lại bình thường, nếu không trạng thái của các cuộc trò chuyện cũ sẽ bị biến dạng.
 */

import type { ConditionPatch } from './types';

/** Dấu phân cách lưu trữ giữa các phân đoạn. */
export const CONDITION_FRAGMENT_SEP = '；';

const FRAGMENT_ID_RE = /^c(\d+)$/i;
/** Chính văn bản lưu cũ có thể đã chép cả số thứ tự hiển thị vào, thậm chí chồng nhiều lớp (`[c1] [c1] …`). */
const FRAGMENT_PREFIX_RE = /^(?:[[【]\s*c\d+\s*[\]】]\s*)+/i;
const FRAGMENT_PREFIX_ANY_RE = /(^|[；;。\n])\s*(?:[[【]\s*c\d+\s*[\]】]\s*)+/gi;

/**
 * Cắt một đoạn condition thành các phân đoạn. Cắt theo dấu chấm phẩy, dấu chấm câu, xuống dòng, không cắt theo dấu phẩy
 * ("Cánh tay bị thương, cố định bằng nẹp, tạm thời không xách được đồ nặng" khi đó được thay thế tổng thể như một phân đoạn).
 * Tiền tố `[cN]` bị chép vào không tính là nội dung.
 */
export function splitConditionFragments(condition: string | undefined): string[] {
  const text = (condition ?? '').trim();
  if (!text) return [];
  return text
    .split(/[；;。\n]+/)
    .map(s => s.replace(FRAGMENT_PREFIX_RE, '').trim())
    .filter(Boolean);
}

/** Bóc bỏ số thứ tự hiển thị bị chép vào chính văn (`[c1] Cánh tay bị thương；[c2] …` → `Cánh tay bị thương；…`), phần còn lại giữ nguyên. */
export function stripConditionFragmentIds(condition: string): string {
  return condition.replace(FRAGMENT_PREFIX_ANY_RE, '$1').trim();
}

/**
 * Áp dụng conditionPatch của một nhân vật, trả về condition mới (có thể là undefined = xóa trống).
 * - replace: định vị phân đoạn cũ theo cN; text là chuỗi rỗng → xóa phân đoạn đó; có nội dung → ghi đè phân đoạn đó.
 * - add: nối thêm làm phân đoạn mới ở cuối.
 * Các phân đoạn cũ không nằm trong replace được giữ nguyên.
 */
export function applyConditionPatch(
  current: string | undefined,
  patch: ConditionPatch | null | undefined,
): string | undefined {
  if (!patch) return current;
  const fragments = splitConditionFragments(current);
  // Đánh số toàn bộ đều tương đối so với các phân đoạn trước khi áp dụng: thu thập đủ trước rồi mới dựng lại một lần. Vừa duyệt vừa splice sẽ làm các số thứ tự phía sau dịch sang trái toàn bộ,
  // khi trong cùng một bản vá xóa hai đoạn, hoặc xóa một đoạn sửa một đoạn sẽ bị xóa nhầm / sửa nhầm, còn mục vượt quá giới hạn thì âm thầm trượt mất.
  const replaced = new Map<number, string>();
  for (const op of patch.replace ?? []) {
    const m = typeof op.id === 'string' ? op.id.trim().match(FRAGMENT_ID_RE) : null;
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= fragments.length) continue;
    replaced.set(idx, op.text);
  }
  const next: string[] = [];
  // Văn bản ghi trả lại được cắt thêm một lần theo cùng quy tắc và bỏ các mục trùng lặp hoàn toàn: bên trong text có dấu chấm / chấm phẩy không nên tự dưng đẻ thêm phân đoạn,
  // cùng một câu cũng không nên treo hai lần.
  const push = (text: string) => {
    for (const frag of splitConditionFragments(text)) {
      if (!next.includes(frag)) next.push(frag);
    }
  };
  fragments.forEach((frag, i) => push(replaced.get(i) ?? frag));
  for (const op of patch.add ?? []) push(op.text);
  return next.join(CONDITION_FRAGMENT_SEP) || undefined;
}

/** Có phải là một bản vá có nội dung thực tế, có thể áp dụng được hay không. */
export function hasConditionPatchContent(patch: ConditionPatch | null | undefined): boolean {
  if (!patch) return false;
  const replace = patch.replace ?? [];
  const add = patch.add ?? [];
  return replace.length > 0 || add.some(op => op.text.trim().length > 0);
}
