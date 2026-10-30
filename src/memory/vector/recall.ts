/**
 * Truy xuất vector kiểu chặn (blocking): trước khi sinh câu trả lời chính, tìm kiếm các ký ức cũ liên quan theo đầu vào người dùng + ngữ cảnh gần đây, tiêm vào đối thoại chính.
 *
 * Đường ống (chặn toàn trình, khớp với phương án đã định, không tìm nạp trước / bất đồng bộ):
 *  1. Viết lại truy vấn (khi bật công tắc + đã cấu hình mô hình viết lại Query): mô hình nhỏ viết lại cốt truyện hiện tại thành INTENT + nhiều Q tìm kiếm;
 *     thất bại / chưa bật sẽ kết thúc lần truy xuất này.
 *  2. Mỗi query tự embed → vec/search (scopes = chat hiện tại + các bundle, backend dung hợp đa luồng),
 *     thuần túy lấy rerankCandidates mục đầu tiên theo điểm embedding (không áp ngưỡng).
 *  3. rerank ứng viên (dùng INTENT làm query; kênh chưa cấu hình thì hạ cấp: bỏ qua rerank, dùng thứ tự embedding).
 *  4. Phân mức: mức toàn văn (rerank≥ngưỡng, lấy fullTextCount mục đầu, gửi nguyên văn mes_full) / mức tóm tắt (embedding≥ngưỡng, gửi document).
 *  5. Khử trùng theo leaf_id + loại trừ các lá đã gửi toàn văn trong cửa sổ hiện tại → ghép văn bản tiêm → setExtensionPrompt.
 *
 * Thất bại / chưa cấu hình toàn trình âm thầm hạ cấp (xóa trống khe tiêm), vector là hạng mục tăng cường, tuyệt đối không chặn việc tạo nội dung.
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecHit } from '@/api/baibaoku';
import { vecSearch } from './store';
import { getLeaf, leafValid } from '../apply';
import { MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from '../prompts';
import { embedTexts, encodeFloat32Base64, rerankDocuments } from './embed';
import { rewriteQuery } from './rewrite';
import { ensureRecallIndex } from './index';
import { currentBundleHashes, currentChatId, currentChatScope, currentVectorDb, recallScopes } from './scope';
import { isAiFloor, resolveKeepStart } from '../engine';
import { cleanBody, compactTimeLabel, latestStoryTime, splitTimeLabel } from '../timeTag';
import { relativeTimeLabel } from '../timeRel';
import { normalizeRecallInjectionDepth } from './depth';
import { RECALL_CACHE_STORAGE_KEY } from './cache';
import {
  previewOf,
  resetRecallDebug,
  restoreRecallDebug,
  setRecallEmbedding,
  setRecallInjected,
  setRecallRerank,
  setRecallRewrite,
  setRecallStatus,
  snapshotRecallDebug,
  type RecallDebug,
  type RecallDebugRerankHit,
} from './debug';

// Khe tiêm: bám sát tầng tóm tắt lịch sử (gần đỉnh), cùng khu vực với tóm tắt lịch sử của inject.ts nhưng có key độc lập.
const RECALL_INJECT_KEY = 'baibai_book_vector_recall';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** Độ sâu tiêm truy xuất hiện tại; chuẩn hóa lại lúc chạy, tương thích với giá trị tạm thời không hợp lệ phát sinh khi người dùng đang gõ trong ô nhập. */
function recallInjectionDepth(): number {
  return normalizeRecallInjectionDepth(apiSettings.vector.recall.injectionDepth);
}

/**
 * Nhãn nguồn trúng kết quả:
 *  - scope bằng cuộc trò chuyện hiện tại → trúng tại cuộc trò chuyện này, hiển thị số tầng "#5" (msgIndex chính là số tầng hiện tại);
 *  - Ngược lại (bundle:<hash>) → đến từ ảnh chụp cuộc trò chuyện cũ đóng băng lúc "Tạo cuộc trò chuyện mới kèm dữ liệu", hiển thị "Bản lưu cũ".
 * Tên thật / số tầng của cuộc trò chuyện cũ không được theo dõi (bundle chỉ lưu mã băm), nên thống nhất gắn nhãn "Bản lưu cũ" để người dùng biết không phải cuộc trò chuyện này.
 */
function sourceLabel(hit: VecHit, selfScope: string | null): string {
  if (selfScope && hit.scope === selfScope) {
    return typeof hit.msgIndex === 'number' && hit.msgIndex >= 0 ? `#${hit.msgIndex}` : 'Trò chuyện này';
  }
  return 'Bản lưu cũ';
}

/** Các id lá đã gửi toàn văn bên trong cửa sổ giữ lại hiện tại (truy xuất cần loại trừ chúng, tránh lặp lại với toàn văn). */
function windowLeafIds(chat: STMessage[]): string[] {
  const keepStart = resolveKeepStart(chat);
  const ids: string[] = [];
  for (let i = keepStart; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (leafValid(chat[i])) ids.push(getLeaf(chat[i])!.id);
  }
  return ids;
}

/** Số lượng tầng AI của cuộc trò chuyện hiện tại (cùng tiêu chuẩn với keepRecent/minAiFloors: chỉ đếm tin nhắn AI). */
function aiFloorCount(chat: STMessage[]): number {
  let n = 0;
  for (const m of chat) if (isAiFloor(m)) n++;
  return n;
}

/**
 * Lượt này có đáng chạy truy xuất hay không. Bản lưu cũ (bundle) của việc tạo cuộc trò chuyện mới kèm dữ liệu luôn đáng truy xuất —— bên trong là ký ức cũ mà cuộc trò chuyện hiện tại không có,
 * không chịu bất kỳ giới hạn ngưỡng nào, cho qua thẳng. Khi không có bundle mới xét xem cuộc trò chuyện này có tầng cũ "ngoài cửa sổ" để truy xuất hay không:
 *  - resolveKeepStart===0: chưa có bất kỳ tầng AI nào bị đẩy ra khỏi cửa sổ trượt, tất cả đều gửi toàn văn trong cửa sổ,
 *    các tầng cũ truy xuất được đều sẽ bị windowLeafIds loại trừ hết, thuần túy gây lãng phí (hạn mức và độ trễ của viết lại+embed+search+rerank) → bỏ qua.
 *  - Số tầng AI < minAiFloors (ngưỡng bắt đầu truy xuất do người dùng đặt): cốt truyện giai đoạn đầu có ít ký ức cũ, người dùng thấy chưa cần thiết → bỏ qua.
 * Trúng bất kỳ điều kiện bỏ qua nào là trả về false ngay; ngược lại trả về true.
 */
function recallWorthRunning(chat: STMessage[]): boolean {
  if (currentBundleHashes().length > 0) return true; // Bản lưu cũ truy xuất vô điều kiện
  if (resolveKeepStart(chat) === 0) return false; // Tất cả đều nằm trong cửa sổ, không có tầng cũ ngoài cửa sổ để truy xuất
  const min = Math.max(0, apiSettings.vector.recall.minAiFloors);
  if (min > 0 && aiFloorCount(chat) < min) return false; // Chưa đạt ngưỡng bắt đầu truy xuất của người dùng
  return true;
}

/** Mã băm ổn định gọn nhẹ (FNV-1a, hệ thập lục phân), cùng tiêu chuẩn với index.ts. Dùng làm dấu vân tay nội dung của key bộ nhớ đệm. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Bộ nhớ đệm kết quả truy xuất: khi tạo lại / lật trang (swipe) đầu vào truy xuất không đổi một chữ, trực tiếp tái sử dụng kết quả lần trước,
 * tiết kiệm hạn mức và thời gian của viết lại+embed+search+rerank. Chỉ lưu một mục "lần gần nhất", key không khớp là ghi đè ngay.
 *
 * key = chatId | số tầng user mới nhất | hash(văn bản user mới nhất) | hash(văn bản AI ngay trước) | dấu vân tay tham số truy xuất
 *  - Kèm hash văn bản user: sau khi chỉnh sửa đầu vào mới nhất rồi tạo lại, số tầng không đổi nhưng nội dung đã đổi, dựa vào nó để vô hiệu hóa (nếu không sẽ tái sử dụng sai).
 *  - Kèm hash văn bản AI: sau khi chỉnh sửa tầng AI ngay trước rồi tạo lại, dựa vào nó để vô hiệu hóa.
 *  - Kèm dấu vân tay tham số truy xuất: bất kỳ thay đổi nào về ngưỡng rerank/embedding, số lượng mục v.v. đều làm mất hiệu lực; chỉ sửa cài đặt khác (kênh/công tắc) thì không mất hiệu lực.
 *  - Kèm chatId: sau khi đổi cuộc trò chuyện dù số tầng / mã băm tình cờ giống nhau cũng không trúng nhầm xuyên cuộc trò chuyện.
 */
interface RecallCache {
  key: string;
  text: string;
  debug: RecallDebug;
}

// Lưu tạm vào localStorage: sau khi chuyển sang chạy nền bị trình duyệt hủy, làm mới trang, mở tab mới thì bộ nhớ đệm truy xuất vẫn còn, đỡ phải truy xuất lại vô ích.
// Phần còn sót qua ngày / qua tab không có tác dụng phụ: key đã chứa chatId+tầng lầu+mã băm nội dung+dấu vân tay tham số, không khớp chỉ tính lại chứ tuyệt đối không trúng nhầm.
// (Không vi phạm nguyên tắc "cài đặt đừng dùng localStorage" —— đó là vì cài đặt cần đồng bộ xuyên thiết bị nên bắt buộc đi qua máy chủ; bộ nhớ đệm truy xuất là kết quả tạm trên máy, không cần đồng bộ.)
// Thất bại hoàn toàn âm thầm (chế độ ẩn danh / đầy hạn ngạch): thoái hóa thành không có bộ nhớ đệm, tuyệt đối không ảnh hưởng quy trình truy xuất chính.
function loadRecallCache(): RecallCache | null {
  try {
    const raw = localStorage.getItem(RECALL_CACHE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecallCache) : null;
  } catch {
    return null;
  }
}

function saveRecallCache(cache: RecallCache): void {
  try {
    localStorage.setItem(RECALL_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* Đầy hạn ngạch / không khả dụng: từ bỏ lưu bền vững, lần này chỉ có hiệu lực trong tiến trình hiện tại */
  }
}

/**
 * Dấu vân tay tham số truy xuất: bao phủ toàn bộ các tham số phân mức ảnh hưởng tới văn bản tiêm cuối cùng.
 * Độ sâu tiêm chỉ làm thay đổi vị trí của cùng một văn bản, không làm thay đổi kết quả tìm kiếm, nên không tính vào và có thể tái sử dụng trực tiếp bộ nhớ đệm.
 */
function recallParamFingerprint(cfg: typeof apiSettings.vector.recall): string {
  return [
    cfg.rerankCandidates,
    cfg.embeddingThreshold,
    cfg.rerankThreshold,
    cfg.fullTextCount,
    cfg.finalRecallCount,
  ].join(',');
}

/**
 * Xây dựng key bộ nhớ đệm của lượt hiện tại. Lấy "tầng lầu user mới nhất" cần quét từ sau ra trước tìm is_user đầu tiên ——
 * khi tạo lại ở cuối có thể là tầng AI / tầng hệ thống chờ thay thế, lấy trực tiếp chat[length-1] sẽ lấy sai.
 * Văn bản AI ngay trước = tầng phi user đầu tiên nằm **trước** tầng user đó (không có thì trống).
 * ⚠️ Không được lấy tầng nằm sau user: khi swipe đó chính là tầng AI hiện tại đang bị tạo lại và nội dung mỗi lần đều đổi,
 *    lấy nó thì bộ nhớ đệm không bao giờ trúng, công cốc. Lấy tầng AI ổn định trước user mới đúng.
 * Thiếu chatId hoặc không có tầng user → trả về null, lượt này không đi qua bộ nhớ đệm (tính thực tế như thường).
 */
function buildRecallCacheKey(chat: STMessage[], cfg: typeof apiSettings.vector.recall): string | null {
  const chatId = currentChatId();
  if (!chatId) return null;

  let userIdx = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.is_user) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;

  const userText = chat[userIdx]?.mes ?? '';
  let aiText = '';
  for (let i = userIdx - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) {
      aiText = chat[i]?.mes ?? '';
      break;
    }
  }

  return `${chatId}|${userIdx}|${fnv1a(userText)}|${fnv1a(aiText)}|${recallParamFingerprint(cfg)}`;
}

let recalling = false;

/** Truy xuất có hiệu lực ở cuộc trò chuyện hiện tại hay không. */
function recallActiveHere(): boolean {
  if (!engineActiveHere()) return false; // Tắt công tắc tổng của plugin / nhân vật hiện tại bị loại trừ → không truy xuất
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && recallScopes().length > 0;
}

/** Loại tạo nội dung này có nên kích hoạt truy xuất hay không: chỉ truy xuất trước những lần tạo sản sinh chính văn mới. */
export function shouldRecallForType(type: string | undefined): boolean {
  // Viết tiếp / im lặng / nhập vai không cần truy xuất ký ức cũ (continue viết nối tiếp, quiet/impersonate không phải đẩy cốt truyện tiến lên)
  return type !== 'continue' && type !== 'quiet' && type !== 'impersonate';
}

/** Xóa trống khe tiêm truy xuất (khi hạ cấp / không trúng / chuyển cuộc trò chuyện). */
export function clearRecallInjection(): void {
  getContext()?.setExtensionPrompt?.(RECALL_INJECT_KEY, '', IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
}

/**
 * Thực thi một lần truy xuất chặn và ghi vào khe tiêm. Được await trong đường dẫn cho qua của bộ chặn tạo nội dung.
 * Bất kỳ thất bại nào cũng xóa trống khe và quay về (âm thầm hạ cấp).
 */
export async function runVectorRecall(signal?: AbortSignal): Promise<void> {
  if (!recallActiveHere()) {
    clearRecallInjection();
    return;
  }
  if (recalling) return;
  const database = currentVectorDb();
  if (!database) return;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function' || !chat.length) return;

  // Số tầng còn ít / tất cả đều trong cửa sổ và không có bản lưu cũ: lượt này không có giá trị truy xuất, bỏ qua toàn bộ đường ống (xóa trống khe tiêm, tránh sót lại lần truy xuất trước).
  if (!recallWorthRunning(chat)) {
    setRecallStatus('Chưa truy xuất:Số tầng chưa đạt ngưỡng bắt đầu truy xuất hoặc đều nằm trong cửa sổ');
    clearRecallInjection();
    return;
  }

  const cfg = apiSettings.vector.recall;
  const scopes = recallScopes();

  // Trúng bộ nhớ đệm (tạo lại / lật trang và đầu vào truy xuất không đổi): tái sử dụng trực tiếp văn bản tiêm + ảnh chụp gỡ lỗi lần trước, bỏ qua toàn bộ đường ống.
  const cacheKey = buildRecallCacheKey(chat, cfg);
  const cached = cacheKey ? loadRecallCache() : null;
  if (cacheKey && cached && cached.key === cacheKey) {
    fn(RECALL_INJECT_KEY, cached.text, IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
    restoreRecallDebug(cached.debug);
    setRecallStatus(`${cached.debug.status}(Tái sử dụng bộ nhớ đệm)`);
    return;
  }

  recalling = true;
  try {
    // Mở một ảnh chụp gỡ lỗi mới (đi vào đường dẫn truy xuất hợp lệ mới ghi lại, tránh khi "tính năng chưa bật" lại xóa trống liên tục kết quả lần trước)
    resetRecallDebug();

    // Trước khi truy xuất bù đủ chỉ mục vector còn thiếu ngoài cửa sổ (tải cuộc trò chuyện cũ / bật vector muộn → các lá cũ có thể chưa từng lập chỉ mục),
    // nếu không những cốt truyện cũ này sẽ bị bỏ sót không truy xuất được. Chỉ chặn phần ngoài cửa sổ, trong cửa sổ giao cho tăng thêm chống rung.
    await ensureRecallIndex(signal);

    // 1) Viết lại truy vấn (bắt buộc bật, không hạ cấp): thu được nhiều vector query + văn bản query dùng cho rerank.
    // Viết lại thất bại / không có query sẽ ném lỗi → rơi vào catch tầng ngoài, xóa trống khe tiêm, kết thúc lần truy xuất này.
    const { queryVectors, rerankQuery } = await resolveQueryVectors(signal);
    if (!queryVectors.length) {
      setRecallStatus('Chưa truy xuất:Viết lại truy vấn không tạo ra query');
      clearRecallInjection();
      return;
    }

    // 2) Tìm kiếm backend: đa luồng trong phạm vi thuần túy lấy rerankCandidates mục đầu theo điểm embedding (backend dung hợp max, không áp ngưỡng), loại trừ các lá trong cửa sổ
    const exclude = windowLeafIds(chat);
    const selfScope = currentChatScope();
    const { results } = await vecSearch(database, scopes, queryVectors, {
      topK: Math.max(1, cfg.rerankCandidates),
      excludeLeafIds: exclude,
    });
    setRecallEmbedding(
      results.map(h => ({
        leafId: h.leafId,
        similarity: h.similarity,
        queryIndex: h.queryIndex ?? -1,
        source: sourceLabel(h, selfScope),
        storyTime: compactTimeLabel((h.storyTime || '').trim()),
        preview: previewOf(h.document),
      })),
    );
    if (!results.length) {
      setRecallStatus('Chưa truy xuất:Tìm kiếm không có ứng viên');
      clearRecallInjection();
      return;
    }

    // 3) rerank (dùng INTENT / query viết lại; kênh chưa cấu hình → hạ cấp: dùng thứ tự embedding, score tái sử dụng similarity)
    const ranked = await rerankCandidates(rerankQuery, results, signal);

    // 4) Phân mức + trần giới hạn (now = thời gian mới nhất trong truyện, làm điểm tham chiếu thời gian tương đối, khớp với tiêm tóm tắt lịch sử)
    const now = latestStoryTime(chat);
    const { text, tiers } = buildRecallText(ranked, cfg, selfScope, now);
    recordRerankDebug(ranked, tiers, selfScope);
    fn(RECALL_INJECT_KEY, text, IN_CHAT, recallInjectionDepth(), false, ROLE_SYSTEM, null);
    setRecallInjected(text);
    setRecallStatus(text ? 'Truy xuất hoàn tất' : 'Truy xuất hoàn tất:Không có nội dung đạt chuẩn, lượt này chưa chèn');
    // Tính thực tế thành công mới lưu bộ nhớ đệm (đường dẫn thất bại / hạ cấp không lưu đệm, lần sau thử lại). Lưu ảnh chụp gỡ lỗi để khi trúng khôi phục lại bảng.
    if (cacheKey) saveRecallCache({ key: cacheKey, text, debug: snapshotRecallDebug() });
  } catch (e) {
    console.warn('[Vector Bách Bảo Thư] Truy xuất thất bại (hạ cấp thành không truy xuất):', e);
    setRecallStatus(`Thất bại:${e instanceof Error ? e.message : String(e)}`);
    clearRecallInjection();
  } finally {
    recalling = false;
  }
}

/** Ghi kết quả phân mức vào ảnh chụp gỡ lỗi: khử trùng theo leaf_id (giữ mục đầu tiên), tier lấy nhãn của buildRecallText, mặc định là drop. */
function recordRerankDebug(
  ranked: RankedHit[],
  tiers: Map<string, 'full' | 'brief'>,
  selfScope: string | null,
): void {
  const seen = new Set<string>();
  const hits: RecallDebugRerankHit[] = [];
  for (const h of ranked) {
    if (seen.has(h.leafId)) continue;
    seen.add(h.leafId);
    hits.push({
      leafId: h.leafId,
      rerankScore: h.rerankScore,
      similarity: h.similarity,
      tier: tiers.get(h.leafId) ?? 'drop',
      source: sourceLabel(h, selfScope),
      storyTime: compactTimeLabel((h.storyTime || '').trim()),
      preview: previewOf(h.document),
    });
  }
  setRecallRerank(hits);
}

/**
 * Phân giải nhiều vector query dùng để tìm kiếm + văn bản query dùng cho rerank.
 * Viết lại truy vấn **bắt buộc bật, không hạ cấp**: rewrite thu được INTENT + nhiều Q, mỗi cái tự embed; rerank query dùng INTENT (không có thì dùng Q đầu tiên).
 * Viết lại thất bại / không có query → ném lỗi trực tiếp, do runVectorRecall kết thúc lần truy xuất này (không còn hạ cấp thành query đơn lẻ nữa).
 */
async function resolveQueryVectors(
  signal?: AbortSignal,
): Promise<{ queryVectors: string[]; rerankQuery: string }> {
  const { intent, queries } = await rewriteQuery(signal);
  setRecallRewrite(intent, queries);
  if (!queries.length) throw new Error('Viết lại truy vấn không tạo ra bất kỳ query nào');
  // Vector tìm kiếm: nhiều Q (INTENT thiên về dài và toàn văn, để dành cho rerank, không đưa vào vector tìm kiếm để tránh làm loãng)
  const vecs = await embedTexts(queries, signal);
  const queryVectors = vecs.map(v => encodeFloat32Base64(v));
  return { queryVectors, rerankQuery: intent || queries[0] };
}

interface RankedHit extends VecHit {
  rerankScore: number; // Khi không có rerank = similarity
}

/** Thực hiện rerank cho các ứng viên; thất bại / chưa cấu hình thì hạ cấp bằng thứ tự độ tương đồng embedding. */
async function rerankCandidates(query: string, hits: VecHit[], signal?: AbortSignal): Promise<RankedHit[]> {
  // Kênh rerank chưa cấu hình → hạ cấp trực tiếp (embedTexts/resolveVectorModel khi rerank thiếu kênh sẽ ném lỗi)
  try {
    // Xếp hạng tinh toàn văn: gửi nguyên văn tầng lầu (mesFull, đã chứa thời gian bắt đầu-kết thúc nhúng sẵn) cho rerank, ngữ nghĩa đầy đủ hơn tóm tắt;
    // không có nguyên văn (như lá hạt giống) thì lùi về document tóm tắt, lúc này bù thêm phần đầu 【Thời gian câu chuyện】 để cung cấp ngữ cảnh thời gian.
    // (Quá dài sẽ do bên trong rerankDocuments cắt cụt / chia đợt theo token)
    const docs = hits.map(h => {
      // mesFull hiện lưu nguyên văn, trước khi gửi cho rerank thì đi qua cleanBody (loại bỏ thanh trạng thái / chuỗi suy nghĩ / thẻ tùy chỉnh v.v.,
      // giữ lại thời gian bắt đầu-kết thúc nhúng sẵn); chỉ mục cũ lưu văn bản đã làm sạch, rửa thêm lần nữa vẫn bất biến không gây tác dụng phụ.
      const full = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      if (full) return full;
      const body = (h.document || '').trim();
      const t = (h.storyTime || '').trim();
      return t ? `【${t}】\n${body}` : body;
    });
    const order = await rerankDocuments(query, docs, hits.length, signal);
    // order là {index, score} giảm dần; ánh xạ ngược về hit
    return order
      .filter(o => hits[o.index])
      .map(o => ({ ...hits[o.index], rerankScore: o.score }));
  } catch {
    // Hạ cấp: giữ nguyên thứ tự embedding, rerankScore tái sử dụng similarity
    return hits.map(h => ({ ...h, rerankScore: h.similarity }));
  }
}

/**
 * Ghép văn bản tiêm theo quy tắc phân mức:
 *  - Mức toàn văn: rerankScore ≥ rerankThreshold, lấy fullTextCount mục đầu, gửi mes_full (không có thì lùi về document).
 *  - Mức tóm tắt: rerankScore < rerankThreshold nhưng similarity ≥ embeddingThreshold, gửi document.
 *  - Tổng số ≤ finalRecallCount; khử trùng theo leaf_id (đã gộp xuyên scope ở backend, ở đây dự phòng thêm một lớp).
 *
 * Trả về văn bản tiêm đã ghép xong + phân mức (full/brief) của từng lá được chấp nhận, phục vụ bảng gỡ lỗi gắn nhãn tier.
 */
function buildRecallText(
  ranked: RankedHit[],
  cfg: typeof apiSettings.vector.recall,
  selfScope: string | null,
  now: string,
): { text: string; tiers: Map<string, 'full' | 'brief'> } {
  const seen = new Set<string>();
  const tiers = new Map<string, 'full' | 'brief'>();
  const fullChunks: string[] = [];
  const briefChunks: string[] = [];
  let fullUsed = 0;

  for (const h of ranked) {
    if (seen.size >= cfg.finalRecallCount) break;
    if (seen.has(h.leafId)) continue;

    const isFull = h.rerankScore >= cfg.rerankThreshold && fullUsed < cfg.fullTextCount;
    if (isFull) {
      // Mức toàn văn ưu tiên gửi mesFull (nguyên văn, sau khi làm sạch qua cleanBody đã chứa thời gian bắt đầu-kết thúc nhúng sẵn), không có thì lùi về document
      const cleanFull = h.mesFull ? cleanBody(h.mesFull).trim() : '';
      const useMesFull = !!cleanFull;
      const body = cleanFull || (h.document || '').trim();
      if (!body) continue;
      seen.add(h.leafId);
      tiers.set(h.leafId, 'full');
      fullUsed++;
      // mesFull tự mang (Thời gian bắt đầu…)/(Thời gian kết thúc…), không thêm đầu 【】 nữa để tránh lặp thời gian; khi lùi về document mới bù phần đầu
      fullChunks.push(fmtChunk(h, body, useMesFull, selfScope, now));
    } else if (h.similarity >= cfg.embeddingThreshold) {
      const body = (h.document || '').trim();
      if (!body) continue;
      seen.add(h.leafId);
      tiers.set(h.leafId, 'brief');
      briefChunks.push(fmtChunk(h, body, false, selfScope, now)); // Mức tóm tắt không có thời gian nhúng sẵn, bù phần đầu 【(tương đối) khoảng thời gian】
    }
    // Cả hai mức đều không đạt chuẩn: hủy bỏ
  }

  const chunks = [...fullChunks, ...briefChunks];
  if (!chunks.length) return { text: '', tiers };
  // Đầu cuối đóng khung bằng bản tin mật, tránh mô hình chính coi ký ức truy xuất là khuôn mẫu cần thuật lại / xuất ra
  return { text: `${MEMORY_BRIEFING_NOTE}\n[Ký ức liên quan]\n${chunks.join('\n\n')}\n${MEMORY_BRIEFING_END}`, tiers };
}

/**
 * Định dạng "đoạn bắt đầu-kết thúc chưa nén" lưu lúc lập chỉ mục thành phần đầu thời gian để hiển thị: 【(tương đối) bắt đầu - kết thúc】.
 *  - Nén thành hiển thị khoảng (compactTimeLabel: xóa ngày tháng bị lặp ở đầu kết thúc);
 *  - Dùng thời gian kết thúc so với "hiện tại" (thời gian mới nhất trong truyện now) để tính tiền tố tương đối (khớp với inject.ts của tóm tắt lịch sử).
 * Không có thời gian → chuỗi rỗng.
 */
function fmtStoryTimeHead(storyTime: string, now: string): string {
  const t = storyTime.trim();
  if (!t) return '';
  const shown = compactTimeLabel(t);
  const end = splitTimeLabel(t).end ?? '';
  const rel = relativeTimeLabel(end, now);
  return rel ? `【(${rel}) ${shown}】` : `【${shown}】`;
}

/**
 * Một đoạn mảnh truy xuất đơn lẻ: đầu dòng thêm nhãn nguồn (cuộc trò chuyện này "#5" / Bản lưu cũ), để mô hình chính biết xuất xứ của đoạn ký ức này;
 * khi body chưa tự mang thời gian nhúng sẵn thì bù thêm một phần đầu thời gian câu chuyện 【(tương đối) bắt đầu - kết thúc】 (nếu có).
 */
function fmtChunk(h: RankedHit, body: string, bodyHasInlineTime: boolean, selfScope: string | null, now: string): string {
  const src = `[${sourceLabel(h, selfScope)}]`;
  if (bodyHasInlineTime) {
    // Bản thân toàn văn giữ lại thẻ thời gian bắt đầu-kết thúc gốc, nhưng vẫn cần bổ sung thời gian tương đối ở trước toàn văn,
    // tránh việc mức toàn văn và mức tóm tắt biểu hiện không nhất quán về cảm nhận thời gian.
    const end = splitTimeLabel((h.storyTime || '').trim()).end ?? '';
    const rel = relativeTimeLabel(end, now);
    return rel ? `${src}【${rel}】 ${body}` : `${src} ${body}`;
  }
  const head = fmtStoryTimeHead(h.storyTime || '', now);
  return head ? `${src}${head}${body}` : `${src} ${body}`;
}
