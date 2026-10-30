/**
 * Di chuyển dữ liệu trí nhớ từ Horae.
 *
 * Sự thật then chốt: Horae và Bách Bảo Thư dùng chung **cùng một loạt đối tượng tin nhắn của cùng một loạt file trò chuyện** —— Horae gắn dữ liệu ở
 * `chat[i].horae_meta`, Bách Bảo Thư gắn ở `chat[i].extra.bbs_leaf`, cả hai cùng tồn tại trên cùng một msg.
 * Do đó việc di chuyển đọc trực tiếp `ctx.chat[i].horae_meta` của "cuộc trò chuyện đang mở hiện tại" để sản sinh dữ liệu Bách Bảo Thư, không xuyên file.
 * Mô hình làm theo carryover.ts: đọc nguồn → tạo lá (gắn vào extra) + rừng (ghi vào metadata) + mã hóa trạng thái cuối cùng thành delta hạt giống.
 *
 * Ánh xạ mô hình:
 *  - Mỗi tầng AI có tự sự → một chiếc lá; text = ghép summary của các events phi tóm tắt ở tầng đó.
 *  - Thời gian Horae là **mốc thời gian** (mỗi tầng một cái), Bách Bảo Thư là **khoảng thời gian**: lá có timeEnd = mốc thời gian tầng này,
 *    timeStart = mốc thời gian đã biết trước đó (cận trái của khoảng); nếu thiếu thì kế thừa giá trị đã biết trước đó (carry-forward).
 *  - Horae autoSummaries (mang range/depth, lồng mergedSummaries) → nút comp trong rừng Bách Bảo Thư:
 *    làm phẳng đệ quy, depth→level, childIds được dựng lại từ "các mục con trực tiếp + các lá trong phạm vi chưa được mục con bao phủ".
 *  - Vật phẩm / kế hoạch là **ảnh chụp từng tầng** của Horae (phi lượng tăng thêm), gấp theo thứ tự tầng ra trạng thái cuối cùng, đóng cả gói làm add-delta gắn vào
 *    chiếc lá cuối cùng (tránh phát lại từng tầng bị cộng dồn trùng lặp).
 *  - Bỏ qua những thứ Bách Bảo Thư không có: affection / npcs / costumes / mood / relationships / RPG / customTables.
 */

import { getContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { isAiFloor, syncHiddenNow } from './engine';
import { makeLeafId } from './apply';
import { flushLeavesNow, memory, recomputeDerived, saveMemory } from './store';
import type { ItemDelta, LeafExtra, MemSummary, StoredDelta } from './types';

/* ============ Hình dạng dữ liệu nguồn Horae (chỉ lấy các trường dùng cho việc di chuyển) ============ */

interface HoraeTimestamp {
  story_date?: string;
  story_time?: string;
  absolute?: string;
}
interface HoraeEvent {
  level?: string;
  summary?: string;
  isSummary?: boolean;
  _summaryId?: string;
}
interface HoraeItemInfo {
  holder?: string;
  location?: string;
  description?: string;
}
interface HoraeAgendaItem {
  type?: string;
  date?: string;
  text?: string;
  done?: boolean;
}
interface HoraeSummaryEntry {
  id?: string;
  range?: [number, number];
  summaryText?: string;
  depth?: number;
  createdAt?: string;
  auto?: boolean;
  mergedSummaries?: HoraeSummaryEntry[];
}
interface HoraeMeta {
  timestamp?: HoraeTimestamp;
  scene?: { location?: string };
  items?: Record<string, HoraeItemInfo>;
  deletedItems?: string[];
  events?: HoraeEvent[];
  event?: HoraeEvent; // Định dạng cũ: một event đơn lẻ
  agenda?: HoraeAgendaItem[];
  deletedAgenda?: string[];
  _deletedAgendaTexts?: string[];
  _skipHorae?: boolean;
  autoSummaries?: HoraeSummaryEntry[];
}

/* ============ Công cụ nhỏ ============ */

/** Lấy horae_meta trên một tin nhắn (có thể không có) */
function horaeMeta(m: STMessage | undefined): HoraeMeta | undefined {
  return (m as unknown as { horae_meta?: HoraeMeta } | undefined)?.horae_meta;
}

/** Ghép chuỗi mốc thời gian: date + time (mỗi cái có thể khuyết). Cả hai đều trống → ''. */
function combineTime(ts: HoraeTimestamp | undefined): string {
  const d = (ts?.story_date ?? '').trim();
  const t = (ts?.story_time ?? '').trim();
  return [d, t].filter(Boolean).join(' ').trim();
}

/** Lấy văn bản tự sự của một tầng: ghép summary của các events phi thẻ tóm tắt (thẻ tóm tắt isSummary bỏ qua). */
function narrativeOf(meta: HoraeMeta | undefined): string {
  if (!meta) return '';
  const events = meta.events ?? (meta.event ? [meta.event] : []);
  return events
    .filter(e => e && !e.isSummary && e.level !== '\u6458\u8981' && e.level !== 'Tóm tắt')
    .map(e => (e.summary ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// Tập lượng từ dùng cho getItemBaseName của Horae (bóc hậu tố "(lượng từ)"); giữ nhất quán với nguồn.
const COUNTING_CLASSIFIERS = '\\u4e2a\\u628a\\u6761\\u5757\\u5f20\\u6839\\u53e3\\u4efd\\u679a\\u53ea\\u9897\\u652f\\u4ef6\\u5957\\u53cc\\u5bf9\\u7897\\u676f\\u76d8\\u76c6\\u4e32\\u675f\\u624e';
const RE_QTY_PAREN = /[(（]\s*(\d+(?:\.\d+)?)\s*[a-zA-Z\u4e00-\u9fff]*\s*[)）]\s*$/; // (3) (3 cái) (500g)
const RE_PURE_CLASSIFIER = new RegExp(`[(（][${COUNTING_CLASSIFIERS}][)）]\\s*$`);
// Nhãn tiêu hao / về 0: hễ xuất hiện là coi như vật phẩm đó đã hết
const RE_CONSUMED = /[(（](\u5df2\u6d88\u8017|\u5df2\u7528\u5b8c|\u5df2\u9500\u6bc1|\u5df2\u92b7\u6bc0|\u6d88\u8017\u6b86\u5c3d|\u6d88\u8017\u6b98\u76e1|\u6d88\u8017|\u7528\u5c3d|\u7528\u76e1|đã tiêu hao|đã dùng hết|đã hủy|cạn kiệt|consumed|used\s*up|destroyed|depleted)[)）]/i;
const RE_ZERO = /[(（]\s*0\s*[a-zA-Z\u4e00-\u9fff]*\s*[)）]\s*$/;

/** Phân tích ra tên cơ sở + số lượng từ tên vật phẩm Horae. Số lượng được mã hóa trong ngoặc đơn của tên (như "Táo(3)"). */
function parseHoraeItemName(raw: string): { name: string; qty?: number; consumed: boolean } {
  let name = String(raw ?? '').trim();
  if (RE_ZERO.test(name) || RE_CONSUMED.test(name)) return { name: name, consumed: true };
  let qty: number | undefined;
  const m = name.match(RE_QTY_PAREN);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) qty = n;
    name = name.replace(RE_QTY_PAREN, '').trim();
  }
  name = name.replace(RE_PURE_CLASSIFIER, '').trim();
  return { name, qty, consumed: false };
}

/* ============ Kế hoạch di chuyển (xem trước, thuần chỉ đọc) ============ */

export interface MigrationPlan {
  /** Có phát hiện bất kỳ dữ liệu Horae nào hay không */
  hasData: boolean;
  /** Số tầng AI có tự sự tạo được lá */
  leafFloors: number;
  /** Số tổng kết (nút nén) có thể di chuyển */
  summaryCount: number;
  /** Số vật phẩm tồn kho cuối cùng */
  itemCount: number;
  /** Số kế hoạch / nghi vấn chưa khép lại */
  planCount: number;
  /** Hiện tại Bách Bảo Thư đã có dữ liệu rừng hay chưa (sẽ bị ghi đè) */
  willOverwrite: boolean;
}

/** Gấp chat thành tồn kho cuối cùng (gộp tiến ảnh chụp từng tầng + xử lý xóa / tiêu hao). */
function foldFinalItems(chat: STMessage[]): ItemDelta[] {
  // Gộp theo tên cơ sở (cùng một vật trong Horae có thể đổi cách viết), giữ lại mô tả / địa điểm xuất hiện lần cuối.
  const byKey = new Map<string, ItemDelta>();
  const keyOf = (name: string) => name.trim().toLowerCase();

  for (let i = 0; i < chat.length; i++) {
    const meta = horaeMeta(chat[i]);
    if (!meta || meta._skipHorae) continue;

    if (meta.items) {
      for (const [rawName, info] of Object.entries(meta.items)) {
        const { name, qty, consumed } = parseHoraeItemName(rawName);
        if (!name) continue;
        const k = keyOf(name);
        if (consumed) {
          byKey.delete(k);
          continue;
        }
        const loc = (info?.location ?? '').trim();
        const desc = (info?.description ?? '').trim();
        const entry: ItemDelta = byKey.get(k) ?? { name };
        entry.name = name; // Lấy cách viết mới nhất làm chuẩn
        if (qty !== undefined) entry.qty = qty;
        if (desc) entry.desc = desc;
        if (loc) {
          entry.location = loc;
          entry.carried = false;
        }
        byKey.set(k, entry);
      }
    }
    // Xóa tường minh
    for (const del of meta.deletedItems ?? []) {
      const { name } = parseHoraeItemName(del);
      byKey.delete(keyOf(name));
    }
  }
  return [...byKey.values()];
}

/** Gấp chat thành "kế hoạch / nghi vấn chưa khép lại" cuối cùng. */
function foldOpenPlans(chat: STMessage[]): StoredDelta['plans'] {
  const deleted = new Set<string>();
  const norm = (s: unknown) => String(s ?? '').trim();
  // Thu thập toàn bộ nhãn xóa trước (deletedAgenda các tầng + chat[0]._deletedAgendaTexts)
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const d of meta?.deletedAgenda ?? []) if (norm(d)) deleted.add(norm(d));
    for (const d of meta?._deletedAgendaTexts ?? []) if (norm(d)) deleted.add(norm(d));
  }
  // Gộp tiến agenda (khử trùng theo text, cái xuất hiện sau ghi đè)
  const byText = new Map<string, HoraeAgendaItem>();
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const a of meta?.agenda ?? []) {
      const text = norm(a?.text);
      if (!text) continue;
      byText.set(text, a);
    }
  }
  const add: NonNullable<StoredDelta['plans']>['add'] = [];
  for (const [text, a] of byText) {
    if (a.done) continue;
    if (deleted.has(text)) continue;
    const kind = a.type === '\u60ac\u5ff5' || a.type === '\u61f8\u5ff5' || a.type === 'Nghi vấn' ? 'suspense' : 'plan';
    add.push({ kind, content: text, createdTime: norm(a.date) || undefined });
  }
  return add.length ? { add } : undefined;
}

/** Làm phẳng đệ quy autoSummaries của Horae (lồng mergedSummaries), trả về [mục, id cha]. */
function flattenHoraeSummaries(
  tops: HoraeSummaryEntry[],
): Array<{ entry: HoraeSummaryEntry; parentId: string | null }> {
  const out: Array<{ entry: HoraeSummaryEntry; parentId: string | null }> = [];
  const walk = (entry: HoraeSummaryEntry, parentId: string | null) => {
    if (!entry?.id) return;
    out.push({ entry, parentId });
    for (const child of entry.mergedSummaries ?? []) walk(child, entry.id);
  };
  for (const t of tops) walk(t, null);
  return out;
}

/** Tính toán kế hoạch di chuyển (chỉ đọc, không gây tác dụng phụ), phục vụ UI xem trước và bật tắt nút bấm. */
export function computeMigrationPlan(): MigrationPlan {
  const ctx = getContext();
  const chat = ctx?.getCurrentChatId?.() ? ctx?.chat ?? [] : [];

  let leafFloors = 0;
  for (let i = 0; i < chat.length; i++) {
    if (!isAiFloor(chat[i])) continue;
    if (narrativeOf(horaeMeta(chat[i]))) leafFloors++;
  }

  const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
  const summaryCount = flattenHoraeSummaries(tops).length;

  const items = foldFinalItems(chat);
  const plans = foldOpenPlans(chat);

  const hasData =
    leafFloors > 0 || summaryCount > 0 || items.length > 0 || !!plans?.add?.length;

  return {
    hasData,
    leafFloors,
    summaryCount,
    itemCount: items.length,
    planCount: plans?.add?.length ?? 0,
    willOverwrite: memory.summaries.length > 0 || hasAnyLeaf(chat),
  };
}

/** Trên chat đã có lá Bách Bảo Thư hay chưa (dùng cho lời nhắc "sẽ ghi đè"). */
function hasAnyLeaf(chat: STMessage[]): boolean {
  return chat.some(m => !!m?.extra?.bbs_leaf);
}

/* ============ Thực thi di chuyển ============ */

/**
 * Di chuyển dữ liệu Horae trong cuộc trò chuyện hiện tại thành dữ liệu Bách Bảo Thư. Trả về có thành công hay không.
 * Ghi trực tiếp vào extra tin nhắn (lá) và chatMetadata (rừng) của chat hiện tại, lưu đĩa xong thì làm mới.
 */
export async function runHoraeMigration(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('Ngữ cảnh SillyTavern không khả dụng', 'error');
    return false;
  }
  if (!ctx.getCurrentChatId?.()) {
    toast('Vui lòng vào một cuộc trò chuyện trước rồi mới di chuyển', 'warning');
    return false;
  }
  const chat = ctx.chat ?? [];
  if (!chat.length) {
    toast('Cuộc trò chuyện hiện tại đang trống, không có dữ liệu để di chuyển', 'warning');
    return false;
  }

  const plan = computeMigrationPlan();
  if (!plan.hasData) {
    toast('Không phát hiện dữ liệu Horae cũ trong cuộc trò chuyện hiện tại', 'warning');
    return false;
  }

  try {
    // ===== 1. Tạo lá cho mỗi tầng AI có tự sự (mốc thời gian → khoảng thời gian) =====
    // aiFloors: chỉ mục tầng AI theo thứ tự tầng; mỗi tầng timeEnd=mốc thời gian tầng này, timeStart=mốc thời gian tầng trước.
    const aiFloors: number[] = [];
    for (let i = 0; i < chat.length; i++) if (isAiFloor(chat[i])) aiFloors.push(i);

    // Tính "mốc thời gian" của mỗi tầng AI trước (carry-forward: tầng này không có thì kế thừa giá trị đã biết trước đó)
    const floorTime = new Map<number, string>();
    let lastKnown = '';
    for (const idx of aiFloors) {
      const t = combineTime(horaeMeta(chat[idx])?.timestamp);
      if (t) lastKnown = t;
      floorTime.set(idx, lastKnown);
    }

    // Tầng idx → id lá mới tạo (phục vụ childIds trong rừng tham chiếu); chỉ tầng có tự sự mới tạo lá.
    const leafIdByFloor = new Map<number, string>();
    let prevTime = '';
    let lastLeafFloor = -1;
    for (let k = 0; k < aiFloors.length; k++) {
      const idx = aiFloors[k];
      const text = narrativeOf(horaeMeta(chat[idx]));
      const end = floorTime.get(idx) || '';
      // Cận trái của khoảng: mốc thời gian đã biết trước đó; tầng đầu dùng tầng này (start=end).
      const start = prevTime || end;
      if (text) {
        const leaf: LeafExtra = {
          id: makeLeafId(),
          text,
          delta: {},
          timeStart: start || undefined,
          timeEnd: end || undefined,
          createdAt: Date.now() + k, // Tăng đơn điệu, đảm bảo phá thế hòa (tie-break) nhất quán với thứ tự tầng
          swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
          v: 1,
        };
        chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
        leafIdByFloor.set(idx, leaf.id);
        lastLeafFloor = idx;
      }
      if (end) prevTime = end;
    }

    // ===== 2. Mã hóa trạng thái cuối cùng (vật phẩm/kế hoạch/thời gian/địa điểm) thành delta hạt giống, gắn vào chiếc lá cuối cùng =====
    // Nếu không có bất kỳ lá tự sự nào nhưng có trạng thái, tạo một lá văn bản rỗng gắn vào tầng AI cuối cùng để mang nó.
    const items = foldFinalItems(chat);
    const plans = foldOpenPlans(chat);
    const finalState = computeFinalState(chat);

    if (lastLeafFloor < 0 && aiFloors.length) {
      const idx = aiFloors[aiFloors.length - 1];
      const leaf: LeafExtra = {
        id: makeLeafId(),
        text: '',
        delta: {},
        timeEnd: floorTime.get(idx) || undefined,
        timeStart: floorTime.get(idx) || undefined,
        createdAt: Date.now() + aiFloors.length,
        swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
        v: 1,
      };
      chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
      leafIdByFloor.set(idx, leaf.id);
      lastLeafFloor = idx;
    }

    if (lastLeafFloor >= 0) {
      const seedLeaf = chat[lastLeafFloor].extra!.bbs_leaf as LeafExtra;
      const delta: StoredDelta = seedLeaf.delta ?? (seedLeaf.delta = {});
      if (items.length) delta.items = { add: items };
      if (plans) delta.plans = plans;
      if (finalState.time) delta.time = finalState.time;
      if (finalState.location) delta.location = finalState.location;
    }

    // ===== 3. Dựng lại rừng (autoSummaries → nút comp) =====
    const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
    const flat = flattenHoraeSummaries(tops);

    // Tập hợp mục con: phục vụ tính toán childIds cho "các lá trong phạm vi bao phủ trực tiếp nhưng chưa được mục con bao phủ".
    const childEntriesByParent = new Map<string, HoraeSummaryEntry[]>();
    for (const { entry, parentId } of flat) {
      if (parentId) {
        const arr = childEntriesByParent.get(parentId) ?? [];
        arr.push(entry);
        childEntriesByParent.set(parentId, arr);
      }
    }

    const newSummaries: MemSummary[] = [];
    let order = 0;
    for (const { entry } of flat) {
      const id = String(entry.id);
      const level = normalizeDepth(entry.depth);
      const childEntries = childEntriesByParent.get(id) ?? [];
      const childRanges = childEntries.map(c => c.range).filter(Boolean) as [number, number][];

      // childIds: ① id các mục con trực tiếp (comp tầng dưới); ② id các lá nằm trong phạm vi này mà chưa được phạm vi mục con nào bao phủ.
      const childIds: string[] = childEntries.map(c => String(c.id));
      const range = entry.range;
      if (range) {
        for (let i = range[0]; i <= range[1]; i++) {
          const leafId = leafIdByFloor.get(i);
          if (!leafId) continue;
          if (childRanges.some(([a, b]) => i >= a && i <= b)) continue; // Đã thuộc về một mục con nào đó
          childIds.push(leafId);
        }
      }
      if (!childIds.length) continue; // Nút vỏ rỗng (toàn bộ lá trong phạm vi đều mất hết) thì bỏ qua

      // Khoảng thời gian: bắt đầu và kết thúc của lá đầu và cuối trong phạm vi
      const { start, end } = rangeTimeSpan(range, floorTime, leafIdByFloor);
      newSummaries.push({
        id,
        text: (entry.summaryText ?? '').trim(),
        level,
        createdAt: Date.now() + order++,
        auto: entry.auto !== false,
        timeStart: start || undefined,
        timeEnd: end || undefined,
        childIds,
      });
    }

    // ===== 4. Ghi trả lại: ghi đè rừng, lá đã ghi vào extra; lưu đĩa + tính lại =====
    memory.summaries.splice(0, memory.summaries.length, ...newSummaries);
    recomputeDerived();
    saveMemory();
    flushLeavesNow();
    if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
    // Kiểm tra ẩn một lần: ẩn các tầng cũ đã được tóm tắt bao phủ và cuộn ra ngoài cửa sổ giữ lại (tái sử dụng logic thu dọn cuối khi tóm tắt),
    // tránh sau khi di chuyển toàn văn và tóm tắt bị lặp lại trong ngữ cảnh; bên trong đã bao gồm làm mới tiêm.
    await syncHiddenNow();

    toast(
      `Di chuyển hoàn tất: ${leafIdByFloor.size} lá / ${newSummaries.length} tổng kết / ${items.length} vật phẩm / ${plans?.add?.length ?? 0} kế hoạch`,
      'success',
    );
    return true;
  } catch (e) {
    toast(`Di chuyển thất bại: ${e instanceof Error ? e.message : String(e)}`, 'error');
    console.error('[Bách Bảo Thư] Di chuyển Horae thất bại:', e);
    return false;
  }
}

/** Chuẩn hóa depth → level của Bách Bảo Thư (≥1). */
function normalizeDepth(depth: unknown): number {
  const n = typeof depth === 'number' ? depth : parseInt(String(depth ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Khoảng thời gian trong phạm vi một comp: lấy thời gian bắt đầu sớm nhất và kết thúc muộn nhất của các tầng có lá trong phạm vi. */
function rangeTimeSpan(
  range: [number, number] | undefined,
  floorTime: Map<number, string>,
  leafIdByFloor: Map<number, string>,
): { start: string; end: string } {
  if (!range) return { start: '', end: '' };
  let start = '';
  let end = '';
  for (let i = range[0]; i <= range[1]; i++) {
    if (!leafIdByFloor.has(i)) continue;
    const t = floorTime.get(i) || '';
    if (t && !start) start = t;
    if (t) end = t;
  }
  return { start, end };
}

/** Gấp ra thời gian / địa điểm cuối cùng (ghi đè tiến từng tầng). */
function computeFinalState(chat: STMessage[]): { time: string; location: string } {
  let time = '';
  let location = '';
  for (const m of chat) {
    const meta = horaeMeta(m);
    if (!meta || meta._skipHorae) continue;
    const t = combineTime(meta.timestamp);
    if (t) time = t;
    const loc = (meta.scene?.location ?? '').trim();
    if (loc) location = loc;
  }
  return { time, location };
}
