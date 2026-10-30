import type { Directive } from 'vue';

/**
 * Tự động điều chỉnh chiều cao textarea: Mặc định một dòng, khi nội dung vượt quá sẽ tự động tăng cao theo scrollHeight (sau khi chạm trần sẽ hiện thanh cuộn).
 *
 * Tại sao không dùng rows cố định: Muốn có cảm giác "nội dung ngắn chiếm một dòng, nội dung dài mới xuống dòng trải rộng".
 * Triển khai: Đưa height về auto trước rồi lấy scrollHeight, nhận chiều cao vừa khít nội dung rồi ghi lại —— việc đưa về auto là bắt buộc,
 * nếu không khi rút ngắn nội dung thì scrollHeight sẽ không giảm xuống (nó chỉ phản ánh giá trị sau khi khung hiện tại đã bị kéo giãn ra).
 *
 * Giới hạn chiều cao tối đa đi theo max-height của CSS (trên .bbs-modal-textarea), vượt quá sẽ cuộn, nên ở đây không quản lý chạm trần.
 * Đổi giá trị qua v-model không kích hoạt sự kiện input, nên trong hook updated cũng resize một lần (bao phủ gán giá trị bằng code / điền lại bản nháp).
 */
function resize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export const vAutosize: Directive<HTMLTextAreaElement> = {
  mounted(el) {
    el.addEventListener('input', () => resize(el));
    // Khi gắn kết giá trị ban đầu có thể đã có sẵn (điền lại khi chỉnh sửa); đợi một khung hình chờ bố cục ổn định rồi mới đo, tránh đọc phải scrollHeight bằng 0
    requestAnimationFrame(() => resize(el));
  },
  updated(el) {
    requestAnimationFrame(() => resize(el));
  },
};
