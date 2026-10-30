/**
 * Tiêm bảng tóm tắt trong tầng (chủ thể vòng đời).
 *
 * Mỗi **tầng AI thực sự** (isRealAiReply, bao gồm cả những tầng đã đánh dấu ngoại truyện) sẽ gắn một host sau .mes_text,
 * bên trong host attachShadow + chia sẻ dist/index.css → gắn một thực thể FloorPanel.vue (props: floor, tick).
 * Ngoại hình thẻ, hoạt ảnh ngăn kéo, chỉ đọc/chỉnh sửa đều nằm trong component; module này chỉ quản lý: tiêm/dọn dẹp, dẫn động sự kiện, chống trùng lặp, chia sẻ kiểu dáng.
 *
 * chat không phải là reactive: dùng một reactive tick chia sẻ, khi sự kiện liên quan kích hoạt thì +1, component watch nó để đọc lại dữ liệu tầng hiện tại.
 * Cô lập kiểu dáng: mỗi tầng có shadow độc lập, chia sẻ cùng một bảng kiểu dáng khởi tạo (adoptedStyleSheets, phân tích một lần áp dụng N lần),
 * tránh chi phí "mỗi tầng một bản sao CSS" như Horae; nếu khởi tạo thất bại sẽ lùi về <link>.
 */
import { createApp, reactive, type App } from 'vue';
import FloorPanel from '@/components/FloorPanel.vue';
import { getContext } from '@/st/context';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { isRealAiReply } from '@/memory/engine';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { watch } from 'vue';
import { versionedAssetUrl } from '@/version';

const HOST_CLASS = 'bbs-fp-host';
const MARK_ATTR = 'data-bbs-fp'; // Đánh dấu trên .mes, chống tiêm trùng lặp

let enabled = false;
let observer: MutationObserver | null = null;
let sharedSheet: CSSStyleSheet | null = null;
let cssHref = '';
const bound = new Set<string>(); // Tên các sự kiện đã gắn kết (idempotent)

// Tín hiệu làm mới chia sẻ: bất kỳ sự kiện nào làm thay đổi trạng thái lá/ngoại truyện của tầng đều +1, component dựa vào đó để đọc lại chat.
const signal = reactive({ tick: 0 });
function bumpTick(): void {
  signal.tick++;
}

interface Mounted {
  host: HTMLElement;
  app: App;
}
const mountedByFloor = new Map<number, Mounted>();

/* ============ Bảng kiểu dáng chia sẻ ============ */

function resolveCssHref(): string {
  if (cssHref) return cssHref;
  try {
    cssHref = versionedAssetUrl('./index.css', import.meta.url);
  } catch {
    cssHref = '';
  }
  return cssHref;
}

/** Khởi tạo bất đồng bộ một bảng kiểu dáng chia sẻ (chỉ một lần). Thất bại im lặng, khi tiêm sẽ lùi về <link>. */
async function ensureSharedSheet(): Promise<void> {
  if (sharedSheet || typeof CSSStyleSheet === 'undefined') return;
  const href = resolveCssHref();
  if (!href) return;
  try {
    const res = await fetch(href);
    const text = await res.text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    sharedSheet = sheet;
    // Những cái đã gắn kết thì áp dụng bổ sung (màn hình đầu tiên có thể được tiêm trước khi bảng kiểu dáng sẵn sàng)
    for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) {
      const root = (host as HTMLElement).shadowRoot;
      if (root && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
    }
  } catch {
    /* Lùi về <link>, xem attachStyles */
  }
}

function attachStyles(root: ShadowRoot): void {
  if (sharedSheet) {
    if (!root.adoptedStyleSheets.includes(sharedSheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    }
    return;
  }
  const href = resolveCssHref();
  if (href && !root.querySelector('link[data-bbs-fp-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-bbs-fp-css', '');
    root.appendChild(link);
  }
}

/* ============ Tiêm / Dọn dẹp ============ */

function currentChatLen(): number {
  return getContext()?.chat?.length ?? 0;
}
function mesEl(idx: number): HTMLElement | null {
  return document.querySelector(`.mes[mesid="${idx}"]`);
}
function activeNow(): boolean {
  return enabled && engineActiveHere();
}

/** Tiêm FloorPanel cho một tầng nào đó (idempotent). */
function injectFloor(idx: number): void {
  const chat = getContext()?.chat ?? [];
  if (!isRealAiReply(chat[idx])) return;

  const el = mesEl(idx);
  if (!el) return;
  if (el.getAttribute(MARK_ATTR) === '1' && mountedByFloor.has(idx)) return; // Đã gắn

  // Gỡ bỏ host cũ có thể còn sót lại ở tầng đó (tái sử dụng mesid / kết xuất lại)
  el.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute('data-bbs-fp-floor', String(idx));
  const root = host.attachShadow({ mode: 'open' });
  guardEditableArrowKeys(root);
  attachStyles(root);
  const container = document.createElement('div');
  root.appendChild(container);

  // Truyền bản thân đối tượng reactive signal (tham chiếu ổn định): component đọc sig.tick là có thể theo dõi phản ứng.
  // props của createApp là ảnh chụp tĩnh, truyền giá trị nguyên thủy (number) sẽ không cập nhật, nên bắt buộc phải truyền đối tượng.
  const app = createApp(FloorPanel, { floor: idx, sig: signal });
  app.mount(container);

  const mesText = el.querySelector('.mes_text');
  if (mesText) mesText.insertAdjacentElement('afterend', host);
  else el.appendChild(host);

  mountedByFloor.set(idx, { host, app });
  el.setAttribute(MARK_ATTR, '1');
}

function removeFloor(idx: number): void {
  const m = mountedByFloor.get(idx);
  if (m) {
    m.app.unmount();
    m.host.remove();
    mountedByFloor.delete(idx);
  }
  mesEl(idx)?.removeAttribute(MARK_ATTR);
}

/** Quét lại toàn lượng: xóa sạch toàn bộ rồi gắn bù từng tầng. Dùng khi chuyển trò chuyện / thay đổi lớn. */
function rebuildAll(): void {
  for (const idx of [...mountedByFloor.keys()]) removeFloor(idx);
  document.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());
  document.querySelectorAll(`.mes[${MARK_ATTR}]`).forEach(n => n.removeAttribute(MARK_ATTR));
  if (!activeNow()) return;
  const len = currentChatLen();
  const chat = getContext()?.chat ?? [];
  for (let i = 0; i < len; i++) if (isRealAiReply(chat[i])) injectFloor(i);
}

/** Gắn bù các tầng AI đã có .mes trong DOM nhưng chưa được gắn kết (màn hình đầu, tải hàng loạt). */
function scanMissing(): void {
  if (!activeNow()) return;
  const chat = getContext()?.chat ?? [];
  document.querySelectorAll('.mes[mesid]').forEach(el => {
    const idx = Number((el as HTMLElement).getAttribute('mesid'));
    if (Number.isFinite(idx) && isRealAiReply(chat[idx]) && !mountedByFloor.has(idx)) injectFloor(idx);
  });
}

/* ============ Sự kiện ============ */

function onRendered(idx: unknown): void {
  if (!activeNow()) return;
  const i = Number(idx);
  setTimeout(() => {
    if (Number.isFinite(i)) injectFloor(i);
    scanMissing(); // Quét bù dự phòng
    bumpTick(); // Tóm tắt có thể vừa được tạo, thông báo cho các component đã gắn đọc lại
  }, 50);
}

function onSwiped(idx: unknown): void {
  if (!activeNow()) return;
  const i = Number(idx);
  setTimeout(() => {
    if (!Number.isFinite(i)) return;
    // Lật trang (swipe): lá có thể mất hiệu lực / đổi trang, component đọc lại là được (host không cần dựng lại)
    if (!mountedByFloor.has(i)) injectFloor(i);
    bumpTick();
  }, 50);
}

function bindEvents(): void {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (!es || !et) return;
  const on = (name: string | undefined, fn: (...a: unknown[]) => void) => {
    if (!name || bound.has(name)) return;
    es.on(name, fn);
    bound.add(name);
  };
  on(et.CHARACTER_MESSAGE_RENDERED, onRendered);
  on(et.USER_MESSAGE_RENDERED, () => activeNow() && setTimeout(scanMissing, 50));
  on(et.MESSAGE_SWIPED, onSwiped);
  on(et.MESSAGE_DELETED, () => activeNow() && setTimeout(rebuildAll, 50));
  on(et.MESSAGE_UPDATED, () => activeNow() && setTimeout(bumpTick, 50));
  on(et.MESSAGE_EDITED, () => activeNow() && setTimeout(bumpTick, 50));
  on(et.CHAT_CHANGED, () => setTimeout(rebuildAll, 80));
  if (et.MORE_MESSAGES_LOADED) on(et.MORE_MESSAGES_LOADED, () => activeNow() && setTimeout(scanMissing, 50));
}

/** Theo dõi vùng trò chuyện: khi ST kết xuất lại tin nhắn thì gắn bù các host bị cuốn trôi. Chống rung (debounce) để tránh kích hoạt tần suất cao trong lúc tạo luồng (stream). */
let obTimer: ReturnType<typeof setTimeout> | null = null;
function startObserver(): void {
  if (observer) return;
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;
  observer = new MutationObserver(() => {
    if (!activeNow() || obTimer) return;
    obTimer = setTimeout(() => {
      obTimer = null;
      if (!activeNow()) return;
      scanMissing();
      // Hiệu chỉnh: host đã tách khỏi DOM (bị ST dựng lại) nhưng vẫn còn trong bảng → gỡ ra, xóa đánh dấu chờ gắn bù
      for (const [idx, m] of mountedByFloor) {
        if (!m.host.isConnected) {
          m.app.unmount();
          mountedByFloor.delete(idx);
          mesEl(idx)?.removeAttribute(MARK_ATTR);
        }
      }
    }, 200);
  });
  observer.observe(chatEl, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (obTimer) {
    clearTimeout(obTimer);
    obTimer = null;
  }
}

/* ============ Đối ngoại ============ */

/** Đồng bộ sự tồn tại của bảng trong tầng theo công tắc (idempotent). */
export function syncFloorPanel(on: boolean): void {
  enabled = on;
  if (!on) {
    stopObserver();
    rebuildAll(); // activeNow=false → chỉ dọn dẹp không tạo mới
    return;
  }
  void ensureSharedSheet();
  bindEvents();
  startObserver();
  rebuildAll();
}

/** Chuỗi khởi động gọi một lần: đi theo công tắc (mục cài đặt apiSettings.ui.showFloorPanel). Giao diện được gắn kết phản ứng bởi ui.theme bên trong component. */
export function bindFloorPanel(): void {
  watch(
    () => apiSettings.ui.showFloorPanel,
    v => syncFloorPanel(!!v),
    { immediate: true },
  );
}
