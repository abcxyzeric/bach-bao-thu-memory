/**
 * Tiêm trí nhớ trở lại ngữ cảnh đối thoại chính.
 *
 * Cơ chế: đi qua hàm chuẩn của ST là setExtensionPrompt(key, value, position, depth, scan, role, filter),
 * thay vì splice thủ công eventData.chat. setExtensionPrompt có tính bền vững —— sau một lần thiết lập,
 * mỗi lần đối thoại chính sinh nội dung đều sẽ mang theo, cho đến lần sau ghi đè bằng cùng key. Vì vậy chỉ cần "trí nhớ thay đổi thì làm mới" là được.
 *
 * Đi kèm với cơ chế ẩn: các tầng cũ bị is_system=true đá khỏi ngữ cảnh chính (xem engine.ts),
 * tại đây đem bản tóm tắt đã nén của chúng + trạng thái có cấu trúc hiện tại tiêm ngược lại làm gợi ý system,
 * nhờ đó mô hình chính vẫn cảm nhận được cốt truyện đã bị ẩn. Tóm tắt lịch sử đặt gần đỉnh cuộc trò chuyện, trạng thái hiện tại bám sát cuộc đối thoại gần nhất.
 */

import { apiSettings, engineActiveHere } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { buildSceneLocationIndex, classifyNpcPresence, findCurrentSceneId, getLeaf, itemReachableAtScene, leafValid } from './apply';
import { fmtItems, fmtPlans, fmtResolvedPlans, renderVarsState, selectRecentResolvedPlans, MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from './prompts';
import { fmtLifeDetail } from './lifeDetails';
import { fmtKnowledgeInjection } from './knowledge';
import { fmtNpcAffinity, fmtNpcTiesContext, NPC_AFFINITY_BRIEFING } from './npcRelations';
import { memory } from './store';
import { compactTimeLabel, formatRange, latestStoryTime, splitTimeLabel, timeTagPrompt } from './timeTag';
import { relativeTimeLabel, weekdayLabel, ageDisplay, calculateRelativeDays } from './timeRel';
import { selectViewNodes, selectLifeDetailsForInjection, type ViewNode } from './select';
import type { LeafExtra, MemItem, MemLifeDetail, MemNpc, MemProtagonist, MemScene, MemSummary, SceneFocus } from './types';

// Danh sách trang tóm tắt tái sử dụng cùng một bộ logic lựa chọn, re-export qua đây (thuật toán thuần nằm ở select.ts, không phụ thuộc, có thể kiểm thử đơn vị)
export { selectViewNodes, type ViewNode };

// Nguồn gốc các hằng số dưới đây: SillyTavern public/script.js
//   extension_prompt_types.IN_CHAT = 1   (script.js:486)
//   extension_prompt_roles.SYSTEM = 0    (script.js:494)
// getContext() không bộc lộ hai enum này, nên mã hóa cứng và ghi chú xuất xứ.
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** Key khe đơn bản cũ; khi làm mới sẽ xóa trống, tránh sau khi nâng cấp D2 còn sót gây tiêm trùng lặp */
const LEGACY_INJECT_KEY = 'baibai_book_memory';
/** Các key setExtensionPrompt sau khi tách; cùng key set lặp lại tức là ghi đè, tự nhiên bất biến (idempotent) */
const HISTORY_INJECT_KEY = 'baibai_book_memory_history';
const STATE_INJECT_KEY = 'baibai_book_memory_state';
/** Khe prompt cố định thẻ thời gian: tiêm vào đối thoại chính, yêu cầu trước sau mỗi chính văn xuất <bbs_start>/<bbs_end> */
const TIMETAG_INJECT_KEY = 'baibai_book_time_tag';
/** Tóm tắt lịch sử cố gắng đặt gần đỉnh ngữ cảnh cuộc trò chuyện; trạng thái hiện tại bám sát đối thoại gần nhất */
const HISTORY_INJECT_DEPTH = 9999;
const STATE_INJECT_DEPTH_AFTER_LATEST_AI = 1;
const STATE_INJECT_DEPTH_BEFORE_LATEST_AI = 2;
/** Prompt thẻ thời gian tiêm độc lập vào D0 (dưới cùng, sát câu trả lời tiếp theo nhất), làm chỉ thị mạnh nhất cho "câu trả lời tiếp theo",
 *  không cùng tầng với ảnh chụp trạng thái (D1/D2) */
const TIMETAG_INJECT_DEPTH = 0;

/**
 * Một lá có đang "được kích hoạt" (nên tiêm) hay không.
 * Tách rời giữa việc tạo và việc sử dụng: lá được tạo trước cho mọi tầng, nhưng chỉ khi tin nhắn chứa nó đã bị ẩn (is_system,
 * nguyên văn rời khỏi ngữ cảnh chính) thì mới tiêm để thay thế nguyên văn; lá vẫn nằm trong cửa sổ giữ lại gửi toàn văn thì tạm không tiêm, tránh lặp lại với toàn văn.
 */
function leafActiveAt(chat: STMessage[] | null, i: number): boolean {
  if (!chat) return false;
  return chat[i]?.is_system === true;
}

/** Dùng để quyết định vị trí của ảnh chụp trạng thái so với tầng AI mới nhất; giữ nhất quán với quy tắc tầng AI có thể theo dõi của engine.ts. */
function isTrackableAiMessage(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (m.extra?.bbs_omit) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.extra?.bbs_hidden) return true;
  return !m.is_system;
}

/** Ngữ cảnh gần đây để khớp kích hoạt: ghép chính văn vài tầng gần nhất (mới cũ đều được, gồm cả tầng người dùng), cắt gọn chống tràn. */
function recentContextText(): string {
  const chat = getContext()?.chat;
  if (!chat?.length) return '';
  const texts: string[] = [];
  for (let i = chat.length - 1; i >= 0 && texts.length < 6; i--) {
    const m = chat[i];
    const mes = typeof m?.mes === 'string' ? m.mes.trim() : '';
    if (mes) texts.push(mes);
  }
  return texts.join('\n').slice(0, 4000);
}

/**
 * Vị trí tiêm của trạng thái hiện tại:
 *  - Tầng AI mới nhất đã có tóm tắt hợp lệ → trạng thái đã bao gồm nó, đặt ở sau nó (D1).
 *  - Tầng AI mới nhất chưa có tóm tắt hợp lệ → trạng thái chưa bao gồm nó, giữ đặt ở trước nó (D2).
 */
function resolveStateInjectionDepth(chat: STMessage[] | null): number {
  if (!chat) return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (!isTrackableAiMessage(chat[i])) continue;
    return leafValid(chat[i]) ? STATE_INJECT_DEPTH_AFTER_LATEST_AI : STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  }
  return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
}

/** Xây dựng khung nhìn rừng thống nhất: lá (leafValid) + nút nén, gốc = những nút không bị bất kỳ childIds nào tham chiếu */
function buildView(
  summaries: MemSummary[],
  chat: STMessage[] | null,
): { byId: Map<string, ViewNode>; roots: ViewNode[] } {
  const byId = new Map<string, ViewNode>();

  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      if (chat[i]?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không đưa vào khung nhìn tiêm
      if (!leafValid(chat[i])) continue; // Lá cũ lỗi thời không đưa vào khung nhìn → không tiêm
      const leaf = getLeaf(chat[i]) as LeafExtra;
      byId.set(leaf.id, {
        id: leaf.id,
        kind: 'leaf',
        level: 0,
        text: leaf.text,
        timeStart: leaf.timeStart,
        timeEnd: leaf.timeEnd,
        timeLabel: leaf.timeLabel,
        createdAt: leaf.createdAt,
        childIds: [],
        msgIndex: i,
        active: leafActiveAt(chat, i),
      });
    }
  }
  for (const s of summaries) {
    byId.set(s.id, {
      id: s.id,
      kind: 'comp',
      level: s.level,
      text: s.text,
      timeStart: s.timeStart,
      timeEnd: s.timeEnd,
      timeLabel: s.timeLabel,
      createdAt: s.createdAt,
      childIds: s.childIds ?? [],
      // Lịch sử nhập vào lấy tầng kết thúc bao phủ làm "vị trí xảy ra lịch sử", tiện cho việc phán đoán beforeIndex; comp thông thường vẫn do lá hậu duệ quyết định.
      msgIndex: s.imported ? (s.importedFloorEnd ?? -1) : -1,
      active: s.imported === true,
      atomic: s.imported === true,
      floorStart: s.importedFloorStart,
      floorEnd: s.importedFloorEnd,
    });
  }

  const referenced = new Set<string>();
  for (const s of summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const roots = [...byId.values()].filter(n => !referenced.has(n.id));
  return { byId, roots };
}

/**
 * Lựa chọn nút tổng quát: mỗi lá "đạt chuẩn" được đại diện một lần bởi nút **cao nhất trên chuỗi tổ tiên mà toàn bộ lá hậu duệ đều đạt chuẩn**
 * (tiết kiệm token); nếu không nút nén sẽ hạ cấp, đệ quy từng nút con. Lá "đạt chuẩn" do leafEligible phán đoán.
 *  - Kịch bản tiêm: đạt chuẩn = đã ẩn (active), dùng selectInjectionNodes.
 *  - Kịch bản phân tích lịch sử: đạt chuẩn = tầng nằm trước tầng đang phân tích, dùng selectHistoryNodesBefore.
 *
 * ⚠️ Tính nguyên vẹn (intact): nếu một childId nào đó của một nút nén trỏ tới lá đã mất hiệu lực (lật sang swipe khác →
 * leafValid=false → không có trong byId), thì nút đó **không nguyên vẹn**, không thể đại diện tổng thể để tiêm (văn bản nén của nó
 * có nhúng tự sự cũ của trang đã mất hiệu lực, sẽ xung đột với chính văn hiện tại). Lúc này hạ cấp đệ quy, đổi sang dùng **các nút con vẫn nguyên vẹn** của nó tự đại diện riêng:
 * nhánh bị ảnh hưởng tách dọc xuống tận tầng lá, bỏ qua lá mất hiệu lực, còn nút con nguyên vẹn ở nhánh bên (như một L1 khác cùng tầng) giữ nguyên cả nhánh.
 * Nút mất hoạt tính chỉ là "hiện tại không hiển thị / không tiêm", dữ liệu rừng không xóa —— lật về trang cũ leafValid khôi phục, tức thì tự động sống lại.
 */
function selectNodes(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  return selectViewNodes(buildView(summaries, chat), leafEligible);
}

/**
 * Chọn ra các nút dùng để tiêm: mỗi lá "đã kích hoạt (đã ẩn)" được đại diện một lần bởi nút toàn-kích-hoạt cao nhất trên chuỗi tổ tiên của nó;
 * lá trong cửa sổ vẫn gửi toàn văn thì không tiêm.
 */
export function selectInjectionNodes(summaries: MemSummary[], chat: STMessage[] | null): ViewNode[] {
  return selectNodes(summaries, chat, n => n.active);
}

/**
 * Chọn ra các nút lịch sử "trước tầng đang được phân tích", dùng để tiêm ngữ cảnh khi sinh tóm tắt:
 * lá có tầng < beforeIndex, được đại diện một lần bởi nút cao nhất trên chuỗi tổ tiên mà "toàn bộ hậu duệ đều ở trước beforeIndex"
 * (có tổng kết thì dùng văn bản nén của tổng kết). Không yêu cầu phải ẩn.
 */
export function selectHistoryNodesBefore(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  beforeIndex: number,
): ViewNode[] {
  return selectNodes(summaries, chat, n => n.msgIndex >= 0 && n.msgIndex < beforeIndex);
}

/** Thời gian hiển thị của nút: dữ liệu mới dùng bắt đầu-kết thúc ghép lại, dữ liệu cũ lùi về timeLabel */
function nodeTime(n: ViewNode): string {
  if (n.timeStart || n.timeEnd) return formatRange(n.timeStart, n.timeEnd);
  return n.timeLabel ? compactTimeLabel(n.timeLabel) : '';
}

/**
 * Ghép các nút đã chọn thành khối văn bản tóm tắt lịch sử chỉ mang thời gian tuyệt đối; trống thì trả về chuỗi rỗng.
 * Bộ kết xuất này dùng chung cho các tác vụ phụ như tóm tắt / tóm tắt hàng loạt / viết lại truy vấn: mỗi tác vụ có điểm cắt lịch sử riêng,
 * không thể dùng chung tiêu chuẩn "tương đối so với cốt truyện mới nhất hiện tại" của đối thoại chính, do đó ở đây cố ý không tính thời gian tương đối.
 */
export function renderHistoryNodes(nodes: ViewNode[]): string {
  return nodes
    .map(n => {
      const t = nodeTime(n);
      return t ? `【${t}】${n.text}` : n.text;
    })
    .join('\n\n');
}

/** "Thời gian sự kiện" của nút: dùng thời gian kết thúc (thời khắc cốt truyện đã đi tới); thiếu thì lùi về bắt đầu, rồi lùi tiếp về đầu kết thúc của timeLabel cũ */
function nodeEventTime(n: ViewNode): string {
  if (n.timeEnd) return n.timeEnd;
  if (n.timeStart) return n.timeStart;
  return n.timeLabel ? splitTimeLabel(n.timeLabel).end ?? '' : '';
}

/** Lấy thời gian bắt đầu và kết thúc chưa nén của nút; ưu tiên trường mới, đầu bị thiếu mới lùi về từ timeLabel cũ. */
function nodeTimeRange(n: ViewNode): { start: string; end: string } {
  const legacy = n.timeLabel ? splitTimeLabel(n.timeLabel) : {};
  return {
    start: n.timeStart?.trim() || legacy.start?.trim() || '',
    end: n.timeEnd?.trim() || legacy.end?.trim() || '',
  };
}

/** Bổ sung thời gian tương đối và thứ trong tuần vào một mốc thời gian đầy đủ; phần không thể suy đoán tự nhiên lược bỏ. */
function timePointWithRelative(time: string, now: string): string {
  const value = time.trim();
  if (!value) return '';
  const parts = [relativeTimeLabel(value, now), weekdayLabel(value)].filter(Boolean);
  return parts.length ? `${value}(${parts.join('·')})` : value;
}

/**
 * Nút tổng kết trải dài qua một khoảng thời gian, không thể dùng một chữ "Hôm qua" đơn lẻ để đại diện cho cả đoạn.
 * Vì vậy điểm đầu và điểm cuối được tính tương đối riêng biệt so với cùng một now, và giữ nguyên thời gian tuyệt đối đầy đủ ở cả hai đầu:
 * 【1988/9/28 22:00(Hôm kia·Thứ tư) - 1988/9/29 08:00(Hôm qua·Thứ năm)】
 */
function nodeRangeWithRelative(n: ViewNode, now: string): string {
  const { start, end } = nodeTimeRange(n);
  if (!start && !end) return '';
  if (start && end && start !== end) {
    return `${timePointWithRelative(start, now)} - ${timePointWithRelative(end, now)}`;
  }
  return timePointWithRelative(start || end, now);
}

/**
 * Dùng cho tiêm đối thoại chính / macro lịch sử công khai: bù thêm thời gian tương đối cho các nút lịch sử, giúp mô hình cảm nhận khoảng cách cốt truyện.
 * Điểm tham chiếu now = thời gian mới nhất trong truyện; những chỗ không phân tích được độ lệch tương đối (kỷ nguyên hư cấu, v.v.) hạ cấp xuống chỉ hiển thị thời gian tuyệt đối.
 * Không gộp vào renderHistoryNodes —— hàm đó được các tác vụ phụ như mô hình tóm tắt tái sử dụng, điểm cắt và điểm tham chiếu khác nhau.
 *
 * Tóm tắt lá trỏ tới một tầng đơn, giữ định dạng 【(Hôm qua·Thứ tư) thời gian tuyệt đối】.
 * Tổng kết trải qua nhiều tầng, gắn nhãn riêng theo hai đầu bắt đầu và kết thúc thành 【bắt đầu(tương đối) - kết thúc(tương đối)】, tránh dùng một thời gian tương đối đơn lẻ đại diện nhầm cho cả đoạn.
 * Thứ trong tuần và thời gian tương đối gộp vào cùng một cặp ngoặc đơn; chỉ dương lịch chuẩn có kèm năm mới có thứ trong tuần (weekdayLabel tự mang ngưỡng lọc).
 */
export function renderHistoryNodesWithRelative(nodes: ViewNode[], now: string): string {
  return nodes
    .map(n => {
      if (n.kind === 'comp') {
        const range = nodeRangeWithRelative(n, now);
        return range ? `【${range}】${n.text}` : n.text;
      }
      const t = nodeTime(n);
      if (!t) return n.text;
      const event = nodeEventTime(n);
      const parts = [relativeTimeLabel(event, now), weekdayLabel(event)].filter(Boolean);
      return parts.length ? `【(${parts.join('·')}) ${t}】${n.text}` : `【${t}】${n.text}`;
    })
    .join('\n\n');
}

/** Tổ hợp văn bản tiêm tóm tắt lịch sử; khi không có tóm tắt được kích hoạt thì trả về chuỗi rỗng (tiêm chuỗi rỗng đồng nghĩa với xóa sạch). */
export function buildHistoryInjectionText(): string {
  const chat = getContext()?.chat ?? null;

  // Chọn nút "tầng nén còn sống cao nhất" từ rừng (nút đã được thu nạp không lặp lại, lá toàn văn trong cửa sổ không tiêm)
  const sums = selectInjectionNodes(memory.summaries, chat);
  if (!sums.length) return '';
  // Đường dẫn tiêm mang tiền tố thời gian tương đối; điểm tham chiếu = thời gian mới nhất trong truyện (đọc thẻ chính văn, không bị ảnh hưởng bởi việc đã tóm tắt hay chưa)
  // Đầu cuối đóng khung bằng bản tin mật, tránh mô hình chính coi tóm tắt là khuôn mẫu cần thuật lại / xuất ra
  return `${MEMORY_BRIEFING_NOTE}\n[Tóm tắt cốt truyện lịch sử]\n${renderHistoryNodesWithRelative(sums, latestStoryTime(chat))}\n${MEMORY_BRIEFING_END}`;
}

/**
 * Định vị "nút hiện tại" trong cây bối cảnh: ưu tiên locationPath có thẩm quyền do AI đưa ra, nếu không thì thu hẹp khớp mờ theo here.
 * Dùng chung apply.findCurrentSceneId với trang bối cảnh (một nguồn duy nhất, triệt tiêu việc rẽ nhánh giữa trang giao diện và tiêm), ở đây giải ngược id về lại nút.
 * Không tìm thấy trả về null (lùi về hành vi chuỗi thuần).
 */
function findCurrentScene(scenes: MemScene[], here: string, locationPath?: string[]): MemScene | null {
  const id = findCurrentSceneId(scenes, here, locationPath);
  if (!id) return null;
  return scenes.find(s => s.id === id) ?? null;
}

/** Truy ngược chuỗi tổ tiên (từ lớn đến nhỏ, bao gồm cả bản thân nút hiện tại). */
function sceneChain(scenes: MemScene[], node: MemScene | null): MemScene[] {
  if (!node) return [];
  const byId = new Map(scenes.map(s => [s.id, s]));
  const chain: MemScene[] = [];
  let cur: MemScene | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * Kết xuất khối tiêm bối cảnh (chia làm các mức để tiết kiệm token):
 *  - Địa điểm hiện tại + chuỗi tổ tiên: chi tiết từng cấp "Tên(mô tả)".
 *  - Các địa điểm khác từng đi qua: chỉ liệt kê tên (tên đường dẫn đầy đủ), giúp AI tái sử dụng cách đặt tên đã có, tránh ghi trùng lặp.
 * Không có dữ liệu bối cảnh trả về chuỗi rỗng.
 */
function fmtSceneContext(scenes: MemScene[], here: string, locationPath?: string[]): string {
  if (!scenes.length) return '';
  const current = findCurrentScene(scenes, here, locationPath);
  const chain = sceneChain(scenes, current);
  const chainIds = new Set(chain.map(s => s.id));

  const lines: string[] = [];
  if (chain.length) {
    const detailed = chain
      .map(n => (oneLine(n.desc) ? `${n.name}(${oneLine(n.desc)})` : n.name))
      .join(' › ');
    lines.push(`Nơi đang ở hiện tại (từ lớn đến nhỏ):${detailed}`);
  }
  // Địa điểm khác: chỉ tên (dùng đường dẫn đầy đủ biểu đạt cấp bậc), loại trừ những nơi đã mô tả chi tiết trong chuỗi tổ tiên
  const others = scenes
    .filter(s => !chainIds.has(s.id))
    .map(s => s.path.join(' › '));
  if (others.length) {
    lines.push(`Các địa điểm đã biết khác (chỉ tên, đừng ghi trùng lặp):\n${others.map(o => `  - ${o}`).join('\n')}`);
  }
  return lines.join('\n');
}

/**
 * Đơn dòng hóa: gộp các ký tự xuống dòng / về đầu dòng trong giá trị thành khoảng trắng.
 * Danh sách NPC có định dạng "mỗi nhân vật một dòng, các trường ghép bằng ;/——", nếu bên trong giá trị chứa dấu xuống dòng sẽ tách một mẩu thông tin thành nhiều dòng,
 * các dòng sau mất tiền tố "  - ", phá hỏng cấu trúc tiêm và làm AI hiểu lầm. Do đó mọi trường nội tuyến trước khi kết xuất đều đi qua hàm này.
 * (Trong UI trường có thể xuống dòng mềm để hiển thị, nhưng khi tiêm bắt buộc phải ép phẳng —— trim chỉ bỏ đầu cuối, không chặn được xuống dòng ở giữa.)
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Nhân vật chính không tham gia phân mức có mặt của NPC; các trường đã có luôn được tiêm đầy đủ. Tuổi tác suy tính theo mốc neo + thời gian câu chuyện hiện tại (now). */
function fmtProtagonistContext(protagonist: MemProtagonist, name: string, now: string): string {
  const fields: Array<[string, string | undefined]> = [
    ['Giới tính', protagonist.gender],
    ['Tuổi tác', ageDisplay(protagonist.age, protagonist.ageTime, now)],
    ['Thân phận', protagonist.identity],
    ['Ngoại hình', protagonist.appearance],
    ['Trang phục', protagonist.outfit],
    ['Trạng thái', protagonist.condition],
  ];
  const lines = fields
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  if (!lines.length) return '';
  return `${oneLine(name) || 'Nhân vật chính'}:\n${lines.join('\n')}`;
}

/** Ghép "trạng thái tức thời" (trang phục / trạng thái / nơi ở) của NPC thành một đoạn chú thích đuôi; không có thì trả về chuỗi rỗng. Dùng chung cho nhóm có mặt và nhóm nhân vật chính yếu. */
function npcStateTail(n: MemNpc, withPlace: boolean): string {
  const tail: string[] = [];
  if (oneLine(n.outfit)) tail.push(`Trang phục:${oneLine(n.outfit)}`);
  if (oneLine(n.condition)) tail.push(`Trạng thái:${oneLine(n.condition)}`);
  if (withPlace) {
    if (n.follow) tail.push('Đi cùng');
    else if (oneLine(n.location)) tail.push(`Ở:${oneLine(n.location)}`);
  }
  return tail.length ? ` 〔${tail.join(';')}〕` : '';
}

/**
 * "Phần đầu xưng hô" của quan hệ: lấy phần trước dấu phẩy / chấm phẩy / gạch ngang dài đầu tiên của relation (hướng dẫn AI viết danh xưng ở đầu).
 * Dùng cho mức vắng mặt —— danh xưng ngắn kiểu "Anh trai nhân vật chính" quan trọng ngang với giới tính (viết anh ruột thành người dưng cũng chí mạng như nhầm giới tính),
 * nhưng cả câu mô tả thái độ ở mức vắng mặt thì quá tốn, chỉ giữ lại danh xưng.
 */
function relationHead(relation: string | undefined): string {
  const r = oneLine(relation);
  if (!r) return '';
  const head = r.split(/[,,;;、——]/)[0].trim();
  // Danh xưng lẽ ra phải ngắn; lấy ra cả một câu dài chứng tỏ AI không viết theo kiểu "danh xưng ở trước", tiêm cả câu ngược lại tốn kém → bỏ qua
  return head.length <= 24 ? head : '';
}

/**
 * Kết xuất khối tiêm danh sách NPC (chia bốn mức để tiết kiệm token):
 *  - **Nhân vật chính yếu** (important): luôn luôn đưa toàn bộ lên đầu, **làm nổi bật bảng trạng thái tức thời** (trang phục/trạng thái/nơi ở), thân phận/tính cách/ngoại hình viết gọn.
 *  - Quan hệ dài hạn với các nhân vật khác (ties) xuất toàn cục độc lập một lần, không bị ảnh hưởng bởi việc phân mức có mặt dưới đây.
 *  - Có mặt (đi cùng / nơi ở = nút hiện tại của nhân vật chính) → toàn bộ: tên + giới tính + tuổi + thân phận + quan hệ + tính cách + ngoại hình + trạng thái tức thời.
 *  - **Cùng khu vực** (ngước lên tối đa một cấp là ở chung với nhân vật chính) → gọn nhẹ: tên + giới tính + tuổi + thân phận + quan hệ + tính cách + nơi ở. Giữ lại tính cách để tránh AI
 *    tạm thời kéo họ xuất hiện lại bị OOC vô căn cứ; nhưng cắt bỏ hai phần nặng nhất là ngoại hình / trạng thái tức thời, khi đông người sẽ tiết kiệm được rất nhiều.
 *  - Vắng mặt (tổ tiên cấp cao hơn / nhánh bên xa hơn) → chỉ gửi tên + giới tính + danh xưng quan hệ + thân phận (title) + mức hảo cảm đã có (lược bỏ giải thích).
 * **Giới tính được gửi ở tất cả các mức** (bao gồm cả vắng mặt), chống việc AI nhầm giới tính; **phần đầu danh xưng** của quan hệ cũng tương tự (viết anh ruột thành người lạ nghiêm trọng ngang nhau).
 * Tuổi tác được suy tính theo mốc neo + thời gian câu chuyện hiện tại (now) rồi mới tiêm, thời gian nhảy vọt tự động tăng tuổi. Không có NPC trả về chuỗi rỗng.
 */
function fmtNpcContext(npcs: MemNpc[], scenes: MemScene[], here: string, locationPath: string[] | undefined, now: string): string {
  if (!npcs.length) return '';
  const main: MemNpc[] = [];
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  for (const n of npcs) {
    if (n.important) { main.push(n); continue; } // Nhân vật chính yếu liệt kê riêng, không đưa vào phán đoán có mặt nữa
    const p = classifyNpcPresence(n, scenes, here, locationPath); // Dùng chung cùng một phán đoán có thẩm quyền với trang NPC
    if (p === 'present') present.push(n);
    else if (p === 'nearby') nearby.push(n);
    else absent.push(n);
  }
  const age = (n: MemNpc): string => oneLine(ageDisplay(n.age, n.ageTime, now));
  // Công tắc tiêm hảo cảm (trang cài đặt "Cài đặt tiêm"): sau khi tắt danh sách vẫn gửi như thường, chỉ không kèm theo ước lượng hảo cảm.
  // API phụ tóm tắt đi qua fmtNpcSummaryList, không bị ảnh hưởng bởi công tắc này —— việc ghi chép luôn diễn ra bình thường.
  const affinityOn = apiSettings.injection.npcAffinity;
  const aff = (n: MemNpc, partial = false, includeNote = true): string =>
    affinityOn ? fmtNpcAffinity(n, partial, includeNote) : '';

  const lines: string[] = [];
  if (npcs.some(n => aff(n))) lines.push(NPC_AFFINITY_BRIEFING);
  const ties = fmtNpcTiesContext(npcs);
  if (ties) lines.push(ties);
  if (main.length) {
    // Nhân vật chính yếu: ưu tiên bảng trạng thái. Thân phận / quan hệ giữ một câu giúp định vị, ngoại hình / tính cách viết gọn (trong thẻ nhân vật thường đã có), trọng tâm là trạng thái tức thời.
    const detailed = main
      .map(n => {
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        const head = inBracket.length ? `${n.name}(${inBracket.join('·')})` : n.name;
        const rel = oneLine(n.relation) ? ` —— Với nhân vật chính:${oneLine(n.relation)}` : '';
        const affinity = aff(n);
        return `  - ${head}${rel}${affinity ? ` 〔Ước lượng hảo cảm:${affinity}〕` : ''}${npcStateTail(n, true)}`;
      })
      .join('\n');
    lines.push(`Nhân vật chính yếu (diễn viên chính cốt lõi, cần luôn giữ trạng thái hiện tại của họ liền mạch):\n${detailed}`);
  }
  if (present.length) {
    const detailed = present
      .map(n => {
        const parts = [n.name];
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        if (inBracket.length) parts.push(`(${inBracket.join('·')})`);
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`Với nhân vật chính:${oneLine(n.relation)}`);
        const affinity = aff(n);
        if (affinity) profile.push(`Ước lượng hảo cảm:${affinity}`);
        if (oneLine(n.personality)) profile.push(`Tính cách:${oneLine(n.personality)}`);
        if (oneLine(n.desc)) profile.push(oneLine(n.desc));
        const profileStr = profile.length ? ` —— ${profile.join(';')}` : '';
        const place = n.follow ? ' [Đi cùng]' : '';
        return `  - ${parts.join('')}${place}${profileStr}${npcStateTail(n, false)}`;
      })
      .join('\n');
    lines.push(`Nhân vật có mặt:\n${detailed}`);
  }
  if (nearby.length) {
    // Cùng khu vực: tên + giới tính + tuổi + thân phận + quan hệ + tính cách + nơi ở; cắt bỏ ngoại hình / nhân tế / trạng thái tức thời. Giữ lại tính cách để giữ vững thiết lập khi tạm thời xuất hiện.
    const brief = nearby
      .map(n => {
        const inBracket = [oneLine(n.gender), age(n), oneLine(n.title)].filter(Boolean);
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const profile: string[] = [];
        if (oneLine(n.relation)) profile.push(`Với nhân vật chính:${oneLine(n.relation)}`);
        const affinity = aff(n);
        if (affinity) profile.push(`Ước lượng hảo cảm:${affinity}`);
        if (oneLine(n.personality)) profile.push(`Tính cách:${oneLine(n.personality)}`);
        const pers = profile.length ? ` —— ${profile.join(';')}` : '';
        const place = oneLine(n.location) ? ` [Ở:${oneLine(n.location)}]` : '';
        return `  - ${n.name}${bracket}${pers}${place}`;
      })
      .join('\n');
    lines.push(`Nhân vật cùng khu vực (ở gần đây nhưng chưa chắc đã chạm mặt; khi cần có thể để họ xuất hiện tự nhiên, đừng tự ý sửa thiết lập):\n${brief}`);
  }
  if (absent.length) {
    // Vắng mặt: chỉ tên + giới tính + danh xưng quan hệ + thân phận + mức hảo cảm, chú thích nơi ở trong ngoặc; không có ngoại hình / tính cách / trạng thái
    const brief = absent
      .map(n => {
        const inBracket = [oneLine(n.gender), relationHead(n.relation), oneLine(n.title)].filter(Boolean);
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const loc = oneLine(n.location);
        const affinity = aff(n, false, false);
        return `  - ${n.name}${bracket}${loc ? ` [Ở:${loc}]` : ''}${affinity ? ` 〔Ước lượng hảo cảm:${affinity}〕` : ''}`;
      })
      .join('\n');
    lines.push(`Các nhân vật đã biết khác (không ở bối cảnh hiện tại, danh sách tóm lược):\n${brief}`);
  }
  return lines.join('\n');
}

/**
 * Kết xuất ngữ cảnh vật phẩm dưới góc nhìn địa điểm chỉ định.
 * Việc tiêm trạng thái bình thường và bản nháp "Đi tới địa điểm" dùng chung cổng này, đảm bảo phán đoán khả năng tiếp cận của vật phẩm cất gửi không bị rẽ nhánh.
 */
function fmtItemContext(items: MemItem[], scenes: MemScene[], here: string, locationPath?: string[]): string[] {
  const current = findCurrentScene(scenes, here, locationPath);
  const sceneIndex = buildSceneLocationIndex(scenes);
  const reachable: MemItem[] = [];
  const elsewhere: MemItem[] = [];

  for (const item of items) {
    if (item.carried !== false || itemReachableAtScene(scenes, item.location, current, here, sceneIndex)) {
      reachable.push(item);
    } else {
      elsewhere.push(item);
    }
  }

  const blocks = [
    `Danh sách vật phẩm:\n${fmtItems(reachable.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`,
  ];
  if (elsewhere.length) {
    const brief = elsewhere
      .map(i => `  - ${i.name}${typeof i.qty === 'number' ? ` ×${i.qty}` : ''}(cất tại:${oneLine(i.location) || 'nơi nào đó'})`)
      .join('\n');
    blocks.push(`Vật phẩm cất gửi nơi khác (quay lại địa điểm tương ứng mới có thông tin đầy đủ):\n${brief}`);
  }
  return blocks;
}

/**
 * Tạo bản nháp người dùng có thể chỉnh sửa cho thao tác "Đi tới" ở trang bối cảnh.
 * Chỉ tạm thời coi nút mục tiêu là địa điểm hiện tại để tính toán ngữ cảnh bối cảnh, vật phẩm và NPC, không sửa đổi memory.state.
 */
export function buildTravelDraft(target: MemScene): string {
  const here = target.name;
  const locationPath = target.path;
  const destination = target.path.join(' › ');
  const blocks: string[] = [];

  const sceneBlock = fmtSceneContext(memory.scenes, here, locationPath);
  if (sceneBlock) blocks.push(`Ký ức địa điểm:\n${sceneBlock}`);
  blocks.push(...fmtItemContext(memory.items, memory.scenes, here, locationPath));

  const npcBlock = fmtNpcContext(memory.npcs, memory.scenes, here, locationPath, memory.state.time);
  if (npcBlock) blocks.push(`Danh sách NPC:\n${npcBlock}`);

  return [
    `Đi tới "${destination}", xin hãy tiếp tục cốt truyện từ sau khi đến nơi.`,
    `Dưới đây là các ký ức liên quan sau khi đến địa điểm này, xin hãy giữ thiết lập nhất quán:\n${blocks.join('\n')}`,
  ].join('\n\n');
}

/** Tổ hợp văn bản tiêm trạng thái có cấu trúc hiện tại; khi không có trạng thái có ý nghĩa thì trả về chuỗi rỗng. */
export function buildStateInjectionText(): string {
  // Chế độ chỉ tóm tắt giữ lại trạng thái nội bộ cho API phụ, trang giao diện và truy vấn công khai sử dụng, mô hình chính chỉ nhận tóm tắt cốt truyện.
  if (apiSettings.summaryOnlyMode) return '';

  // Cài đặt tiêm (khu vực "Cài đặt tiêm" ở trang cài đặt): chỉ ảnh hưởng nội dung gửi cho mô hình chính tại đây;
  // Tóm tắt API phụ đi qua phần kết xuất trạng thái riêng của prompts.ts, luôn thấy toàn bộ và ghi chép bình thường, không bị các công tắc này ảnh hưởng.
  // Phụ thuộc: Phân mức có mặt của NPC / phán đoán khả năng tiếp cận vật phẩm đều đi qua cây bối cảnh → khi bối cảnh không tiêm thì NPC/vật phẩm cũng theo đó không tiêm.
  const inj = apiSettings.injection;
  const scenesOn = inj.scenes;
  const npcsOn = inj.npcs && scenesOn;
  const itemsOn = inj.items && scenesOn;

  const st: string[] = [];
  if (memory.state.time) {
    // Thứ trong tuần chỉ có khi là dương lịch chuẩn có kèm năm (weekdayLabel tự mang ngưỡng lọc), thời gian cổ phong / hư cấu không gắn nhãn
    const wd = weekdayLabel(memory.state.time);
    st.push(`Thời gian hiện tại:${memory.state.time}${wd ? ` (${wd})` : ''}`);
  }
  if (memory.state.location) st.push(`Địa điểm hiện tại:${oneLine(memory.state.location)}`);

  // Thẻ cục diện tương tác: nối tiếp cảnh tượng trước mắt. tension / sắp xảy ra chỉ làm ràng buộc bầu không khí ngầm, báo rõ đừng nói toạc ra —— chống việc nhắc đi nhắc lại quá mức.
  const focus = memory.state.sceneFocus;
  if (inj.sceneFocus && focus) {
    const bits: string[] = [`Cục diện:${oneLine(focus.situation)}`];
    const who = focus.participants.map(oneLine).filter(Boolean).join('、');
    if (who) bits.push(`Có mặt:${who}`);
    if (focus.currentFocus) bits.push(`Tiêu điểm hiện tại:${oneLine(focus.currentFocus)}`);
    if (focus.tension) bits.push(`Sức căng tương tác:${oneLine(focus.tension)}(ràng buộc bầu không khí ngầm: thể hiện tự nhiên là được, đừng nói toạc ra hay nhắc đi nhắc lại)`);
    if (focus.pendingBeat) bits.push(`Sắp xảy ra:${oneLine(focus.pendingBeat)}(chuyển tiếp tự nhiên là được, đừng thúc đẩy gượng gạo)`);
    st.push(`[Cục diện tương tác hiện tại]\n${bits.join('\n')}`);
  }

  // Hồ sơ nhỏ đời sống: ghim đầu thường trú + tầng thời hiệu / lắng đọng kích hoạt bằng từ khóa. "Ghi nhớ ≠ lượt nào cũng phải nhắc" —— không trúng thì không xuất hiện.
  // Việc ghi chép luôn bật (không có công tắc); ở đây injection.lifeDetails chỉ quản lý việc "tiêm".
  if (inj.lifeDetails && memory.lifeDetails.length) {
    const picked = selectLifeDetailsForInjection(memory.lifeDetails, recentContextText(), memory.state.time, calculateRelativeDays);
    if (picked.length) {
      const lines = picked.map(d => `- ${oneLine(fmtLifeDetail(d, getContext()?.name1?.trim() || 'Nhân vật chính'))}`);
      st.push(`[Hồ sơ nhỏ đời sống · Theo nhân vật]\n${lines.join('\n')}\n(Mỗi mục chỉ thuộc về người được ghi rõ tên, không được trộn lẫn sang nhân vật chính hay nhân vật khác; chỉ tham khảo khi liên quan tự nhiên tới cuộc đối thoại hiện tại, đừng thuật lại từng mục hay cố ý nhắc tới, không dùng đến thì bỏ qua. Hồ sơ tồn tại không có nghĩa các nhân vật khác đã biết những chi tiết này, vẫn phải tuân thủ góc nhìn cốt truyện)`);
    }
  }

  // Trạng thái nhân vật chính tự khép kín, không phụ thuộc cây bối cảnh, công tắc độc lập.
  if (inj.protagonist) {
    const protagonistBlock = fmtProtagonistContext(memory.protagonist, getContext()?.name1 ?? '', memory.state.time);
    if (protagonistBlock) st.push(`[Trạng thái hiện tại của nhân vật chính]\n${protagonistBlock}`);
  }

  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  // Cây bối cảnh: địa điểm hiện tại + chuỗi tổ tiên (chi tiết) + các địa điểm khác (chỉ tên). Chuỗi tổ tiên đồng thời dùng để phán đoán khả năng tiếp cận vật phẩm / NPC.
  if (scenesOn) {
    const sceneBlock = fmtSceneContext(memory.scenes, here, locPath);
    if (sceneBlock) st.push(`Ký ức địa điểm:\n${sceneBlock}`);
  }

  // Vật phẩm chia làm hai nhóm để tiết kiệm token: tiếp cận được (mang theo người / nơi cất nằm ở địa điểm hiện tại hoặc chuỗi tổ tiên của nó) gửi toàn bộ (tên+lượng+mô tả);
  // cất gửi nơi khác chỉ gửi tên+số lượng (cắt bỏ phần mô tả vốn rất tốn), vừa tiết kiệm token vừa không khiến mô hình chính tưởng là đồ mất rồi.
  if (itemsOn) st.push(...fmtItemContext(memory.items, memory.scenes, here, locPath));
  // Lưu ý: biến động vật phẩm gần đây không tiêm tại đây. Đổi sang sau khi tóm tắt thì ghi vào sau </bbs_end> trong chính văn tầng tương ứng (xem engine.ts),
  // các tầng toàn văn trong cửa sổ tự nhiên nhìn thấy, cuộn ra khỏi cửa sổ tự nhiên biến mất —— phù hợp với sự đánh đổi "biến động vật phẩm chỉ có ích trong khoảng thời gian đó".

  // Danh sách NPC bốn mức: có mặt gửi toàn bộ; cùng khu vực gửi tên+thân phận+tính cách+nơi ở; vắng mặt chỉ gửi tên+thân phận. NPC càng nhiều càng tiết kiệm được nhiều.
  if (npcsOn) {
    const npcBlock = fmtNpcContext(memory.npcs, memory.scenes, here, locPath, memory.state.time);
    if (npcBlock) st.push(`Danh sách NPC:\n${npcBlock}`);
  }

  // Danh sách hiểu biết: nhân vật chính yếu + nhân vật có mặt, không phụ thuộc công tắc bối cảnh; chưa có bản ghi cũng liệt kê ra, để "chưa ghi = không biết" có hiệu lực với họ.
  // Ngoại lệ: công tắc này đồng thời quản lý cả việc ghi chép của API phụ (tắt đi là không ghi nữa), khác với các công tắc ở trên chỉ quản lý việc tiêm.
  let knowledgeBlock = '';
  if (inj.knowledge) {
    const names = [
      ...memory.npcs.filter(n => n.important),
      ...memory.npcs.filter(n => !n.important && classifyNpcPresence(n, memory.scenes, here, locPath) === 'present'),
    ].map(n => n.name);
    knowledgeBlock = fmtKnowledgeInjection(memory.knowledge, names, getContext()?.name1?.trim() || 'Nhân vật chính');
    if (knowledgeBlock) st.push(knowledgeBlock);
  }

  const openPlans = memory.plans
    .filter(p => p.status === 'open')
    .map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime }));
  st.push(`Kế hoạch/nghi vấn chưa khép lại:\n${fmtPlans(openPlans)}`);

  // Kế hoạch/nghi vấn đã hoàn thành gần đây: chống việc AI coi mục vừa khép lại là chưa xong rồi lại đi thúc đẩy tiếp. Cùng tiêu chuẩn với tóm tắt API phụ, chỉ khác điểm cắt
  // (ở đây dùng toàn bộ memory.plans; API phụ dùng deriveMemory(chat, beforeIndex).plans).
  const recentResolved = selectRecentResolvedPlans(memory.plans, apiSettings.recentResolvedPlansCount);
  if (recentResolved.length) st.push(`Đã khép lại gần đây (đã kết án, kèm cách thức/nguyên nhân khép lại; đừng coi là chưa hoàn thành để thúc đẩy tiếp hay ghi lặp lại):\n${fmtResolvedPlans(recentResolved)}`);

  // Biến tùy chỉnh: gửi trạng thái hiện tại + "ý nghĩa" các trường cho mô hình chính (giúp nó hiểu và giữ con số/thiết lập liền mạch), đóng khung rõ ràng là chỉ đọc.
  // ⚠️ Tuyệt đối không tiêm "quy tắc biến đổi" (rule) —— đó là chỉ thị "thêm xóa sửa thế nào" dành cho tóm tắt API phụ (chứa cú pháp lệnh set/assign);
  //    mô hình chính nhìn thấy "khi nào đổi thế nào" sẽ hiểu lầm là phải xuất / thuật lại biến số hoặc câu lệnh trong chính văn. Ý nghĩa chỉ mô tả "là cái gì", đưa cho mô hình chính rất an toàn.
  const varMeaning = (['global', 'char', 'chat'] as const)
    .map(t => memory.varTemplates[t].meaning.trim())
    .filter(Boolean)
    .join('\n\n');
  const hasVarState = Object.keys(memory.vars).length > 0;
  if (hasVarState) {
    let block = `Biến tùy chỉnh (trạng thái hiện tại, chỉ đọc tham khảo —— nghiêm cấm thuật lại, liệt kê hoặc xuất các biến/lệnh này trong chính văn):\n${renderVarsState(memory.vars)}`;
    if (varMeaning) block += `\nÝ nghĩa biến số (chỉ giúp bạn hiểu các giá trị bên trên, đừng xuất ra):\n${varMeaning}`;
    st.push(block);
  }

  // Khối trạng thái chỉ được tiêm khi có bất kỳ nội dung có ý nghĩa nào (vật phẩm/kế hoạch cho dù trống cũng sẽ có chữ giữ chỗ "(Không có)",
  // nhưng chỉ cần tồn tại tóm tắt hoặc thời gian/địa điểm là đã đáng mang theo cả khối)
  const hasProtagonist = inj.protagonist && Object.values(memory.protagonist).some(value => !!oneLine(value));
  const hasState = memory.state.time || memory.state.location || (inj.sceneFocus && memory.state.sceneFocus) || hasProtagonist || (itemsOn && memory.items.length) || (scenesOn && memory.scenes.length) || (npcsOn && memory.npcs.length) || openPlans.length || hasVarState || (inj.lifeDetails && memory.lifeDetails.length) || !!knowledgeBlock;
  if (!hasState) return '';
  // Đầu cuối đóng khung bằng bản tin mật, tránh mô hình chính coi ảnh chụp trạng thái là khuôn mẫu cần thuật lại / xuất ra (nhả thêm một bản trạng thái ở sau chính văn)
  return `${MEMORY_BRIEFING_NOTE}\n[Trạng thái hiện tại]\n${st.join('\n')}\n${MEMORY_BRIEFING_END}`;
}

/**
 * Tổ hợp văn bản tiêm: tóm tắt lịch sử đã kích hoạt + trạng thái có cấu trúc hiện tại (thời gian/địa điểm/vật phẩm/kế hoạch chưa khép lại).
 * Giữ lại cho việc gỡ lỗi / gọi tương thích; việc tiêm thực tế do refreshInjection tách thành hai khe ST.
 */
export function buildInjectionText(): string {
  return [buildHistoryInjectionText(), buildStateInjectionText()].filter(Boolean).join('\n\n').trim();
}

/** Ước tính số token văn bản theo tiêu chuẩn dự phòng khi bản thân tokenizer của ST không khả dụng. */
function estimateTextTokens(blocks: string[]): number {
  const bytes = blocks.filter(Boolean).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
  return Math.ceil(bytes / 3.35);
}

/**
 * Ước tính số token thực tế hiện tại sẽ tiêm vào đối thoại chính, tách thành hai loại: tóm tắt và phần khác.
 * "Phần khác" bao gồm trạng thái có cấu trúc hiện tại và prompt thẻ thời gian.
 * Ở đây chỉ dùng để cho người dùng một độ lớn trực quan, không gọi backend, cũng không tính lượng nhỏ token phụ trội do việc bọc khuôn mẫu cuộc trò chuyện mang lại.
 */
export function estimateInjectionTokenBreakdown(): { summary: number; other: number } {
  if (!engineActiveHere()) return { summary: 0, other: 0 };

  return {
    summary: estimateTextTokens([buildHistoryInjectionText()]),
    other: estimateTextTokens([
      buildStateInjectionText(),
      apiSettings.autoSummaryEnabled ? timeTagPrompt() : '',
    ]),
  };
}

/** Làm mới trí nhớ hiện tại vào khe gợi ý mở rộng của ST. Khi ST chưa sẵn sàng / bản cũ không có API này thì âm thầm bỏ qua. */
export function refreshInjection(): void {
  // Engine không có hiệu lực ở cuộc trò chuyện này (tắt công tắc tổng / nhân vật hiện tại bị loại trừ): xóa sạch các khe đã tiêm.
  // Dùng clearInjection thay vì return trực tiếp —— khi chuyển sang nhân vật bị loại trừ bắt buộc phải xóa sạch phần tiêm còn sót lại từ cuộc trò chuyện trước.
  if (!engineActiveHere()) {
    clearInjection();
    return;
  }
  const ctx = getContext();
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function') return;
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  fn(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  fn(HISTORY_INJECT_KEY, buildHistoryInjectionText(), IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  fn(STATE_INJECT_KEY, buildStateInjectionText(), IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  // Prompt cố định thẻ thời gian: tiêm vào đối thoại chính theo công tắc tự động tóm tắt, khi tắt thì tiêm chuỗi rỗng (đồng nghĩa xóa sạch)
  fn(TIMETAG_INJECT_KEY, apiSettings.autoSummaryEnabled ? timeTagPrompt() : '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}

/** Xóa sạch phần tiêm (tiêm chuỗi rỗng). Khi chuyển sang cuộc trò chuyện không có trí nhớ sẽ do refreshInjection tự động hoàn thành, ở đây cung cấp cho việc gọi tường minh. */
export function clearInjection(): void {
  const ctx = getContext();
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  ctx?.setExtensionPrompt?.(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(HISTORY_INJECT_KEY, '', IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(STATE_INJECT_KEY, '', IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(TIMETAG_INJECT_KEY, '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}
