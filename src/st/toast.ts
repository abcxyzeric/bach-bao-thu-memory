/**
 * Lớp bọc toast gọn nhẹ. Toàn cục ST có gắn toastr (plugin jQuery), dùng trực tiếp nó để bật thông báo không chặn (non-modal).
 * Khi không lấy được thì âm thầm lùi về console.log, tuyệt đối không ném lỗi (thông báo thất bại không nên ảnh hưởng quy trình chính).
 */

type ToastType = 'info' | 'success' | 'warning' | 'error';

interface Toastr {
  info: (msg: string, title?: string) => void;
  success: (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
  error: (msg: string, title?: string) => void;
}

export function toast(message: string, type: ToastType = 'info'): void {
  try {
    const t = (window as unknown as { toastr?: Toastr }).toastr;
    if (t && typeof t[type] === 'function') {
      t[type](message, 'Bách Bảo Thư');
      return;
    }
  } catch {
    /* toastr không khả dụng → lùi về ghi log */
  }
  console.log('[Bách Bảo Thư]', message);
}
