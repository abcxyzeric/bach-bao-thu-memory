import { hydrateSettings } from '@/api/settings';
import { bindEngine, handleGenerationIntercept } from '@/memory/engine';
import { runVectorRecall, shouldRecallForType } from '@/memory/vector/recall';
import { refreshInjection } from '@/memory/inject';
import { syncTimeTagRegex } from '@/memory/timeTag';
import { bindChatLifecycle } from '@/memory/store';
import { checkForUpdate } from '@/memory/update';
import App from '@/App.vue';
import { vAutosize } from '@/directives/autosize';
import { injectMenuButton } from '@/menu';
import { syncTopBarButton } from '@/topbar';
import { syncQuickReplyButton } from '@/quickReply';
import { bindFloorPanel } from '@/floorPanel';
import { registerPublicInterface } from '@/public/register';
import { ui } from '@/state/ui';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { versionedAssetUrl } from '@/version';
import { watch } from 'vue';
// Hai dòng này để Vite đóng gói kiểu dáng toàn cục vào dist/index.css (sau đó tiêm vào shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import { createApp } from 'vue';

const HOST_ID = 'bbs-app-host';

/**
 * Bộ chặn tạo phản hồi: Trước mỗi lần tạo phản hồi, ST sẽ await gọi hàm toàn cục được chỉ định bởi manifest.generate_interceptor,
 * chữ ký hàm (chat, contextSize, abort, type), gọi abort(true) sẽ hủy bỏ lần tạo này.
 * Ở đây ủy quyền cho engine phán đoán "quá nhiều tầng tồn đọng" và chặn theo nhu cầu + chèn tầng nhắc nhở. Gắn trên globalThis để ST tìm thấy.
 */
(globalThis as Record<string, unknown>).bbs_generateInterceptor = async (
  _chat: unknown,
  _contextSize: number,
  abort: (immediately: boolean) => void,
  type: string | undefined,
): Promise<void> => {
  try {
    // Đi qua chặn tồn đọng trước: trả về true = đã abort lần tạo này, không cần truy xuất (việc tạo sẽ không diễn ra).
    const intercepted = await handleGenerationIntercept(type, abort);
    // Cho phép đi qua và loại này cần truy xuất → truy xuất vector kiểu chặn (ghi vào khe tiêm rồi mới cho phép tạo).
    // Bên trong truy xuất đã tự kèm phán đoán công tắc/tính khả dụng của vector, thất bại sẽ hạ cấp âm thầm, tuyệt đối không ảnh hưởng việc tạo.
    if (!intercepted && shouldRecallForType(type)) {
      await runVectorRecall();
    }
  } catch (e) {
    console.error('[Bách Bảo Thư] Lỗi ngoại lệ ở bộ chặn tạo phản hồi (cho phép lần tạo này đi qua)', e);
  }
};

/**
 * Các thuộc tính dàn trang có thể kế thừa —— shadow DOM không cô lập sự kế thừa, những thuộc tính này sẽ xuyên qua host rò rỉ từ ST vào.
 * Dùng inline !important ghim chặt trên host, cắt đứt chuỗi kế thừa ngay từ gốc.
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'font-variant': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  color: '#1c242c',
  direction: 'ltr',
};

function mount() {
  // Phần tử host nằm lại ở light DOM của ST, toàn bộ ứng dụng Vue sống trong shadow root của nó.
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  // host không tham gia bố cục (bên trong cửa sổ dùng định vị fixed), đồng thời cắt đứt kế thừa
  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.textContent = '';
  guardEditableArrowKeys(shadow);

  // Đưa dist/index.css đã build của chúng ta vào shadow root bằng thẻ <link> ——
  // như vậy kiểu dáng chỉ có hiệu lực trong cây shadow này, kiểu dáng toàn cục của ST không vào được, và của chúng ta cũng không lọt ra ngoài.
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // index.js và index.css nằm cùng cấp trong dist, suy ra từ URL module hiện tại, không phụ thuộc đường dẫn triển khai.
  link.href = versionedAssetUrl('./index.css', import.meta.url);
  shadow.appendChild(link);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const app = createApp(App);
  app.directive('autosize', vAutosize);
  app.mount(container);

  $(window).on('pagehide', () => app.unmount());
}

$(() => {
  mount();
  injectMenuButton();
  // Nút mở nhanh trên thanh đỉnh: tiêm/gỡ theo công tắc. watch đồng bộ khi công tắc thay đổi (bao gồm nạp lại giá trị thực khi hydrate).
  syncTopBarButton(ui.showTopBar);
  watch(
    () => ui.showTopBar,
    on => syncTopBarButton(on),
  );
  // Nút kiểu trả lời nhanh ở khung trò chuyện: mô hình tương tự như trên
  syncQuickReplyButton(ui.showQuickReply);
  watch(
    () => ui.showQuickReply,
    on => syncQuickReplyButton(on),
  );
  // Hệ thống trí nhớ: đợi getContext của ST sẵn sàng rồi mới gắn kết (polling khi thứ tự tải không xác định)
  bindMemoryWhenReady();
});

function bindMemoryWhenReady(attempt = 0) {
  if (window.SillyTavern?.getContext) {
    try {
      console.log('[Bách Bảo Thư] Chuỗi khởi động bắt đầu gắn kết (getContext đã sẵn sàng)');
      // Hydrate cài đặt trước: tải từ extension_settings (hoặc di chuyển từ localStorage cũ), sau đó mới đồng bộ đa thiết bị
      hydrateSettings();
      bindChatLifecycle();
      // Giao diện đọc công khai không phụ thuộc công tắc bộ máy trí nhớ; sau khi tải trò chuyện sẽ lập tức phơi bày để plugin/script khác đọc.
      void registerPublicInterface();
      bindEngine();
      // Thẻ thời gian: đăng ký/gỡ bỏ regex ẩn của ST theo công tắc (idempotent; đồng bộ tiếp theo khi công tắc thay đổi nằm trong watch của bindEngine)
      syncTimeTagRegex();
      // Màn hình đầu tiên: gắn tiêm cho trí nhớ hiện có của cuộc trò chuyện hiện tại
      refreshInjection();
      // Điểm neo tóm tắt trong tầng: tiêm theo công tắc cài đặt (bên trong bindFloorPanel có watch công tắc + giao diện, đồng bộ lần đầu ngay lập tức)
      bindFloorPanel();
      // Kiểm tra cập nhật chạy ngầm (đối chiếu thời gian thực phiên bản manifest cục bộ/từ xa; thất bại im lặng, không chặn khởi động)
      void checkForUpdate();
      console.log('[Bách Bảo Thư] Hoàn tất gắn kết chuỗi khởi động');
    } catch (e) {
      console.error('[Bách Bảo Thư] Gắn kết hệ thống trí nhớ thất bại', e);
    }
    return;
  }
  if (attempt > 40) return; // Tối đa khoảng 20s
  setTimeout(() => bindMemoryWhenReady(attempt + 1), 500);
}
