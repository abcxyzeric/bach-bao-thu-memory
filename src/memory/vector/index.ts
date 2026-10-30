/**
 * Điều phối chỉ mục vector: đồng bộ các lá hợp lệ của cuộc trò chuyện hiện tại vào kho vector backend (scope chat:<chatId> của nhân vật đó).
 *
 * Quy trình (tăng thêm, bất biến):
 *  1. Quét chat thu thập các lá hợp lệ → present = [{leafId, docHash, payloadHash}].
 *  2. vec/reconcile: backend xóa bỏ các mục lỗi thời, và phân biệt giữa thay đổi tóm tắt với "chỉ thay đổi toàn văn / thời gian".
 *  3. Có thay đổi tóm tắt mới embed+upsert lại; chỉ thay đổi toàn văn / thời gian thì đi qua cập nhật payload gọn nhẹ.
 * Cùng văn bản (cùng hash) không embed lặp lại —— đây là mấu chốt giúp việc "vừa chơi vừa lập chỉ mục" không bị giật lag.
 *
 * Thời điểm gọi: sau khi tạo / chỉnh sửa / xóa lá (kích hoạt chống rung, xem schedule). Toàn trình try/catch âm thầm,
 * vector là hạng mục tăng cường, thất bại tuyệt đối không ảnh hưởng quy trình tóm tắt chính.
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecItem, VecPayloadItem } from '@/api/baibaoku';
import { resetVectorStoreProbe, vecClearScope, vecReconcile, vecUpdatePayload, vecUpsert } from './store';
import { getLeaf, leafValid } from '../apply';
import { memory } from '../store';
import { stripThinkBlocks } from '../timeTag';
import type { LeafExtra } from '../types';
import { embedTexts, encodeFloat32Base64 } from './embed';
import { currentChatId, currentVectorDb } from './scope';
import { invalidateRecallCache } from './cache';

/** Mã băm ổn định gọn nhẹ (FNV-1a, hệ thập lục phân); văn bản tóm tắt lá thay đổi thì hash đổi ngay, kích hoạt embed lại. */
function docHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Dấu vân tay phiên bản của toàn văn và thời gian câu chuyện; hai thứ này thay đổi chỉ làm mới payload, không tạo lại vector tóm tắt. */
function payloadHashOf(mesFull: string, storyTime: string): string {
  return docHashOf(JSON.stringify([mesFull, storyTime]));
}

interface LeafForIndex {
  leafId: string;
  docHash: string;
  payloadHash: string;
  document: string; // Văn bản tóm tắt lá (đối tượng vector hóa + trả về ở mức tóm tắt)
  mesFull: string; // Nguyên văn tầng lầu (trả về ở mức toàn văn)
  storyTime: string;
  msgIndex: number;
}

/**
 * Thời gian câu chuyện của lá, lưu thành đoạn bắt đầu-kết thúc đầy đủ **chưa nén** "bắt đầu - kết thúc" (bắt đầu-kết thúc giống nhau / thiếu một đầu thì là đơn điểm).
 * Tại sao không nén (không xóa ngày tháng bị lặp ở đầu kết thúc): đầu truy xuất cần tách từ chuỗi này về lại **thời gian kết thúc đầy đủ** để tính thời gian tương đối,
 * sau khi nén đầu kết thúc sẽ bị thiếu ngày tháng (như "06:55") dẫn đến không tính ra được tương đối. Khi hiển thị đầu truy xuất mới dùng compactTimeLabel nén thành khoảng.
 */
function leafStoryTime(leaf: LeafExtra): string {
  const start = leaf.timeStart?.trim() || '';
  const end = leaf.timeEnd?.trim() || '';
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start || end || leaf.timeLabel?.trim() || '';
}

/**
 * Tập hợp id của các lá hạt giống (lá gắn ở #0 khi carryover, mang tổng kết gộp của cuộc trò chuyện cũ, không lập chỉ mục vào kho vector).
 * Nhận diện theo hai tiêu chuẩn, trúng bất kỳ cái nào cũng tính:
 *  - Dữ liệu mới: leaf.seed === true (carryover.ts đánh dấu tường minh).
 *  - Dữ liệu cũ (cuộc trò chuyện carryover được tạo trước khi có nhãn): lá được thu nạp bởi childIds của nút tổng kết có id bắt đầu bằng `sum_carry_`.
 * Như vậy các cuộc trò chuyện cũ đã tồn tại không cần di chuyển dữ liệu —— lần đối chiếu tiếp theo của reconcile sẽ tự động xóa bỏ chỉ mục lỗi thời này.
 */
function seedLeafIds(): Set<string> {
  const ids = new Set<string>();
  for (const s of memory.summaries) {
    if (!s.id.startsWith('sum_carry_')) continue;
    for (const c of s.childIds ?? []) ids.add(c);
  }
  return ids;
}

/** Quét chat hiện tại thu thập nguyên liệu chỉ mục của tất cả các lá hợp lệ (trừ lá hạt giống). */
function collectLeaves(chat: STMessage[]): LeafForIndex[] {
  const seeds = seedLeafIds();
  const out: LeafForIndex[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i]) as LeafExtra;
    if (leaf.seed || seeds.has(leaf.id)) continue; // Lá hạt giống: mang cả đoạn tổng kết, không đưa vào kho vector (xem LeafExtra.seed)
    const document = (leaf.text ?? '').trim();
    if (!document) continue; // Tóm tắt rỗng không lập chỉ mục
    const mesFull = stripThinkBlocks(chat[i].mes);
    const storyTime = leafStoryTime(leaf);
    out.push({
      leafId: leaf.id,
      docHash: docHashOf(document),
      payloadHash: payloadHashOf(mesFull, storyTime),
      document,
      // Lưu gần như nguyên văn: chỉ bóc trước chuỗi suy nghĩ (nhiễu tất định, tiết kiệm dung lượng và không rủi ro), các bước làm sạch còn lại (thẻ tùy chỉnh v.v.)
      // để đến lúc truy xuất mới đi qua cleanBody —— như vậy sau này người dùng điều chỉnh cài đặt "Thẻ làm sạch tùy chỉnh", chỉ mục cũ cũng có hiệu lực tức thì, không cần dựng lại.
      mesFull,
      storyTime,
      msgIndex: i,
    });
  }
  return out;
}

export interface VectorSyncResult {
  embedded: number;
  payloadUpdated: number;
}

let indexingPromise: Promise<VectorSyncResult> | null = null;
let indexingKey = '';
let mutationRevision = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Trí nhớ vector có thể lập chỉ mục ở cuộc trò chuyện hiện tại hay không (bật công tắc tổng + nhân vật hiện tại không bị loại trừ + bật công tắc vector + đã vào cuộc trò chuyện đơn nhân vật). */
export function vectorIndexableHere(): boolean {
  if (!engineActiveHere()) return false; // Tắt công tắc tổng của plugin / nhân vật hiện tại bị loại trừ → không lập chỉ mục
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && !!currentChatId();
}

/**
 * Đồng bộ các lá của cuộc trò chuyện hiện tại vào kho vector (tăng thêm). Có thể được gọi trực tiếp bởi schedule chống rung hoặc nút "Dựng lại chỉ mục" thủ công.
 * @returns Số lượng mục tạo lại vector và chỉ cập nhật dữ liệu phụ trợ trong lượt này.
 */
export async function syncVectorIndex(signal?: AbortSignal): Promise<VectorSyncResult> {
  if (!vectorIndexableHere()) return { embedded: 0, payloadUpdated: 0 };
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return { embedded: 0, payloadUpdated: 0 };
  const scope = `chat:${chatId}`;
  const taskKey = `${database}\0${scope}`;
  if (indexingPromise) {
    if (indexingKey === taskKey) return indexingPromise;
    // Khi cuộc trò chuyện trước đang thu dọn cuối thì đợi nó kết thúc trước, rồi lấy lại ngữ cảnh theo cuộc trò chuyện mới, tuyệt đối không ghi lá mới vào scope cũ.
    await indexingPromise;
    return syncVectorIndex(signal);
  }

  const run = async (): Promise<VectorSyncResult> => {
    const total: VectorSyncResult = { embedded: 0, payloadUpdated: 0 };
    try {
      let passRevision: number;
      do {
        passRevision = mutationRevision;
        if (currentVectorDb() !== database || currentChatId() !== chatId) break;
        const leaves = collectLeaves(getContext()?.chat ?? []);
        const present = leaves.map(l => ({
          leafId: l.leafId,
          docHash: l.docHash,
          payloadHash: l.payloadHash,
        }));

        // Thay đổi tóm tắt đi qua embed+upsert; chỉ thay đổi toàn văn / thời gian đi qua cập nhật payload gọn nhẹ.
        const { deleted = 0, missing, stalePayload = [] } = await vecReconcile(database, scope, present);
        // Backend đối chiếu đã xóa bỏ các mục lỗi thời (như người dùng xóa tầng qua ST gốc, lá biến mất theo) → nội dung mà truy xuất phụ thuộc đã đổi,
        // lập tức vô hiệu hóa bộ nhớ đệm, tránh việc về sau tái sử dụng bản tiêm cũ có chứa ký ức đã xóa.
        if (deleted > 0) invalidateRecallCache();
        const missingSet = new Set(missing);
        const staleSet = new Set(stalePayload);
        total.embedded += await embedAndUpsert(
          database,
          scope,
          leaves.filter(l => missingSet.has(l.leafId)),
          signal,
        );
        total.payloadUpdated += await updatePayload(
          database,
          scope,
          leaves.filter(l => staleSet.has(l.leafId)),
        );
        // Trong lúc lập chỉ mục đang chạy mà lại phát sinh chỉnh sửa, quét thêm một vòng nữa, tránh việc single-flight nuốt mất thay đổi mới.
      } while (passRevision !== mutationRevision);
    } catch (e) {
      console.warn('[Vector Bách Bảo Thư] Đồng bộ chỉ mục thất bại (không ảnh hưởng tóm tắt):', e);
    }
    return total;
  };

  indexingKey = taskKey;
  indexingPromise = run().finally(() => {
    indexingPromise = null;
    indexingKey = '';
  });
  return indexingPromise;
}

/** embed một loạt lá và upsert vào scope chỉ định; trả về số lượng mục thực tế đã ghi. Bên trong embedTexts chia đợt theo mốc 64. */
async function embedAndUpsert(database: string, scope: string, todo: LeafForIndex[], signal?: AbortSignal): Promise<number> {
  if (!todo.length) return 0;
  const vectors = await embedTexts(todo.map(l => l.document), signal);
  const items: VecItem[] = todo.map((l, i) => {
    const vec = vectors[i];
    return {
      leafId: l.leafId,
      docHash: l.docHash,
      payloadHash: l.payloadHash,
      vector: encodeFloat32Base64(vec),
      dim: vec.length,
      document: l.document,
      mesFull: l.mesFull,
      storyTime: l.storyTime,
      msgIndex: l.msgIndex,
    };
  });
  await vecUpsert(database, scope, items);
  return items.length;
}

/** Khi tóm tắt không đổi chỉ cập nhật toàn văn và thời gian, không gọi embedding. */
async function updatePayload(database: string, scope: string, todo: LeafForIndex[]): Promise<number> {
  if (!todo.length) return 0;
  const items: VecPayloadItem[] = todo.map(l => ({
    leafId: l.leafId,
    payloadHash: l.payloadHash,
    mesFull: l.mesFull,
    storyTime: l.storyTime,
  }));
  const { updated } = await vecUpdatePayload(database, scope, items);
  return updated;
}

/**
 * Trước khi truy xuất bù đủ chỉ mục và làm mới các payload hết hạn. Dùng chung single-flight với chỉ mục chạy nền;
 * các chỉnh sửa mới phát sinh trong lúc đang chạy sẽ tự động chạy bù trước khi tác vụ hiện tại kết thúc.
 */
export async function ensureRecallIndex(signal?: AbortSignal): Promise<void> {
  if (!vectorIndexableHere()) return;
  await syncVectorIndex(signal);
}

/**
 * Xóa trống chỉ mục vector của cuộc trò chuyện hiện tại (chỉ xóa scope chat:<chatId>, không đụng tới ảnh chụp bundle được kế thừa).
 * Dùng khi "chỉ mục bị bẩn / muốn làm lại từ đầu": sau khi xóa trống có thể dùng "Dựng lại" để lập chỉ mục lại từ đầu. Trả về số lượng mục đã xóa.
 * Không đi qua cổng chắn vectorIndexableHere (thao tác thủ công của người dùng, cho dù công tắc vector tạm thời tắt cũng nên cho phép dọn dẹp),
 * nhưng vẫn cần kho hiện tại + id cuộc trò chuyện thì mới có scope mục tiêu.
 */
export async function clearVectorIndex(): Promise<number> {
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;
  invalidateRecallCache();
  resetVectorStoreProbe(); // Trước khi bảo trì thủ công thì thăm dò lại backend, backend vừa sẵn sàng / vừa dừng đều chuyển sang đúng store được
  const { deleted } = await vecClearScope(database, `chat:${chatId}`);
  return deleted;
}

/** Kích hoạt chống rung đồng bộ chỉ mục: gọi sau khi tạo / chỉnh sửa / xóa lá, gộp các biến động liên tiếp thành một lần.
 * Lưu ý: tại đây **không còn** tiện tay vô hiệu hóa bộ nhớ đệm truy xuất nữa —— khi tạo lại / lật trang ST sẽ phát MESSAGE_DELETED/MESSAGE_SWIPED trước
 * rồi mới chạy bộ chặn, nếu vô hiệu hóa tại đây, bộ nhớ đệm luôn bị xóa trống trước khi bộ chặn kịp truy vấn, làm việc tạo lại / lật trang luôn phải truy xuất lại từ đầu.
 * Việc vô hiệu hóa bộ nhớ đệm truy xuất chỉ xảy ra ở điểm đáp khi "nội dung lá thực sự thay đổi" (xem applyLeafForFloor / chỉnh sửa xóa trong apply.ts /
 * xóa khi đối chiếu), xem chú thích buildRecallCacheKey của recall.ts: key đã loại trừ tầng AI cuối đang được viết lại,
 * tạo lại / lật trang vốn dĩ phải trúng bộ nhớ đệm. */
export function scheduleVectorIndex(): void {
  mutationRevision++;
  if (timer) clearTimeout(timer);
  if (!vectorIndexableHere()) {
    timer = null;
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void syncVectorIndex();
  }, 2500);
}
