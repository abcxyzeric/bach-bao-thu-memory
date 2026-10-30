/**
 * Kiểm tra cập nhật: đối chiếu "version của manifest.json cục bộ" với "version của manifest.json trên kho GitHub từ xa",
 * nếu có phiên bản mới thì bật chấm đỏ ở tab Cài đặt + đưa ra lối vào "Cập nhật ngay" ở trang Cài đặt, sau khi xác nhận sẽ đi qua API cập nhật tiện ích mở rộng của ST để tự động cập nhật và làm mới trang.
 *
 * ⚠️ Cố ý không lưu bền vững kết quả "có bản cập nhật" (không ghi localStorage):
 *   Cách làm cũ lưu đệm updateAvailable vào localStorage, chỉ khi bấm nút cập nhật mới xóa —— kết quả là cập nhật xong vẫn báo có bản cập nhật,
 *   bắt buộc phải bấm tay một lần mới mất. Ở đây đổi sang mỗi lần đều đối chiếu thời gian thực version của hai bản manifest: sau khi máy cục bộ cài bản mới thì version tự nhiên lớn lên,
 *   lần đối chiếu tiếp theo sẽ không nhắc nữa. Chỉ dùng cờ trong bộ nhớ checkedThisSession để tránh gửi yêu cầu lặp lại trong một phiên, vừa làm mới trang là kiểm tra lại.
 */

import { reactive } from 'vue';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';

/**
 * Số phiên bản cục bộ: do Vite tiêm từ package.json, và được script trước khi đóng gói đồng bộ vào manifest.json.
 * Tiết kiệm một lần gửi yêu cầu so với fetch manifest cục bộ, không dính bẫy đường dẫn / bộ nhớ đệm; sau khi cập nhật cài bản mới chuỗi này tự nhiên lớn lên, lần đối chiếu sau sẽ không nhắc nữa.
 */
const CURRENT_VERSION = PLUGIN_VERSION;

/** Manifest từ xa: GitHub raw (kèm dấu thời gian để vượt qua bộ nhớ đệm). homePage trỏ tới abcxyzeric/bach-bao-thu-memory. */
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/abcxyzeric/bach-bao-thu-memory/main/manifest.json';

/** Trạng thái phản ứng (reactive) hướng ra ngoài: điều khiển chấm thông báo ở tab cài đặt và khu vực phiên bản ở trang cài đặt. */
export const updateState = reactive<{
  current: string; // Phiên bản cục bộ (hằng số trong mã nguồn)
  latest: string; // Phiên bản từ xa (trống = chưa tra được / yêu cầu thất bại)
  available: boolean; // Từ xa > Cục bộ
  checking: boolean;
  updating: boolean;
}>({
  current: CURRENT_VERSION,
  latest: '',
  available: false,
  checking: false,
  updating: false,
});

// Trong một phiên chỉ chủ động kiểm tra một lần (làm mới trang là đặt lại → kiểm tra lại), tránh gọi GitHub lặp đi lặp lại.
let checkedThisSession = false;

/** Phân tích "a có mới hơn b hay không": tách đoạn theo dấu . để so sánh từng số, thiếu đoạn thì bù 0 (như 0.0.1 vs 0.1). Đoạn phi chữ số xử lý như 0. */
function isNewer(a: string, b: string): boolean {
  if (!a || !b) return false;
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Đọc version của manifest.json từ xa. Yêu cầu thất bại / quá thời gian trả về chuỗi rỗng (âm thầm, không làm phiền người dùng). */
async function readRemoteVersion(): Promise<string> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!resp.ok) return '';
      const json = (await resp.json()) as { version?: string };
      return String(json?.version ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

/**
 * Kiểm tra cập nhật: đối chiếu thời gian thực phiên bản manifest cục bộ và từ xa, làm mới updateState.
 * Một phiên chỉ chủ động kiểm tra một lần; force=true bỏ qua giới hạn đó (phục vụ nút "Kiểm tra lại" kích hoạt thủ công).
 */
export async function checkForUpdate(force = false): Promise<void> {
  if (updateState.checking) return;
  if (checkedThisSession && !force) return;
  updateState.checking = true;
  try {
    const latest = await readRemoteVersion();
    if (latest) {
      updateState.latest = latest;
      updateState.available = isNewer(latest, CURRENT_VERSION);
    }
    // Không lấy được từ xa thì giữ nguyên kết luận lần trước (không báo nhầm, không xóa nhầm).
    checkedThisSession = true;
  } finally {
    updateState.checking = false;
  }
}

/** Tên thư mục tiện ích mở rộng này (tên thư mục dưới third-party). Phân tích từ URL mô-đun, không lấy được thì lùi về tên đã biết. */
function extensionFolderName(): string {
  try {
    const path = new URL(import.meta.url).pathname;
    const marker = '/third-party/';
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      const rest = path.slice(idx + marker.length);
      const folder = rest.split('/')[0];
      if (folder) return folder;
    }
  } catch {
    /* Phân tích thất bại thì lùi về mặc định */
  }
  return 'bach-bao-thu-memory';
}

/** Thăm dò loại cài đặt của tiện ích mở rộng này (global/local/system), quyết định tham số global của API cập nhật. Không lấy được thì coi như local. */
async function discoverExtensionType(folder: string): Promise<'global' | 'local' | 'system' | null> {
  try {
    const headers = getContext()?.getRequestHeaders?.() ?? {};
    const resp = await fetch('/api/extensions/discover', { method: 'GET', headers, cache: 'no-store' });
    if (!resp.ok) return null;
    const list = (await resp.json()) as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(list)) return null;
    const target = `third-party/${folder}`;
    const hit = list.find(x => x?.name === target);
    const type = hit?.type;
    return type === 'global' || type === 'local' || type === 'system' ? type : null;
  } catch {
    return null;
  }
}

/**
 * Thực thi cập nhật: gọi /api/extensions/update của ST để kéo mã nguồn mới nhất về, sau khi thành công thì làm mới trang để có hiệu lực.
 * Thất bại sẽ ném lỗi (do bên gọi hiển thị thông báo). Tiện ích mở rộng toàn cục cần quyền quản trị viên, backend sẽ tự kiểm tra và trả về thông báo lỗi.
 */
export async function performUpdate(): Promise<void> {
  if (updateState.updating) return;
  updateState.updating = true;
  try {
    const folder = extensionFolderName();
    const type = await discoverExtensionType(folder);
    const headers = getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    const resp = await fetch('/api/extensions/update', {
      method: 'POST',
      headers,
      body: JSON.stringify({ extensionName: folder, global: type === 'global' }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || resp.statusText || `HTTP ${resp.status}`);
    }
    // Cập nhật thành công: mã cục bộ đã đổi sang bản mới, làm mới trang để nạp bản dựng mới (sau khi làm mới đối chiếu tự nhiên sẽ không nhắc nữa).
    updateState.available = false;
    setTimeout(() => location.reload(), 800);
  } finally {
    updateState.updating = false;
  }
}
