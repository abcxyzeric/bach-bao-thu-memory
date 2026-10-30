import type { ChatMsg } from '@/api/client';
import { mainApiAvailable, requestCompletion, requestViaMainApi } from '@/api/client';
import { apiSettings, engineActiveHere, getChannelForTask } from '@/api/settings';
import type { TaskType } from '@/api/settings';
import type { STMessage, WorldInfoEntry } from '@/st/context';
import { getContext, getCheckWorldInfo, getEjsTemplate, setMessageText } from '@/st/context';
import { toast } from '@/st/toast';
import { addSummary, classifyNpcPresence, deriveMemory, finalizeDelta, fmtVarOpsInline, getLeaf, invalidateSummaryAncestors, itemChangesOf, leafValid, makeLeafId, pruneBrokenComps, syncItemLogFromMessage } from './apply';
import { selectKnowledgeForSummary } from './knowledge';
import { extractJsonObject } from './json';
import { clearInjection, refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { buildBatchSummaryPrompt, buildBatchThinking, buildCharCardSystem, buildPersonaSystem, buildResummaryPrompt, buildSummaryPrompt, buildSummaryThinking, buildWorldInfoSystem, fmtItemLogInline, JAILBREAK_PROMPT, RESUMMARY_THINKING_CHECKLIST, selectRecentResolvedPlans } from './prompts';
import { clampToTimeTags, cleanBody, parseTimeRange, syncTimeTagRegex, writeItemLogTag, writeVarLogTag } from './timeTag';
import { renderSourceHints, type SourceExcerpt } from './sourceHints';
import { memory, recomputeDerived, scheduleLeafFlush } from './store';
import type { LeafExtra, SummaryDelta } from './types';
import { scheduleVectorIndex } from './vector';
import { invalidateRecallCache } from './vector/cache';
import { clearRecallInjection } from './vector/recall';
import { reactive, watch } from 'vue';

function llmString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function llmScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function llmOptionalScalar(v: unknown): string | undefined {
  return llmScalar(v) || undefined;
}

/** Trạng thái chạy của engine (phục vụ hiển thị UI) */
export const engineState = reactive({
  running: false,
  lastError: '' as string,
  lastRunAt: 0,
});

/**
 * Trạng thái tóm tắt đơn tầng (dùng chung cho tự động tóm tắt / tóm tắt bù / tóm tắt lại; singleton cấp mô-đun, phục vụ UI khôi phục vòng xoay ở tầng tương ứng sau khi đóng rồi mở lại cửa sổ).
 * chatId dùng để cô lập cuộc trò chuyện: khi chuyển sang cuộc trò chuyện khác sẽ không hiển thị nhầm số tầng giống nhau thành đang tóm tắt bù.
 */
export const floorBackfillState = reactive({
  running: false,
  floor: null as number | null,
  chatId: '',
});
let floorBackfillOwnerRunId: number | null = null;

/**
 * Trạng thái chạy tóm tắt bù hàng loạt (singleton cấp mô-đun, phục vụ UI khôi phục tiến độ / nút hủy sau khi đóng rồi mở lại cửa sổ).
 * Đặt ở đây thay vì ref cục bộ của component: cửa sổ Bách Bảo Thư đóng lại sẽ hủy component, mất ref cục bộ, nhưng batchBackfill vẫn chạy tiếp trong mô-đun này ——
 * đóng cửa sổ ≠ hủy bỏ. Sau khi mở lại, component chỉ cần đọc singleton này là khôi phục được hiển thị "Đang tóm tắt bù X/Y + Hủy".
 */
export const batchState = reactive({
  running: false,
  done: 0,
  total: 0,
  cancelRequested: false, // Người dùng đã bấm hủy, đợi có hiệu lực ở ranh giới khối
});

/** Yêu cầu hủy bỏ việc tóm tắt bù hàng loạt đang diễn ra (có hiệu lực ở ranh giới khối, không ngắt ngang khối đang chạy). */
export function cancelBatchBackfill(): void {
  if (batchState.running) batchState.cancelRequested = true;
}

let busy = false;
// Tín hiệu hoàn thành tóm tắt đang bay hiện tại: bộ chặn có thể await nó (thành công / thất bại đều resolve, không bao giờ reject, nên sẽ không làm treo việc tạo).
// Khi không có tóm tắt đang bay thì là null. Được duy trì ở đầu và cuối runSummary.
let currentRun: Promise<void> | null = null;
let summaryRunSeq = 0;
export function currentSummaryPromise(): Promise<void> | null {
  return currentRun;
}

/** Kết xuất tin nhắn thành văn bản đưa cho mô hình tóm tắt (cleanBody: cắt gọn đoạn chính văn + xóa nguyên khối thẻ nhiễu + chuyển thẻ thời gian thành văn bản) */
function renderMessages(chat: STMessage[], indices: number[], name1: string, name2: string): string {
  const sources: SourceExcerpt[] = [];
  const content = indices
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      // Nhãn kép: vừa ghi bên phát ngôn (Người dùng/Nhân vật), vừa kèm tên người —— chính văn tóm tắt dùng tên người, trò chuyện nhóm cũng phân biệt được ai nói
      const tag = m.is_user ? 'Người dùng' : 'Nhân vật';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      // cleanBody: cắt gọn vào <bbs_start>…</bbs_end> (loại bỏ định dạng ngoài chính văn như thanh trạng thái) + xóa nguyên khối thẻ nhiễu
      // (chuỗi suy nghĩ/chú thích/chú thích vật phẩm/thẻ tùy chỉnh) + chuyển thẻ thời gian thành văn bản dễ đọc. Không còn xóa trần thẻ.
      // Chỉ đánh số cho tài liệu yêu cầu; dùng số thứ tự tin nhắn trò chuyện, cùng một chính văn trong đơn tầng và hàng loạt giữ cùng nhãn nguồn.
      const body = cleanBody(m.mes).split(/\r?\n/)
        .filter(line => line.trim())
        .map((line, p) => {
          const excerpt = { source: `[M${i + 1}-P${p + 1}]`, text: line };
          sources.push(excerpt);
          return `${excerpt.source} ${excerpt.text}`;
        })
        .join('\n');
      return `【${tag}·${who}】\n${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
  return content + renderSourceHints(sources);
}

/** Khử trùng và join các phân đoạn sau khi đã bỏ trống. Các nguồn kích hoạt sách thế giới thống nhất gom về đây (nhất quán với hành vi cũ). */
function joinWorldInfoChunks(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const t = c?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join('\n\n').trim();
}

/**
 * Phán đoán xem một mục có nên bị loại trừ hay không: ① Loại trừ cả cuốn (world nằm trong danh sách); ② Tên mục (comment) trúng bất kỳ quy tắc nào.
 * Quy tắc biên dịch theo regex, **không phân biệt hoa thường** (điền mvu sẽ trúng [MVU]); tên thông thường tự nhiên = khớp bao hàm.
 * Biên dịch thất bại thì hạ cấp thành bao hàm chuỗi con nguyên văn (không phân biệt hoa thường) —— người dùng có điền tên thông thường chứa siêu ký tự (như "(tạm thời)")
 * cũng không làm hỏng nhầm, chỉ thoái hóa thành đối chiếu chuỗi con.
 */
function isWorldInfoEntryExcluded(entry: WorldInfoEntry): boolean {
  const world = entry.world?.trim();
  if (world && apiSettings.excludedWorldNames.includes(world)) return true;
  const comment = entry.comment?.trim();
  if (!comment) return false;
  for (const raw of apiSettings.excludedWorldInfoPatterns) {
    const pat = raw.trim();
    if (!pat) continue;
    let hit = false;
    try {
      hit = new RegExp(pat, 'i').test(comment);
    } catch {
      hit = comment.toLowerCase().includes(pat.toLowerCase()); // Regex không hợp lệ → thoái hóa thành bao hàm chuỗi con chữ
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Mảng quét văn bản chờ tóm tắt của lượt này (chính văn các tầng sau khi làm sạch, kèm tiền tố tên người giúp từ khóa trúng tên nhân vật).
 * Dùng chung cho checkWorldInfo / getWorldInfoPrompt.
 */
function buildScanText(chat: STMessage[], targets: number[], name1: string, name2: string): string[] {
  return targets
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      return `${who}: ${clampToTimeTags(m.mes)}`;
    })
    .filter(Boolean);
}

// Nội bộ ST: ngân sách thực tế của WI = world_info_budget (mặc định 25%) × maxContext, vượt quá là cắt cụt mục (đèn xanh lam cũng không ngoại lệ).
// Kịch bản tóm tắt cần "mục đã kích hoạt không sót một mục nào", nên truyền một maxContext cực lớn, để ngân sách lớn đến mức không thể tràn.
// (Nếu người dùng đặt trần world_info_budget_cap, vẫn sẽ bị nó khống chế —— đó là giới hạn cứng tường minh của người dùng, tôn trọng nó.)
const HUGE_WI_CONTEXT = 1_000_000_000;

/**
 * Kết xuất nội dung mục sách thế giới, để API phụ nhận được thành phẩm "sau khi thực thi" thay vì nguyên văn:
 *   ① substituteParams mở rộng {{macro}} (bao gồm macro tùy chỉnh của JS-Slash-Runner đăng ký qua MacrosParser);
 *   ② Nếu có cài ST-Prompt-Template (khuôn mẫu prompt) và văn bản chứa <% %>, gọi bộ thực thi của nó chạy EJS
 *      (như các mục điều kiện "chuyển đổi thiết lập nhân vật theo độ hảo cảm").
 * Sao chép đúng thứ tự evaluateWIEntities chính thức của nó (macro trước EJS sau). Khi tắt công tắc renderWorldInfoTemplates thì bỏ qua toàn bộ.
 *
 * Thời điểm biến số (floor): truyền làm **tầng lầu cắt** vào tham số thứ hai của prepareContext (chữ ký giao diện xuất ra là
 * (context, end), end chính là msg_id). Như vậy getvar trong EJS đọc được là **ảnh chụp biến số cấp tầng lầu của đúng tầng đó**
 * (các framework lưu trữ theo cấp message như MVU tự nhiên khớp được), chứ không phải giá trị mới nhất hiện tại —— khi tổng kết tầng cũ phải dùng độ hảo cảm của thời điểm đó.
 *   - floor lược bỏ (đường dẫn hạ cấp không lấy được tầng lầu) → prepareContext mặc định lấy tầng mới nhất.
 *   - Nếu biến của tầng đó chỉ ở cấp cuộc trò chuyện (một giá trị mới nhất duy nhất) mà không có ảnh chụp tầng lầu → vẫn là giá trị mới nhất (hạ cấp êm đẹp, không tệ hơn ban đầu).
 *
 * ⚠️ EJS có chứa ghi biến (setvar v.v.) mỗi lần tóm tắt sẽ thực thi thêm, làm bẩn trạng thái, nên đã cung cấp công tắc để người dùng có thể tắt.
 * Một mục thất bại không ảnh hưởng tổng thể: lùi về văn bản bước trước của mục đó (đã mở rộng macro / nguyên văn), và ghi log.
 */
async function renderWorldInfoContent(content: string, entry?: WorldInfoEntry, floor?: number): Promise<string> {
  if (!apiSettings.renderWorldInfoTemplates) return content;
  const ctx = getContext();
  // ① Mở rộng macro (khi substituteParams không tồn tại thì giữ nguyên văn)
  let text = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(content) : content;
  // ② Không có thẻ EJS thì không cần gọi plugin khuôn mẫu (đỡ tốn chi phí prepareContext/sandbox)
  if (!text.includes('<%')) return text;
  const ejs = getEjsTemplate();
  if (!ejs) return text; // Chưa cài ST-Prompt-Template: chỉ mở rộng macro
  try {
    // Tham số thứ hai end=floor: để getvar tính giá trị bằng ảnh chụp biến số "tính đến tầng đó"; khi undefined giao diện mặc định lấy tầng mới nhất
    const env = await ejs.prepareContext({ world_info: entry }, floor);
    const out = await ejs.evalTemplate(text, env);
    if (typeof out === 'string') text = out;
  } catch (e) {
    console.log('[Bách Bảo Thư] Kết xuất EJS sách thế giới thất bại (lùi về văn bản chưa thực thi):', e);
  }
  return text;
}

/**
 * Đường dẫn hạ cấp: đi qua getWorldInfoPrompt do ST bộc lộ (chỉ lấy được chuỗi đã ghép sẵn, **không thể lọc theo tên**).
 * Chỉ dùng khi không lấy được checkWorldInfo —— lúc này cài đặt loại trừ không có hiệu lực, nhưng ít nhất tóm tắt vẫn mang theo sách thế giới như thường, không sập.
 * Đèn xanh lam / các mục liên quan có thể rơi vào bất kỳ vị trí nào trong before, after, depth (@độ sâu), ghi chú tác giả, trích xuất toàn bộ.
 */
async function fetchWorldInfoViaPrompt(scanText: string[], refFloor?: number): Promise<string> {
  const fn = getContext()?.getWorldInfoPrompt;
  if (typeof fn !== 'function') return '';
  const res = await fn(scanText, HUGE_WI_CONTEXT, true);
  if (!res) return '';
  const chunks: string[] = [];
  if (typeof res.worldInfoBefore === 'string') chunks.push(res.worldInfoBefore);
  if (typeof res.worldInfoAfter === 'string') chunks.push(res.worldInfoAfter);
  for (const d of res.worldInfoDepth ?? []) {
    for (const e of d?.entries ?? []) if (typeof e === 'string') chunks.push(e);
  }
  for (const e of res.anBefore ?? []) if (typeof e === 'string') chunks.push(e);
  for (const e of res.anAfter ?? []) if (typeof e === 'string') chunks.push(e);
  // Kết xuất từng khối (mở rộng macro + EJS); đường dẫn này không lấy được đối tượng mục, EJS chỉ mang ngữ cảnh trạng thái hiện tại (không có world_info), nhưng vẫn lấy biến theo refFloor
  const rendered = await Promise.all(chunks.map(c => renderWorldInfoContent(c, undefined, refFloor)));
  return joinWorldInfoChunks(rendered);
}

// Enum vị trí chèn mục sách thế giới (khớp với ST world_info_position; giá trị chưa biết quy vào "Khác" xếp cuối cùng, không làm mất mục)
const WI_POSITION_BEFORE = 0;
const WI_POSITION_AT_DEPTH = 4;

// Thứ tự nhóm: sao chép thứ tự xuất hiện trước sau của các loại mục trong prompt chính của ST (thứ tự đưa vào của populateChatCompletion trong openai.js):
// worldInfoBefore(0 trước nhân vật) → worldInfoAfter(1 sau nhân vật) → trước ghi chú tác giả(2) → sau ghi chú tác giả(3) → @độ sâu(4) → EM trên(5) → EM dưới(6)
// Cổng ra (outlet, 7) do vị trí khuôn mẫu PromptManager quyết định, không có thứ tự cố định, quy vào "Khác" xếp ở cuối.
const WI_BUCKET_ORDER: Record<number, number> = {
  0: 0, // before trước nhân vật
  1: 1, // after sau nhân vật
  2: 2, // ANTop trước ghi chú tác giả
  3: 3, // ANBottom sau ghi chú tác giả
  4: 4, // atDepth @độ sâu
  5: 5, // EMTop mốc EM trên
  6: 6, // EMBottom mốc EM dưới
  7: 99, // outlet cổng ra: không có vị trí cố định, thống nhất quy vào khác
};

/** Order mặc định khi ST tạo mục mới (world-info.js newWorldInfoEntryDefinition.order.default) */
const WI_DEFAULT_ORDER = 100;

/** Độ sâu mặc định khi ST tạo mục mới (newWorldInfoEntryDefinition.depth.default = DEFAULT_DEPTH) */
const WI_DEFAULT_DEPTH = 4;

/**
 * Sắp xếp các mục đã kích hoạt theo đúng thứ tự của prompt chính ST (order tăng dần trong nhóm + giữa các nhóm theo thứ tự xuất hiện trước sau):
 * Nội bộ ST (đoạn cuối world-info.js) là "duyệt theo order giảm dần + chèn đầu unshift" → tương đương order tăng dần trong cùng vị trí;
 * allActivatedEntries mà chúng ta lấy được là thứ tự trúng khi quét (thứ tự chèn Set/Map), chưa bao gồm bước này, nên sao chép lại tại đây.
 * Thứ tự giữa các nhóm theo thứ tự chúng đi vào prompt chính (trước nhân vật → sau nhân vật → trước/sau ghi chú tác giả → @độ sâu → EM);
 * bên trong nhóm @độ sâu lại xếp theo depth giảm dần (độ sâu lớn xuất hiện sớm hơn trong prompt) rồi mới theo order tăng dần.
 * Khi thiếu position/order/depth thì dùng giá trị mặc định của ST (0/100/4) làm đáy; position chưa biết quy vào "Khác" xếp ở cuối.
 */
function sortWorldInfoEntriesLikeST(entries: WorldInfoEntry[]): WorldInfoEntry[] {
  return [...entries].sort((a, b) => {
    const pa = WI_BUCKET_ORDER[Number(a.position ?? WI_POSITION_BEFORE)] ?? 99;
    const pb = WI_BUCKET_ORDER[Number(b.position ?? WI_POSITION_BEFORE)] ?? 99;
    if (pa !== pb) return pa - pb;
    // Cùng là @độ sâu: độ sâu lớn xuất hiện trước (trong prompt nằm xa cuộc đối thoại hơn)
    if (pa === WI_BUCKET_ORDER[WI_POSITION_AT_DEPTH]) {
      const da = Number(a.depth ?? WI_DEFAULT_DEPTH);
      const db = Number(b.depth ?? WI_DEFAULT_DEPTH);
      if (da !== db) return db - da;
    }
    // Trong nhóm: order tăng dần (kết quả tương đương của duyệt giảm dần + chèn đầu trong ST); phi chữ số / bị thiếu tính theo mặc định 100
    const oa = Number.isFinite(a.order as number) ? Number(a.order) : WI_DEFAULT_ORDER;
    const ob = Number.isFinite(b.order as number) ? Number(b.order) : WI_DEFAULT_ORDER;
    return oa - ob;
  });
}

/**
 * Kích hoạt các mục sách thế giới theo văn bản chờ tóm tắt của lượt này (kích hoạt bằng từ khóa + đèn xanh lam constant), sau khi lọc trả về văn bản thiết lập.
 * Ưu tiên đi qua checkWorldInfo: nó trả về **đối tượng mục** (kèm world/comment), dựa vào đó lọc bỏ các mục không cần thiết theo "loại trừ cả cuốn" + "quy tắc tên mục"
 * (như sách kiến thức phụ gắn toàn cục). Logic kích hoạt (độ sâu quét/đệ quy/ngân sách) đều nằm bên trong nó, không đụng vào.
 * Không lấy được checkWorldInfo (bản cũ / đổi đường dẫn) → hạ cấp xuống getWorldInfoPrompt (không lọc, nhưng tóm tắt vẫn mang theo sách như thường, không sập).
 * Không có mục kích hoạt / thẻ nhân vật không có sách thế giới / xảy ra lỗi → trả về chuỗi rỗng (không ảnh hưởng việc tóm tắt chạy bình thường).
 */
async function fetchWorldInfo(chat: STMessage[], targets: number[], name1: string, name2: string): Promise<string> {
  const scanText = buildScanText(chat, targets, name1, name2);
  if (!scanText.length) return '';
  // Tầng đại diện thời điểm biến số: lấy **tầng target cuối cùng** của đợt này (= trạng thái khi kết thúc đoạn cốt truyện này, khớp nhất với việc "tổng kết đoạn này đã xảy ra chuyện gì").
  // targets là chỉ mục chat tăng dần; trống thì undefined (hạ cấp lấy mới nhất). getvar trong EJS dựa vào đây đọc ảnh chụp biến số lịch sử của tầng đó.
  const refFloor = targets.length ? targets[targets.length - 1] : undefined;
  try {
    const check = await getCheckWorldInfo();
    if (!check) return await fetchWorldInfoViaPrompt(scanText, refFloor); // Hạ cấp: không lấy được đối tượng mục, không có cách nào lọc

    const res = await check(scanText, HUGE_WI_CONTEXT, true);
    const activated = res?.allActivatedEntries;
    if (!activated) return '';
    // allActivatedEntries có thể là Set<entry> hoặc Map<key,entry>, thống nhất lấy values;
    // sau đó xếp thành thứ tự giống hệt prompt chính của ST (thứ tự trúng khi quét chưa gồm sắp xếp, xem sortWorldInfoEntriesLikeST)
    const entries = sortWorldInfoEntriesLikeST(
      activated instanceof Map ? [...activated.values()] : [...activated],
    );
    // Kết xuất từng mục (mở rộng macro + thực thi EJS), để các mục động như "chuyển đổi thiết lập theo độ hảo cảm" nhận được thành phẩm thay vì nguyên văn; biến số lấy giá trị lịch sử theo refFloor
    const chunks = await Promise.all(
      entries
        .filter(e => e && !isWorldInfoEntryExcluded(e))
        .map(e => renderWorldInfoContent(typeof e.content === 'string' ? e.content : '', e, refFloor)),
    );
    return joinWorldInfoChunks(chunks);
  } catch (e) {
    console.log('[Bách Bảo Thư] Kích hoạt sách thế giới thất bại (hạ cấp thành không mang theo thiết lập):', e);
    return '';
  }
}

/**
 * Lấy các trường thiết lập nhân vật của thẻ nhân vật hiện tại (description / personality / scenario).
 * Có những thẻ viết thiết lập nhân vật ở phần mô tả nhân vật thay vì trong sách thế giới, việc tóm tắt cũng cần dựa vào đó để hiểu lời nói hành động của nhân vật.
 *   - Cả ba trường đều thử lấy, trường trống tự động bỏ qua (thẻ hiện đại thường chỉ điền description);
 *   - Trong trường có thể chứa macro {{char}}/{{user}}, dùng substituteParams để mở rộng;
 *   - Trò chuyện nhóm (characterId trống) tạm thời không mang theo —— logic gộp nhiều thành viên phức tạp, để làm sau.
 * Không lấy được nhân vật / trống toàn bộ → trả về chuỗi rỗng (hạ cấp, không ảnh hưởng tóm tắt).
 */
function fetchCharCard(): string {
  const ctx = getContext();
  if (!ctx || ctx.groupId) return ''; // Trò chuyện nhóm tạm thời không mang theo
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return '';
  const ch = ctx.characters?.[Number(idx)] as Record<string, unknown> | undefined;
  if (!ch) return '';
  const sub = typeof ctx.substituteParams === 'function' ? ctx.substituteParams : (s: string) => s;
  const fields: Array<[string, string]> = [
    ['Mô tả', String(ch.description ?? '')],
    ['Tính cách', String(ch.personality ?? '')],
    ['Bối cảnh', String(ch.scenario ?? '')],
  ];
  const parts: string[] = [];
  for (const [label, raw] of fields) {
    const t = sub(raw).trim();
    if (t) parts.push(`【${label}】\n${t}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * Lấy thiết lập người dùng hiện tại (persona / thiết lập người dùng).
 * Đi qua macro ổn định của ST là {{persona}} (= power_user.persona_description), mở rộng bằng substituteParams là có ngay;
 * không đi lục tìm biến toàn cục power_user, giữ nguyên tắc "chỉ tiếp xúc với host thông qua context".
 * Công dụng: API phụ tóm tắt vốn chỉ biết thẻ nhân vật (phía {{char}}), không biết nhân vật chính ({{user}}) là ai,
 * khi viết summary, phán đoán "tương tác giữa NPC và user" bị khuyết mất một mảng. Mang theo persona sẽ bù đắp phía bên này.
 * Trò chuyện nhóm cũng áp dụng tương tự (persona độc lập với nhân vật, không thoát sớm theo groupId); chưa đặt persona / không lấy được → chuỗi rỗng (hạ cấp).
 */
function fetchUserPersona(): string {
  const ctx = getContext();
  if (!ctx || typeof ctx.substituteParams !== 'function') return '';
  return ctx.substituteParams('{{persona}}').trim();
}

// Câu cố định trong chính văn tầng thông báo, vừa để người dùng xem, vừa dùng làm lính canh nhận diện tương thích dữ liệu cũ và khử trùng tầng cuối.
const BACKLOG_NOTICE_SENTINEL = 'Lần tạo này đã bị chặn';
const LEGACY_BACKLOG_SENTINEL = '\u672c\u6b21\u751f\u6210\u5df2\u62e6\u622a';

/** Có phải tầng thông báo tồn đọng do chính Bách Bảo Thư chèn vào hay không. Nhận diện chính văn chỉ dùng để tương thích với các tầng thông báo cũ trước khi nâng cấp chưa mang nhãn chuyên dụng. */
function isBacklogNotice(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (m.extra?.bbs_internal_notice === 'backlog') return true;
  return (m.name === 'Bách Bảo Thư' || m.name === '\u67cf\u5b9d\u4e66')
    && typeof m.mes === 'string'
    && (m.mes.includes(BACKLOG_NOTICE_SENTINEL) || m.mes.includes(LEGACY_BACKLOG_SENTINEL));
}

/**
 * Đánh dấu tầng thông báo tồn đọng thành tầng nội bộ:
 *  - bbs_internal_notice: xác định rõ danh tính, tránh dựa vào chính văn để phán đoán lâu dài;
 *  - bbs_omit: tái sử dụng kênh "hoàn toàn không tham gia vào trí nhớ" hiện có, đảm bảo cho dù tầng thông báo cũ từng bị tóm tắt nhầm thì lá của nó cũng không còn được phát lại / tiêm.
 * Trả về có sửa đổi chat hay không, bên gọi dựa vào đó tính lại và lưu đĩa.
 */
function normalizeBacklogNotices(chat: STMessage[]): boolean {
  let changed = false;
  for (const m of chat) {
    if (!isBacklogNotice(m)) continue;
    if (m.extra?.bbs_internal_notice === 'backlog' && m.extra?.bbs_omit === true) continue;
    m.extra = { ...(m.extra ?? {}), bbs_internal_notice: 'backlog', bbs_omit: true };
    changed = true;
  }
  if (changed) {
    recomputeDerived();
    scheduleLeafFlush();
  }
  return changed;
}

/**
 * Có phải "tầng lầu AI có thể theo dõi" hay không. Tách rời với việc "có hiển thị với LLM chính hay không" —— ẩn hay không đều phải tính, miễn nó là câu trả lời AI thực sự.
 *
 * Phân biệt then chốt: `is_system=true` có hai nguồn gốc, không thể loại trừ vơ đũa cả nắm:
 *   ① Câu trả lời AI thực sự bị ẩn (do chúng ta /hide → mang extra.bbs_hidden; hoặc do người dùng / tiện ích khác /hide → không nhãn)
 *      —— Đây là phát ngôn thực sự của nhân vật, **bắt buộc phải tính là tầng AI**, nếu không tầng đã ẩn sẽ bị bỏ sót không tóm tắt (điểm đau thực tế người dùng gặp).
 *   ② Tầng hệ thống gốc của ST (/sys, /comment, tiêm tự sự v.v.) —— Những tầng này mang extra.type, **không tính**.
 * Dựa vào đó: không phải người dùng, có chính văn, và không phải "tầng hệ thống gốc có mang type" tức là tầng AI. Câu trả lời hiển thị thông thường is_system=false tự nhiên trúng.
 */
export function isAiFloor(m: STMessage | undefined): boolean {
  // Tầng ngoại truyện (bbs_omit): hoàn toàn không tồn tại đối với engine —— không tóm tắt, không tổng kết, không phát lại, không tiêm, không đếm ẩn.
  // Đặt ở ngay đầu tiên để ngắt mạch, đứng trên mọi phán đoán khác (bao gồm cả bbs_hidden).
  if (m?.extra?.bbs_omit) return false;
  return isRealAiReply(m);
}

/**
 * Có phải "tầng câu trả lời AI thực sự" hay không —— chỉ xét tính chất vật lý của bản thân tin nhắn, **không xét nhãn ngoại truyện**.
 * Khác biệt với isAiFloor: tầng ngoại truyện vẫn là câu trả lời AI thực sự (isRealAiReply=true), chỉ là bị engine loại trừ (isAiFloor=false).
 * Mốc neo trong tầng cần gắn trên mọi câu trả lời AI thực sự (gồm cả những tầng đã đánh dấu ngoại truyện, nếu không sẽ không có chỗ để bỏ đánh dấu ngoại truyện), nên dùng hàm này thay vì isAiFloor.
 */
export function isRealAiReply(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (isBacklogNotice(m)) return false; // Tầng thông báo nội bộ của plugin không phải chính văn cốt truyện, không gắn bảng trong tầng, không tham gia trí nhớ
  if (m.extra?.bbs_hidden) return true; // Tầng AI cũ bị chúng ta ẩn đi
  // Tầng hệ thống gốc của ST mang extra.type (narrator/sys v.v.); câu trả lời thực sự (hiển thị hoặc bị /hide) không có type.
  if (m.is_system && m.extra?.type) return false;
  return true;
}

/**
 * Tìm chỉ mục điểm đầu của "cửa sổ giữ lại": từ tin nhắn này trở đi (bao gồm cả nó) đều gửi toàn văn, các tin nhắn trước đó có thể tóm tắt / ẩn.
 * Khớp với _resolveAutoSummaryKeepStart của Horae —— keepRecent hiện tại đếm **số lượng tin nhắn AI**.
 *   - Không có tầng AI → 0 (không ẩn)
 *   - keep<=0 → chat.length (toàn bộ đều có thể tóm tắt)
 *   - Số tầng AI <= keep → 0 (giữ lại toàn bộ)
 *   - Ngược lại → chỉ mục của tầng AI thứ keep đếm từ dưới lên
 */
export function resolveKeepStart(chat: STMessage[]): number {
  const keep = Math.max(0, apiSettings.keepRecent);
  const aiIdx: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (isAiFloor(chat[i])) aiIdx.push(i);
  }
  if (aiIdx.length === 0) return 0;
  if (keep <= 0) return chat.length;
  if (aiIdx.length <= keep) return 0;
  return aiIdx[aiIdx.length - keep];
}

/** Phạm vi bao phủ lịch sử nhập vào trong rừng hiện tại. Cho dù nút đã được tổng kết tầng cao hơn thu nạp, phạm vi tiếp quản của nó vẫn có hiệu lực. */
function importedHistoryRanges(): Array<[number, number]> {
  return memory.summaries
    .filter(s => s.imported && Number.isFinite(s.importedFloorEnd))
    .map(s => {
      const start = Math.max(0, Math.floor(s.importedFloorStart ?? 0));
      const end = Math.max(start, Math.floor(s.importedFloorEnd ?? start));
      return [start, end] as [number, number];
    });
}

function floorInImportedRanges(floor: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => floor >= start && floor <= end);
}

function importedHistoryCovers(floor: number): boolean {
  return floorInImportedRanges(floor, importedHistoryRanges());
}

/**
 * Tìm ra các tầng lầu AI "chờ tóm tắt": là tầng AI và không có lá hợp lệ (không lá / lỗi thời). Từ cũ đến mới.
 * Tin nhắn mới, regenerate swipe mới, tầng đã chỉnh sửa, đều vì leafValid=false mà tự nhiên rơi vào đây.
 */
export function pendingAiFloors(chat: STMessage[]): number[] {
  const out: number[] = [];
  const imported = importedHistoryRanges();
  for (let i = 0; i < chat.length; i++) {
    if (floorInImportedRanges(i, imported)) continue;
    if (isAiFloor(chat[i]) && !leafValid(chat[i])) out.push(i);
  }
  return out;
}

/**
 * Tầng lầu "lỗ hổng": các tầng AI chờ tóm tắt vi phạm bất biến cốt lõi "trừ tin nhắn AI cuối cùng ra, các tầng AI còn lại đều bắt buộc phải có tóm tắt hợp lệ".
 * = Tất cả các tầng AI chờ tóm tắt nằm trước tầng AI cuối cùng. Tầng cuối cùng đó được miễn —— nó vừa chốt bản thảo, vốn dĩ chưa tóm tắt, thuộc diện chờ tóm tắt bình thường chứ không phải lỗ hổng.
 *
 * Đây là tiêu chuẩn phán đoán của bộ chặn tạo nội dung (xem handleGenerationIntercept). Lưu ý: **không xét cửa sổ giữ lại (keepRecent)** ——
 * lỗ hổng ở giữa bên trong cửa sổ (như một tầng tóm tắt thất bại, hoặc xóa thủ công tóm tắt của một tầng) cũng phá vỡ bất biến như nhau, bắt buộc phải chặn,
 * nếu không các tầng gửi sau sẽ vẫn sinh nội dung bình thường khi "phía trước đang thiếu tóm tắt", dẫn đến việc tiêm trạng thái / kế hoạch bị lệch vị trí (vị trí tiêm D2 giả định bất biến này).
 */
export function holesExceptLast(chat: STMessage[]): number[] {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) return [];
  return pendingAiFloors(chat).filter(i => i < lastAi);
}

/**
 * regenerate/swipe chỉ đại diện cho việc "đang viết lại tầng cuối" khi ở cuối cuộc trò chuyện thực sự là tầng AI.
 * Nếu ở cuối là tầng người dùng (ví dụ khôi phục tạo sau khi thất bại), tầng AI phía trước đã ổn định, không thể vì chuỗi type mà bỏ qua.
 */
function shouldSkipLastAiForGeneration(chat: STMessage[], type: string | undefined): boolean {
  if (type !== 'regenerate' && type !== 'swipe') return false;
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || message.extra?.bbs_omit) continue;
    return isAiFloor(message);
  }
  return false;
}

/**
 * Kịch bản "lời mở đầu chờ tóm tắt": tầng AI mới nhất là **tầng AI đầu tiên trước khi người chơi phát ngôn (lời mở đầu)**, chưa tóm tắt, và chính văn không có thẻ thời gian.
 * Trả về chỉ mục tầng lời mở đầu đó; không khớp trả về -1.
 *
 * Tại sao phải xử lý đặc biệt: lời mở đầu không phải do prompt của plugin này sinh ra (thiết lập sẵn của thẻ nhân vật), thường vừa không có thẻ <bbs_start>/<bbs_end>,
 * vừa chưa được tóm tắt —— lúc này chưa có bất kỳ mốc thời gian nào. Nếu cứ mặc kệ cho lần tạo chính văn đầu tiên chạy, mô hình chính sẽ tự bịa ra một thời gian, còn bản tóm tắt lời mở đầu
 * lại độc lập bịa ra một thời gian khác, hai bên không khớp nhau (lỗi loạn thời gian người dùng đã gặp thực tế). Cách giải quyết: tóm tắt lời mở đầu trước, đưa thời gian vào lá, khi mô hình chính
 * tạo nội dung sẽ thông qua lớp dự phòng "không thẻ → lùi về thời gian của lá" của latestStoryTime + thời gian hiện tại được tiêm vào, lấy đó làm chuẩn để đẩy tiếp, đồng bộ hoàn toàn.
 * Khi lời mở đầu đã có sẵn thẻ thời gian thì không xử lý đặc biệt (mô hình chính đọc trực tiếp được thẻ, đã có mốc neo), không cần đợi thêm một lần yêu cầu.
 */
export function openingPendingFloor(chat: STMessage[]): number {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) return -1;
  for (let i = lastAi - 1; i >= 0; i--) {
    if (chat[i]?.is_user || isAiFloor(chat[i])) return -1; // Phía trước đã có phát ngôn của người chơi hoặc tầng AI khác → không phải lời mở đầu
  }
  if (importedHistoryCovers(lastAi)) return -1; // Đã được lịch sử nhập vào tiếp quản, không tạo riêng lá cho lời mở đầu nữa
  if (leafValid(chat[lastAi])) return -1; // Đã tóm tắt → mốc neo đã có sẵn
  const tag = parseTimeRange(clampToTimeTags(chat[lastAi].mes));
  if (tag.start && tag.end) return -1; // Lời mở đầu tự mang thẻ thời gian → mô hình chính đọc được, không cần tóm tắt trước
  return lastAi;
}

/**
 * Bộ chặn tạo nội dung: trước mỗi lần tạo "sản sinh chính văn mới", giữ vững bất biến "trừ tin nhắn AI cuối cùng ra các tầng còn lại đều bắt buộc phải có tóm tắt".
 * Tiêu chuẩn phán đoán = holesExceptLast (các tầng chờ tóm tắt trước AI cuối cùng), phân luồng theo số lượng:
 *  - 0 lỗ hổng → cho qua.
 *  - Đúng 1 lỗ hổng → đợi bản tóm tắt đang được tạo dưới nền; nếu trình tự sự kiện chưa khởi động nó, bộ chặn tự tóm tắt bù tầng này.
 *    Sau khi hoàn tất thì phán đoán lại, lấp xong lỗ hổng thì khởi động tóm tắt tầng ổn định mới nhất; xác nhận yêu cầu tóm tắt đã phát đi rồi mới cho qua, nếu không thì chặn.
 *  - >1 lỗ hổng → chặn trực tiếp, và không khởi động tự động tóm tắt bù mới; để người dùng tự chọn tóm tắt bù từng tầng hoặc tóm tắt bù hàng loạt.
 * Chặn = abort(true) + /sendas chèn tầng thông báo.
 *
 * Trình tự / tiêu chuẩn then chốt (trước khi sửa nhất định phải hiểu rõ, nếu không rất dễ tái phát lỗi chạy song song):
 *  1) Tiêu chuẩn type bắt buộc phải nhất quán với kích hoạt tóm tắt (trình lắng nghe GENERATION_STARTED trong bindEngine) —— đều cho qua
 *     continue/quiet/impersonate, đều quản lý normal/regenerate/swipe. Nếu không khi tạo lại / lật trang việc "tóm tắt bù" và "tạo nội dung" sẽ chạy song song.
 *  2) GENERATION_STARTED (kích hoạt maybeSummarizePrevAi) trong ST được emit trước bộ chặn này, và từ maybeSummarizePrevAi
 *     đến runSummary là mã đồng bộ, runSummary đặt sẵn currentRun đồng bộ → khi bộ chặn này chạy đã đọc được tín hiệu "đang bay".
 *  3) ST sẽ await bộ chặn này (script.js runGenerationInterceptors), nên await thực sự chặn được việc tạo;
 *     và bộ chặn chạy trước khi lắp ráp prompt, sau khi tóm tắt lưu đĩa, việc tiêm ở giai đoạn lắp ráp tiếp theo tự nhiên mang theo dữ liệu mới.
 * Đi theo công tắc "Tự động tóm tắt": tắt đi thì cũng không chặn nữa.
 */
export async function handleGenerationIntercept(
  type: string | undefined,
  abort: (immediately: boolean) => void,
): Promise<boolean> {
  if (!engineActiveHere()) return false; // Nhân vật bị loại trừ / tắt công tắc tổng: không chặn
  if (!apiSettings.autoSummaryEnabled) return false; // Tắt tự động tóm tắt → tắt luôn việc chặn
  // Chỉ chặn những lần tạo sẽ sản sinh chính văn mới: normal (gửi tin nhắn) / regenerate (tạo lại) / swipe (lật trang).
  // Cùng tiêu chuẩn với kích hoạt tóm tắt (trình lắng nghe GENERATION_STARTED), nếu không khi tạo lại / lật trang việc "tóm tắt bù" và "tạo nội dung" sẽ chạy song song.
  // continue (viết tiếp) / quiet (im lặng) / impersonate (nhập vai) cho qua, không nên bị lỗ hổng chặn lại.
  if (type === 'continue' || type === 'quiet' || type === 'impersonate') return false;

  const ctx = getContext();
  if (!ctx) return false;
  if (!ctx.getCurrentChatId?.()) return false; // Trang chào mừng: không có cuộc trò chuyện thì không chặn
  const chat = ctx.chat ?? [];
  normalizeBacklogNotices(chat); // Tương thích với các tầng thông báo đã tồn tại trước khi nâng cấp nhưng chưa được gắn nhãn
  const skipLastAi = shouldSkipLastAiForGeneration(chat, type);

  // Xử lý đặc biệt lời mở đầu (không chặn, chỉ đợi): khi lời mở đầu không có thẻ thời gian, lại chưa tóm tắt, thì tóm tắt nó trước để thiết lập mốc thời gian, rồi mới cho qua lần tạo đầu tiên.
  // Nếu không mô hình chính và bản tóm tắt lời mở đầu sẽ tự bịa riêng một thời gian mở đầu, dẫn đến thời gian chính văn và tóm tắt không khớp nhau (người dùng đã gặp thực tế).
  // Tóm tắt xong (hoặc thất bại thoái hóa) là tiếp tục cho qua ngay —— tóm tắt lời mở đầu thất bại không nên cản trở người dùng bắt đầu trò chơi.
  // Tầng cuối đang lật trang / tạo lại chưa chốt bản thảo, cho dù là lời mở đầu thật cũng không thể tóm tắt trang cũ để lập mốc neo.
  const opening = skipLastAi ? -1 : openingPendingFloor(chat);
  if (opening >= 0) {
    const inflight = currentSummaryPromise();
    if (inflight) {
      toast('Đang thiết lập mốc thời gian cho lời mở đầu, vui lòng đợi…', 'info');
      await inflight; // promise không bao giờ reject, sẽ không làm treo việc tạo
    } else if (!busy) {
      toast('Đang thiết lập mốc thời gian cho lời mở đầu, vui lòng đợi…', 'info');
      await runSummary(opening);
    }
    // Sau khi tóm tắt lưu đĩa, refreshInjection đã quét "Thời gian hiện tại" thành thời gian lời mở đầu; tiếp tục đi vào phán đoán lỗ hổng (thường là cho qua).
  }

  let holes = holesExceptLast(chat);
  if (holes.length < 1) {
    // Đảm bảo tầng AI ổn định mới nhất đã đi vào tóm tắt dưới nền; chỉ khi ở cuối cuộc trò chuyện thực sự là AI mới bỏ qua tầng cuối đang được viết lại.
    // Thông thường trình lắng nghe sự kiện đã khởi động nó rồi, cổng bảo vệ busy sẽ tự động khử trùng; ở đây là dự phòng trình tự thời gian.
    void maybeSummarizePrevAi(skipLastAi);
    return false;
  }

  // Đúng 1 lỗ hổng: ưu tiên đợi tác vụ nền; nếu trình tự sự kiện chưa khởi động và engine đang rảnh, bộ chặn tự tóm tắt bù.
  if (holes.length === 1) {
    const inflight = currentSummaryPromise();
    if (inflight) {
      toast('Đang tóm tắt bù tầng trước đó, vui lòng đợi…', 'info');
      await inflight;
    } else if (!busy) {
      toast('Đang tóm tắt bù tầng trước đó, vui lòng đợi…', 'info');
      await runSummary(holes[0]);
    }
    holes = holesExceptLast(chat);
    if (holes.length < 1) {
      // Tóm tắt trước khi thực sự gửi API còn phải đọc bất đồng bộ các ngữ cảnh như sách thế giới. Nếu cho qua ngay, việc tạo chính văn có thể tranh chạy trước,
      // dẫn đến yêu cầu tóm tắt của tầng ổn định mới nhất không thể khởi động. Ở đây chỉ đợi yêu cầu thực sự được phát đi, không đợi tóm tắt hoàn tất.
      await maybeSummarizePrevAi(skipLastAi, true);
      return false;
    }
  }

  abort(true); // Vẫn còn lỗ hổng (>1, hoặc lỗ hổng duy nhất đó không đang bay / tóm tắt bù thất bại): lập tức hủy bỏ

  // Khử trùng: nếu tầng cuối đã là tầng thông báo này rồi thì không chèn lặp lại nữa (bấm gửi liên tục không làm tràn màn hình)
  const last = chat[chat.length - 1];
  if (last && !last.is_user && typeof last.mes === 'string' && (last.mes.includes(BACKLOG_NOTICE_SENTINEL) || last.mes.includes(LEGACY_BACKLOG_SENTINEL))) {
    return true;
  }

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    // Nhiều dòng dựa vào macro {{newline}} (sendMessageAs đi qua substituteParams sẽ khôi phục thành xuống dòng)
    const text = [
      `【Bách Bảo Thư】${BACKLOG_NOTICE_SENTINEL}`,
      `Chuyện gì đã xảy ra: Vì phía trước có tầng lầu chưa có tóm tắt, để đảm bảo tính liên tục của cốt truyện, bạn cần đi bổ sung hoàn tất tóm tắt cho nó trước thì mới có thể tiếp tục gửi tin nhắn`,
      `Cần làm gì: Bấm vào cây đũa phép ở góc dưới bên trái, mở giao diện Bách Bảo Thư, trong mục "Tầng chưa tóm tắt" ở trang đầu tiên hãy tóm tắt bù từng tầng, hoặc dùng "Tóm tắt bù hàng loạt" để xử lý một lần`,
      `Bổ sung thất bại: Đa phần là vấn đề API, hãy thử đổi các API khác nhau`,
      `Bổ sung thành công: Sau khi bổ sung thành công, chỉ cần xóa tầng lầu thông báo này đi là có thể tiếp tục tạo nội dung bình thường`
    ].join('{{newline}}');
    try {
      await exec(`/sendas name="Bách Bảo Thư" ${text}`);
      // Sản phẩm của /sendas trong ST là tin nhắn phi người dùng thông thường (is_system=false, không có extra.type), bắt buộc phải chủ động đánh dấu,
      // nếu không ở lượt tiếp theo nó sẽ bị coi là tầng AI thực sự và lại yêu cầu tóm tắt bù.
      normalizeBacklogNotices(chat);
    } catch (e) {
      engineState.lastError = `Chèn tầng thông báo tồn đọng thất bại: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return true;
}

/** Thu dọn cuối thống nhất sau khi tóm tắt: đồng bộ ẩn trượt + làm mới tiêm (tự động ẩn đã gộp vào quy trình tóm tắt, không còn công tắc độc lập) */
async function afterSummaryHideAndInject(chat: STMessage[]): Promise<void> {
  await syncWindowHiddenState(chat);
  refreshInjection();
}

/**
 * Hàm "kiểm tra ẩn một lần" hướng ra ngoài: đồng bộ ẩn cửa sổ trượt theo tình trạng bao phủ lá hiện tại + làm mới tiêm.
 * Phục vụ gọi sau khi ghi hàng loạt lá như di chuyển dữ liệu, tái sử dụng cùng một bộ logic thu dọn cuối của tóm tắt; cổng bảo vệ nhất quán với quy trình tóm tắt
 * (engine không có hiệu lực ở cuộc trò chuyện này / tắt tự động tóm tắt thì không ẩn, chỉ làm mới tiêm). force=true phục vụ khi người dùng chủ động nhập / xóa
 * tổng kết cũ thì đồng bộ ngay phạm vi bao phủ, không bị ảnh hưởng bởi công tắc tự động tóm tắt.
 */
export async function syncHiddenNow(force = false): Promise<void> {
  const chat = getContext()?.chat ?? [];
  if (force || (engineActiveHere() && apiSettings.autoSummaryEnabled)) {
    await afterSummaryHideAndInject(chat);
  } else {
    refreshInjection();
  }
}

/**
 * Tóm tắt bù toàn bộ: lần lượt tạo tóm tắt cho tất cả các tầng AI "không có lá hợp lệ".
 * **Chỉ dành cho nút "Tóm tắt ngay" ở trang tóm tắt gọi thủ công** —— kích hoạt tự động đã đổi sang dùng maybeSummarizePrevAi (tăng thêm đơn tầng).
 */
export async function checkAutoSummary(): Promise<void> {
  console.log('[Bách Bảo Thư] checkAutoSummary(toàn bộ thủ công) đi vào', { enabled: apiSettings.autoSummaryEnabled, busy });
  if (!engineActiveHere()) { console.log('[Bách Bảo Thư] Thoát sớm: công tắc tổng của plugin đang tắt hoặc nhân vật hiện tại bị loại trừ'); return; }
  if (!apiSettings.autoSummaryEnabled) { console.log('[Bách Bảo Thư] Thoát sớm: tự động tóm tắt chưa bật'); return; }
  if (busy) { console.log('[Bách Bảo Thư] Thoát sớm: khóa busy'); return; }

  const ctx = getContext();
  if (!ctx) { console.log('[Bách Bảo Thư] Thoát sớm: không có ctx'); return; }
  const chat = ctx.chat ?? [];
  if (chat.length === 0) { console.log('[Bách Bảo Thư] Thoát sớm: chat trống'); return; }

  const floors = pendingAiFloors(chat);
  console.log('[Bách Bảo Thư] Các tầng chờ tóm tắt =', floors);
  for (const floor of floors) {
    await runSummary(floor);
  }
  await afterSummaryHideAndInject(chat);
}

/**
 * Tóm tắt bù thủ công cho một tầng lầu đơn lẻ (bấm từng tầng trong danh sách "Tầng chưa tóm tắt" ở trang tóm tắt).
 * Tách rời với kích hoạt tự động: không xét autoSummaryEnabled, chỉ cần công tắc tổng đang bật là thực thi; tóm tắt xong chạy thu dọn cuối (ẩn + tiêm).
 */
export async function summarizeFloor(floor: number): Promise<void> {
  if (!engineActiveHere()) return;
  if (busy) return;
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (importedHistoryCovers(floor)) return;
  if (!isAiFloor(chat[floor]) || leafValid(chat[floor])) return;
  await runSummary(floor);
  await afterSummaryHideAndInject(chat);
}

/**
 * Tạo lại thủ công bản tóm tắt hiện có của một tầng.
 * Giữ lại lá cũ cho đến khi yêu cầu mới thành công mới thay thế; khi thất bại bản tóm tắt gốc và trạng thái dẫn xuất không đổi.
 * Tóm tắt lại giữ nguyên id lá, tránh làm mất hiệu lực các tham chiếu kế hoạch phía sau; các tổng kết tầng trên có chứa lá đó sẽ bị vô hiệu hóa gỡ bỏ khi lá hạ cánh.
 * Thao tác này chỉ làm lại lá hiện tại, không kích hoạt thêm yêu cầu tổng kết tầng trên.
 */
export async function regenerateFloor(floor: number): Promise<boolean> {
  if (!engineActiveHere()) return false;
  if (busy) return false;
  const ctx = getContext();
  if (!ctx) return false;
  const chat = ctx.chat ?? [];
  if (!isAiFloor(chat[floor]) || !leafValid(chat[floor])) return false;
  const oldLeaf = getLeaf(chat[floor]);
  if (!oldLeaf) return false;

  try {
    await runSummary(floor, { replaceLeaf: oldLeaf, checkResummary: false });
    return getLeaf(chat[floor]) !== oldLeaf && !engineState.lastError;
  } finally {
    await afterSummaryHideAndInject(chat);
  }
}

/**
 * Đánh dấu / bỏ đánh dấu một tầng là "Ngoại truyện" (tiểu kịch trường / phần ngoại truyện, không liên quan mạch truyện chính).
 * Tầng ngoại truyện **hoàn toàn không tồn tại** đối với engine: không tóm tắt, không tổng kết, không phát lại dẫn xuất, không tiêm —— được thực hiện bởi cổng bảo vệ bbs_omit ở những nơi như isAiFloor.
 *
 * Phi phá hủy: chỉ bật tắt cờ extra.bbs_omit, **không xóa lá đã có của tầng đó**. Do đó có thể đảo ngược —— bỏ đánh dấu ngoại truyện là khôi phục ngay bản tóm tắt của nó,
 * không cần gọi lại AI. Dữ liệu lá / rừng đều được giữ nguyên, cổng bảo vệ chỉ bỏ qua nó khi duyệt.
 *
 * ⚠️ Trường hợp biên: nếu lá của tầng đó **đã được nén vào nút tổng kết tầng trên** (L1+), văn bản tự sự của nó đã hòa vào văn xuôi tổng kết do AI viết,
 * không thể bóc tách không tổn hao —— đoạn văn bản tổng kết đó vẫn chứa tầng này, cho đến khi tổng kết lại. Đại đa số kịch bản (tiểu kịch trường vừa viết xong là đánh dấu ngoại truyện ngay,
 * chưa bị nén) không bị ảnh hưởng, loại trừ hoàn toàn.
 *
 * @param on true = đánh dấu là ngoại truyện, false = bỏ đánh dấu ngoại truyện
 */
export async function setFloorOmit(floor: number, on: boolean): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  const m = chat[floor];
  if (!m) return;
  const already = !!m.extra?.bbs_omit;
  if (already === on) return; // Bất biến

  if (on) {
    m.extra = { ...(m.extra ?? {}), bbs_omit: true };
  } else {
    const { bbs_omit: _omit, ...rest } = m.extra ?? {};
    m.extra = rest;
  }

  // Nhãn được lưu bền vững theo file chat; dữ liệu dẫn xuất / tiêm / cửa sổ ẩn được tính lại theo tiêu chuẩn mới.
  recomputeDerived();
  await syncHiddenNow(); // Bên trong dựa vào engineActiveHere/autoSummary quyết định có đồng bộ ẩn hay không, và làm mới tiêm
  scheduleLeafFlush();
}

/**
 * Tóm tắt đơn tầng kích hoạt tự động: **ưu tiên tầng chờ tóm tắt sớm nhất**, mỗi lần xử lý tối đa một tầng.
 * @param skipLastAi khi true sẽ bỏ qua tin nhắn AI ở cuối đang thao tác (kịch bản lật trang / tạo lại), nó không tham gia chọn mục tiêu.
 * @param waitUntilRequestStarts khi true chỉ đợi đến khi yêu cầu API tóm tắt thực sự được phát đi, sau đó để việc tóm tắt hoàn tất dưới nền.
 *
 * Bất biến: trừ tin nhắn AI cuối cùng ra, các tầng AI còn lại đều phải có tóm tắt. Vì mục tiêu này, lấy "tầng AI chờ tóm tắt sớm nhất trong phạm vi có thể tóm tắt",
 * thay vì "tin nhắn ngay trước" —— nếu không khi phía trước có tầng thất bại (lỗ hổng), tầng mới sẽ nhảy qua nó để tóm tắt trước, dẫn đến ngược thứ tự (xóa sót kế hoạch v.v.).
 *  - Gửi tin nhắn: phạm vi có thể tóm tắt = cho đến tầng AI cuối cùng. skipLastAi=false.
 *  - Lật trang / tạo lại: AI ở cuối đang bị viết lại, loại trừ nó, phạm vi = cho đến tầng AI trước đó nữa. skipLastAi=true.
 * Nếu tồn tại nhiều lỗ hổng cũ, không tự động tiêu hao hạn mức: thoát sớm trực tiếp, giao cho bộ chặn nhắc người dùng chọn tóm tắt bù từng tầng hoặc hàng loạt.
 * Chỉ có tầng mới nhất bình thường, hoặc một lỗ hổng cũ duy nhất mới được tự động xử lý. Sau khi lấp xong lỗ hổng cũ duy nhất, bộ chặn sẽ khởi động thêm một lần tóm tắt nền
 * cho tầng ổn định mới nhất, khôi phục nhịp độ bình thường "tóm tắt và tạo chính văn chạy song song".
 */
export async function maybeSummarizePrevAi(
  skipLastAi: boolean,
  waitUntilRequestStarts = false,
): Promise<void> {
  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!engineActiveHere()) return;
  if (!apiSettings.autoSummaryEnabled) return;
  if (busy) return;
  if (!ctx) return;
  if (chat.length === 0) return;

  const holes = holesExceptLast(chat);
  if (holes.length > 1) {
    console.log('[Bách Bảo Thư] Có nhiều khoảng trống tóm tắt, dừng tự động tóm tắt bù, giao cho người dùng xử lý thủ công:', holes);
    return;
  }

  // Cận trên của phạm vi có thể tóm tắt: gửi tin nhắn = AI cuối cùng; lật trang / tạo lại = AI trước đó (tầng cuối dễ biến đổi, loại trừ).
  const ceiling = prevAiFloor(chat, skipLastAi);
  if (ceiling < 0) return;

  // Tầng AI chờ tóm tắt sớm nhất trong phạm vi (ưu tiên lỗ hổng); không có thì chỉ chạy thu dọn cuối (cửa sổ ẩn có thể thay đổi).
  const pending = pendingAiFloors(chat);
  const target = pending.find(f => f <= ceiling);
  if (target === undefined) {
    await afterSummaryHideAndInject(chat);
    return;
  }

  if (waitUntilRequestStarts) {
    let markStarted: () => void = () => {};
    const started = new Promise<'request-started'>(resolve => {
      markStarted = () => resolve('request-started');
    });
    const run = runSummary(target, { onRequestStart: markStarted });
    void run
      .then(async () => {
        await afterSummaryHideAndInject(chat);
      })
      .catch(e => {
        engineState.lastError = e instanceof Error ? e.message : String(e);
      });
    // Khi thoát sớm / thất bại run sẽ hoàn thành trước, không vì rào chắn khởi động chưa kích hoạt mà làm kẹt việc tạo chính văn.
    await Promise.race([
      started,
      run.then(() => 'run-finished' as const),
    ]);
    return;
  }

  await runSummary(target);
  await afterSummaryHideAndInject(chat);
}

/**
 * Tìm chỉ mục của "tin nhắn AI đã chốt bản thảo trước đó".
 * skipLastAi=false → tầng AI cuối cùng; skipLastAi=true → bỏ qua tầng AI cuối cùng, lấy tầng trước đó nữa.
 * Không tìm thấy trả về -1.
 */
export function prevAiFloor(chat: STMessage[], skipLastAi: boolean): number {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) {
      lastAi = i;
      break;
    }
  }
  if (lastAi < 0) return -1;
  if (!skipLastAi) return lastAi;
  for (let i = lastAi - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) return i;
  }
  return -1;
}

/** Gộp danh sách chỉ mục tăng dần thành các khoảng liên tục (phục vụ tham số hàng loạt kiểu /hide 0-3) */
export function coalesceRanges(indices: number[]): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const i of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else ranges.push([i, i]);
  }
  return ranges;
}

/**
 * Đồng bộ trạng thái ẩn của cửa sổ trượt:
 *  - Ẩn các tin nhắn "trước cửa sổ giữ lại, đã được tóm tắt bao phủ, chưa ẩn".
 *  - Bỏ ẩn các tin nhắn "từng bị plugin này ẩn, nhưng hiện tại không nên ẩn".
 * Đi qua lệnh gốc /hide của ST (khớp với Horae, tự động đồng bộ DOM, đi qua cổng chính thức),
 * /unhide, đồng thời dùng nhãn riêng extra.bbs_hidden để phân biệt giữa "do chúng ta ẩn" và "tầng hệ thống gốc của ST".
 * Chỉ ẩn những tầng đã được tóm tắt bao phủ, tuyệt đối không tạo ra hố đen thông tin.
 */
async function syncWindowHiddenState(chat: STMessage[]): Promise<void> {
  const keepStart = resolveKeepStart(chat);
  const covered = coveredSet(chat);
  const imported = importedHistoryRanges();
  const ctx = getContext();
  if (!ctx) return;

  const toHide: number[] = [];
  const toUnhide: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    // Khi người dùng giao rõ ràng một đoạn cốt truyện cũ cho "lịch sử nhập vào" tiếp quản, ẩn toàn bộ cả đoạn, không còn chịu ảnh hưởng bởi số lượng giữ lại cửa sổ gần đây nữa,
    // nếu không chính văn nhập vào sẽ bị tiêm trùng lặp với nguyên văn cũ trong cửa sổ. Sau khi xóa nút nhập vào sẽ tự động đi qua nhánh unhide bên dưới.
    const shouldHide = covered.has(i) && (i < keepStart || floorInImportedRanges(i, imported));
    if (shouldHide) {
      if (!m.extra?.bbs_hidden || m.is_system !== true) toHide.push(i);
    } else if (m.extra?.bbs_hidden) {
      toUnhide.push(i);
    }
  }
  if (toHide.length === 0 && toUnhide.length === 0) return;

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    for (const [start, end] of coalesceRanges(toUnhide)) {
      const arg = start === end ? `${start}` : `${start}-${end}`;
      try {
        for (let i = start; i <= end; i++) {
          const m = chat[i];
          if (!m?.extra?.bbs_hidden) continue;
          const { bbs_hidden: _hidden, ...extra } = m.extra;
          m.extra = extra;
        }
        await exec(`/unhide ${arg}`);
      } catch (e) {
        // /unhide thất bại thì lùi về ghi trực tiếp is_system, đảm bảo việc bỏ ẩn chắc chắn có hiệu lực
        for (let i = start; i <= end; i++) {
          const m = chat[i];
          if (!m) continue;
          m.is_system = false;
          if (m.extra?.bbs_hidden) {
            const { bbs_hidden: _hidden, ...extra } = m.extra;
            m.extra = extra;
          }
        }
        engineState.lastError = `/unhide ${arg} thất bại: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    for (const [start, end] of coalesceRanges(toHide)) {
      const arg = start === end ? `${start}` : `${start}-${end}`;
      try {
        // Ghi trước nhãn riêng + trạng thái bộ nhớ, ngăn việc saveChat tranh chấp trong lúc /hide bất đồng bộ ghi đè mất
        for (let i = start; i <= end; i++) if (chat[i]) chat[i].extra = { ...(chat[i].extra ?? {}), bbs_hidden: true };
        await exec(`/hide ${arg}`);
      } catch (e) {
        // /hide thất bại thì lùi về ghi trực tiếp is_system, đảm bảo việc ẩn chắc chắn có hiệu lực
        for (let i = start; i <= end; i++) if (chat[i]) chat[i].is_system = true;
        engineState.lastError = `/hide ${arg} thất bại: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } else {
    // Không có bộ thực thi slash (bản cũ / chưa sẵn sàng): lùi về ghi trực tiếp is_system + tải lại
    for (const i of toUnhide) {
      const m = chat[i];
      if (!m) continue;
      m.is_system = false;
      if (m.extra?.bbs_hidden) {
        const { bbs_hidden: _hidden, ...extra } = m.extra;
        m.extra = extra;
      }
    }
    for (const i of toHide) {
      const m = chat[i];
      if (!m) continue;
      m.extra = { ...(m.extra ?? {}), bbs_hidden: true };
      m.is_system = true;
    }
    try {
      await ctx.saveChat();
      await ctx.reloadCurrentChat();
    } catch {
      /* Làm mới thất bại không gây chết chương trình */
    }
  }
}

/**
 * Thực thi tóm tắt cho một tầng lầu AI đơn lẻ.
 * Ngữ cảnh: để bản tóm tắt liền mạch, đem tầng AI đó cùng với phát ngôn của người dùng nằm sát ngay trước nó và chưa được bao phủ nạp chung cho mô hình,
 * nhưng chỉ đánh dấu một tầng AI này (cùng các tầng người dùng phía trước nó) là đã được bao phủ.
 */
/**
 * Phân giải xem một tác vụ tóm tắt thực tế gửi yêu cầu như thế nào:
 *  - Đã chỉ định kênh API phụ → dùng kênh đó (requestCompletion);
 *  - Chưa chỉ định (trống) → đi theo API chính (requestViaMainApi → generateRaw, dùng API đang dùng trên giao diện chính hiện tại, không mang lịch sử trò chuyện).
 * Khi API chính cũng không khả dụng (ST không có generateRaw) thì trả về error, bên gọi dựa vào đó thoát sớm và ghi lastError.
 */
function resolveSender(
  task: TaskType,
): { send: (messages: ChatMsg[]) => Promise<string>; label: string } | { error: string } {
  const channel = getChannelForTask(task);
  if (channel) {
    return { send: messages => requestCompletion(channel, messages), label: `Kênh "${channel.name}" (${channel.model})` };
  }
  if (!mainApiAvailable()) {
    return { error: 'Chưa chỉ định kênh API phụ, và API chính hiện tại không khả dụng (vui lòng điền xong API chính rồi thử lại, hoặc chỉ định riêng kênh cho tác vụ này)' };
  }
  return { send: messages => requestViaMainApi(messages), label: 'API chính (đang dùng trên giao diện chính)' };
}

/**
 * Gửi yêu cầu và phân tích, thất bại tự động thử lại. Thất bại = yêu cầu ném lỗi hoặc hàm phân tích ném lỗi (JSON không hợp lệ / thiếu trường).
 * Thử lại tối đa apiSettings.summaryMaxRetries lần (mặc định 1), tức là "lần thử đầu + N lần thử lại" tổng cộng N+1 lần thử.
 * Thất bại toàn bộ thì ném ra lỗi của lần cuối cùng, do bên gọi ghi vào lastError.
 */
async function sendAndParse<T>(
  send: (messages: ChatMsg[]) => Promise<string>,
  messages: ChatMsg[],
  parse: (raw: string) => T,
): Promise<T> {
  const maxRetries = Math.max(0, apiSettings.summaryMaxRetries | 0);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return parse(await send(messages));
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.log(`[Bách Bảo Thư] Lần thử thứ ${attempt + 1} thất bại, thử lại:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Tóm tắt đơn tầng. Bọc một lớp hướng ra ngoài, duy trì tín hiệu "tóm tắt đang bay hiện tại" currentRun, phục vụ bộ chặn tạo nội dung await (xem handleGenerationIntercept).
 *  - currentRun được đặt đồng bộ thành promise lần này → khi bộ chặn chạy sau GENERATION_STARTED (kích hoạt tóm tắt) đã có thể đọc được nó.
 *  - Trong finally xóa về lại null (chỉ xóa chính mình, tránh xóa mất promise mới do lần gọi sau thiết lập).
 *  - Việc gửi yêu cầu / lưu đĩa thực sự nằm ở runSummaryInner; bên trong nó đã có try/catch, promise không bao giờ reject → bộ chặn await sẽ không bị treo cứng.
 * Lưu ý: khi thoát sớm (busy / không phải tầng AI v.v.) cũng sẽ trải qua "đặt p → lập tức finally xóa về null", chỉ là p gần như resolve tức khắc, không tạo thành trạng thái đang bay thực sự.
 */
interface RunSummaryOptions {
  replaceLeaf?: LeafExtra;
  checkResummary?: boolean;
  /** Rào chắn khởi động nội bộ: kích hoạt khi ngữ cảnh tóm tắt đã chuẩn bị xong, sắp gọi API. */
  onRequestStart?: () => void;
}

export function runSummary(aiFloor: number, options: RunSummaryOptions = {}): Promise<void> {
  const runId = ++summaryRunSeq;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  const ownsFloorState = !!chatId && !busy && !currentRun;
  if (ownsFloorState) {
    floorBackfillOwnerRunId = runId;
    floorBackfillState.running = true;
    floorBackfillState.floor = aiFloor;
    floorBackfillState.chatId = chatId;
  }
  const p = runSummaryInner(aiFloor, options).finally(() => {
    const ownsCurrentRun = currentRun === p;
    if (ownsCurrentRun) currentRun = null;
    if (floorBackfillOwnerRunId === runId) {
      floorBackfillOwnerRunId = null;
      floorBackfillState.running = false;
      floorBackfillState.floor = null;
      floorBackfillState.chatId = '';
    }
  });
  currentRun = p;
  return p;
}

/**
 * Tìm "phạm vi bao phủ" của một tầng AI (đoạn tầng ngữ cảnh nạp cho mô hình): tầng AI này + các tầng (người dùng) nằm sát ngay trước nó và chưa được bao phủ.
 * Gặp tầng đã bao phủ hoặc tầng AI phía trước là dừng. Dùng chung cho đơn tầng và hàng loạt, đảm bảo đoạn chính văn nạp cho mô hình ở hai đường dẫn nhất quán với nhau.
 */
function floorTargets(chat: STMessage[], aiFloor: number, covered: Set<number>): number[] {
  const targets: number[] = [aiFloor];
  for (let i = aiFloor - 1; i >= 0; i--) {
    if (covered.has(i)) break;
    if (chat[i]?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không gộp chính văn của nó vào ngữ cảnh tóm tắt (nhưng không làm rào chắn)
    if (isAiFloor(chat[i])) break; // Gặp tầng AI phía trước là dừng
    if (chat[i]) targets.unshift(i);
  }
  return targets;
}

/** Khi tóm tắt lại lá đã có thì chỉ xét trạng thái bao phủ trước tầng mục tiêu, tránh việc lá cũ chặn mất tin nhắn người dùng phía trước của chính nó. */
function coveredBeforeFloor(chat: STMessage[], floor: number): Set<number> {
  return coveredSet(chat.slice(0, Math.max(0, floor)));
}

/**
 * Cố định một bản AI delta thành lá và hạ cánh xuống một tầng AI (dùng chung cho đơn tầng và hàng loạt, đảm bảo tiêu chuẩn hạ cánh lá ở hai đường dẫn nhất quán).
 *  - Thời gian: ưu tiên đọc thẻ <bbs_start>/<bbs_end> trong chính văn tầng đó (mốc neo có thẩm quyền); đầu bị thiếu dùng kết quả AI bù làm dự phòng.
 *  - Số thứ tự ngắn plans.resolve → id ổn định: dịch theo thứ tự kế hoạch chưa khép lại của stateBefore (trạng thái trước tầng này) truyền vào.
 *  - Biến động ròng vật phẩm ghi vào chú thích <bbs_items> trong chính văn (mốc chuẩn = stateBefore.items).
 * Không làm recompute/flush/tiêm —— do bên gọi thống nhất thu dọn cuối vào thời điểm thích hợp (hàng loạt có thể gom đến cuối khối mới làm mới một lần).
 */
function applyLeafForFloor(
  chat: STMessage[],
  aiFloor: number,
  delta: SummaryDelta,
  stateBefore: ReturnType<typeof deriveMemory>,
  replaceLeaf?: LeafExtra,
  knowledgeShown?: { id: string }[],
): void {
  if (!chat[aiFloor]) {
    throw new Error(`Hạ cánh lá tóm tắt thất bại: Tầng #${aiFloor} không còn tồn tại (có thể đã bị xóa trong lúc gửi yêu cầu)`);
  }
  if (replaceLeaf && getLeaf(chat[aiFloor]) !== replaceLeaf) {
    throw new Error(`Tóm tắt lại thất bại: Tóm tắt gốc của tầng #${aiFloor} đã thay đổi trong lúc gửi yêu cầu`);
  }
  // Mốc thời gian: đọc thời gian bắt đầu-kết thúc từ thẻ chính văn tầng đó (cắt gọn về đoạn chính văn trước, bỏ qua thẻ cùng tên lẫn trong chuỗi suy nghĩ / thanh trạng thái)
  const tag = parseTimeRange(clampToTimeTags(chat[aiFloor].mes));

  // Danh sách có thứ tự các kế hoạch chưa khép lại: thứ tự chính là p1/p2… trong prompt, dùng để dịch số thứ tự ngắn của resolve thành id ổn định
  const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
  // Danh sách hiện tại của hồ sơ nhỏ đời sống: thứ tự chính là d1/d2… trong prompt, dùng để dịch số thứ tự ngắn của update/archive/remove thành id ổn định
  // Danh sách hiểu biết cũng tương tự (k1/k2…); không truyền knowledgeShown = tính năng đang tắt, toàn bộ đoạn knowledge do AI xuất ra bị hủy bỏ
  const storedDelta = finalizeDelta(delta, openPlansOrdered, stateBefore.lifeDetails,
    knowledgeShown && { shown: knowledgeShown, npcNames: stateBefore.npcs.map(n => n.name) });

  // Thời gian bắt đầu-kết thúc: ưu tiên thẻ (cùng nguồn với cốt truyện mới nên không lệch); đầu nào thiếu thẻ thì dùng timeStart/timeEnd do AI bù làm dự phòng.
  const timeStart = tag.start || llmOptionalScalar(delta.timeStart) || undefined;
  const timeEnd = tag.end || llmOptionalScalar(delta.timeEnd) || llmOptionalScalar(delta.time) || undefined;
  // Thời gian hiện tại của trạng thái (kiểu ghi đè): dùng thời gian kết thúc (thời khắc cuối của đoạn này); không lấy được thì giữ nguyên trạng thái hiện có.
  if (timeEnd) storedDelta.time = timeEnd;

  const leaf: LeafExtra = {
    id: replaceLeaf?.id ?? makeLeafId(),
    text: llmString(delta.summary),
    delta: storedDelta,
    timeStart,
    timeEnd,
    createdAt: replaceLeaf?.createdAt ?? Date.now(),
    // Ghi lại số trang lúc tạo, phục vụ leafValid phán đoán quyền sở hữu (khi lật sang trang khác không bị nhiễu chéo); thiếu swipe_id tính là trang đầu tiên 0
    swipe: replaceLeaf?.swipe ?? (typeof chat[aiFloor].swipe_id === 'number' ? chat[aiFloor].swipe_id : 0),
    v: 1,
  };
  if (replaceLeaf) invalidateSummaryAncestors(replaceLeaf.id);
  chat[aiFloor].extra = { ...(chat[aiFloor].extra ?? {}), bbs_leaf: leaf };
  // Chính văn / tóm tắt của lá đã đổi → nội dung vector đọc được khi truy xuất sẽ đổi, lập tức vô hiệu hóa bộ nhớ đệm truy xuất (chống việc tạo lại / lật trang tái sử dụng truy xuất cũ).
  invalidateRecallCache();

  if (!apiSettings.summaryOnlyMode) {
    // Ghi biến động ròng vật phẩm của tầng này vào sau </bbs_end> trong chính văn (chú thích <bbs_items>, ẩn bằng regex, không đi vào tóm tắt API phụ).
    // Dùng stateBefore.items (vật phẩm trước tầng này) làm chuẩn để tính from→to; không có biến động thì chỉ xóa khối cũ.
    const changes = itemChangesOf(storedDelta, stateBefore.items, timeEnd || timeStart || '');
    let mes = writeItemLogTag(chat[aiFloor].mes, fmtItemLogInline(changes));
    // Biến động ròng của biến tùy chỉnh cũng ghi vào <bbs_vars> trong chính văn (nối sát sau khối vật phẩm, ẩn bằng regex, không đi vào tóm tắt API phụ),
    // giúp mô hình chính ở các tầng toàn văn trong cửa sổ thấy được "tầng này đã sửa những biến này rồi", chống sửa lặp lại (cùng cơ chế với chú thích vật phẩm).
    mes = writeVarLogTag(mes, fmtVarOpsInline(storedDelta.varOps));
    setMessageText(chat[aiFloor], mes);
  }
}

/**
 * Phần "công việc thuần túy" của tóm tắt đơn tầng: gửi yêu cầu + phân tích + hạ cánh lá + làm mới dẫn xuất/tiêm.
 * **Không quản lý busy / không làm cổng bảo vệ / không kích hoạt checkResummary** —— do bên gọi (runSummaryInner hoặc lùi về trong hàng loạt) phụ trách.
 * Thất bại (yêu cầu báo lỗi / JSON không hợp lệ) ném thẳng ra ngoài, bên gọi quyết định cách xử lý.
 */
async function summarizeFloorWork(
  chat: STMessage[],
  aiFloor: number,
  sender: { send: (messages: ChatMsg[]) => Promise<string>; label: string },
  options: Pick<RunSummaryOptions, 'replaceLeaf' | 'onRequestStart'> = {},
): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('Không có ngữ cảnh ST');
  if (!chat[aiFloor]) {
    throw new Error(`Tóm tắt thất bại: Tầng #${aiFloor} không còn tồn tại (có thể đã bị xóa trong lúc gửi yêu cầu)`);
  }

  const covered = options.replaceLeaf ? coveredBeforeFloor(chat, aiFloor) : coveredSet(chat);
  const targets = floorTargets(chat, aiFloor, covered);
  const content = renderMessages(chat, targets, ctx.name1, ctx.name2);

  // Cả hai đầu thẻ đều đủ mới tính là "có thẻ", prompt dựa vào đó miễn cho AI việc tính thời gian.
  const tag = parseTimeRange(clampToTimeTags(chat[aiFloor].mes));
  const hasTimeTags = !!(tag.start && tag.end);

  // Trạng thái và lịch sử tính đến "trước đoạn tầng đang phân tích" (không rò rỉ tương lai: khi tóm tắt lại tầng sớm sẽ loại trừ các lá phía sau nó)
  const beforeIndex = targets[0];
  const stateBefore = deriveMemory(chat, beforeIndex);
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, beforeIndex));

  const worldInfo = await fetchWorldInfo(chat, targets, ctx.name1, ctx.name2);
  const charCard = fetchCharCard();
  const persona = fetchUserPersona();

  const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
  // Danh sách hiểu biết chỉ đưa cho các nhân vật liên quan (chính yếu / có mặt / được điểm tên trong chính văn lượt này), tiết kiệm token; thứ tự chính là k1/k2… trong prompt
  // Điểm tên chỉ nhận tên từ hai ký tự trở lên: tên một chữ hầu như đoạn chính văn nào cũng có thể trúng nhầm
  const knowledgeShown = apiSettings.injection.knowledge
    ? selectKnowledgeForSummary(
        stateBefore.knowledge,
        stateBefore.npcs
          .filter(n => n.important || (n.name.length >= 2 && content.includes(n.name))
            || classifyNpcPresence(n, stateBefore.scenes, stateBefore.state.location, stateBefore.state.locationPath) === 'present')
          .map(n => n.name),
      )
    : undefined;
  const prompt = buildSummaryPrompt({
    user: ctx.name1,
    char: ctx.name2,
    time: stateBefore.state.time,
    location: stateBefore.state.location,
    sceneFocus: stateBefore.state.sceneFocus,
    lifeDetails: stateBefore.lifeDetails,
    knowledge: knowledgeShown,
    protagonist: stateBefore.protagonist,
    items: stateBefore.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })),
    itemLog: stateBefore.itemLog,
    scenes: stateBefore.scenes.map(s => ({ path: s.path, desc: s.desc })),
    npcs: stateBefore.npcs.map(n => ({ name: n.name, gender: n.gender, age: n.age, ageTime: n.ageTime, relation: n.relation, affinityInner: n.affinityInner, affinityOuter: n.affinityOuter, affinityNote: n.affinityNote, ties: n.ties, title: n.title, personality: n.personality, important: n.important, outfit: n.outfit, condition: n.condition || undefined, follow: n.follow, location: n.location,
      // Nhãn có mặt tính theo trạng thái "trước tầng này", yêu cầu AI đối chiếu từng người để hạch toán rời trường / quay lại hiện trường (cùng phán đoán có thẩm quyền với đầu tiêm)
      presence: classifyNpcPresence(n, stateBefore.scenes, stateBefore.state.location, stateBefore.state.locationPath) })),
    openPlans: openPlansOrdered.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })),
    // Kế hoạch đã hoàn thành gần đây: cùng tiêu chuẩn với đầu tiêm, điểm cắt dùng trạng thái trước tầng này (không rò rỉ tương lai)
    resolvedPlans: selectRecentResolvedPlans(stateBefore.plans, apiSettings.recentResolvedPlansCount),
    history,
    content,
    hasTimeTags,
    // Biến tùy chỉnh: trạng thái hiện tại lấy trước tầng này (không rò rỉ tương lai); ý nghĩa + quy tắc mỗi thứ gộp ba tầng (API phụ cần cả hai đoạn)
    varsState: stateBefore.vars,
    varsMeaning: (['global', 'char', 'chat'] as const).map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n'),
    varsRule: (['global', 'char', 'chat'] as const).map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n'),
  });

  const checklist = buildSummaryThinking(ctx.name1, !!knowledgeShown);
  const messages: ChatMsg[] = [];
  const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
  if (jb) messages.push({ role: 'system', content: jb });
  if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
  if (persona) messages.push({ role: 'system', content: buildPersonaSystem(persona) });
  if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
  // Khi khuôn mẫu tùy chỉnh đã tự kèm toàn bộ các đoạn bổ sung thì system sẽ trống; một số giao diện sẽ từ chối nhận tin nhắn có nội dung rỗng
  if (prompt.system) messages.push({ role: 'system', content: prompt.system });
  messages.push(
    { role: 'user', content: prompt.user },
    { role: 'system', content: checklist },
  );
  options.onRequestStart?.();
  const delta = await sendAndParse(sender.send, messages, raw => {
    console.log('[Bách Bảo Thư] Kết quả tóm tắt gốc trả về (chưa làm sạch):\n', raw);
    const d = extractJsonObject<SummaryDelta>(raw);
    const summary = llmString(d?.summary);
    if (!d || !summary) {
      throw new Error(raw.trim() ? 'Tóm tắt thất bại: AI xin lỗi hoặc làm rơi định dạng' : 'Tóm tắt thất bại: AI trả về rỗng');
    }
    return { ...d, summary } as SummaryDelta & { summary: string };
  });

  applyLeafForFloor(chat, aiFloor, delta, stateBefore, options.replaceLeaf, knowledgeShown);
  engineState.lastRunAt = Date.now();

  // Phản ánh ngay lập tức vào dữ liệu dẫn xuất và phần tiêm; lưu đĩa đi qua chống rung (việc ẩn do syncWindowHiddenState ở bước thu dọn cuối thống nhất phụ trách)
  recomputeDerived();
  refreshInjection();
  scheduleLeafFlush();
  scheduleVectorIndex(); // Lá mới → chống rung đồng bộ vào kho vector (thất bại âm thầm, không ảnh hưởng tóm tắt)
}

async function runSummaryInner(aiFloor: number, options: RunSummaryOptions = {}): Promise<void> {
  if (!engineActiveHere()) { console.log('[Bách Bảo Thư] runSummary thoát sớm: công tắc tổng của plugin đang tắt hoặc nhân vật hiện tại bị loại trừ'); return; }
  if (busy) { console.log('[Bách Bảo Thư] runSummary thoát sớm: busy'); return; }
  const sender = resolveSender('summary');
  if ('error' in sender) {
    engineState.lastError = sender.error;
    console.log('[Bách Bảo Thư] runSummary thoát sớm:', sender.error);
    return;
  }
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (!isAiFloor(chat[aiFloor])) { console.log('[Bách Bảo Thư] runSummary thoát sớm: không phải tầng AI', aiFloor); return; }
  if (options.replaceLeaf && getLeaf(chat[aiFloor]) !== options.replaceLeaf) {
    engineState.lastError = `Tóm tắt lại thất bại: Tóm tắt gốc của tầng #${aiFloor} đã thay đổi`;
    return;
  }
  console.log('[Bách Bảo Thư] runSummary sắp gửi yêu cầu,', sender.label);

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    await summarizeFloorWork(chat, aiFloor, sender, options);
    // Tóm tắt tích lũy đạt ngưỡng thì kích hoạt tổng kết
    if (options.checkResummary !== false) await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
  }
}

/* ============ Tóm tắt bù hàng loạt (chia khối hàng loạt, một yêu cầu → nhiều lá đơn tầng) ============ */

/** Tùy chọn tóm tắt bù hàng loạt */
export interface BatchBackfillOpts {
  /** Các tầng AI chờ tóm tắt bù (từ cũ đến mới); lược bỏ thì lấy toàn bộ các tầng AI đang chờ tóm tắt hiện tại */
  floors?: number[];
}

/** Tổng hợp kết quả hàng loạt */
export interface BatchBackfillResult {
  /** Số tầng hạ cánh lá thành công */
  done: number;
  /** Tổng số tầng dự kiến xử lý */
  total: number;
  /** Có phải kết thúc sớm do hủy bỏ hay không */
  cancelled: boolean;
}

/**
 * Cắt các tầng chờ tóm tắt thành nhiều khối theo dung lượng nội dung: mỗi khối tích lũy ký tự chính văn đạt maxChars hoặc số tầng đạt maxFloors là cắt.
 * Khi chính văn một tầng đơn lẻ vượt quá maxChars thì tự làm thành một khối riêng (không thể chia nhỏ hơn). Các tầng trong mỗi khối tăng dần, giữa các khối tăng dần.
 * Dùng chung floorTargets/renderMessages với yêu cầu hàng loạt, tính cả tin nhắn người chơi phía trước, số đoạn và lời nhắc nguyên văn.
 */
export function planBatches(chat: STMessage[], floors: number[], maxChars: number, maxFloors: number): number[][] {
  const ctx = getContext();
  const name1 = ctx?.name1 ?? '';
  const name2 = ctx?.name2 ?? '';
  const lo = Math.max(1, maxFloors | 0);
  const cap = Math.max(500, maxChars | 0);

  const batches: number[][] = [];
  const covered = coveredSet(chat);
  let cur: number[] = [];
  let curChars = 0;
  for (const f of floors) {
    const len = renderMessages(chat, floorTargets(chat, f, covered), name1, name2).length;
    // Khối hiện tại khác rỗng, và (thêm tầng này sẽ vượt số chữ hoặc số tầng đã đạt trần) → cắt khối trước
    if (cur.length && (curChars + len > cap || cur.length >= lo)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(f);
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Gửi một yêu cầu hàng loạt cho một khối, phân tích ra mảng floors và **hạ cánh lá từng tầng** (theo thứ tự trong khối, tầng sau nối tiếp trạng thái tầng trước).
 * Kiểm tra độ dài floors == số tầng của khối; không khớp thì ném lỗi (do bên gọi xử lý theo thử lại / lùi về).
 */
async function summarizeBatchWork(
  chat: STMessage[],
  block: number[],
  sender: { send: (messages: ChatMsg[]) => Promise<string>; label: string },
): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('Không có ngữ cảnh ST');
  const covered = coveredSet(chat);

  // Trạng thái / lịch sử / sách thế giới trước đầu khối (thống nhất tiêu chuẩn cho cả khối, chỉ lấy một lần)
  const beforeIndex = floorTargets(chat, block[0], covered)[0];
  const stateBefore = deriveMemory(chat, beforeIndex);
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, beforeIndex));

  // Chính văn nhiều tầng: mỗi tầng kèm phân cách "━━ Tầng thứ n ━━", bên trong gồm tầng AI đó + các tầng user phía trước chưa được bao phủ của nó
  const allTargets: number[] = [];
  const segments: string[] = [];
  block.forEach((f, idx) => {
    const targets = floorTargets(chat, f, covered);
    allTargets.push(...targets);
    segments.push(`━━ Tầng thứ ${idx + 1} ━━\n${renderMessages(chat, targets, ctx.name1, ctx.name2)}`);
  });
  const content = segments.join('\n\n');

  // Sách thế giới kích hoạt một lần theo chính văn gộp của cả khối (đỡ phải kích hoạt từng tầng)
  const worldInfo = await fetchWorldInfo(chat, allTargets, ctx.name1, ctx.name2);
  const charCard = fetchCharCard();
  const persona = fetchUserPersona();

  const prompt = buildBatchSummaryPrompt({
    user: ctx.name1,
    char: ctx.name2,
    time: stateBefore.state.time,
    location: stateBefore.state.location,
    history,
    content,
    floorCount: block.length,
  });

  const checklist = buildBatchThinking(block.length);
  const messages: ChatMsg[] = [];
  const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
  if (jb) messages.push({ role: 'system', content: jb });
  if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
  if (persona) messages.push({ role: 'system', content: buildPersonaSystem(persona) });
  if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
  messages.push(
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
    { role: 'system', content: checklist },
  );

  // Phân tích { floors: [...] }; kiểm tra độ dài bằng số tầng của khối (thiếu tầng / thừa tầng đều tính là thất bại, kích hoạt thử lại / lùi về)
  const list = await sendAndParse(sender.send, messages, raw => {
    console.log('[Bách Bảo Thư] Kết quả tóm tắt hàng loạt gốc trả về (chưa làm sạch):\n', raw);
    const d = extractJsonObject<{ floors?: SummaryDelta[] }>(raw);
    const floors = d?.floors;
    if (!Array.isArray(floors) || !floors.length) {
      throw new Error(raw.trim() ? 'Tóm tắt hàng loạt thất bại: AI xin lỗi hoặc làm rơi định dạng' : 'Tóm tắt hàng loạt thất bại: AI trả về rỗng');
    }
    if (floors.length !== block.length) {
      throw new Error(`Tóm tắt hàng loạt thất bại: Trả về ${floors.length} tầng, kỳ vọng ${block.length} tầng`);
    }
    const cleaned = floors.map(f => {
      if (!f || typeof f !== 'object') return null;
      const summary = llmString(f.summary);
      return summary ? { ...f, summary } : null;
    });
    if (cleaned.some(f => !f)) {
      throw new Error('Tóm tắt hàng loạt thất bại: Có tầng lầu bị thiếu summary');
    }
    return cleaned as Array<SummaryDelta & { summary: string }>;
  });

  // Hạ cánh lá từng tầng (thứ tự trong khối, nghiêm ngặt theo block tăng dần). Hàng loạt chỉ lấy summary + thời gian bắt đầu-kết thúc:
  // bóc bỏ tường minh items/plans/location —— những thứ này qua nhiều tầng khó đảm bảo đúng thứ tự (dễ gây loạn kế hoạch / thời gian),
  // cho dù AI không nghe lời cố tình sinh ra cũng hủy bỏ. Dữ liệu có cấu trúc giao cho tự động tóm tắt từng tầng bình thường về sau.
  block.forEach((f, idx) => {
    const r = list[idx];
    const lean: SummaryDelta = {
      summary: r.summary,
      timeStart: r.timeStart,
      timeEnd: r.timeEnd,
    };
    const sb = deriveMemory(chat, f);
    applyLeafForFloor(chat, f, lean, sb);
  });

  engineState.lastRunAt = Date.now();
  recomputeDerived();
  refreshInjection();
  scheduleLeafFlush();
  scheduleVectorIndex();
}

/**
 * Tóm tắt bù hàng loạt: cắt các tầng AI chờ tóm tắt thành từng khối theo dung lượng nội dung, gửi yêu cầu tuần tự từng khối, **hạ cánh lá từng tầng nghiêm ngặt theo thứ tự tầng lầu**.
 * Mấu chốt tiết kiệm token: ngữ cảnh cố định (vượt giới hạn / thiết lập / chuyện trước đó) được phân bổ theo khối, thay vì gửi lại ở mỗi tầng.
 *  - Hàng loạt chỉ sinh summary + thời gian bắt đầu-kết thúc (không sinh vật phẩm / kế hoạch), tránh việc dữ liệu có cấu trúc qua nhiều tầng bị loạn thứ tự;
 *    dữ liệu có cấu trúc giao cho tự động tóm tắt từng tầng bình thường về sau bù đắp.
 *  - Tuần tự giữa các khối + thứ tự AI trong khối duy trì tính đơn điệu thời gian, khối sau dùng chuyện trước đó sau khi khối trước đã lưu đĩa.
 *  - Một khối phân tích thất bại (đã bao gồm summaryMaxRetries lần thử lại) → lùi về: đi qua tóm tắt đơn tầng cho từng tầng của khối đó (đường dẫn đơn tầng vẫn sinh đầy đủ dữ liệu có cấu trúc), không làm gián đoạn tổng thể.
 *  - Hủy bỏ có hiệu lực ở ranh giới khối (không ngắt ngang khối đang chạy).
 * Sau khi hoàn tất toàn bộ sẽ kích hoạt checkResummary (dây chuyền L1/L2) + thu dọn cuối (ẩn + tiêm).
 */
export async function batchBackfill(opts: BatchBackfillOpts = {}): Promise<BatchBackfillResult> {
  if (!engineActiveHere()) return { done: 0, total: 0, cancelled: false };
  if (busy) return { done: 0, total: 0, cancelled: false };
  const sender = resolveSender('summary');
  if ('error' in sender) {
    engineState.lastError = sender.error;
    return { done: 0, total: 0, cancelled: false };
  }
  const ctx = getContext();
  if (!ctx) return { done: 0, total: 0, cancelled: false };
  const chat = ctx.chat ?? [];

  // Các tầng mục tiêu: nếu truyền vào tường minh thì lọc thành "các tầng AI hiện tại thực sự đang chờ tóm tắt" (chống lỗi thời), nếu không thì lấy toàn bộ các tầng chờ tóm tắt
  const pending = new Set(pendingAiFloors(chat));
  const floors = (opts.floors ?? [...pending]).filter(f => pending.has(f)).sort((a, b) => a - b);
  const total = floors.length;
  if (total === 0) {
    await afterSummaryHideAndInject(chat);
    return { done: 0, total: 0, cancelled: false };
  }

  const batches = planBatches(chat, floors, apiSettings.batchMaxChars, apiSettings.batchMaxFloors);
  console.log('[Bách Bảo Thư] Tóm tắt bù hàng loạt:', total, 'tầng →', batches.length, 'đợt,', sender.label);

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  // Trạng thái hàng loạt (singleton cấp mô-đun) → UI đóng rồi mở lại cửa sổ vẫn khôi phục được tiến độ / hủy
  batchState.running = true;
  batchState.cancelRequested = false;
  batchState.done = 0;
  batchState.total = total;
  let done = 0;
  let cancelled = false;
  try {
    for (const block of batches) {
      if (batchState.cancelRequested) { cancelled = true; break; }
      try {
        await summarizeBatchWork(chat, block, sender);
      } catch (e) {
        // Cả khối thất bại (đã gồm thử lại) → lùi về: tóm tắt riêng từng tầng. Đơn tầng cũng có thể thất bại (ghi lastError), tầng thất bại để lại làm chờ tóm tắt, không làm gián đoạn phía sau.
        console.log('[Bách Bảo Thư] Khối hàng loạt thất bại, lùi về từng tầng:', e instanceof Error ? e.message : String(e));
        for (const f of block) {
          if (!isAiFloor(chat[f]) || leafValid(chat[f])) continue; // Đã được lấp hoặc không phải tầng AI: bỏ qua
          try {
            await summarizeFloorWork(chat, f, sender);
          } catch (e2) {
            engineState.lastError = e2 instanceof Error ? e2.message : String(e2);
          }
        }
      }
      // Các tầng đã hạ cánh lá do khối này sinh ra được tính vào tiến độ (chỉ đếm những tầng thực sự đã gắn được lá, tầng thất bại không tính)
      done = floors.filter(f => leafValid(chat[f])).length;
      batchState.done = done;
    }
    // Kích hoạt dây chuyền tổng kết (có thể qua nhiều tầng), thất bại ghi lastError không ảnh hưởng các lá đã hạ cánh
    await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
    batchState.running = false;
    batchState.cancelRequested = false;
  }
  await afterSummaryHideAndInject(chat);
  return { done, total, cancelled };
}

/**
 * Tập hợp các chỉ mục tầng lầu đã được bao phủ hiện tại (suy dẫn hình học tức thì, không đọc lưu trữ).
 * Một tầng AI nếu có lá hợp lệ → nó cùng với các tầng phía trước nó "chưa được lá AI sớm hơn bao phủ" (gồm cả tầng user) đều tính là đã được bao phủ.
 * Tức là khoảng (lá AI hợp lệ ngay trước, lá AI hợp lệ này] được bao phủ toàn bộ. Tầng AI chờ tóm tắt không đóng khoảng.
 */
export function coveredSet(chat: STMessage[]): Set<number> {
  const covered = new Set<number>();
  for (const [start, end] of importedHistoryRanges()) {
    for (let i = start; i <= Math.min(end, chat.length - 1); i++) {
      if (!chat[i]?.extra?.bbs_omit) covered.add(i); // Tầng ngoại truyện vẫn tuân thủ "bỏ qua hoàn toàn", không vì phạm vi nhập vào mà bị ẩn
    }
  }
  let segStart = 0;
  for (let i = 0; i < chat.length; i++) {
    if (!isAiFloor(chat[i])) continue;
    if (leafValid(chat[i])) {
      for (let k = segStart; k <= i; k++) covered.add(k);
      segStart = i + 1;
    }
    // Tầng AI chờ tóm tắt (không có lá hợp lệ): đoạn không tiến lên, đợi sau khi nó được tóm tắt mới bao phủ
  }
  return covered;
}

/** Ngưỡng cần thiết để một cấp độ kích hoạt việc nén: L0→L1, L1→L2, L2+ kiểm soát riêng, tránh việc văn bản dài ở tầng cao bị chất đống theo mốc 7 mục. */
function thresholdForLevel(level: number): number {
  if (level === 0) return apiSettings.leafBatchThreshold;
  if (level === 1) return apiSettings.resummaryThreshold;
  return apiSettings.higherResummaryThreshold;
}

/**
 * Ghép một loạt nút chờ dung hợp thành content đưa cho mô hình tổng kết: **ở đầu mỗi đoạn gắn nhãn phạm vi thời gian của đoạn đó**.
 * Then chốt: thời gian có thẩm quyền của chính văn tóm tắt lưu ở trường timeStart/timeEnd (trong chính văn thường không chứa ngày tháng đầy đủ),
 * nếu chỉ nạp chính văn, việc tổng kết bị quy tắc "bắt buộc viết đủ ngày tháng" ép phải bịa tại chỗ → ngày tháng lệch nhau toàn bộ (bug đã sửa).
 * Do đó tại đây giao thời gian thực tế kèm theo chính văn cho mô hình, để nó "nhìn mà viết" thay vì bịa đặt vô căn cứ.
 * Chú thích ngoặc đơn thời gian: đủ hai đầu → "bắt đầu – kết thúc"; chỉ có một đầu → đầu đó; không có cả hai → không thêm chú thích ngoặc đơn (không ép bịa).
 */
function joinNodesForResummary(nodes: Array<{ text: string; timeStart?: string; timeEnd?: string }>): { content: string; hints: string } {
  const sources = nodes.map((n, i) => {
    const start = llmOptionalScalar(n.timeStart);
    const end = llmOptionalScalar(n.timeEnd);
    let time = '';
    if (start && end) time = start === end ? `(${start}) ` : `(${start} – ${end}) `;
    else if (start || end) time = `(${start || end}) `;
    return { source: `[${i + 1}]`, text: `${time}${n.text}` };
  });
  // Lời nhắc chỉ nối thêm vào tài liệu sau khi đã tính toán ngân sách, không được dùng nguyên văn lặp lại làm đẩy cao số chữ mục tiêu của tổng kết lần hai.
  return {
    content: sources.map(({ source, text }) => `${source} ${text}`).join('\n\n'),
    hints: renderSourceHints(sources),
  };
}

/** Khung nhìn nút gốc dùng cho việc nén: mang thời gian bắt đầu-kết thúc (lá lấy trực tiếp, comp lấy phạm vi đã tổng hợp), phục vụ lấy ranh giới khi gộp lên trên. */
interface RootView {
  id: string;
  text: string;
  createdAt: number;
  timeStart?: string;
  timeEnd?: string;
}

/** "Các nút gốc chưa được thu nạp" ở một cấp độ, tăng dần theo thời gian / tầng lầu. level0=lá (quét chat), level≥1=rừng. */
function rootsAtLevel(level: number, chat: STMessage[]): RootView[] {
  const collected = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds) collected.add(c);

  if (level === 0) {
    const out: RootView[] = [];
    for (let i = 0; i < chat.length; i++) {
      if (chat[i]?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không đưa vào nén rừng
      if (!leafValid(chat[i])) continue;
      const lf = getLeaf(chat[i]) as LeafExtra;
      if (collected.has(lf.id)) continue; // Đã được một L1 nào đó thu nạp
      out.push({ id: lf.id, text: llmString(lf.text), createdAt: lf.createdAt, timeStart: llmOptionalScalar(lf.timeStart), timeEnd: llmOptionalScalar(lf.timeEnd) }); // Đã theo thứ tự tầng lầu
    }
    return out;
  }
  return memory.summaries
    .filter(s => s.level === level && !collected.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(s => ({ id: s.id, text: llmString(s.text), createdAt: s.createdAt, timeStart: llmOptionalScalar(s.timeStart), timeEnd: llmOptionalScalar(s.timeEnd) }));
}

/**
 * Nén cấp bậc có thể đảo ngược (không xóa tầng đáy).
 * Kiểm tra từng tầng từ tầng thấp nhất lên trên: khi "các nút gốc chưa được thu nạp" của một tầng tích lũy đủ ngưỡng của tầng đó,
 * dùng AI dung hợp **văn bản tự sự** của đợt này thành một nút tầng trên, childIds thu nạp chúng (tầng đáy giữ lại toàn bộ).
 * Một lần gọi sẽ dây chuyền lên trên (thêm lá → có thể sinh L1 → có thể sinh L2…), đệ quy theo ngưỡng từng tầng.
 */
export async function checkResummary(): Promise<number> {
  if (!engineActiveHere()) return 0;
  const ctx = getContext();
  if (!ctx) return 0;
  const chat = ctx.chat ?? [];

  let made = 0; // Tổng số mục tổng kết sinh ra trong chuỗi dây chuyền lần này

  // Cấp độ nén cao nhất hiện có, làm trần dây chuyền (+1 để chứa tầng mới sinh ra)
  const maxLevel = memory.summaries.reduce((m, s) => Math.max(m, s.level), 0);

  for (let level = 0; level <= maxLevel + 1; level++) {
    const threshold = thresholdForLevel(level);
    if (!threshold || threshold < 2) continue;

    const roots = rootsAtLevel(level, chat);
    // Tầng lá (L0→L1) giữ lại N mục gần nhất không nén: ngưỡng nâng lên thành ngưỡng + số giữ lại, nhưng bên dưới vẫn chỉ nén số mục bằng ngưỡng cũ nhất,
    // N mục mới nhất tự nhiên lưu lại làm gốc, tiếp tục được tiêm từng mục một, tránh vách đá tiêm kiểu "nén sập hết một lần thành L1".
    // Chỉ có hiệu lực ở level 0 (tầng cao hơn đã là văn xuôi nén, giữ lại thêm không có ý nghĩa); keep=0 tức là lùi về hành vi cũ.
    const keep = level === 0 ? Math.max(0, apiSettings.leafKeepRecent) : 0;
    if (roots.length < threshold + keep) continue;

    const sender = resolveSender('resummary');
    if ('error' in sender) {
      engineState.lastError = sender.error;
      return made;
    }

    const batch = roots.slice(0, threshold);
    const { content, hints } = joinNodesForResummary(batch);
    // Truyền **cấp độ đầu ra** (level+1): L1 (tổng kết thông thường, 300-500 chữ) / L2+ (tổng kết lần hai, số chữ động theo đầu vào)
    const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content, level: level + 1 });

    try {
      const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
      const messages: ChatMsg[] = [];
      if (jb) messages.push({ role: 'system', content: jb });
      // Khi khuôn mẫu tùy chỉnh đã tự kèm toàn bộ các đoạn bổ sung thì system sẽ trống; một số giao diện sẽ từ chối nhận tin nhắn có nội dung rỗng
      if (prompt.system) messages.push({ role: 'system', content: prompt.system });
      messages.push(
        { role: 'user', content: prompt.user + hints },
        { role: 'system', content: RESUMMARY_THINKING_CHECKLIST },
      );
      // Gửi yêu cầu + phân tích, thất bại thử lại theo cài đặt (yêu cầu báo lỗi hoặc JSON không hợp lệ / thiếu summary đều tính là thất bại)
      const delta = await sendAndParse(sender.send, messages, raw => {
        console.log('[Bách Bảo Thư] Kết quả tổng kết gốc trả về (chưa làm sạch):\n', raw);
        const d = extractJsonObject<{ summary?: string }>(raw);
        const summary = llmString(d?.summary);
        if (!summary) {
          // Cấp độ đầu ra level+1: bằng 1 là tổng kết thông thường, ≥2 là tổng kết lần hai; có văn bản = rơi định dạng, trống = trả về rỗng
          const what = level + 1 === 1 ? 'Tổng kết' : 'Tổng kết lần hai';
          throw new Error(raw.trim() ? `${what} thất bại: AI xin lỗi hoặc làm rơi định dạng` : `${what} thất bại: AI trả về rỗng`);
        }
        return { summary };
      });

      // Sinh nút tầng trên thu nạp đợt này (**không xóa batch**), dấu thời gian lấy mới nhất trong đợt, xếp ở sau chúng
      const newCreatedAt = Math.max(...batch.map(s => s.createdAt)) + 1;
      // Thời gian bắt đầu-kết thúc: batch đã tăng dần theo thời gian → cái đầu tiên có bắt đầu làm start, cái cuối cùng có kết thúc làm end
      const timeStart = batch.find(s => s.timeStart)?.timeStart;
      const timeEnd = [...batch].reverse().find(s => s.timeEnd)?.timeEnd;
      addSummary({
        text: delta.summary.trim(),
        level: level + 1,
        childIds: batch.map(s => s.id),
        auto: true,
        createdAt: newCreatedAt,
        timeStart,
        timeEnd,
      });
      made += 1;
      refreshInjection();
      // Không break: tiếp tục vòng for ngoài, tầng trên có thể cũng đã tích lũy đủ → dây chuyền nén lên tầng cao hơn
    } catch (e) {
      engineState.lastError = e instanceof Error ? e.message : String(e);
      return made; // Tầng này thất bại thì dừng dây chuyền, lần sau thử lại
    }
  }
  return made;
}

/* ============ Tổng kết cưỡng chế thủ công (chọn nhiều để gộp, bỏ qua ngưỡng) ============ */

/** Khung nhìn thống nhất trong engine của một nút có thể được gộp (lá hoặc nút nén). */
interface SelectableNode {
  id: string;
  text: string;
  level: number; // lá=0, comp=cấp độ của nó
  timeStart?: string;
  timeEnd?: string;
  floorLo: number; // Cận dưới tầng lầu bao phủ (lá = tầng của chính nó; comp = nhỏ nhất của lá hậu duệ); không có thì -1
  floorHi: number; // Cận trên tầng lầu bao phủ
}

/**
 * Phân tích khung nhìn thống nhất + tầng lầu bao phủ của "tất cả các nút" trong rừng hiện tại.
 * Lá đến từ chat (lá hợp lệ), tầng lầu = msgIndex; comp đến từ memory.summaries, tầng lầu = min..max đệ quy các lá hậu duệ.
 * Phục vụ summarizeSelected sắp xếp, lấy phạm vi thời gian, tính phạm vi bao phủ.
 */
function collectSelectableNodes(chat: STMessage[]): Map<string, SelectableNode> {
  const map = new Map<string, SelectableNode>();
  // Lá: id → tầng lầu
  const leafFloor = new Map<string, number>();
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không làm nút có thể chọn
    if (!leafValid(chat[i])) continue;
    const lf = getLeaf(chat[i]) as LeafExtra;
    leafFloor.set(lf.id, i);
    map.set(lf.id, { id: lf.id, text: llmString(lf.text), level: 0, timeStart: llmOptionalScalar(lf.timeStart), timeEnd: llmOptionalScalar(lf.timeEnd), floorLo: i, floorHi: i });
  }
  // comp: phân tích đệ quy tầng lầu của các lá hậu duệ
  const byComp = new Map(memory.summaries.map(s => [s.id, s]));
  const floorsOf = (id: string, seen: Set<string>, acc: number[]): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const lf = leafFloor.get(id);
    if (lf !== undefined) { acc.push(lf); return; }
    const c = byComp.get(id);
    if (!c) return;
    if (c.imported) {
      acc.push(c.importedFloorStart ?? 0, c.importedFloorEnd ?? c.importedFloorStart ?? 0);
      return;
    }
    for (const cid of c.childIds ?? []) floorsOf(cid, seen, acc);
  };
  for (const s of memory.summaries) {
    const floors: number[] = [];
    floorsOf(s.id, new Set(), floors);
    const lo = floors.length ? Math.min(...floors) : -1;
    const hi = floors.length ? Math.max(...floors) : -1;
    map.set(s.id, { id: s.id, text: llmString(s.text), level: s.level, timeStart: llmOptionalScalar(s.timeStart), timeEnd: llmOptionalScalar(s.timeEnd), floorLo: lo, floorHi: hi });
  }
  return map;
}

/**
 * Tổng kết cưỡng chế thủ công: đem một số **nút gốc** (trộn lẫn tầng lá / tổng kết) do người dùng tích chọn gộp thành một tổng kết tầng trên bất chấp ngưỡng.
 * Khác biệt với checkResummary tự động: không xét ngưỡng, không xét cấp độ có đồng đều hay không, nén thẳng đợt này.
 *  - level = max(cấp độ đã chọn) + 1; phạm vi thời gian = timeStart đầu tiên + timeEnd cuối cùng sau khi sắp xếp (giống checkResummary).
 *  - Dự phòng tính liên tục: tầng lầu bao phủ của các nút được chọn phải nối liền thành một đoạn (UI đã giới hạn, ở đây phòng vệ); cho phép chọn trộn lẫn khác tầng.
 *  - Nút sinh ra có auto=false đánh dấu thủ công. busy loại trừ lẫn nhau, thu dọn cuối giống resummarizeNow + ẩn/tiêm.
 * Trả về { made, error }: made=1 thành công, 0 chưa tạo (error giải thích nguyên nhân).
 */
export async function summarizeSelected(nodeIds: string[]): Promise<{ made: number; error?: string }> {
  if (!engineActiveHere()) return { made: 0, error: 'Plugin không có hiệu lực trong cuộc trò chuyện hiện tại' };
  if (busy) return { made: 0, error: 'Đang bận, vui lòng thử lại sau' };
  if (nodeIds.length < 2) return { made: 0, error: 'Phải chọn ít nhất hai mục mới có thể gộp' };

  const ctx = getContext();
  if (!ctx) return { made: 0, error: 'Không có ngữ cảnh ST' };
  const chat = ctx.chat ?? [];

  const all = collectSelectableNodes(chat);
  const picked: SelectableNode[] = [];
  for (const id of nodeIds) {
    const n = all.get(id);
    if (!n) return { made: 0, error: 'Có mục đã chọn không còn hợp lệ, vui lòng làm mới rồi thử lại' };
    picked.push(n);
  }
  // Tăng dần theo tầng lầu bao phủ (nhất quán với trình tự thời gian của rừng tóm tắt); không có tầng lầu xếp cuối cùng
  const key = (n: SelectableNode) => (n.floorLo < 0 ? Number.MAX_SAFE_INTEGER : n.floorLo);
  picked.sort((a, b) => key(a) - key(b));

  // Dự phòng tính liên tục: các mục được chọn bắt buộc phải là một lát cắt liên tục trong "chuỗi gốc hiện tại" (ở giữa không được nhảy cóc qua gốc khác).
  // ⚠️ Không thể dùng hiệu số msgIndex (cur.floorLo > prev.floorHi + 1) để phán đoán —— floorLo/Hi của lá chỉ ghi
  // index của chính tầng AI đó, không bao gồm tầng user phía trước, mà giữa hai tầng AI liền kề tất nhiên cách nhau tầng user (hiệu số ≥2),
  // làm vậy sẽ phán đoán nhầm bất kỳ hai tóm tắt lá liền kề nào thành không liên tục (nguyên nhân gốc rễ khiến việc gộp âm thầm thất bại). Đổi sang phán đoán theo
  // "thứ tự của gốc trong rừng", cùng nguồn với canMerge của UI (chỉ mục mảng chuỗi gốc liền kề nhau).
  const referenced = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const rootOrder = [...all.values()].filter(n => !referenced.has(n.id)).sort((a, b) => key(a) - key(b));
  const posOf = new Map(rootOrder.map((n, i) => [n.id, i] as const));
  const positions: number[] = [];
  for (const n of picked) {
    const p = posOf.get(n.id);
    if (p === undefined) return { made: 0, error: 'Trong các mục đã chọn có tóm tắt đã được thu nạp, vui lòng chỉ chọn tóm tắt tầng cao nhất' };
    positions.push(p);
  }
  positions.sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) {
      return { made: 0, error: 'Chỉ có thể gộp các tóm tắt liên tiếp nhau (ở giữa không được bỏ qua tóm tắt khác)' };
    }
  }

  const sender = resolveSender('resummary');
  if ('error' in sender) return { made: 0, error: sender.error };

  const level = Math.max(...picked.map(n => n.level)) + 1;
  const { content, hints } = joinNodesForResummary(picked);
  const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content, level });

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
    const messages: ChatMsg[] = [];
    if (jb) messages.push({ role: 'system', content: jb });
    // Giống nén tự động: system có thể trống, tin nhắn trống không gửi
    if (prompt.system) messages.push({ role: 'system', content: prompt.system });
    messages.push(
      { role: 'user', content: prompt.user + hints },
      { role: 'system', content: RESUMMARY_THINKING_CHECKLIST },
    );
    const delta = await sendAndParse(sender.send, messages, raw => {
      console.log('[Bách Bảo Thư] Kết quả tổng kết cưỡng chế gốc trả về (chưa làm sạch):\n', raw);
      const d = extractJsonObject<{ summary?: string }>(raw);
      const summary = llmString(d?.summary);
      if (!summary) {
        const what = level === 1 ? 'Tổng kết' : 'Tổng kết lần hai';
        throw new Error(raw.trim() ? `${what} thất bại: AI xin lỗi hoặc làm rơi định dạng` : `${what} thất bại: AI trả về rỗng`);
      }
      return { summary };
    });

    // Phạm vi thời gian: picked đã tăng dần theo tầng lầu → cái đầu tiên có bắt đầu làm start, cái cuối cùng có kết thúc làm end (giống checkResummary)
    const timeStart = picked.find(s => s.timeStart)?.timeStart;
    const timeEnd = [...picked].reverse().find(s => s.timeEnd)?.timeEnd;
    addSummary({
      text: delta.summary.trim(),
      level,
      childIds: picked.map(s => s.id),
      auto: false, // Gộp thủ công
      timeStart,
      timeEnd,
    });
    engineState.lastRunAt = Date.now();
    recomputeDerived();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    engineState.lastError = msg;
    return { made: 0, error: msg };
  } finally {
    busy = false;
    engineState.running = false;
  }
  await afterSummaryHideAndInject(chat);
  return { made: 1 };
}

/**
 * "Kiểm tra và tổng kết ngay" thủ công: phục vụ nút bấm ở trang tóm tắt gọi.
 * Cùng một bộ logic ngưỡng / dây chuyền với đường dẫn tự động (checkResummary), nhưng có kèm loại trừ lẫn nhau busy,
 * tránh đụng độ với việc tóm tắt / tổng kết đang chạy. Trả về số lượng tổng kết mới tạo ra (0 = chưa đạt ngưỡng, chưa làm gì cả).
 */
export async function resummarizeNow(): Promise<number> {
  if (!engineActiveHere()) return 0;
  if (busy) return 0;
  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    return await checkResummary();
  } finally {
    busy = false;
    engineState.running = false;
  }
}

/**
 * Phản hồi biến động cấu trúc chat (lật trang / xóa / chỉnh sửa): dữ liệu đã tự động đi theo tin nhắn, chỉ cần dọn chuỗi hỏng, tính lại dẫn xuất, làm mới,
 * không làm bất kỳ phẫu thuật chỉ mục nào, **không kích hoạt sinh tóm tắt** (việc sinh do maybeSummarizePrevAi quyết định riêng theo quy tắc).
 * debounce gộp các lần lật liên tiếp nhanh.
 */
let reactTimer: ReturnType<typeof setTimeout> | null = null;
function reactToChatMutation(syncHidden = false): void {
  // Bộ nhớ đệm mất hiệu lực ngay lập tức, chỉ mục chống rung riêng; việc tính lại UI / dẫn xuất vẫn gộp theo mốc 200ms bên dưới.
  scheduleVectorIndex();
  if (reactTimer) clearTimeout(reactTimer);
  reactTimer = setTimeout(() => {
    reactTimer = null;
    pruneBrokenComps(); // Lá mất hiệu lực → xóa toàn bộ chuỗi nén tổ tiên có chứa nó
    recomputeDerived(); // Xóa lá / lỗi thời → vật phẩm / kế hoạch lùi về; UI (derivedMeta) cập nhật
    if (syncHidden && engineActiveHere() && apiSettings.autoSummaryEnabled) {
      void syncWindowHiddenState(getContext()?.chat ?? [])
        .catch(e => {
          engineState.lastError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => refreshInjection());
      return;
    }
    refreshInjection(); // Không còn tiêm các lá lỗi thời / đã xóa nữa
  }, 200);
}

/**
 * Gắn kết sự kiện. Quy tắc kích hoạt tóm tắt: **chỉ đảm bảo "tin nhắn AI đã chốt bản thảo ngay trước đó" có tóm tắt** (tăng thêm đơn tầng, không phải toàn bộ).
 * Vào cuộc trò chuyện / lật sang trang chưa có tóm tắt, đều không còn tự động tóm tắt bù ngay lập tức nữa.
 *  - USER_MESSAGE_RENDERED: gửi tin nhắn mới → tóm tắt "AI ngay trước" (skipLastAi=false).
 *  - GENERATION_STARTED(regenerate/swipe): AI ở cuối đang bị viết lại, bỏ qua nó → tóm tắt "AI trước đó nữa" (skipLastAi=true).
 *  - MESSAGE_SWIPED / MESSAGE_EDITED: dữ liệu đi theo tin nhắn → reactToChatMutation (dọn chuỗi hỏng + tính lại + làm mới), không tạo mới tại đây.
 *  - MESSAGE_DELETED: như trên, đồng thời đồng bộ một lần ẩn / bỏ ẩn trượt.
 *  - CHAT_CHANGED: store phụ trách tải lại, ở đây làm mới tiêm.
 */
export function bindEngine(): void {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  const es = ctx.eventSource;
  const et = ctx.eventTypes;

  normalizeBacklogNotices(ctx.chat ?? []);
  console.log('[Bách Bảo Thư] bindEngine thực thi, lắng nghe', et.USER_MESSAGE_RENDERED, et.GENERATION_STARTED);

  // Gửi tin nhắn mới: lúc này AI ở cuối là câu trả lời "đã chốt bản thảo ngay trước", đuổi theo thứ tự từ khoảng trống sớm nhất đến nó.
  es.on(et.USER_MESSAGE_RENDERED, () => {
    console.log('[Bách Bảo Thư] USER_MESSAGE_RENDERED → tóm tắt AI ngay trước');
    void maybeSummarizePrevAi(false);
  });

  // Tạo lại / lật trang: chỉ khi ở cuối cuộc trò chuyện thực sự là AI mới coi là đang viết lại và bỏ qua;
  // khi ở cuối là tầng người dùng (như khôi phục tạo sau khi thất bại), tầng AI phía trước đã ổn định, vẫn nên tóm tắt bù bình thường.
  // ⚠️ Các type được cho qua ở đây (quiet/impersonate/continue) bắt buộc phải nhất quán nghiêm ngặt với cổng đầu tiên của handleGenerationIntercept ——
  //    một khi tiêu chuẩn hai bên không đồng bộ, khi tạo lại / lật trang sẽ xuất hiện việc "tóm tắt bù" và "tạo chính văn" chạy song song (xem phần "Trình tự / tiêu chuẩn then chốt" trong chú thích bộ chặn).
  if (et.GENERATION_STARTED) {
    es.on(et.GENERATION_STARTED, (type?: string, _opts?: unknown, dryRun?: boolean) => {
      if (dryRun) return;
      if (type === 'quiet' || type === 'impersonate' || type === 'continue') return; // Không phải câu trả lời mới thực sự
      const chat = getContext()?.chat ?? [];
      const skipLastAi = shouldSkipLastAiForGeneration(chat, type);
      console.log('[Bách Bảo Thư] GENERATION_STARTED → tự động tóm tắt, type =', type, '| skipLastAi =', skipLastAi);
      void maybeSummarizePrevAi(skipLastAi);
    });
  }

  // Ba sự kiện dưới đây chỉ để dữ liệu / UI đi theo, không chủ động sinh tóm tắt.
  if (et.MESSAGE_SWIPED) es.on(et.MESSAGE_SWIPED, () => reactToChatMutation());
  // Chỉnh sửa tin nhắn: trước tiên đồng bộ ngược thay đổi của chú thích <bbs_items> trong chính văn tầng đó về lại delta của lá (người dùng sửa tay vật phẩm),
  // sau đó đi qua xử lý hậu kỳ chung (dọn chuỗi hỏng / tính lại / làm mới). Trễ một nhịp để đảm bảo ST đã ghi phần chỉnh sửa về lại chat[messageId].mes.
  if (et.MESSAGE_EDITED) {
    es.on(et.MESSAGE_EDITED, (messageId?: number) => {
      setTimeout(() => {
        if (typeof messageId === 'number') {
          try { syncItemLogFromMessage(messageId); } catch (e) { console.warn('[Bách Bảo Thư] Phân tích ngược chú thích vật phẩm thất bại', e); }
        }
        reactToChatMutation();
      }, 0);
    });
  }
  if (et.MESSAGE_DELETED) es.on(et.MESSAGE_DELETED, () => reactToChatMutation(true));

  // Câu trả lời mới của AI đã chốt: chưa chắc sẽ kích hoạt tóm tắt (tự động tóm tắt đang tắt / nó không phải là "AI ngay trước"),
  // nhưng danh sách "Tầng chưa tóm tắt" bắt buộc phải bắt kịp tầng AI mới thêm, nên tính lại không điều kiện một lần bộ nhớ đệm dẫn xuất (không gửi yêu cầu).
  if (et.CHARACTER_MESSAGE_RENDERED) es.on(et.CHARACTER_MESSAGE_RENDERED, () => recomputeDerived());

  if (et.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, () => {
      // Việc tải lại bộ nhớ do trình lắng nghe CHAT_CHANGED của store phụ trách; tại đây chỉ làm mới tiêm ở ngay sau đó
      clearRecallInjection(); // Chuyển cuộc trò chuyện thì xóa sạch phần truy xuất còn sót của cuộc trò chuyện trước (cuộc trò chuyện mới lần tạo sau sẽ tính lại)
      setTimeout(() => {
        normalizeBacklogNotices(getContext()?.chat ?? []);
        refreshInjection();
      }, 0);
    });
  }

  // Chuyển đổi công tắc tổng: tắt → xóa sạch các khe trí nhớ đã tiêm (không đụng các tầng đã ẩn và tóm tắt đã lưu, phù hợp với nguyên tắc "dữ liệu đã có không xử lý");
  // bật → tiêm lại trí nhớ hiện tại về ngữ cảnh. Chỉ phản hồi việc chuyển đổi, không kích hoạt ở khung hình đầu tiên.
  watch(
    () => apiSettings.enabled,
    on => (on ? refreshInjection() : clearInjection()),
  );

  // Chuyển đổi công tắc tự động tóm tắt: thẻ thời gian (regex ẩn + prompt cố định) bật tắt theo nó, không còn công tắc độc lập nữa.
  watch(
    () => apiSettings.autoSummaryEnabled,
    () => {
      syncTimeTagRegex();
      refreshInjection();
    },
  );

  // Sau khi chuyển đổi chế độ chỉ tóm tắt thì làm mới ngay khe gợi ý ST bền vững; các chú thích hiện có trong chính văn không chủ động dọn dẹp.
  watch(
    () => apiSettings.summaryOnlyMode,
    () => refreshInjection(),
  );
}
