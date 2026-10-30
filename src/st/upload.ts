/**
 * Tải ảnh lên: **nén** ảnh cục bộ do người dùng chọn rồi lưu lên máy chủ ST, nhận về một chuỗi đường dẫn ngắn
 * (như /user/images/baibai_book/orb.webp).
 *
 * Tại sao không lưu trực tiếp base64 vào cài đặt: base64 sẽ nhét cả bức ảnh vào settings.json, ảnh lớn làm phình file đó ra,
 * mỗi lần lưu đều phải mang theo nó. Đổi sang lưu "chuỗi đường dẫn máy chủ" —— vừa đồng bộ xuyên thiết bị (các đầu cuối cùng một thực thể ST dùng chung ảnh),
 * vừa không làm phình settings.
 *
 * Hai nhánh xử lý:
 *  · Ảnh tĩnh (png/jpg/webp…) → canvas thu phóng nén thành webp, kiểm soát dung lượng.
 *  · GIF → **tải lên nguyên bản** (canvas chỉ lấy khung hình đầu sẽ làm mất hoạt ảnh), chỉ kiểm tra trần dung lượng.
 *
 * Cách thực hiện: **POST trực tiếp điểm cuối REST ổn định ở backend /api/images/upload**, header xác thực lấy từ
 * getContext().getRequestHeaders() (API ổn định của ST). Không import các file JS nội bộ của ST ——
 * các phần xuất ra của những file đó sẽ thay đổi theo phiên bản (saveBase64AsFile nằm ở utils.js, script.js không re-export,
 * bản cài đặt cũ lấy từ /script.js chắc chắn thất bại). Hợp đồng điểm cuối REST ổn định hơn xuất nội bộ rất nhiều.
 */
import { getContext } from '@/st/context';

const MAX_SIDE = 256; // Quả cầu nổi rất nhỏ, 256px là đủ rõ nét
const QUALITY = 0.85;
const GIF_MAX_BYTES = 2 * 1024 * 1024; // GIF tải lên nguyên bản, trần dung lượng 2MB (quá lớn làm chậm tải / làm phình máy chủ)

/** Đọc File thành dataURL (base64). */
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('Đọc file thất bại'));
    fr.readAsDataURL(file);
  });
}

/** Lấy base64 thuần từ dataURL (bỏ tiền tố data:*;base64,). */
function stripDataUrl(dataUrl: string): string {
  return dataUrl.split(',')[1] ?? '';
}

/** Có phải GIF hay không (theo MIME, chịu lỗi theo phần mở rộng). */
function isGif(file: File): boolean {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name);
}

/** Nạp thành <img>, phục vụ canvas lấy điểm ảnh. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Giải mã hình ảnh thất bại'));
    img.src = src;
  });
}

/**
 * Thu phóng đồng tỷ lệ về cạnh dài nhất ≤ MAX_SIDE, chuyển sang webp, trả về **base64 thuần** (bỏ tiền tố data:*;base64,).
 * saveBase64AsFile nhận base64 trần không kèm tiền tố (xem ST utils.js).
 */
async function compressToBase64(file: File): Promise<string> {
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas không khả dụng');
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/webp', QUALITY);
  return stripDataUrl(out);
}

/**
 * Tải lên một bức ảnh cục bộ làm biểu tượng quả cầu nổi, trả về chuỗi đường dẫn máy chủ; thất bại ném lỗi (bên gọi thông báo cho người dùng).
 * Tên file kèm một số thứ tự để tránh ghi đè (ghép thuần ở frontend, không phụ thuộc dấu thời gian —— Date.now bị hạn chế ở một số môi trường).
 *
 * POST trực tiếp /api/images/upload (điểm cuối ổn định ở backend):
 *   body { image: base64 thuần, format, ch_name: thư mục con, filename: không gồm phần mở rộng }
 *   trả về { path }. Header xác thực đi qua getRequestHeaders (có chứa CSRF token).
 *   GIF dùng format='gif' tải lên nguyên bản (giữ lại hoạt ảnh); phần còn lại nén thành 'webp'.
 */
let seq = 0;
export async function uploadOrbImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Vui lòng chọn file hình ảnh');

  let base64: string;
  let format: string;
  if (isGif(file)) {
    // GIF không đi qua canvas (sẽ chỉ lấy khung hình đầu làm mất hoạt ảnh), tải lên nguyên bản; kiểm tra trần dung lượng trước
    if (file.size > GIF_MAX_BYTES) {
      throw new Error(`Ảnh GIF không được vượt quá ${Math.round(GIF_MAX_BYTES / 1024 / 1024)}MB`);
    }
    base64 = stripDataUrl(await readAsDataURL(file));
    format = 'gif';
  } else {
    base64 = await compressToBase64(file);
    format = 'webp';
  }
  if (!base64) throw new Error('Xử lý hình ảnh thất bại');

  const ctx = getContext();
  const headers = ctx?.getRequestHeaders?.();
  if (!headers) throw new Error('SillyTavern chưa sẵn sàng, vui lòng thử lại sau');

  const res = await fetch('/api/images/upload', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image: base64,
      format,
      ch_name: 'baibai_book',
      filename: `orb_${++seq}`,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error ?? '';
    } catch {
      /* Phản hồi không phải JSON */
    }
    throw new Error(detail || `Tải lên thất bại (${res.status})`);
  }
  const data = (await res.json()) as { path?: string };
  if (!data.path) throw new Error('Máy chủ không trả về đường dẫn hình ảnh');
  return data.path;
}
