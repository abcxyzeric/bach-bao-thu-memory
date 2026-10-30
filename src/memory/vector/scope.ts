/**
 * Logic "chọn kho + chọn scope" của kho vector.
 *
 * Cô lập nhân vật = mỗi nhân vật một file <database>.sqlite độc lập: tên kho tính ra từ avatar nhân vật (khóa duy nhất ổn định).
 * Xóa nhân vật = xóa một file kho đó, không liên lụy nhân vật khác.
 * Trong kho dùng scope để phân biệt tập hợp:
 *   'chat:<chatId>'    cuộc trò chuyện hiện tại vừa chơi vừa lập chỉ mục
 *   'bundle:<hash>'    ảnh chụp đóng băng khi tạo cuộc trò chuyện mới kèm dữ liệu (ghi ở metadata.bbs_bundles)
 */

import { getContext } from '@/st/context';

/** Tên trường lưu danh sách gói mã băm trên metadata (đi theo file chat, nhánh gốc của ST sẽ sao chép vật lý) */
export const BUNDLES_META_KEY = 'bbs_bundles';

/**
 * Gấp chuỗi bất kỳ (avatar nhân vật) thành tên kho hợp lệ.
 * Backend DATABASE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/, avatar chứa chữ Unicode / chữ hoa / dấu gạch chéo sẽ không qua được, nên băm (hash).
 * Dùng FNV-1a (không cần crypto, frontend tính đồng bộ): ổn định, cùng avatar luôn ra cùng một kho.
 */
function avatarToDbName(avatar: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < avatar.length; i++) {
    h ^= avatar.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Trộn thêm độ dài để khử va chạm gọn nhẹ; chuyển sang hệ thập lục phân không dấu
  const hex = ((h >>> 0).toString(16) + (avatar.length & 0xffff).toString(16)).padStart(8, '0');
  return `bbs_vec_${hex}`;
}

/** Tên kho vector tương ứng với nhân vật hiện tại; khi trò chuyện nhóm / chưa vào nhân vật thì trả về null (không lập chỉ mục). */
export function currentVectorDb(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // Trò chuyện nhóm tạm thời chưa hỗ trợ
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  const avatar = ch?.avatar;
  if (!avatar) return null;
  return avatarToDbName(avatar);
}

/** ID cuộc trò chuyện hiện tại; chưa vào cuộc trò chuyện trả về null. */
export function currentChatId(): string | null {
  const ctx = getContext();
  return ctx?.getCurrentChatId?.() ?? null;
}

/** Scope riêng của cuộc trò chuyện hiện tại ('chat:<chatId>'); chưa vào cuộc trò chuyện trả về null. */
export function currentChatScope(): string | null {
  const id = currentChatId();
  return id ? `chat:${id}` : null;
}

/** Đọc danh sách gói mã băm trên metadata của cuộc trò chuyện hiện tại (khử trùng), không có thì mảng rỗng. */
export function currentBundleHashes(): string[] {
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[BUNDLES_META_KEY];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const h of raw) if (typeof h === 'string' && h) seen.add(h);
  return [...seen];
}

/** Phạm vi truy xuất scopes = cuộc trò chuyện hiện tại + các bundle. Chưa vào cuộc trò chuyện trả về mảng rỗng. */
export function recallScopes(): string[] {
  const self = currentChatScope();
  if (!self) return [];
  return [self, ...currentBundleHashes().map(h => `bundle:${h}`)];
}

/**
 * Nối thêm một mã băm bundle vào metadata của cuộc trò chuyện hiện tại (cộng dồn, khử trùng), và kích hoạt lưu bền vững.
 * Dùng vào khoảnh khắc ghi vào cuộc trò chuyện mới khi "Tạo cuộc trò chuyện mới kèm dữ liệu".
 */
export function appendBundleHash(metadata: Record<string, unknown>, parentHashes: string[], newHash: string): void {
  const merged = new Set<string>([...parentHashes, newHash].filter(Boolean));
  metadata[BUNDLES_META_KEY] = [...merged];
}
