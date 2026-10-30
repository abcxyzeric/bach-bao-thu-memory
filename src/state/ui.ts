import { apiSettings, onSettingsReady } from '@/api/settings';
import { reactive, ref, watch } from 'vue';

/**
 * Host Teleport của hộp thoại bật lên: được App.vue gắn ở cấp con trực tiếp của .bbs-root (bên ngoài vùng chứa cuộn .bbs-body).
 * Tất cả các hộp thoại .bbs-modal-mask đều Teleport tới đây, né tránh vấn đề kinh niên của iOS Safari ——
 * "hậu duệ position:fixed bên trong tổ tiên có thể cuộn" sẽ định vị tương đối theo nội dung cuộn thay vì khung nhìn (viewport), làm hộp thoại bị đẩy văng ra khỏi màn hình sau khi cuộn trang cài đặt.
 * Vẫn nằm bên trong shadow root, kiểu dáng scoped và các biến chủ đề --bbs-* vẫn có hiệu lực như thường (vì vậy không thể dùng Teleport to="body").
 */
export const modalHost = ref<HTMLElement | null>(null);

/** Vị trí điều hướng: auto = PC ở trên cùng, thiết bị di động ở dưới cùng */
export type NavPosition = 'top' | 'bottom' | 'auto';

/**
 * Giao diện chủ đề. Thêm chủ đề mới chỉ cần:
 *   1) Trong theme.css thêm một bộ biến .bbs-root[data-theme='xxx'];
 *   2) Tại đây thêm 'xxx' vào ThemeName, và thêm một mục vào bảng đăng ký THEMES.
 * Trang cài đặt và nút chuyển đổi ở đầu trang đều tự động đọc từ THEMES, không cần sửa nơi khác nữa.
 */
export type ThemeName = 'day' | 'night' | 'pastel' | 'green' | 'st';

export interface ThemeDef {
  value: ThemeName;
  label: string;
  /** Tên component Icon, xem components/Icon.vue */
  icon: string;
}

export const THEMES: ThemeDef[] = [
  { value: 'day', label: 'Ban ngày', icon: 'sun' },
  { value: 'night', label: 'Ban đêm', icon: 'moon' },
  { value: 'pastel', label: 'Phấn màu', icon: 'sparkles' },
  { value: 'green', label: 'Mộc Bạch', icon: 'sparkles' },
  { value: 'st', label: 'Theo ST', icon: 'plug' },
];

interface UiState {
  open: boolean;
  /** ID trang hiện tại, tương ứng với key trong registry */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
  /** Thiết bị di động: bấm lại nút điều hướng của trang hiện tại sẽ đóng cửa sổ (mặc định bật, sợ chạm nhầm có thể tắt) */
  navTapClose: boolean;
  /** Tiêm nút mở nhanh vào thanh trên cùng của ST (mặc định tắt) */
  showTopBar: boolean;
  /** Nút kiểu trả lời nhanh phía trên khung trò chuyện (mặc định tắt) */
  showQuickReply: boolean;
  /** Mốc neo tóm tắt bên trong tầng lầu (xem dữ liệu tầng đó + đánh dấu ngoại truyện, mặc định tắt) */
  showFloorPanel: boolean;
  /** Quả cầu nổi ở mép màn hình (mặc định tắt) */
  showOrb: boolean;
  /** Biểu tượng tùy chỉnh của quả cầu nổi (đường dẫn ảnh trên máy chủ ST; trống = biểu tượng dấu trang mặc định) */
  orbImage: string;
  /** Hình dạng quả cầu nổi: bookmark / circle / square */
  orbShape: OrbShape;
  /** Độ mờ của quả cầu nổi khi đứng yên (phần trăm 20–100) */
  orbOpacity: number;
  /** Kích thước cơ sở của quả cầu nổi (px, 32–80) */
  orbSize: number;
}

/** Hình dạng quả cầu nổi */
export type OrbShape = 'bookmark' | 'circle' | 'square';
export const ORB_SHAPES: { value: OrbShape; label: string }[] = [
  { value: 'bookmark', label: 'Dấu trang' },
  { value: 'circle', label: 'Hình tròn' },
  { value: 'square', label: 'Hình vuông' },
];
function validOrbShape(s: string): OrbShape {
  return s === 'bookmark' || s === 'circle' || s === 'square' ? s : 'bookmark';
}

// activePage (lần trước dừng ở trang nào) là trạng thái điều hướng tạm thời thuần trên máy, đồng bộ xuyên thiết bị vô nghĩa và mỗi lần lật trang đều ghi lại lên máy chủ thì quá dày,
// nên vẫn lưu ở localStorage trên máy; chủ đề / vị trí điều hướng là cài đặt thực sự, đổi sang lưu vào apiSettings.ui (→ ST đồng bộ xuyên thiết bị).
const PAGE_STORAGE_KEY = 'bbs.ui.page.v1';

function loadActivePage(): string {
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) || 'summary';
  } catch {
    return 'summary';
  }
}

// Kiểm tra tính hợp lệ của chủ đề: apiSettings.ui.theme là chuỗi trần, có thể đến từ phiên bản cũ / bị sửa tay hỏng, trước khi đưa vào ui thì kiểm tra trước.
function validTheme(t: string): ThemeName {
  return THEMES.some(x => x.value === t) ? (t as ThemeName) : 'day';
}
function validNav(n: string): NavPosition {
  return n === 'top' || n === 'bottom' || n === 'auto' ? n : 'auto';
}

// Tạo ui bằng giá trị hiện tại của apiSettings trước (ở giai đoạn import đa phần là mặc định; sau khi hydrate hoàn tất sẽ do onSettingsReady rót giá trị thực vào).
export const ui = reactive<UiState>({
  open: false,
  activePage: loadActivePage(),
  theme: validTheme(apiSettings.ui.theme),
  navPosition: validNav(apiSettings.ui.navPosition),
  navTapClose: apiSettings.ui.navTapClose,
  showTopBar: apiSettings.ui.showTopBar,
  showQuickReply: apiSettings.ui.showQuickReply,
  showFloorPanel: apiSettings.ui.showFloorPanel,
  showOrb: apiSettings.ui.showOrb,
  orbImage: apiSettings.ui.orbImage,
  orbShape: validOrbShape(apiSettings.ui.orbShape),
  orbOpacity: apiSettings.ui.orbOpacity,
  orbSize: apiSettings.ui.orbSize,
});

// Sau khi giá trị đồng bộ xuyên thiết bị của settings sẵn sàng, rót lại chủ đề / điều hướng vào ui (ghi đè mặc định của giai đoạn import)
onSettingsReady(() => {
  ui.theme = validTheme(apiSettings.ui.theme);
  ui.navPosition = validNav(apiSettings.ui.navPosition);
  ui.navTapClose = apiSettings.ui.navTapClose;
  ui.showTopBar = apiSettings.ui.showTopBar;
  ui.showQuickReply = apiSettings.ui.showQuickReply;
  ui.showFloorPanel = apiSettings.ui.showFloorPanel;
  ui.showOrb = apiSettings.ui.showOrb;
  ui.orbImage = apiSettings.ui.orbImage;
  ui.orbShape = validOrbShape(apiSettings.ui.orbShape);
  ui.orbOpacity = apiSettings.ui.orbOpacity;
  ui.orbSize = apiSettings.ui.orbSize;
});

// ui thay đổi → ghi về apiSettings.ui (do watch của settings chống rung lưu đĩa, đồng bộ xuyên thiết bị); activePage vẫn lưu trên máy.
watch(
  () => [
    ui.theme,
    ui.navPosition,
    ui.navTapClose,
    ui.showTopBar,
    ui.showQuickReply,
    ui.showFloorPanel,
    ui.showOrb,
    ui.orbImage,
    ui.orbShape,
    ui.orbOpacity,
    ui.orbSize,
  ],
  () => {
    apiSettings.ui.theme = ui.theme;
    apiSettings.ui.navPosition = ui.navPosition;
    apiSettings.ui.navTapClose = ui.navTapClose;
    apiSettings.ui.showTopBar = ui.showTopBar;
    apiSettings.ui.showQuickReply = ui.showQuickReply;
    apiSettings.ui.showFloorPanel = ui.showFloorPanel;
    apiSettings.ui.showOrb = ui.showOrb;
    apiSettings.ui.orbImage = ui.orbImage;
    apiSettings.ui.orbShape = ui.orbShape;
    apiSettings.ui.orbOpacity = ui.orbOpacity;
    apiSettings.ui.orbSize = ui.orbSize;
  },
);
watch(
  () => ui.activePage,
  () => {
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, ui.activePage);
    } catch {
      /* Khi localStorage không khả dụng thì giữ im lặng */
    }
  },
);

/**
 * Dấu thời gian lần mở cửa sổ gần nhất. Dùng để bỏ qua việc đóng màn chắn ngay trong khoảnh khắc vừa mở ——
 * sự kiện click tổng hợp ở cuối cử chỉ mở trên thiết bị di động sẽ xuyên qua màn chắn vừa mới kết xuất, gây ra hiện tượng "vừa mở đã tắt".
 */
export let lastOpenedAt = 0;

export function openBook(page?: string) {
  if (page) ui.activePage = page;
  ui.open = true;
  lastOpenedAt = performance.now();
}

export function closeBook() {
  ui.open = false;
}

/** Nút ở đầu trang: chuyển đổi xoay vòng giữa tất cả các chủ đề đã đăng ký */
export function cycleTheme() {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  ui.theme = THEMES[(i + 1) % THEMES.length].value;
}
