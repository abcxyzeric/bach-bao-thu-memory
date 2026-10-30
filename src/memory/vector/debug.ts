/**
 * Ảnh chụp gỡ lỗi truy xuất vector (toàn cục, reactive).
 *
 * Chỉ phục vụ cho bảng "Cài đặt → Trí nhớ vector → Chi tiết lần truy xuất trước": giữ lại một bản kết quả trung gian của các giai đoạn trong lần truy xuất trước
 * ở trong bộ nhớ để UI đăng ký theo dõi. Quan sát gỡ lỗi thuần túy, không tham gia logic truy xuất, thất bại / hạ cấp cũng vẫn ghi lại như thường (ghi rõ status).
 * Singleton toàn cục (không theo từng cuộc trò chuyện): chỉ quan tâm "lần gần nhất", sau khi chuyển cuộc trò chuyện lần truy xuất tiếp theo tự nhiên sẽ ghi đè.
 */

import { reactive } from 'vue';

/** Trúng tìm kiếm Embedding (sau khi backend dung hợp max) */
export interface RecallDebugEmbedHit {
  leafId: string;
  similarity: number;
  /** Chỉ mục Q nguồn (backend trả về); -1 = chưa rõ (backend cũ không trả về) */
  queryIndex: number;
  /** Nhãn nguồn: trúng ở cuộc trò chuyện này là số tầng "#5", ảnh chụp bundle là "Bản lưu cũ" */
  source: string;
  storyTime: string;
  preview: string;
}

/** Ứng viên Rerank cùng kết quả phân mức của nó */
export interface RecallDebugRerankHit {
  leafId: string;
  rerankScore: number;
  similarity: number;
  /** Phân mức: full=gửi toàn văn, brief=gửi tóm tắt, drop=cả hai mức đều không đạt chuẩn nên bị hủy bỏ */
  tier: 'full' | 'brief' | 'drop';
  /** Nhãn nguồn: trúng ở cuộc trò chuyện này là số tầng "#5", ảnh chụp bundle là "Bản lưu cũ" */
  source: string;
  storyTime: string;
  preview: string;
}

export interface RecallDebug {
  /** Thời khắc ghi nhận (Date.now); 0 = chưa có bản ghi */
  at: number;
  /** Văn bản trạng thái: 'Truy xuất hoàn tất' | 'Đang thực hiện…' | 'Chưa truy xuất:…' | 'Thất bại:…' */
  status: string;
  /** Ý đồ bối cảnh của bước viết lại truy vấn (kiêm làm rerank query) */
  intent: string;
  /** Nhiều query tìm kiếm do bước viết lại truy vấn sinh ra */
  queries: string[];
  embedding: RecallDebugEmbedHit[];
  rerank: RecallDebugRerankHit[];
  /** Văn bản cuối cùng được tiêm vào đối thoại chính (trống = lượt này chưa chèn) */
  injectedText: string;
}

function empty(): RecallDebug {
  return { at: 0, status: '', intent: '', queries: [], embedding: [], rerank: [], injectedText: '' };
}

/** Ảnh chụp gỡ lỗi truy xuất toàn cục. UI trực tiếp đăng ký theo dõi; recall.ts ghi vào ở từng giai đoạn. */
export const recallDebug = reactive<RecallDebug>(empty());

/** Xem trước tóm tắt: lấy văn bản tóm tắt cắt ngắn, phục vụ bảng hiển thị trên một dòng (bỏ xuống dòng, giới hạn độ dài). */
export function previewOf(text: string | null | undefined, max = 80): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Mở một lần truy xuất mới: xóa trống các giai đoạn, đặt thành "Đang thực hiện". Gọi sau khi runVectorRecall đi vào đường dẫn hợp lệ. */
export function resetRecallDebug(): void {
  Object.assign(recallDebug, empty(), { at: Date.now(), status: 'Đang thực hiện…' });
}

/** Chỉ cập nhật văn bản trạng thái (các đường dẫn thoát sớm ghi rõ nguyên nhân, như "Chưa truy xuất: Chưa cấu hình viết lại Query"). */
export function setRecallStatus(status: string): void {
  recallDebug.status = status;
  if (!recallDebug.at) recallDebug.at = Date.now();
}

export function setRecallRewrite(intent: string, queries: string[]): void {
  recallDebug.intent = intent;
  recallDebug.queries = [...queries];
}

export function setRecallEmbedding(hits: RecallDebugEmbedHit[]): void {
  recallDebug.embedding = hits;
}

export function setRecallRerank(hits: RecallDebugRerankHit[]): void {
  recallDebug.rerank = hits;
}

export function setRecallInjected(text: string): void {
  recallDebug.injectedText = text;
}

/** Chụp nhanh kết quả gỡ lỗi hiện tại (sao chép sâu), phục vụ lưu giữ trong bộ nhớ đệm truy xuất, khi trúng sẽ restore lại về bảng. */
export function snapshotRecallDebug(): RecallDebug {
  return JSON.parse(JSON.stringify(recallDebug));
}

/** Khôi phục ảnh chụp gỡ lỗi đã lưu đệm về lại bảng (dùng khi trúng bộ nhớ đệm, tránh việc sau khi reset bảng bị trống trơn). */
export function restoreRecallDebug(snap: RecallDebug): void {
  Object.assign(recallDebug, snap);
}
