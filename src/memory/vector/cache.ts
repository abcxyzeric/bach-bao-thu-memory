/** Khóa bộ nhớ đệm trên máy cho kết quả truy xuất vector gần nhất. */
export const RECALL_CACHE_STORAGE_KEY = 'bbs_vec_recall_cache';

/** Sau khi nguyên liệu chỉ mục thay đổi thì lập tức vô hiệu hóa kết quả truy xuất cũ, tránh lần tạo tiếp theo tái sử dụng nội dung trước khi sửa đổi. */
export function invalidateRecallCache(): void {
  try {
    localStorage.removeItem(RECALL_CACHE_STORAGE_KEY);
  } catch {
    /* Không cần xử lý khi ở chế độ ẩn danh / bộ nhớ lưu trữ không khả dụng. */
  }
}
