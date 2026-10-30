/** Độ sâu tiêm mặc định của truy xuất vector: D0, nằm sát ngay đầu vào người dùng mới nhất. */
export const DEFAULT_RECALL_INJECTION_DEPTH = 0;

/** Độ sâu tiêm chỉ chấp nhận số nguyên không âm; khi cấu hình cũ bị thiếu, ô nhập để trống hoặc không hợp lệ thì giữ nguyên mặc định D0. */
export function normalizeRecallInjectionDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_RECALL_INJECTION_DEPTH;
}
