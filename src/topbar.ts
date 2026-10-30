import { openBook } from '@/state/ui';
import { ensureIconFallback } from '@/st/iconFallback';

const BTN_ID = 'bbs-topbar-button';
const STYLE_ID = 'bbs-topbar-style';

function ensureStyle(): void {
  // Giao diện làm đẹp có thể xóa sạch glyph biểu tượng thanh đỉnh, dùng bộ chọn độ đặc hiệu cao ép khôi phục (xem iconFallback)
  ensureIconFallback(STYLE_ID, `#top-settings-holder #${BTN_ID} .drawer-icon.fa-solid`);
}

/**
 * Tiêm một nút drawer mở nhanh Bách Bảo Thư vào thanh đỉnh của ST (#top-settings-holder),
 * vị trí nằm bên trái "Quản lý thiết lập người dùng" (#persona-management-button).
 *
 * Nút được tiêm **không vào shadow DOM** —— dùng trực tiếp tên lớp .drawer / .drawer-icon của ST,
 * đi theo làm đẹp giao diện của quán rượu. Nhấn vào chỉ phụ trách mở cửa sổ Bách Bảo Thư, không mở rộng bất kỳ ngăn kéo nào (do đó không gắn hàm của .drawer-toggle,
 * tránh việc doNavbarIconClick của ST coi nó là ngăn kéo để đóng mở).
 *
 * Chịu sự điều khiển của công tắc cài đặt: Bật → đảm bảo đã tiêm; Tắt → gỡ bỏ. Dùng polling đợi thanh đỉnh xuất hiện (thanh đỉnh tải lười).
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'drawer';
  btn.innerHTML = `
    <div class="drawer-toggle">
      <div class="drawer-icon fa-solid fa-book-bookmark fa-fw closedIcon" title="Bách Bảo Thư"></div>
    </div>
  `;
  // Chỉ mở cửa sổ, không đi theo logic đóng mở ngăn kéo của ST (vì vậy không gắn doNavbarIconClick của .drawer-toggle)
  btn.querySelector('.drawer-toggle')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openBook();
  });
  return btn;
}

/** Thực sự thực thi chèn: thành công hoặc đã tồn tại trả về true, thanh đỉnh chưa sẵn sàng trả về false (do polling thử lại). */
function tryInject(): boolean {
  const holder = document.getElementById('top-settings-holder');
  if (!holder) return false;
  if (document.getElementById(BTN_ID)) return true;

  ensureStyle();
  const btn = buildButton();
  // Chèn vào bên trái "Quản lý thiết lập người dùng"; nếu nó chưa kết xuất thì lùi về gắn ở cuối thanh đỉnh.
  const persona = document.getElementById('persona-management-button');
  if (persona) persona.before(btn);
  else holder.appendChild(btn);
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
}

/** Đồng bộ sự tồn tại của nút thanh đỉnh theo công tắc. Gọi khi công tắc thay đổi là được (idempotent). */
export function syncTopBarButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    removeButton();
    return;
  }
  if (tryInject()) return;
  // Thanh đỉnh tải lười: polling đợi nó xuất hiện. Thanh đỉnh là cấu trúc tĩnh trong index.html, thường trúng ngay lần đầu, timer không khởi động;
  // vạn nhất mãi không xuất hiện, giới hạn ~20s (40 lần) rồi từ bỏ, tuyệt đối không chạy không tải thường trực (cùng mô hình với bindMemoryWhenReady trong index.ts).
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 500);
}
