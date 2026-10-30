<script setup lang="ts">
import { computed } from 'vue';

/**
 * Biểu tượng SVG nội tuyến —— không phụ thuộc thư viện phông chữ, tự nhiên xuyên qua shadow DOM.
 * Khung nhìn 24×24 thống nhất, phong cách nét viền (currentColor + stroke),
 * kế thừa kích thước và màu sắc thông qua CSS color / font-size (1em = cỡ chữ hiện tại).
 * Thêm biểu tượng mới: thêm một mục name -> thẻ <path>/<circle> bên trong vào PATHS.
 */
const props = defineProps<{ name: string; size?: number | string }>();

// Chỉ đặt dữ liệu đường dẫn, vỏ svg thống nhất nằm trong template. Phong cách stroke.
const PATHS: Record<string, string> = {
  // Tóm tắt: tài liệu + các dòng văn bản
  summary:
    '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h6M9 9h2"/>',
  // Nhân vật: chân dung người
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // Danh sách NPC (điều hướng): chân dung đôi, phân biệt với characters một người
  npcs:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 4.8"/><path d="M17 14.8c2.3.5 3.9 2.3 3.9 4.7"/>',
  // Đi cùng: đinh ghim (đánh dấu/bỏ đánh dấu đồng hành)
  pin: '<path d="M12 2.5 9 5.5l1 1L7 13l-3 .5 3.5 3.5L11 14l6.5-3 1 1 3-3-6.5-6.5z"/><path d="M5 19l3.2-3.2"/>',
  // Nhân vật chính yếu: ngôi sao năm cánh (nét viền = chưa đánh dấu, có thể bật sáng)
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>',
  // Khung cảnh: núi + mặt trời
  scenes:
    '<circle cx="8" cy="8" r="2"/><path d="M3.5 19.5 9 12l4 5"/><path d="M11.5 19.5 16 13.5l4.5 6"/><path d="M3.5 19.5h17"/>',
  // Vật phẩm: khối lập phương
  items:
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  // Cài đặt: thanh trượt
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // Biến số: dấu ngoặc nhọn { } —— biến JSON tùy chỉnh, phân biệt với thanh trượt của cài đặt
  vars:
    '<path d="M9 4.5c-2 0-2 2.4-2 4 0 1.8-.8 2.9-2.5 3 1.7.1 2.5 1.2 2.5 3 0 1.6 0 4 2 4"/><path d="M15 4.5c2 0 2 2.4 2 4 0 1.8.8 2.9 2.5 3-1.7.1-2.5 1.2-2.5 3 0 1.6 0 4-2 4"/>',
  // Xuất / Chia sẻ: mũi tên hướng lên ra khỏi khay
  upload: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // Nhập: mũi tên hướng xuống vào trong khay
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  // Sao chép: tài liệu xếp chồng
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/>',
  // Thẻ đánh dấu sách (biểu trưng thương hiệu)
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  // Mặt trăng
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // Mặt trời
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // Đóng
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // Dấu tích: xác nhận / lưu
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  // Thêm mới / dấu cộng
  plus: '<path d="M12 5v14M5 12h14"/>',
  // Hiển thị (mở mắt)
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // Ẩn (nhắm mắt / gạch chéo)
  'eye-off':
    '<path d="M4 4l16 16"/><path d="M9.6 5.8A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.8 15.8 0 0 1-3.3 3.9"/><path d="M6.3 8.1A15.9 15.9 0 0 0 2.5 12S6 18.5 12 18.5a8.5 8.5 0 0 0 3.2-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  // Mũi tên xuống (chỉ báo thu gọn)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // Đi tới địa điểm: mũi tên sang phải có thân dài, phân biệt với chevron dùng cho thu gọn
  navigate: '<path d="M4 12h15"/><path d="m14 7 5 5-5 5"/>',
  // Tìm kiếm: kính lúp
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  // Chọn nhiều: danh sách tích chọn (dấu tích bên trái + dòng bên phải, nhìn thoáng qua là hiểu "tích chọn nhiều mục")
  checklist: '<path d="M3.5 6.5 5 8l2.5-2.5M3.5 12.5 5 14l2.5-2.5M3.5 18.5 5 20l2.5-2.5"/><path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5"/>',
  // Tia chớp: ngay lập tức / tức thì (đại tóm tắt ngay). Phạm vi y gốc hơi đầy (chạm đỉnh chạm đáy trông hơi cao),
  // lấy tâm y=12 ép nhẹ về ~4.0~20.0, chiều cao thị giác ngang hàng với kính lúp / danh sách (ép mạnh quá sẽ trông lùn, lấy mức vừa).
  bolt: '<path d="M13 4 5 13h6l-1 7 8-9h-6z"/>',
  // Kế hoạch / Nghi vấn: lá cờ
  plans: '<path d="M6 21V4M6 4.5h11l-2.5 3.5L17 11.5H6"/>',
  // Kết nối / Kiểm tra
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // Làm mới / Kéo lấy
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // Xóa / Thùng rác: thân thùng hơi thu hẹp (7~17), giảm trọng lượng thị giác, cân bằng với bút chì
  trash: '<path d="M5 7.5h14M10 7.5V6h4v1.5M7 7.5l.8 11h8.4l.8-11"/>',
  // Chỉnh sửa / Bút chì: vắt chéo 4.5~19.5, nét mực trải đầy hơn bản cũ, trọng lượng thị giác tương đương thùng rác (nếu không bút chì trông nhỏ hơn một cỡ)
  edit: '<path d="M4.5 19.5h4L19 9 15 5 4.5 15.5z"/><path d="M13 7 17 11"/>',
  // Danh sách hiểu biết / Bóng đèn: nhân vật biết những chuyện gì về nhân vật chính
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.7.6 1 1.3 1 2.1v.5h4.6v-.5c0-.8.3-1.5 1-2.1A5.5 5.5 0 0 0 12 3.5z"/>',
  // Lấp lánh / Mộng mơ (giao diện Pastel)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbs-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbs-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
