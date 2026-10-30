import { openBook } from '@/state/ui';

const BTN_ID = 'bbs-qr-button';
const BAR_CLASS = 'bbs-qr-bar'; // Chỉ khi #qr--bar không tồn tại, thanh do chúng ta tự tạo mới thêm lớp đánh dấu này để tiện thu hồi

/**
 * Tiêm một nút "Bách Bảo Thư" vào phía trên khung trò chuyện, ngoại hình **hoàn toàn đồng nhất** với nút trả lời nhanh gốc của ST.
 *
 * Cách làm mô phỏng theo mô hình của plugin lân cận JS-Slash-Runner (src/panel/script/use_button_destination_element.ts
 * và Script.vue): nút chỉ là một `<div class="qr--button menu_button interactable">Văn bản</div>`,
 * thứ quyết định ngoại hình là lớp `.qr--button` do tiện ích mở rộng quick-reply định nghĩa —— gắn nó vào là cùng kiểu dáng với nút gốc, không cần biểu tượng,
 * không viết kiểu dáng riêng (tự vẽ / chỉ ké menu_button đều trông lạc quẻ, đã thử nghiệm thực tế).
 *
 * Cấu trúc gắn kết căn chỉnh theo bản gốc: #qr--bar (nếu đã tồn tại thì tái sử dụng, nếu không thì tự tạo một thanh .flex-container.flexGap5)
 *   └ .qr--buttons (vùng chứa)
 *       └ .qr--button (nút của chúng ta)
 *
 * Chịu sự điều khiển của công tắc cài đặt: Bật → đảm bảo đã tiêm; Tắt → gỡ bỏ. Polling đợi khung trò chuyện xuất hiện (SPA tải lười).
 *
 * Lưu ý: Kiểu dáng của .qr--button hoàn toàn dựa vào bộ chọn tổ tiên `#qr--bar > .qr--buttons .qr--button` để có hiệu lực,
 * nút **bắt buộc** phải nằm trong cấu trúc đó mới có ngoại hình gốc. Mà trả lời nhanh của ST sẽ dựng lại #qr--bar khi chuyển trò chuyện / đổi cài đặt,
 * cuốn trôi luôn nút của chúng ta —— do đó dùng MutationObserver theo dõi sát #send_form, bị cuốn trôi thì bù lại (giống JS-Slash-Runner).
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;

/** Lấy (hoặc tạo) #qr--bar: ưu tiên tái sử dụng thanh gốc của ST, không có mới tự tạo một thanh cùng kiểu. Trả về vùng chứa .qr--buttons dùng để gắn nút. */
function ensureButtonHolder(sendForm: HTMLElement): HTMLElement {
  // Ràng buộc id duy nhất, dùng lọc thuộc tính thay vì bộ chọn #qr--bar (cùng cách làm với JS-Slash-Runner)
  let bar = Array.from(sendForm.querySelectorAll('div')).find(d => d.id === 'qr--bar') as HTMLElement | undefined;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'qr--bar';
    bar.className = `${BAR_CLASS} flex-container flexGap5`;
    sendForm.prepend(bar);
  }
  // Tái sử dụng .qr--buttons đã có trong thanh, không có thì tạo mới (ở chế độ chưa kết hợp gốc có thể không có)
  let holder = bar.querySelector('.qr--buttons') as HTMLElement | null;
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'qr--buttons';
    bar.appendChild(holder);
  }
  return holder;
}

function buildButton(): HTMLElement {
  const btn = document.createElement('div');
  btn.id = BTN_ID;
  btn.className = 'qr--button menu_button interactable';
  btn.setAttribute('tabindex', '0');
  btn.title = 'Mở Bách Bảo Thư';
  btn.textContent = 'Bách Bảo Thư';
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openBook();
  });
  btn.addEventListener('keydown', e => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      openBook();
    }
  });
  return btn;
}

/** Thực sự thực thi chèn: thành công hoặc đã tồn tại trả về true, khung trò chuyện chưa sẵn sàng trả về false (do polling thử lại). */
function tryInject(): boolean {
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return false;
  if (document.getElementById(BTN_ID)) return true;

  const holder = ensureButtonHolder(sendForm);
  holder.appendChild(buildButton());
  return true;
}

function removeButton(): void {
  document.getElementById(BTN_ID)?.remove();
  // Nếu là #qr--bar rỗng do chúng ta tự tạo (bản gốc không có QR), khi rút nút đi thì thu hồi luôn, đừng để lại thanh trống
  const bar = document.querySelector(`#qr--bar.${BAR_CLASS}`) as HTMLElement | null;
  if (bar && bar.querySelector('.qr--buttons')?.children.length === 0) bar.remove();
}

/** Theo dõi sát #send_form: khi ST dựng lại #qr--bar cuốn trôi nút của chúng ta, bù lại (idempotent, tryInject tự kèm kiểm tra tồn tại). */
function startObserver(): void {
  if (observer) return;
  const sendForm = document.getElementById('send_form');
  if (!sendForm) return;
  observer = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID)) tryInject();
  });
  observer.observe(sendForm, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}

/** Đồng bộ sự tồn tại của nút trả lời nhanh theo công tắc. Gọi khi công tắc thay đổi là được (idempotent). */
export function syncQuickReplyButton(enabled: boolean): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    stopObserver();
    removeButton();
    return;
  }
  if (tryInject()) {
    startObserver();
    return;
  }
  // Khung trò chuyện tải lười: polling đợi nó xuất hiện, giới hạn ~20s (40 lần) rồi từ bỏ, tuyệt đối không chạy không tải thường trực.
  let attempts = 0;
  pollTimer = setInterval(() => {
    if (tryInject() || ++attempts > 40) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (document.getElementById(BTN_ID)) startObserver();
    }
  }, 500);
}
