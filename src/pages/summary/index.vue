<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { addSummary, appendOpToLatestLeaf, deleteLeafAt, deleteSummary, deleteSummarySubtrees, editLeafAt, editPlan, editSummary, invalidateSummaryAncestors } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { batchBackfill, batchState, cancelBatchBackfill, engineState, floorBackfillState, isAiFloor, resummarizeNow, summarizeFloor, summarizeSelected, syncHiddenNow } from '@/memory/engine';
import { estimateInjectionTokenBreakdown, refreshInjection, selectViewNodes, type ViewNode } from '@/memory/inject';
import { compactTimeLabel, formatRange, splitTimeLabel } from '@/memory/timeTag';
import { relativeTimeLabel, weekdayLabel } from '@/memory/timeRel';
import { derivedMeta, memory, recomputeDerived } from '@/memory/store';
import type { SceneFocus } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue';
import SummaryNode from './SummaryNode.vue';
import { SUMMARY_CTX, type SummaryRow } from './ctx';

// Khi mở trang Tóm tắt thì ép tính lại dẫn xuất một lần: bộ nhớ đệm dẫn xuất như các tầng chưa tóm tắt chỉ làm mới ở sự kiện nhất định,
// các tầng AI mới tích lũy trong lúc vừa trò chuyện có thể chưa kích hoạt làm mới, khi vào trang căn chỉnh một lần trước để tránh danh sách sót tầng.
onMounted(() => recomputeDerived());

// Chuyển trò chuyện: đặt lại trạng thái xem tạm thời (mở rộng / tìm kiếm / chọn), tránh để tàn dư của cuộc trò chuyện trước mang sang cuộc trò chuyện khác.
const resetViewStates = () => {
  expanded.value = new Set();
  searchQuery.value = '';
  searchOpen.value = false;
  closeImportHistory();
  exitSelectMode();
};
let offChatChanged: (() => void) | null = null;
onMounted(() => {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (es && et?.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, resetViewStates);
    offChatChanged = () => es.off?.(et.CHAT_CHANGED, resetViewStates);
  }
});
onUnmounted(() => offChatChanged?.());

// Phán đoán màn hình cảm ứng: dùng để bỏ qua tự động focus hộp thoại (trên di động tự động focus sẽ bật bộ gõ che khuất giao diện).
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* ============ Kế hoạch / Nghi vấn (hai vùng ở đỉnh) ============
 * Vốn dĩ "Sổ nghi vấn" trộn lẫn kế hoạch và nghi vấn vào một cột; nay tách thành hai vùng ngang cấp, mỗi vùng tự thu gọn, tự đếm số lượng,
 * ngữ nghĩa rõ ràng hơn (Kế hoạch = dự định của nhân vật, Nghi vấn = bí ẩn chưa lời giải), đồng thời xếp ngang hàng với "Tóm tắt" bên dưới thành ba vùng. */
const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');
const newTargetTime = ref(''); // Thời gian mục tiêu tùy chọn khi thêm kế hoạch thủ công (thời gian trong truyện)
// Thêm thủ công là thao tác tần suất thấp: dùng hộp thoại đảm nhận, bình thường chỉ lộ một nút "+" nhỏ, không chiếm diện tích trang.
const composerOpen = ref(false);
const contentInput = ref<HTMLTextAreaElement | null>(null);
// Đi vào từ nút "+" của vùng tương ứng: chọn sẵn loại giúp tiết kiệm một bước (trong hộp thoại vẫn có thể chuyển đổi).
function openComposer(kind: 'plan' | 'suspense') {
  if (!hasLeaf.value) return;
  newKind.value = kind;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = true;
  // Chỉ tự động focus khi không phải màn hình cảm ứng: trên di động tự động focus sẽ lập tức bật bộ gõ lên, che khuất hộp thoại, trải nghiệm kém.
  if (!isTouch) void nextTick(() => contentInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
// Kế hoạch / Nghi vấn chỉ hiển thị "Đang tiến hành". Nhấn xóa là gỡ bỏ —— không còn khái niệm "Kết thúc / Đã kết thúc".
const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
// Tách thành hai cột theo loại: không phải suspense thì quy về Kế hoạch (bao gồm trường hợp dữ liệu cũ khuyết kind), suspense quy về Nghi vấn.
const plansOnly = computed(() => openPlans.value.filter(p => p.kind !== 'suspense'));
const suspenses = computed(() => openPlans.value.filter(p => p.kind === 'suspense'));
const hasLeaf = computed(() => derivedMeta.hasLeaf);

/* —— Thu gọn ——
 * Hai vùng khi tích lũy nhiều đều sẽ đẩy phần Tóm tắt bên dưới ra xa, nên mỗi vùng đều có thể thu gọn. Dòng tiêu đề kiêm nhiệm công tắc thu gọn.
 * Trạng thái thu gọn là tùy chọn chế độ xem trên máy (cùng loại trạng thái điều hướng tạm thời như activePage), đi theo localStorage, không vào apiSettings ——
 * đồng bộ đa thiết bị cho nó không có ý nghĩa, và không nên làm bẩn cài đặt thực sự. */
const PLAN_COLLAPSE_KEY = 'bbs.ui.planCollapsed.v1';
const SUSPENSE_COLLAPSE_KEY = 'bbs.ui.suspenseCollapsed.v1';
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* Khi localStorage không khả dụng thì chỉ có hiệu lực trong phiên hiện tại */
  }
}
const plansCollapsed = ref(loadCollapsed(PLAN_COLLAPSE_KEY));
const suspenseCollapsed = ref(loadCollapsed(SUSPENSE_COLLAPSE_KEY));
function toggleFold(kind: 'plan' | 'suspense') {
  if (kind === 'plan') {
    plansCollapsed.value = !plansCollapsed.value;
    persistCollapsed(PLAN_COLLAPSE_KEY, plansCollapsed.value);
  } else {
    suspenseCollapsed.value = !suspenseCollapsed.value;
    persistCollapsed(SUSPENSE_COLLAPSE_KEY, suspenseCollapsed.value);
  }
}
// Không có mục nào tức là không có gì để thu gọn: không hiển thị mũi tên, đồng thời ép mở rộng (tránh sau khi xóa sạch bị kẹt ở trạng thái trống đang thu gọn)
const plansFoldable = computed(() => plansOnly.value.length > 0);
const plansShown = computed(() => !plansCollapsed.value || !plansFoldable.value);
const suspenseFoldable = computed(() => suspenses.value.length > 0);
const suspenseShown = computed(() => !suspenseCollapsed.value || !suspenseFoldable.value);

// Cấu hình kết xuất hai vùng: cấu trúc đồng dạng, chỉ khác loại / văn bản / màu bộ đếm, dùng cấu hình dẫn động một bộ template để tránh hai nơi lệch nhau.
const foldGroups = computed(() => [
  {
    kind: 'plan' as const, title: 'Kế hoạch', items: plansOnly.value,
    foldable: plansFoldable.value, shown: plansShown.value,
    empty: 'Chưa có kế hoạch nào. Khi tóm tắt sẽ tự động ghi lại dự định của nhân vật, cũng có thể thêm thủ công tại đây.',
  },
  {
    kind: 'suspense' as const, title: 'Nghi vấn', items: suspenses.value,
    foldable: suspenseFoldable.value, shown: suspenseShown.value,
    empty: 'Chưa có nghi vấn nào. Những bí ẩn, sự việc chưa lời giải được cài cắm trong truyện sẽ được ghi lại ở đây.',
  },
]);

// id lá → tầng tạo. id kế hoạch có dạng `plan:${id lá}#${số thứ tự}`, từ đó tra ngược ra tầng tại thời điểm tạo kế hoạch/nghi vấn đó
// (cùng nguồn với #tầng của danh sách tóm tắt). Kế hoạch thêm thủ công gắn vào lá mới nhất, hiển thị tầng của lá đó.
const leafFloor = computed(() => {
  const m = new Map<string, number>();
  for (const l of derivedMeta.leaves) m.set(l.id, l.msgIndex);
  return m;
});
function planFloor(planId: string): number | undefined {
  const leafId = planId.replace(/^plan:/, '').replace(/#\d+$/, '');
  return leafFloor.value.get(leafId);
}

function addPlan() {
  const content = newContent.value.trim();
  if (!content) return;
  // Thời gian tạo dùng thời gian trong truyện đã biết hiện tại (không có thì để trống); thời gian mục tiêu chỉ Kế hoạch mới điền được, người dùng có điền mới kèm theo
  const createdTime = memory.state.time?.trim() || undefined;
  const targetTime = newKind.value === 'plan' ? newTargetTime.value.trim() || undefined : undefined;
  if (!appendOpToLatestLeaf({ plans: { add: [{ kind: newKind.value, content, createdTime, targetTime }] } })) return;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = false;
}
function removePlan(id: string) {
  appendOpToLatestLeaf({ plans: { remove: [id] } });
}

/* —— Chỉnh sửa Kế hoạch / Nghi vấn (hộp thoại) —— */
const editingPlan = ref<{ id: string; kind: 'plan' | 'suspense'; content: string; createdTime: string; targetTime: string } | null>(null);
function openPlanEdit(p: { id: string; kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }) {
  editingPlan.value = {
    id: p.id,
    kind: p.kind,
    content: p.content,
    createdTime: p.createdTime ?? '',
    targetTime: p.targetTime ?? '',
  };
}
function cancelPlanEdit() {
  editingPlan.value = null;
}
function savePlanEdit() {
  const e = editingPlan.value;
  if (!e || !e.content.trim()) return;
  editPlan(e.id, {
    content: e.content,
    createdTime: e.createdTime,
    // Thời gian mục tiêu chỉ có ý nghĩa với Kế hoạch; Nghi vấn giữ trống
    targetTime: e.kind === 'plan' ? e.targetTime : '',
  });
  refreshInjection();
  editingPlan.value = null;
}

/* —— Thẻ cục diện trước mắt (hộp thoại chỉnh sửa) ——
 * Đối tượng đơn kiểu ghi đè: chỉnh sửa thủ công = thay thế toàn bộ thẻ; xóa trống = ghi null (cảnh truyện khép lại).
 * Cùng cơ chế với kế hoạch thủ công: nối thêm vào delta của lá mới nhất, sau khi phát lại sẽ có hiệu lực. */
const focus = computed(() => memory.state.sceneFocus);
const editingFocus = ref<{ situation: string; participants: string; tension: string; pendingBeat: string } | null>(null);
function openFocusEdit() {
  const f = focus.value;
  editingFocus.value = {
    situation: f?.situation ?? '',
    participants: (f?.participants ?? []).join(', '),
    tension: f?.tension ?? '',
    pendingBeat: f?.pendingBeat ?? '',
  };
}
function cancelFocusEdit() {
  editingFocus.value = null;
}
function saveFocusEdit() {
  const e = editingFocus.value;
  if (!e || !e.situation.trim()) return;
  const participants = e.participants.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
  const card: SceneFocus = { situation: e.situation.trim(), participants };
  if (e.tension.trim()) card.tension = e.tension.trim();
  if (e.pendingBeat.trim()) card.pendingBeat = e.pendingBeat.trim();
  if (!appendOpToLatestLeaf({ sceneFocus: card })) return;
  refreshInjection();
  editingFocus.value = null;
}
function clearFocus() {
  if (!appendOpToLatestLeaf({ sceneFocus: null })) return;
  refreshInjection();
}

/* ============ Các tầng chưa tóm tắt ============
 * derivedMeta.pendingFloors = tầng AI và chưa có lá hợp lệ, từ cũ đến mới; ở đây hiển thị ngược (tầng mới ở trước). */
const pendingFloors = computed(() => [...derivedMeta.pendingFloors].sort((a, b) => b - a));
const summarizingFloor = computed<number | null>(() => {
  // derivedMeta.rev giúp computed sau khi chuyển trò chuyện đối chiếu lại chatId hiện tại.
  void derivedMeta.rev;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  return floorBackfillState.running && floorBackfillState.chatId === chatId
    ? floorBackfillState.floor
    : null;
});
function summarizeOne(floor: number) {
  if (engineState.running || summarizingFloor.value !== null) return;
  // Trạng thái tác vụ do floorBackfillState của engine duy trì; khi trang bị gỡ / mở lại sẽ không bị mất.
  void summarizeFloor(floor);
}

/* ============ Tóm tắt bù hàng loạt ============
 * Chia toàn bộ các tầng chưa tóm tắt thành từng khối theo dung lượng nội dung, tóm tắt bù tuần tự từng khối: tiết kiệm token (ngữ cảnh cố định được phân bổ theo khối) + giảm số lần gửi yêu cầu.
 * Bật hộp thoại xác nhận trước (hiển thị số tầng chờ tóm tắt), trong khi thực thi hiển thị tiến độ + có thể hủy (có hiệu lực ở ranh giới khối).
 * Trạng thái chạy đọc từ singleton batchState của engine (không phải ref cục bộ của component): đóng cửa sổ Bách Bảo Thư rồi mở lại,
 * thanh tiến độ và nút hủy vẫn khôi phục được —— vì tác vụ vẫn tiếp tục chạy trong engine, đóng cửa sổ không làm hủy tác vụ. */
const batchConfirmOpen = ref(false);

function openBatchConfirm() {
  if (engineState.running || !pendingFloors.value.length) return;
  batchConfirmOpen.value = true;
}
function runBatchBackfill() {
  batchConfirmOpen.value = false;
  if (engineState.running) return;
  // Không await: tác vụ chạy trong engine, trạng thái đi theo singleton batchState; UI chỉ đọc nó, không phụ thuộc việc hàm này dừng lại chờ
  void batchBackfill({
    // Bù từ cũ đến mới; pendingFloors là thứ tự ngược để hiển thị, ở đây truyền thứ tự tăng dần ổn định hơn (bên trong engine cũng sẽ lọc và sắp xếp lại lần nữa)
    floors: [...derivedMeta.pendingFloors].sort((a, b) => a - b),
  });
}

/* ============ Đại tóm tắt ngay ============
 * Kích hoạt thủ công một lần "kiểm tra xem đã đạt ngưỡng chưa → đạt rồi thì đại tóm tắt (có thể dây chuyền nhiều tầng)". Kết quả phản hồi bằng một câu nhắc tạm thời. */
const resummaryRunning = ref(false);
const resummaryHint = ref('');
let resummaryHintTimer: ReturnType<typeof setTimeout> | null = null;

// Nhịp điệu đại tóm tắt: thực tế khoảng mỗi "Số tin nhắn AI giữ lại gần nhất + Số tin nhắn AI mỗi lần đại tóm tắt" tầng sẽ đại tóm tắt một lần ——
// keepRecent tin gần nhất gửi toàn văn không tóm tắt, các tin cũ hơn tóm tắt thành lá, lá tích đủ leafBatchThreshold mục sẽ nén một lần đại tóm tắt.
// Khi ngưỡng tắt (<2) thì không hiển thị câu nhịp điệu.
const resummaryEvery = computed(() => (Math.max(0, apiSettings.keepRecent) + apiSettings.leafBatchThreshold + apiSettings.leafKeepRecent) * 2);
const showCadence = computed(() => apiSettings.leafBatchThreshold >= 2);

// Ước tính thuần giao diện lượng tiêm thực tế hiện tại. derivedMeta.rev bổ sung tín hiệu làm mới cho các dữ liệu không phải phản ứng Vue như chat/is_system.
const injectionTokenEstimate = computed(() => {
  void derivedMeta.rev;
  const estimate = estimateInjectionTokenBreakdown();
  return {
    summary: estimate.summary.toLocaleString(),
    other: estimate.other.toLocaleString(),
  };
});

async function doResummarize() {
  if (resummaryRunning.value || engineState.running) return;
  resummaryRunning.value = true;
  resummaryHint.value = '';
  try {
    const made = await resummarizeNow();
    // Có báo lỗi thì ưu tiên hiển thị lỗi (như chưa chỉ định kênh đại tóm tắt); nếu không thì phản hồi theo số mục đã tạo
    if (engineState.lastError) {
      resummaryHint.value = '';
    } else if (made > 0) {
      resummaryHint.value = `Đã tạo ${made} bản đại tóm tắt`;
    } else {
      // Chưa đạt ngưỡng: bổ sung một câu nhịp điệu động, cho người dùng biết khoảng bao nhiêu tầng thì đại tóm tắt một lần
      const cadence = showCadence.value ? `, khoảng mỗi ${resummaryEvery.value} tầng sẽ đại tóm tắt một lần` : '';
      resummaryHint.value = `Hiện chưa có tóm tắt nào đạt ngưỡng đại tóm tắt${cadence}`;
    }
  } finally {
    resummaryRunning.value = false;
    if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
    if (resummaryHint.value) resummaryHintTimer = setTimeout(() => (resummaryHint.value = ''), 4000);
  }
}

/* ============ Danh sách tóm tắt (bên dưới) ============ */
/**
 * Dòng hiển thị trải phẳng: dùng cho hai chế độ xem Tìm kiếm (trúng toàn rừng trải phẳng) và Chọn (gốc + hộp kiểm).
 * Chế độ xem mặc định (gốc + mở rộng từng tầng) chuyển sang do component đệ quy SummaryNode kết xuất trực tiếp, không đi qua cấu trúc này.
 */
interface DisplayRow extends SummaryRow {
  isChild: boolean; // Nút tầng sâu (đã bị nén) trúng tìm kiếm: chỉ đọc, không đưa ra nút chỉnh sửa / xóa
}

/**
 * Khung nhìn rừng đầy đủ (byId): mọi lá **hợp lệ** (stale=false) + toàn bộ các nút nén.
 * ⚠️ Bắt buộc phải đi qua derivedMeta thay vì quét trực tiếp chat: chat không phải reactive, UI muốn cập nhật phải qua derivedMeta.
 * Mở rộng (lấy childIds của comp) và tìm kiếm (duyệt toàn bộ các nút, bao gồm cả tầng sâu đã bị nén) đều lấy từ đây.
 */
const byId = computed<Map<string, ViewNode>>(() => {
  const m = new Map<string, ViewNode>();
  for (const l of derivedMeta.leaves) {
    if (l.stale) continue;
    m.set(l.id, {
      id: l.id, kind: 'leaf', level: 0, text: l.text,
      timeStart: l.timeStart, timeEnd: l.timeEnd, timeLabel: l.timeLabel,
      createdAt: l.createdAt, childIds: [], msgIndex: l.msgIndex, active: l.active,
    });
  }
  for (const s of memory.summaries) {
    m.set(s.id, {
      id: s.id, kind: 'comp', level: s.level, text: s.text,
      timeStart: s.timeStart, timeEnd: s.timeEnd, timeLabel: s.timeLabel,
      createdAt: s.createdAt, childIds: s.childIds ?? [],
      msgIndex: s.imported ? (s.importedFloorEnd ?? -1) : -1,
      active: s.imported === true,
      atomic: s.imported === true,
      floorStart: s.importedFloorStart,
      floorEnd: s.importedFloorEnd,
    });
  }
  return m;
});

/** Phân giải đệ quy tập hợp các tầng lá mà một nút nào đó bao phủ (comp lấy toàn bộ lá hợp lệ hậu duệ; child mất hiệu lực không lấy được thì bỏ qua). */
function nodeFloors(n: ViewNode, map: Map<string, ViewNode>): [number, number] {
  const acc: number[] = [];
  const seen = new Set<string>();
  const walk = (x: ViewNode): void => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    if (x.atomic) {
      if (typeof x.floorStart === 'number') acc.push(x.floorStart);
      if (typeof x.floorEnd === 'number') acc.push(x.floorEnd);
      return;
    }
    if (x.kind === 'leaf') { acc.push(x.msgIndex); return; }
    for (const cid of x.childIds) {
      const c = map.get(cid);
      if (c) walk(c);
    }
  };
  walk(n);
  return acc.length ? [Math.min(...acc), Math.max(...acc)] : [-1, -1];
}

/** ViewNode → các trường cốt lõi của dòng hiển thị (dùng để kết xuất thẻ) */
function toRow(n: ViewNode, map: Map<string, ViewNode>): SummaryRow {
  const [lo, hi] = nodeFloors(n, map);
  return {
    key: `${n.kind}:${n.id}`,
    id: n.id,
    kind: n.kind,
    level: n.level,
    text: n.text,
    timeStart: n.timeStart,
    timeEnd: n.timeEnd,
    timeLabel: n.timeLabel,
    floorLo: lo,
    floorHi: hi,
    msgIndex: n.kind === 'leaf' ? n.msgIndex : undefined,
    stale: false,
    imported: n.atomic === true,
  };
}

/** Nút gốc (ngược thứ tự: tầng càng về sau càng nằm ở trên), dùng cho chế độ xem mặc định và chế độ xem chọn. */
const rootNodes = computed<ViewNode[]>(() => {
  const map = byId.value;
  const referenced = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const roots = [...map.values()].filter(n => !referenced.has(n.id));
  // Nút nén chứa hậu duệ mất hiệu lực sẽ không hoàn chỉnh → selectViewNodes tự động hạ cấp, chỉ tháo chuỗi bị ảnh hưởng đó (nhánh phụ nguyên vẹn giữ nguyên cả chuỗi)
  const chosen = selectViewNodes({ byId: map, roots }, () => true);
  return chosen.sort((a, b) => nodeFloors(b, map)[1] - nodeFloors(a, map)[1]);
});

/* ---- Trạng thái chế độ xem: Mở rộng / Tìm kiếm / Chọn (ba trạng thái loại trừ lẫn nhau, đều là trạng thái UI tạm thời, không lưu bền vững) ---- */
const expanded = ref<Set<string>>(new Set()); // Các id comp đã mở rộng
const searchQuery = ref('');
// Khung tìm kiếm mặc định thu gọn, nhấn vào kính lúp trên thanh công cụ mới mở rộng —— bình thường không chiếm diện tích. Thu gọn sẽ xóa sạch từ khóa tìm kiếm.
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());

/* ---- Nhập đại tóm tắt cũ: phiên bản đầu chỉ nhận văn bản dán vào + tầng kết thúc bao phủ tính từ #0. ---- */
const importHistoryOpen = ref(false);
const importHistoryText = ref('');
const importHistoryFloor = ref(0);
const importHistoryMaxFloor = ref(0);

function closeImportHistory() {
  importHistoryOpen.value = false;
}

function openImportHistory() {
  if (memory.summaries.some(s => s.imported)) {
    toast('Cuộc trò chuyện hiện tại đã có một lịch sử nhập; vui lòng chỉnh sửa trực tiếp hoặc xóa đi rồi nhập lại', 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) {
    toast('Cuộc trò chuyện hiện tại không có tầng cốt truyện AI nào có thể tiếp quản', 'warning');
    return;
  }
  importHistoryText.value = '';
  importHistoryMaxFloor.value = lastAi;
  importHistoryFloor.value = lastAi;
  importHistoryOpen.value = true;
}

async function saveImportedHistory() {
  const text = importHistoryText.value.trim();
  const floor = Number(importHistoryFloor.value);
  if (!text) {
    toast('Vui lòng dán nội dung đại tóm tắt cũ trước', 'warning');
    return;
  }
  if (!Number.isInteger(floor) || floor < 0 || floor > importHistoryMaxFloor.value) {
    toast(`Tầng kết thúc bao phủ phải nằm trong khoảng #0 - #${importHistoryMaxFloor.value}`, 'warning');
    return;
  }
  const chat = getContext()?.chat ?? [];
  if (!isAiFloor(chat[floor])) {
    toast('Tầng kết thúc bao phủ bắt buộc phải là một tầng cốt truyện AI, tránh ẩn luôn cả tin nhắn người dùng chưa được phản hồi', 'warning');
    return;
  }
  if (memory.summaries.some(s => s.imported)) {
    toast('Cuộc trò chuyện hiện tại đã có lịch sử nhập, không nhập trùng lặp', 'warning');
    return;
  }
  // Không ghi đè im lặng các tóm tắt từng tầng mà Bách Bảo Thư đã thực hiện: khi chồng lấp hai bộ tự sự sẽ đồng thời đi vào ngữ cảnh, cần để người dùng xử lý ranh giới trước.
  const overlap = derivedMeta.leaves.some(l => !l.stale && l.msgIndex <= floor);
  if (overlap) {
    toast('Trong phạm vi đã chọn đã có tóm tắt của Bách Bảo Thư; vui lòng thu hẹp tầng kết thúc, hoặc xóa các tóm tắt chồng lấp trước', 'warning');
    return;
  }

  const existingTimes = [
    ...memory.summaries.map(s => s.createdAt),
    ...derivedMeta.leaves.filter(l => !l.stale).map(l => l.createdAt),
  ].filter(Number.isFinite);
  const createdAt = (existingTimes.length ? Math.min(...existingTimes) : Date.now()) - 1;
  addSummary({
    text,
    level: 2,
    auto: false,
    childIds: [],
    imported: true,
    importedFloorStart: 0,
    importedFloorEnd: floor,
    createdAt,
  });
  closeImportHistory();
  recomputeDerived();
  await syncHiddenNow(true);
  toast(`Đã nhập đại tóm tắt cũ, tiếp quản #0 - #${floor}`, 'success');
}

const searching = computed(() => searchQuery.value.trim().length > 0);

function openSearch() {
  searchOpen.value = true;
  // Không phải màn hình cảm ứng thì tự động focus; màn hình cảm ứng không focus để tránh bật ngay bộ gõ (cùng sự đánh đổi với hộp thoại thêm kế hoạch)
  if (!isTouch) void nextTick(() => searchInput.value?.focus());
}
function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = '';
}
function toggleSearch() {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/** Chế độ xem tìm kiếm: duyệt **toàn bộ rừng** (bao gồm cả các nút tầng sâu đã nén), kết quả trúng trải phẳng, sắp xếp ngược theo tầng. */
function buildSearchRows(): DisplayRow[] {
  const map = byId.value;
  const q = searchQuery.value.trim();
  const qLower = q.toLowerCase();
  // Truy vấn tầng: thuần chữ số / #chữ số → trúng nút bao phủ tầng đó
  const floorNum = /^#?\d+$/.test(q) ? Number(q.replace(/^#/, '')) : null;
  const rootIdSet = new Set(rootNodes.value.map(n => n.id));

  const rows: DisplayRow[] = [];
  for (const n of map.values()) {
    const base = toRow(n, map);
    let hit = false;
    if (n.text && n.text.toLowerCase().includes(qLower)) hit = true;
    if (!hit && floorNum !== null && base.floorLo >= 0 && floorNum >= base.floorLo && floorNum <= base.floorHi) hit = true;
    if (!hit) {
      const t = base.timeStart || base.timeEnd ? formatRange(base.timeStart, base.timeEnd) : (base.timeLabel ? compactTimeLabel(base.timeLabel) : '');
      if (t && t.toLowerCase().includes(qLower)) hit = true;
    }
    if (!hit) continue;
    // Dòng gốc trúng có thể chỉnh sửa/xóa; nút tầng sâu đã bị nén chỉ đọc (đồng nhất ngữ nghĩa mở rộng, tránh xóa nhầm chuỗi tổ tiên)
    const isRoot = rootIdSet.has(n.id);
    rows.push({ ...base, isChild: !isRoot });
  }
  return rows.sort((a, b) => b.floorHi - a.floorHi);
}

/** Các dòng chế độ xem trải phẳng: kết quả tìm kiếm trải phẳng / gốc ở trạng thái chọn; chế độ xem mặc định không đi qua đây (do SummaryNode kết xuất đệ quy). */
const visibleRows = computed<DisplayRow[]>(() => {
  if (searching.value) return buildSearchRows();
  const map = byId.value;
  // Chế độ chọn: chỉ nút gốc, ngược thứ tự, kèm hộp kiểm
  return rootNodes.value.map(n => ({ ...toRow(n, map), isChild: false }));
});

/** Cắt lát văn bản trúng tìm kiếm: cắt text theo từ khóa trúng thành các đoạn [{t, hit}], template dùng span kết xuất (không đi qua v-html, chống XSS). */
function highlightParts(text: string): Array<{ t: string; hit: boolean }> {
  const q = searchQuery.value.trim();
  if (!q || !searching.value) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx < 0) { parts.push({ t: text.slice(i), hit: false }); break; }
    if (idx > i) parts.push({ t: text.slice(i, idx), hit: false });
    parts.push({ t: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts.length ? parts : [{ t: text, hit: false }];
}

/* ---- Chế độ chọn: vào/ra, tích chọn, ràng buộc tính liên tục, gộp ---- */
function enterSelectMode() {
  selectMode.value = true;
  selectedIds.value = new Set();
  expanded.value = new Set(); // Thu gọn toàn bộ các mục đang mở rộng, chỉ thao tác trên gốc
}
function exitSelectMode() {
  selectMode.value = false;
  selectedIds.value = new Set();
}
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

/** Toàn bộ nút gốc đã được tích chọn hết hay chưa (dẫn động văn bản "Chọn tất cả / Bỏ chọn tất cả") */
const allSelected = computed(() => {
  const roots = rootNodes.value;
  return roots.length > 0 && roots.every(n => selectedIds.value.has(n.id));
});
/** Chuyển đổi Chọn tất cả / Bỏ chọn tất cả: khi chọn tất cả thì ghi toàn bộ id gốc; đã chọn tất cả rồi thì xóa sạch. */
function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(rootNodes.value.map(n => n.id));
  }
}

/** Chỉ số vị trí của các mục đã chọn trong chuỗi gốc (ngược thứ tự), sắp xếp tăng dần */
const selectedRootIndexes = computed<number[]>(() => {
  const roots = rootNodes.value;
  const idxs: number[] = [];
  roots.forEach((n, i) => { if (selectedIds.value.has(n.id)) idxs.push(i); });
  return idxs;
});
/** Có thể gộp hay không: đã chọn ≥2 và liên tiếp nhau trong chuỗi gốc (không chọn nhảy cóc) */
const canMerge = computed(() => {
  const idxs = selectedRootIndexes.value;
  if (idxs.length < 2) return false;
  for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return false;
  return true;
});
/** Phạm vi tầng mà các mục đã chọn bao phủ và cấp độ sẽ tạo ra (dùng để hiển thị trên thanh thao tác) */
const selectionSummary = computed(() => {
  const map = byId.value;
  const picked = rootNodes.value.filter(n => selectedIds.value.has(n.id));
  if (!picked.length) return { count: 0, floorLo: -1, floorHi: -1, level: 1 };
  let lo = Infinity, hi = -Infinity, maxLevel = 0;
  for (const n of picked) {
    const [a, b] = nodeFloors(n, map);
    if (a >= 0) lo = Math.min(lo, a);
    if (b >= 0) hi = Math.max(hi, b);
    maxLevel = Math.max(maxLevel, n.level);
  }
  return {
    count: picked.length,
    floorLo: lo === Infinity ? -1 : lo,
    floorHi: hi === -Infinity ? -1 : hi,
    level: maxLevel + 1,
  };
});

const mergeConfirmOpen = ref(false);
const merging = ref(false);
function openMergeConfirm() {
  if (!canMerge.value || merging.value || engineState.running) return;
  mergeConfirmOpen.value = true;
}
async function runMerge() {
  mergeConfirmOpen.value = false;
  if (!canMerge.value || merging.value) return;
  // Truyền cho engine theo thứ tự tăng dần của chuỗi gốc (tức là tầng từ cũ → mới); bên trong engine vẫn sẽ sắp xếp lại một lần nữa
  const idxs = [...selectedRootIndexes.value].sort((a, b) => a - b);
  const ids = idxs.map(i => rootNodes.value[i].id);
  merging.value = true;
  try {
    const res = await summarizeSelected(ids);
    if (res.made > 0) {
      exitSelectMode();
    } else if (res.error) {
      // Khi thất bại vẫn giữ nguyên lựa chọn. Nhánh thoát sớm (chưa có hiệu lực / đang bận / không liên tiếp...) không đi qua try/catch của engine,
      // sẽ không ghi engineState.lastError, nên ở đây chủ động bật toast, tránh việc "không có chuyện gì xảy ra, không báo lỗi".
      toast(res.error, 'warning');
    }
  } finally {
    merging.value = false;
  }
}

/** Thống kê xóa được tính theo toàn bộ cây con đã chọn: khi chọn đại tóm tắt, các tóm tắt tầng dưới được nó thu nạp cũng thuộc phạm vi xóa. */
const selectionDeleteSummary = computed(() => {
  const map = byId.value;
  const visited = new Set<string>();
  let leaves = 0, summaries = 0, imported = 0;
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = map.get(id);
    if (!node) return;
    if (node.kind === 'leaf') {
      leaves++;
      return;
    }
    summaries++;
    if (node.atomic) {
      imported++;
      return;
    }
    for (const childId of node.childIds) walk(childId);
  };
  for (const id of selectedIds.value) walk(id);
  return { leaves, summaries, imported };
});

const deleteConfirmOpen = ref(false);
const deleting = ref(false);
function openDeleteConfirm() {
  if (!selectionSummary.value.count || deleting.value || merging.value || engineState.running) return;
  deleteConfirmOpen.value = true;
}
async function runDeleteSelected() {
  deleteConfirmOpen.value = false;
  if (!selectionSummary.value.count || deleting.value) return;
  // Chụp nhanh id trước: sau khi xóa cây con đầu tiên thì chuỗi gốc sẽ thay đổi ngay lập tức, không thể đọc từng mục từ danh sách phản ứng được nữa.
  const ids = [...selectedIds.value];
  deleting.value = true;
  try {
    const result = deleteSummarySubtrees(ids);
    refreshInjection();
    if (result.imported > 0) await syncHiddenNow(true);
    exitSelectMode();
    const parts = [
      result.leaves ? `${result.leaves} bản tóm tắt` : '',
      result.summaries ? `${result.summaries} bản đại tóm tắt` : '',
    ].filter(Boolean);
    toast(parts.length ? `Đã xóa ${parts.join(', ')}` : 'Nội dung đã chọn không còn tồn tại', parts.length ? 'success' : 'warning');
  } finally {
    deleting.value = false;
  }
}

/** Thời gian hiển thị của dòng: dữ liệu mới dùng timeStart/timeEnd tổng hợp và nén gọn; dữ liệu cũ lùi về timeLabel đã cố định (cũng nén gọn một lần) */
function rowTime(r: SummaryRow): string {
  if (r.timeStart || r.timeEnd) return formatRange(r.timeStart, r.timeEnd);
  return r.timeLabel ? compactTimeLabel(r.timeLabel) : '';
}
/** Tiền tố thời gian tương đối của dòng (như "Hôm qua·Thứ tư"): chỉ hiển thị ở lá (tóm tắt tầng đơn); đại tóm tắt trải qua nhiều tầng nên thời gian tương đối vô nghĩa, trả về chuỗi rỗng */
function rowRelative(r: SummaryRow): string {
  if (r.kind !== 'leaf') return '';
  const event = r.timeEnd || r.timeStart || (r.timeLabel ? splitTimeLabel(r.timeLabel).end : '') || '';
  // Thứ mấy trong tuần được gộp vào tiền tố tương đối (chỉ dương lịch tiêu chuẩn có kèm năm mới có); đồng nhất tiêu chuẩn với đầu tiêm
  return [relativeTimeLabel(event, derivedMeta.latestStoryTime), weekdayLabel(event)].filter(Boolean).join('·');
}

// Thời gian hiện tại: ưu tiên đọc "thời gian mới nhất trong truyện" được tính thời gian thực từ thẻ chính văn (không bị ảnh hưởng bởi việc tầng mới nhất đã tóm tắt hay chưa);
// không lấy được mới lùi về state.time dẫn xuất (dữ liệu cũ / kịch bản không có thẻ). Sửa triệt để vấn đề "khi tầng mới nhất chưa tóm tắt lại hiển thị thời gian cũ".
const currentTime = computed(() => derivedMeta.latestStoryTime || memory.state.time);
/** Thứ mấy trong tuần của thời gian hiện tại (chỉ dương lịch tiêu chuẩn có kèm năm mới có); dùng để hiển thị */
const currentWeekday = computed(() => weekdayLabel(currentTime.value));

function levelLabel(level: number, imported = false): string {
  if (imported) return 'Lịch sử nhập';
  if (level === 0) return 'Tóm tắt';
  return `Đại tóm tắt L${level}`;
}
/** Nhãn phạm vi tầng: tầng đơn #5, liên tầng #0 - #10 */
function floorLabel(r: SummaryRow): string {
  if (r.floorLo < 0) return '—';
  return r.floorLo === r.floorHi ? `#${r.floorLo}` : `#${r.floorLo} - #${r.floorHi}`;
}

async function onDelete(r: SummaryRow) {
  if (r.kind === 'leaf') {
    if (!confirm('Xóa bản tóm tắt này? Các biến đổi về vật phẩm, kế hoạch, thời gian địa điểm do nó mang lại sẽ được tính toán lại theo các tóm tắt còn lại (có thể lùi về trước); đại tóm tắt chứa nó cũng sẽ bị xóa theo. Tầng nguyên văn vẫn giữ nguyên trạng thái ẩn.')) return;
    if (typeof r.msgIndex === 'number') deleteLeafAt(r.msgIndex);
  } else {
    if (r.imported) {
      if (!confirm('Xóa lịch sử nhập này? Các tầng cũ do nó tiếp quản sẽ hiển thị trở lại và quay về trạng thái chờ tóm tắt; nội dung Sách Thế Giới gốc không bị ảnh hưởng.')) return;
      invalidateSummaryAncestors(r.id);
      recomputeDerived();
      await syncHiddenNow(true);
      return;
    }
    if (!confirm('Xóa bản đại tóm tắt này? Các tóm tắt tầng dưới được nó thu nạp sẽ mở rộng trở lại, vật phẩm / kế hoạch... không bị ảnh hưởng.')) return;
    deleteSummary(r.id);
  }
  refreshInjection();
}

/* ============ Hộp thoại chỉnh sửa ============
 * Lá: có thể sửa "Thời gian trong truyện" + Nội dung chính; Đại tóm tắt: chỉ nén văn bản, nên chỉ sửa nội dung chính.
 * nested = nút đó đã được một đại tóm tắt nào đó thu nạp: chỉnh sửa nó không ảnh hưởng văn bản đại tóm tắt tầng trên (đại tóm tắt chỉ nén ảnh chụp nhanh),
 * trong hộp thoại nhắc người dùng "đại tóm tắt tầng trên sẽ không tự đổi theo", tránh việc sửa xong thấy thông tin cũ trong đại tóm tắt vẫn còn lại tưởng là chưa lưu được. */
type Editing =
  | { kind: 'leaf'; msgIndex: number; text: string; timeStart: string; timeEnd: string; nested: boolean }
  | { kind: 'comp'; compId: string; level: number; text: string; imported: boolean; nested: boolean };
const editing = ref<Editing | null>(null);

/** id đó đã được childIds của bất kỳ đại tóm tắt nào thu nạp hay chưa (= dòng tầng sâu trong chế độ xem mở rộng) */
function isNested(id: string): boolean {
  return memory.summaries.some(s => (s.childIds ?? []).includes(id));
}

function openEdit(r: SummaryRow) {
  if (r.kind === 'leaf' && typeof r.msgIndex === 'number') {
    // Khi dữ liệu cũ không có timeStart/timeEnd, tách điểm đầu cuối từ timeLabel đã cố định để điền vào
    const fb = !r.timeStart && !r.timeEnd ? splitTimeLabel(r.timeLabel) : {};
    editing.value = {
      kind: 'leaf',
      msgIndex: r.msgIndex,
      text: r.text,
      timeStart: r.timeStart ?? fb.start ?? '',
      timeEnd: r.timeEnd ?? fb.end ?? '',
      nested: isNested(r.id),
    };
  } else if (r.kind === 'comp') {
    editing.value = { kind: 'comp', compId: r.id, level: r.level, text: r.text, imported: r.imported === true, nested: isNested(r.id) };
  }
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e) return;
  if (e.kind === 'leaf') editLeafAt(e.msgIndex, e.text, e.timeStart, e.timeEnd);
  else editSummary(e.compId, e.text);
  refreshInjection();
  editing.value = null;
}

// Tiêm trạng thái, helper và hành động cần thiết cho thẻ đệ quy (SummaryNode), khỏi phải truyền props qua từng tầng
provide(SUMMARY_CTX, {
  byId, expanded, selectMode, searching, selectedIds,
  toggleExpand, toggleSelect, openEdit, onDelete,
  nodeFloors, toRow, levelLabel, floorLabel, rowTime, rowRelative, highlightParts,
});
</script>

<template>
  <section class="bbs-page">
    <!-- ===== Thẻ cục diện trước mắt: ảnh chụp nhanh cảnh hiện tại (kiểu ghi đè; lược bỏ = giữ nguyên, xóa trống = khép màn) ===== -->
    <div class="bbs-fold-section">
      <div class="bbs-section-head">
        <h2 class="bbs-title bbs-title-sub">Cục diện trước mắt</h2>
        <!-- Khi chưa có thẻ: bút chì nằm ở đầu phân khu; khi có thẻ: chỉnh sửa / xóa trống thu vào vùng thao tác đầu thẻ -->
        <span v-if="!focus" class="bbs-focus-acts">
          <button
            class="bbs-add-mini"
            type="button"
            :disabled="!hasLeaf"
            :title="hasLeaf ? 'Viết thẻ cục diện thủ công' : 'Cần có tóm tắt trước mới có thể viết thủ công'"
            @click="openFocusEdit"
          >
            <Icon name="edit" />
          </button>
        </span>
      </div>
      <!-- Đồng dạng với thẻ nhân vật: vạch màu bên trái + dòng đầu (người có mặt + ghi thời gian + vùng thao tác) + văn bản chính + bảng trường nhãn nhỏ phân loại có màu -->
      <article v-if="focus" class="bbs-focus">
        <div class="bbs-focus-head">
          <span class="bbs-focus-names" :class="{ 'is-empty': !focus.participants.length }">
            {{ focus.participants.length ? focus.participants.join(', ') : 'Cục diện trước mắt' }}
          </span>
          <span v-if="focus.updatedTime" class="bbs-focus-time">Ghi lúc {{ focus.updatedTime }}</span>
          <span class="bbs-focus-acts">
            <button
              class="bbs-plan-act"
              type="button"
              :disabled="!hasLeaf"
              :title="hasLeaf ? 'Sửa thẻ cục diện thủ công' : 'Cần có tóm tắt trước mới có thể sửa thủ công'"
              @click="openFocusEdit"
            >
              <Icon name="edit" />
            </button>
            <button
              class="bbs-plan-act bbs-plan-del"
              type="button"
              :disabled="!hasLeaf"
              title="Xóa trống thẻ cục diện (cảnh truyện khép lại)"
              @click="clearFocus"
            >
              <Icon name="close" />
            </button>
          </span>
        </div>
        <p class="bbs-focus-situation">{{ focus.situation }}</p>
        <dl v-if="focus.currentFocus || focus.tension || focus.pendingBeat" class="bbs-focus-fields">
          <div v-if="focus.currentFocus" class="bbs-focus-field">
            <!-- currentFocus đã ngừng sử dụng: chỉ khi dữ liệu cũ vẫn còn giá trị mới hiển thị, không nhắc ghi nhận nữa -->
            <dt>Tiêu điểm</dt>
            <dd>{{ focus.currentFocus }}</dd>
          </div>
          <div v-if="focus.tension" class="bbs-focus-field f-tension">
            <dt>Căng thẳng</dt>
            <dd>{{ focus.tension }}</dd>
          </div>
          <div v-if="focus.pendingBeat" class="bbs-focus-field f-next">
            <dt>Sắp tới</dt>
            <dd>{{ focus.pendingBeat }}</dd>
          </div>
        </dl>
      </article>
      <p v-else class="bbs-plan-empty">Chưa có thẻ cục diện. Khi cảnh truyện có thay đổi thực chất thì tóm tắt sẽ tự động cập nhật, cũng có thể nhấn vào biểu tượng bút chì phía trên để viết thủ công.</p>
    </div>

    <!-- Hộp thoại chỉnh sửa thẻ cục diện -->
    <ModalMask :open="!!editingFocus" @close="cancelFocusEdit">
      <div v-if="editingFocus" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa thẻ cục diện">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thẻ cục diện trước mắt</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="cancelFocusEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Cục diện (một câu)</span>
          <textarea v-model="editingFocus.situation" class="bbs-input bbs-modal-textarea" rows="2" placeholder="VD: &quot;Đời thường sống chung buổi chiều, tâm trạng cô ấy hơi trùng xuống&quot; / &quot;Đang lẻn vào, vừa bị đội tuần tra phát hiện&quot;"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Người tham gia có mặt (ngăn cách bằng dấu phẩy)</span>
          <input v-model="editingFocus.participants" class="bbs-input" type="text" placeholder="VD: Nhân vật chính, Adele" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Căng thẳng tương tác (tùy chọn, ngưỡng cao)</span>
          <input v-model="editingFocus.tension" class="bbs-input" type="text" placeholder="Chỉ căng thẳng xã hội rõ ràng và kéo dài, VD: Chiến tranh lạnh / Ngượng ngùng" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Sắp diễn ra (tùy chọn, cấm dự đoán)</span>
          <input v-model="editingFocus.pendingBeat" class="bbs-input" type="text" placeholder="Chỉ những việc được báo trước / hẹn ước rõ ràng trong chính văn" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelFocusEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingFocus.situation.trim()" @click="saveFocusEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Kế hoạch / Nghi vấn: hai vùng ở đỉnh, mỗi vùng tự thu gọn và đếm số lượng ===== -->
    <!-- Cấu trúc đồng dạng, dẫn động bằng cấu hình (foldGroups): dòng tiêu đề kiêm công tắc thu gọn, nút "+" bên phải độc lập (khi disabled không phản hồi, không chạm nhầm thu gọn) -->
    <div v-for="g in foldGroups" :key="g.kind" class="bbs-fold-section">
      <div class="bbs-section-head">
        <button
          class="bbs-fold-head"
          type="button"
          :class="{ 'is-static': !g.foldable }"
          :disabled="!g.foldable"
          :aria-expanded="g.shown"
          :title="g.foldable ? (g.shown ? `Thu gọn ${g.title}` : `Mở rộng ${g.title}`) : ''"
          @click="toggleFold(g.kind)"
        >
          <Icon v-if="g.foldable" name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': !g.shown }" />
          <h2 class="bbs-title bbs-title-sub">{{ g.title }}</h2>
          <span v-if="g.foldable" class="bbs-fold-count">{{ g.items.length }}</span>
        </button>
        <button
          class="bbs-add-mini"
          type="button"
          :disabled="!hasLeaf"
          :title="hasLeaf ? `Thêm ${g.title} thủ công` : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
          @click="openComposer(g.kind)"
        >
          <Icon name="plus" />
        </button>
      </div>

      <!-- Thu mở grid 1fr↔0fr: chiều cao tự thích ứng, không cần viết cứng max-height; dưới reduced-motion sẽ cắt tức thì (xem kiểu dáng) -->
      <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !g.shown }">
        <div class="bbs-fold-inner">
          <div v-if="g.items.length" class="bbs-plan-group">
            <div v-for="p in g.items" :key="p.id" class="bbs-plan">
              <div class="bbs-plan-head">
                <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? 'Nghi vấn' : 'Kế hoạch' }}</span>
                <span v-if="planFloor(p.id) !== undefined" class="bbs-plan-floor">#{{ planFloor(p.id) }}</span>
                <span class="bbs-plan-acts">
                  <button class="bbs-plan-act" type="button" title="Chỉnh sửa" @click="openPlanEdit(p)"><Icon name="edit" /></button>
                  <button class="bbs-plan-act bbs-plan-del" type="button" title="Xóa" @click="removePlan(p.id)"><Icon name="close" /></button>
                </span>
              </div>
              <p class="bbs-plan-content">{{ p.content }}</p>
              <!-- Thời gian trong truyện: Lập lúc (thời gian tạo) / Mục tiêu (thời gian mục tiêu), có bất kỳ cái nào mới hiển thị -->
              <div v-if="p.createdTime || p.targetTime" class="bbs-plan-times">
                <span v-if="p.createdTime" class="bbs-plan-time">Lập lúc {{ p.createdTime }}</span>
                <span v-if="p.targetTime" class="bbs-plan-time bbs-plan-time-target">Mục tiêu {{ p.targetTime }}</span>
              </div>
            </div>
          </div>
          <p v-else class="bbs-plan-empty">{{ g.empty }}</p>
        </div>
      </div>
    </div>

    <!-- Ngăn cách phân chương: đường kẻ mảnh hai bên + hình thoi vàng ở giữa (dấu đuôi cá phân chương sách cổ), ngăn cách hai vùng rõ ràng hơn thẻ hr thông thường -->
    <div class="bbs-divider" role="separator" aria-hidden="true">
      <span class="bbs-divider-mark"></span>
    </div>

    <!-- ===== Tóm tắt ===== -->
    <div class="bbs-section-head">
      <div class="bbs-summary-heading">
        <h2 class="bbs-title bbs-title-sub">Tóm tắt</h2>
        <div class="bbs-token-estimate" title="Ước tính theo số byte UTF-8, không gửi yêu cầu tới backend">
          <span>Tiêm tóm tắt ≈ {{ injectionTokenEstimate.summary }} tokens</span>
          <span>Tiêm khác ≈ {{ injectionTokenEstimate.other }} tokens</span>
        </div>
      </div>
      <div class="bbs-summary-tools">
        <!-- Tìm kiếm: nhấn kính lúp để mở rộng khung tìm kiếm (bình thường thu gọn không chiếm diện tích); đã mở rộng thì thu gọn và xóa trống -->
        <button
          v-if="!selectMode"
          class="bbs-add-mini"
          type="button"
          :class="{ 'is-on': searchOpen }"
          :disabled="!rootNodes.length"
          :title="searchOpen ? 'Thu gọn tìm kiếm' : 'Tìm kiếm tóm tắt'"
          @click="toggleSearch"
        >
          <Icon name="search" />
        </button>
        <!-- Chế độ chọn: vào/ra. Ở trạng thái chọn đổi thành "Hoàn tất", đồng thời ẩn Đại tóm tắt ngay (tránh đụng độ với gộp) -->
        <!-- Màn hình hẹp thu thành biểu tượng thuần (ẩn .bbs-btn-label), cùng trọng lượng với kính lúp bên trái, không lấn át chủ thể -->
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="!rootNodes.length || searching"
          title="Tích chọn nhiều bản tóm tắt liên tiếp để gộp thủ công thành một bản đại tóm tắt"
          @click="enterSelectMode"
        >
          <Icon name="checklist" /><span class="bbs-btn-label">Chọn nhiều</span>
        </button>
        <button
          v-else
          class="bbs-btn bbs-btn-sm"
          type="button"
          title="Thoát chọn nhiều"
          @click="exitSelectMode"
        >
          <Icon name="close" /><span class="bbs-btn-label">Hoàn tất</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm"
          type="button"
          :disabled="engineState.running"
          title="Dán và nhập bản đại tóm tắt cũ từ trước khi sử dụng Bách Bảo Thư"
          @click="openImportHistory"
        >
          <Icon name="download" />
          <span class="bbs-btn-label">Nhập đại tóm tắt cũ</span>
        </button>
        <button
          v-if="!selectMode"
          class="bbs-btn bbs-btn-sm bbs-resummary-btn"
          type="button"
          :disabled="resummaryRunning || engineState.running"
          title="Kiểm tra xem tóm tắt đã đạt ngưỡng đại tóm tắt chưa, nếu đạt thì thực hiện đại tóm tắt ngay một lần"
          @click="doResummarize"
        >
          <span v-if="resummaryRunning" class="bbs-pending-spin"></span>
          <Icon v-else name="bolt" />
          <span class="bbs-btn-label">Đại tóm tắt ngay</span>
        </button>
      </div>
    </div>
    <p v-if="resummaryHint" class="bbs-resummary-hint">{{ resummaryHint }}</p>

    <!-- Khung tìm kiếm: nhấn kính lúp trên thanh công cụ mới mở rộng (ở chế độ chọn không hiển thị, hai trạng thái loại trừ nhau). Tìm toàn bộ rừng (bao gồm cả các nút tầng sâu đã nén) -->
    <div v-if="!selectMode && searchOpen && rootNodes.length" class="bbs-search">
      <Icon name="search" class="bbs-search-icon" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="bbs-input bbs-search-input"
        type="text"
        placeholder="Tìm kiếm nội dung tóm tắt / thời gian, hoặc nhập #số tầng"
        @keydown.esc="closeSearch"
      />
      <button class="bbs-search-clear" type="button" :title="searching ? 'Xóa trống' : 'Thu gọn tìm kiếm'" @click="searching ? (searchQuery = '') : closeSearch()">
        <Icon name="close" />
      </button>
    </div>

    <!-- Các tầng chưa tóm tắt: chỉ liệt kê số tầng, nhấn một cái sẽ tóm tắt bù riêng tầng đó; khi có nhiều tầng có thể "Tóm tắt bù hàng loạt" -->
    <div v-if="pendingFloors.length" class="bbs-pending">
      <div class="bbs-pending-head">
        <span class="bbs-pending-label" :data-count="pendingFloors.length">
          <Icon name="summary" />Tầng chưa tóm tắt
        </span>
        <!-- Tóm tắt bù hàng loạt: chia toàn bộ các tầng chưa tóm tắt thành từng đợt bù tuần tự cho xong (tiết kiệm token, giảm số yêu cầu); khi đang chạy hàng loạt hiển thị tiến độ + hủy -->
        <button
          v-if="!batchState.running"
          class="bbs-btn bbs-btn-sm bbs-batch-btn"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null"
          title="Chia toàn bộ các tầng chưa tóm tắt thành từng đợt để tóm tắt bù một lần cho xong (tiết kiệm token và nhanh hơn so với từng tầng)"
          @click="openBatchConfirm"
        >
          <Icon name="plans" />Tóm tắt bù hàng loạt
        </button>
        <span v-else class="bbs-batch-progress">
          <span class="bbs-pending-spin"></span>
          Đang tóm tắt bù {{ batchState.done }}/{{ batchState.total }}
          <button class="bbs-batch-cancel" type="button" :disabled="batchState.cancelRequested" @click="cancelBatchBackfill">
            {{ batchState.cancelRequested ? 'Đang dừng…' : 'Hủy' }}
          </button>
        </span>
      </div>
      <div class="bbs-pending-chips">
        <button
          v-for="f in pendingFloors"
          :key="f"
          class="bbs-pending-chip"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null || batchState.running"
          :title="`Tạo tóm tắt cho tầng #${f}`"
          @click="summarizeOne(f)"
        >
          <span v-if="summarizingFloor === f" class="bbs-pending-spin"></span>
          <template v-else>#{{ f }}</template>
        </button>
      </div>
    </div>

    <!-- Hộp thoại xác nhận tóm tắt bù hàng loạt -->
    <ConfirmDialog
      v-model:open="batchConfirmOpen"
      title="Tóm tắt bù hàng loạt"
      confirmText="Bắt đầu"
      @confirm="runBatchBackfill"
    >
      Tổng cộng {{ pendingFloors.length }} tầng chưa tóm tắt, sẽ được chia đợt theo dung lượng nội dung và tóm tắt bù tuần tự từng đợt (tiết kiệm token và nhanh hơn so với từng tầng).
      Trong quá trình chạy có thể hủy bất cứ lúc nào (sẽ dừng lại sau khi đợt hiện tại hoàn tất). Tiếp tục?
    </ConfirmDialog>

    <!-- Trạng thái hiện tại -->
    <div v-if="currentTime || memory.state.location" class="bbs-state">
      <div v-if="currentTime" class="bbs-state-item">
        <span class="bbs-state-key">Thời gian</span>
        <span class="bbs-state-val">{{ currentTime }}<template v-if="currentWeekday"> ({{ currentWeekday }})</template></span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">Địa điểm</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <p v-if="engineState.lastError" class="bbs-error">{{ engineState.lastError }}</p>

    <!-- Chế độ xem mặc định: gốc ngược thứ tự, mở rộng từng tầng do SummaryNode đệ quy đảm nhận (chuyển tiếp chiều cao grid, không rời luồng, không nhấp nháy) -->
    <div v-if="!searching && !selectMode && rootNodes.length" class="bbs-summary-list">
      <SummaryNode v-for="n in rootNodes" :key="`${n.kind}:${n.id}`" :node="n" :depth="0" />
    </div>

    <!-- Chế độ xem Tìm kiếm / Chọn: danh sách trải phẳng (không mở rộng từng tầng). Kết quả tìm kiếm bao gồm cả các nút tầng sâu đã nén -->
    <div
      v-else-if="visibleRows.length"
      class="bbs-summary-list"
      :class="{ 'is-selecting': selectMode }"
    >
      <article
        v-for="r in visibleRows"
        :key="r.key"
        class="bbs-summary-card"
        :class="{ 'is-deep': r.level > 0, 'is-stale': r.stale, 'is-child': r.isChild, 'is-selected': selectMode && selectedIds.has(r.id) }"
        :role="selectMode ? 'checkbox' : undefined"
        :aria-checked="selectMode ? selectedIds.has(r.id) : undefined"
        :tabindex="selectMode ? 0 : undefined"
        @click="selectMode && toggleSelect(r.id)"
        @keydown.enter.prevent="selectMode && toggleSelect(r.id)"
        @keydown.space.prevent="selectMode && toggleSelect(r.id)"
      >
        <!-- Chế độ chọn: hộp kiểm chỉ làm trạng thái thị giác, nhấn vào cả thẻ là tích chọn (label không bọc input nữa, tránh kích hoạt kép) -->
        <span v-if="selectMode" class="bbs-summary-check" aria-hidden="true">
          <input
            class="bbs-checkbox"
            type="checkbox"
            :checked="selectedIds.has(r.id)"
            tabindex="-1"
            @click.stop
          />
        </span>
        <div class="bbs-summary-main">
          <header class="bbs-summary-meta">
            <!-- Đại tóm tắt: nhãn cấp độ + viên nang phạm vi + thời gian tương đối (giữ ở dòng đầu đề) + thời gian tuyệt đối (xuống dòng trên màn hình hẹp) -->
            <template v-if="r.kind === 'comp'">
              <span class="bbs-summary-badge">{{ levelLabel(r.level, r.imported) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>
              <span v-if="rowTime(r)" class="bbs-summary-time">{{ rowTime(r) }}</span>
            </template>
            <!-- Tóm tắt: thời gian tương đối + số tầng đều làm thành nhãn nhỏ cùng chiều cao (căn giữa hộp, tránh chìm đường cơ sở CJK), thời gian tuyệt đối làm văn bản đầu đề (xuống dòng trên màn hình hẹp) -->
            <template v-else>
              <span v-if="rowRelative(r)" class="bbs-summary-rel">{{ rowRelative(r) }}</span>
              <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
              <span v-if="rowTime(r)" class="bbs-summary-dateline">{{ rowTime(r) }}</span>
            </template>
            <span v-if="r.stale" class="bbs-summary-stale">Chờ cập nhật</span>
            <!-- Nút thao tác: chỉnh sửa mở cho bất kỳ dòng trúng nào (an toàn cấu trúc; lá sửa xong vector tự động embed lại, đại tóm tắt không vào kho vector);
                 xóa chỉ dành cho dòng gốc (xóa tầng sâu sẽ xóa dây chuyền chuỗi đại tóm tắt tổ tiên); chế độ chọn không có thao tác -->
            <span v-if="!selectMode" class="bbs-summary-acts">
              <button
                class="bbs-summary-act"
                type="button"
                :title="r.imported ? 'Chỉnh sửa lịch sử nhập' : r.kind === 'comp' ? 'Chỉnh sửa đại tóm tắt' : 'Chỉnh sửa tóm tắt'"
                @click="openEdit(r)"
              >
                <Icon name="edit" />
              </button>
              <button
                v-if="!r.isChild"
                class="bbs-summary-act bbs-summary-del"
                type="button"
                :title="r.imported ? 'Xóa lịch sử nhập' : r.kind === 'comp' ? 'Xóa đại tóm tắt (tầng dưới sẽ mở rộng ra)' : 'Xóa tóm tắt'"
                @click="onDelete(r)"
              >
                <Icon name="trash" />
              </button>
            </span>
          </header>
          <p class="bbs-summary-text">
            <template v-for="(seg, i) in highlightParts(r.text)" :key="i">
              <mark v-if="seg.hit" class="bbs-hit">{{ seg.t }}</mark>
              <template v-else>{{ seg.t }}</template>
            </template>
          </p>
        </div>
      </article>
    </div>
    <!-- Tìm kiếm không có kết quả: phân biệt với "Chưa có tóm tắt" -->
    <div v-else-if="searching" class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="search" /></span>
      <p>Không có bản tóm tắt nào khớp với "{{ searchQuery.trim() }}". Hãy thử đổi từ khóa khác, hoặc nhập #số tầng.</p>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="summary" /></span>
      <p>Chưa có tóm tắt nào. Sau khi đối thoại tích lũy tới tầng đã thiết lập sẽ tự động tạo, cũng có thể nhấn vào số tầng trong phần "Tầng chưa tóm tắt" để tóm tắt bù riêng.</p>
    </div>

    <!-- Thanh thao tác đáy ở chế độ chọn: hiển thị thống kê đã chọn + Chọn tất cả / Xóa / Gộp. sticky ở đáy trang -->
    <div v-if="selectMode" class="bbs-select-bar">
      <span class="bbs-select-info">
        <template v-if="selectionSummary.count">
          Đã chọn {{ selectionSummary.count }} mục
          <template v-if="selectionSummary.floorLo >= 0">
            · Bao phủ {{ selectionSummary.floorLo === selectionSummary.floorHi ? `#${selectionSummary.floorLo}` : `#${selectionSummary.floorLo} - #${selectionSummary.floorHi}` }}
          </template>
          · Tạo {{ levelLabel(selectionSummary.level) }}
        </template>
        <template v-else>Tích chọn nhiều bản tóm tắt liên tiếp để gộp</template>
      </span>
      <span v-if="selectionSummary.count >= 2 && !canMerge" class="bbs-select-warn">Cần chọn các bản tóm tắt liên tiếp</span>
      <!-- Chọn tất cả / Bỏ chọn tất cả: khi danh sách dài khỏi phải nhấn từng mục; văn bản chuyển đổi theo allSelected -->
      <button
        class="bbs-btn bbs-btn-sm"
        type="button"
        :disabled="!rootNodes.length || deleting"
        :title="allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả các tóm tắt gốc'"
        @click="toggleSelectAll"
      >
        {{ allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả' }}
      </button>
      <button
        class="bbs-btn bbs-btn-sm bbs-btn-danger"
        type="button"
        :disabled="!selectionSummary.count || deleting || merging || engineState.running"
        title="Xóa các mục đã chọn cùng các tóm tắt tầng dưới được chúng thu nạp"
        @click="openDeleteConfirm"
      >
        <span v-if="deleting" class="bbs-pending-spin"></span>
        <Icon v-else name="trash" />
        Xóa mục đã chọn
      </button>
      <button
        class="bbs-btn bbs-btn-sm bbs-btn-primary"
        type="button"
        :disabled="!canMerge || merging || deleting || engineState.running"
        @click="openMergeConfirm"
      >
        <span v-if="merging" class="bbs-pending-spin"></span>
        <Icon v-else name="plans" />
        Gộp đại tóm tắt
      </button>
    </div>

    <!-- Hộp thoại xác nhận gộp -->
    <ConfirmDialog
      v-model:open="mergeConfirmOpen"
      title="Gộp đại tóm tắt"
      confirmText="Gộp"
      @confirm="runMerge"
    >
      Sẽ gộp {{ selectionSummary.count }} bản tóm tắt đã chọn thành một {{ levelLabel(selectionSummary.level) }} (bỏ qua ngưỡng đại tóm tắt tự động).
      Các bản tóm tắt gốc sẽ được thu nạp vào đại tóm tắt mới và thu gọn khỏi danh sách (dữ liệu không bị xóa, có thể xóa bản đại tóm tắt mới để khôi phục). Tiếp tục?
    </ConfirmDialog>

    <!-- Xác nhận xóa hàng loạt: chọn đại tóm tắt đại diện cho cả đoạn lịch sử, sẽ xóa vĩnh viễn cùng với các nút tầng dưới được nó thu nạp. -->
    <ConfirmDialog
      v-model:open="deleteConfirmOpen"
      :title="allSelected ? 'Xóa sạch toàn bộ tóm tắt' : 'Xóa tóm tắt đã chọn'"
      confirmText="Xóa"
      confirmIcon="trash"
      tone="danger"
      @confirm="runDeleteSelected"
    >
      Sẽ xóa vĩnh viễn toàn bộ nội dung đại diện bởi {{ selectionSummary.count }} mục đã chọn
      ({{ selectionDeleteSummary.leaves }} bản tóm tắt từng tầng, {{ selectionDeleteSummary.summaries }} bản đại tóm tắt).
      Các tóm tắt tầng dưới được thu nạp bởi đại tóm tắt đã chọn cũng sẽ bị xóa theo; các trạng thái vật phẩm, kế hoạch, thời gian địa điểm... do tóm tắt từng tầng mang lại sẽ được tính toán lại theo các tóm tắt còn lại, tầng nguyên văn vẫn giữ nguyên trạng thái ẩn.
      <template v-if="selectionDeleteSummary.imported">Các tầng nguyên văn được bao phủ bởi lịch sử nhập sẽ hiển thị trở lại.</template>
      Thao tác này không thể hoàn tác, tiếp tục?
    </ConfirmDialog>

    <!-- ===== Hộp thoại nhập đại tóm tắt cũ ===== -->
    <ModalMask :open="importHistoryOpen" @close="closeImportHistory">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Nhập đại tóm tắt cũ">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Nhập đại tóm tắt cũ</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="closeImportHistory"><Icon name="close" /></button>
        </header>
        <p class="bbs-field-hint bbs-import-note">
          Dán bản tổng kết cốt truyện được viết ở Sách Thế Giới hoặc nơi khác trước khi sử dụng Bách Bảo Thư vào đây. Chỉ nhập nội dung tự sự, không tự động tạo vật phẩm, kế hoạch hay trạng thái nhân vật.
        </p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung đại tóm tắt cũ</span>
          <textarea
            v-model="importHistoryText"
            class="bbs-input bbs-modal-textarea"
            rows="10"
            placeholder="Dán bản tổng kết cốt truyện cũ đã được sắp xếp theo trình tự thời gian…"
          ></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tầng kết thúc bao phủ (bao gồm cả tầng này)</span>
          <input
            v-model.number="importHistoryFloor"
            class="bbs-input"
            type="number"
            min="0"
            :max="importHistoryMaxFloor"
          />
          <span class="bbs-field-hint">Nội dung nhập sẽ đại diện cho #0 - #{{ importHistoryFloor }}; các tầng này sẽ không bị tóm tắt bù trùng lặp nữa. Tầng AI cuối cùng hiện tại là #{{ importHistoryMaxFloor }}.</span>
        </label>
        <p class="bbs-field-hint bbs-import-warning">
          Sau khi nhập vui lòng tắt mục tổng kết cũ trong Sách Thế Giới để tránh việc mô hình chính nhận đồng thời hai bản nội dung trùng lặp. Sách Thế Giới gốc sẽ không bị thao tác này sửa đổi.
        </p>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeImportHistory">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importHistoryText.trim()" @click="saveImportedHistory">Nhập</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại thêm Kế hoạch / Nghi vấn ===== -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Thêm kế hoạch hoặc nghi vấn">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thêm Kế hoạch / Nghi vấn</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Loại</span>
          <div class="bbs-kind-toggle">
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'plan' }" @click="newKind = 'plan'">Kế hoạch</button>
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'suspense' }" @click="newKind = 'suspense'">Nghi vấn</button>
          </div>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung</span>
          <textarea
            ref="contentInput"
            v-model="newContent"
            class="bbs-input bbs-modal-textarea"
            rows="3"
            placeholder="Mô tả kế hoạch hoặc nghi vấn này…"
            @keydown.enter.exact.prevent="addPlan"
          ></textarea>
        </label>
        <!-- Thời gian mục tiêu chỉ "Kế hoạch" mới điền được, tùy chọn; nghi vấn thường không có thời gian mục tiêu nên không hiển thị -->
        <label v-if="newKind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian mục tiêu (tùy chọn)</span>
          <input
            v-model="newTargetTime"
            class="bbs-input"
            type="text"
            placeholder="VD: Sau giờ học / 1988/10/1; ước chừng hoặc để trống đều được"
          />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newContent.trim()" @click="addPlan">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại chỉnh sửa Kế hoạch / Nghi vấn ===== -->
    <ModalMask :open="!!editingPlan" @close="cancelPlanEdit">
      <div v-if="editingPlan" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa kế hoạch hoặc nghi vấn">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa {{ editingPlan.kind === 'suspense' ? 'nghi vấn' : 'kế hoạch' }}</span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="cancelPlanEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung</span>
          <textarea v-model="editingPlan.content" class="bbs-input bbs-modal-textarea" rows="3"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian tạo (tùy chọn)</span>
          <input v-model="editingPlan.createdTime" class="bbs-input" type="text" placeholder="Thời gian trong truyện, VD: 1988/9/29" />
        </label>
        <label v-if="editingPlan.kind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">Thời gian mục tiêu (tùy chọn)</span>
          <input v-model="editingPlan.targetTime" class="bbs-input" type="text" placeholder="VD: Sau giờ học / 1988/10/1; ước chừng hoặc để trống đều được" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelPlanEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingPlan.content.trim()" @click="savePlanEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- ===== Hộp thoại chỉnh sửa ===== -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" :aria-label="editing.kind === 'comp' ? 'Chỉnh sửa đại tóm tắt' : 'Chỉnh sửa tóm tắt'">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">
            {{ editing.kind === 'comp' ? `Chỉnh sửa ${levelLabel(editing.level, editing.imported)}` : `Chỉnh sửa tóm tắt · Tầng #${editing.msgIndex}` }}
          </span>
          <button class="bbs-summary-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <!-- Nút đã được đại tóm tắt thu nạp: nhắc nhở đại tóm tắt tầng trên sẽ không tự đổi theo. Chỉ lá mới nhắc truy xuất vector (đại tóm tắt không vào kho vector) -->
        <p v-if="editing.nested" class="bbs-field-hint bbs-nested-hint">
          {{ editing.kind === 'leaf'
            ? 'Mục này đã được đại tóm tắt tầng trên thu nạp: thay đổi sẽ được dùng cho truy xuất vector, nhưng văn bản của đại tóm tắt tầng trên sẽ không tự động cập nhật; nếu trong đại tóm tắt cũng có lỗi tương tự, vui lòng chỉnh sửa cả ở đó.'
            : 'Mục này đã được đại tóm tắt tầng cao hơn thu nạp: thay đổi sẽ không đồng bộ lên đại tóm tắt tầng trên; nếu ở tầng trên cũng có lỗi tương tự, vui lòng chỉnh sửa cả ở đó.' }}
        </p>
        <!-- Thời gian chỉ lá mới chỉnh sửa được (hai đầu bắt đầu và kết thúc); đại tóm tắt chỉ nén văn bản, không có trường thời gian -->
        <div v-if="editing.kind === 'leaf'" class="bbs-modal-field bbs-time-pair">
          <label class="bbs-time-col">
            <span class="bbs-modal-label">Thời gian bắt đầu</span>
            <input v-model="editing.timeStart" class="bbs-input" type="text" placeholder="VD: 1988/9/29 21:00" />
          </label>
          <label class="bbs-time-col">
            <span class="bbs-modal-label">Thời gian kết thúc</span>
            <input v-model="editing.timeEnd" class="bbs-input" type="text" placeholder="VD: 1988/9/29 21:30" />
          </label>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">{{ editing.kind === 'comp' ? (editing.imported ? 'Nội dung lịch sử nhập' : 'Nội dung đại tóm tắt') : 'Nội dung tóm tắt' }}</span>
          <textarea v-model="editing.text" class="bbs-input bbs-modal-textarea" rows="8"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* Thời gian bắt đầu và kết thúc: hai ô nhập xếp cạnh nhau, mỗi ô chiếm một nửa */
.bbs-time-pair {
  display: flex;
  gap: 10px;
}
.bbs-time-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbs-import-note,
.bbs-import-warning {
  margin-bottom: 14px;
}
.bbs-import-warning {
  color: var(--bbs-warning);
}
/* Lời nhắc khi chỉnh sửa nút đã được đại tóm tắt thu nạp */
.bbs-nested-hint {
  margin-bottom: 14px;
  color: var(--bbs-warning);
}
/* .bbs-section-head / .bbs-add-mini đã được nâng lên thành nguyên tử toàn cục trong base.css (Tóm tắt và Khung cảnh dùng chung) */

/* —— Công tắc thu gọn Sổ nghi vấn ——
 * Toàn bộ dòng tiêu đề có thể nhấn: mũi tên trái + tiêu đề + nhãn đếm màu vàng. Không khung trong suốt, bám sát mép trái của section-head,
 * không lấn át chủ thể —— thu gọn là thao tác phụ trợ, tiêu đề vẫn là chủ thể. */
.bbs-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
/* Khi không có gì để thu gọn (không có mục nào) thì thoái hóa thành tiêu đề thường: không mang cảm giác nút bấm, con trỏ mặc định */
.bbs-fold-head.is-static {
  cursor: default;
}
/* Mũi tên thu gọn: mở rộng hướng xuống, thu gọn xoay -90° hướng sang phải —— giống như "khép chương này lại".
   Nét viền kế thừa currentColor (muted), hover cả dòng mới bật sáng màu nhấn. */
.bbs-fold-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  transition: transform 0.2s ease, color 0.15s;
}
.bbs-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fold-head:hover:not(.is-static) .bbs-fold-caret,
.bbs-fold-head:focus-visible .bbs-fold-caret {
  color: var(--bbs-accent);
}
/* Nhãn đếm: viên nang nhỏ viền nền vàng, hưởng ứng "bộ đếm cuối trang" của sổ cái, luôn hiển thị; khi thu gọn lại càng hữu ích —— chỉ rõ đang ẩn bao nhiêu mục.
   margin-top:2px —— tiêu đề là chữ lớn, đường cơ sở hơi thấp, viên nang nhỏ căn giữa theo hộp dòng sẽ hơi lệch lên trên, ép xuống 2px mới căn chỉnh về mặt thị giác. */
.bbs-fold-count {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
}
/* Hai vùng ngang cấp xếp cạnh nhau: ngăn cách nhờ khoảng cách + tiêu đề riêng của mỗi vùng là đủ; đường phân chương đuôi cá đậm hơn dành cho ranh giới "Vùng sổ sách ↔ Tóm tắt" */
.bbs-fold-section + .bbs-fold-section {
  margin-top: 22px;
}

/* —— Vùng chứa có thể thu mở: grid 1fr↔0fr, chiều cao tự thích ứng theo nội dung, không cần viết cứng max-height —— */
.bbs-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
}
.bbs-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
/* min-height:0 + overflow:hidden mới có thể ép 0fr thực sự về chiều cao bằng không (nếu không chiều cao nội dung tối thiểu của mục con sẽ chống mở ra) */
.bbs-fold-inner {
  min-height: 0;
  overflow: hidden;
}

.bbs-kind-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 3px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius-sm);
}
.bbs-kind {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-kind.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 2px oklch(0 0 0 / 0.08);
}
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}
/* Thẻ xếp dọc: dòng nhãn ở trên (viên nang loại + nút xóa nhỏ bên phải), nội dung chiếm trọn chiều rộng ở dưới */
.bbs-plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
/* Dòng nhãn: viên nang loại dạt sang trái, nút xóa đẩy về ngoài cùng bên phải */
.bbs-plan-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Nhãn loại: viên nang nhỏ, dùng màu sắc phân biệt Kế hoạch / Nghi vấn */
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* Số tầng: tầng tại thời điểm tạo kế hoạch/nghi vấn đó, nhãn định vị nét viền; cùng cảm giác nhìn với #tầng của danh sách tóm tắt */
.bbs-plan-floor {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
/* Nhóm hành động (chỉnh sửa/xóa) đẩy về ngoài cùng bên phải; bình thường trầm lắng, trên máy tính hover/focus vào thẻ đó mới hiện lên */
.bbs-plan-acts {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-plan:hover .bbs-plan-acts,
.bbs-plan:focus-within .bbs-plan-acts {
  opacity: 1;
}
/* Nút hành động đơn lẻ: nhỏ và muted */
.bbs-plan-act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-plan-act:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-plan-del:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
/* Nội dung: chiếm riêng toàn bộ chiều rộng, xuống dòng tự nhiên */
.bbs-plan-content {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* Thời gian kế hoạch: hai nhãn nhỏ Lập lúc / Mục tiêu, viền trầm lắng, Mục tiêu dùng màu nhấn để phân biệt */
.bbs-plan-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-plan-time {
  font-size: 11px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
}
.bbs-plan-time-target {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-empty {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--bbs-ink-muted);
}

/* —— Trạng thái hiện tại —— */
.bbs-state {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 12px;
}
.bbs-state-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0; /* Cho phép mục này thu hẹp trong vùng chứa wrap, hạn mức thu hẹp do hai mục con bên dưới phân bổ */
}
.bbs-state-key {
  font-size: 11px;
  color: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 8px;
  /* Viên nang chiều rộng cố định: tên địa điểm dài sẽ kéo giãn toàn bộ mục quá rộng, mặc định flex-shrink:1 sẽ ép bẹp cả nhãn này
     (lề trong bị nuốt mất, chữ "Địa điểm" bị xếp dọc). Để nó không tham gia thu hẹp, chiều rộng vượt quá hoàn toàn do giá trị bên phải tiêu hóa */
  flex: none;
  white-space: nowrap;
}
.bbs-state-val {
  font-size: 14px;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}

.bbs-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--bbs-danger);
}

/* —— Nút Đại tóm tắt ngay: thao tác thứ cấp bên phải tiêu đề Tóm tắt, nhỏ hơn một cỡ, kèm biểu tượng —— */
.bbs-resummary-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* Tái sử dụng vòng xoay của tầng chưa tóm tắt (.bbs-pending-spin), ở đây tinh chỉnh kích thước cho khớp chữ nút bấm */
.bbs-resummary-btn .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-resummary-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}

/* —— Tầng chưa tóm tắt: bảng việc cần làm, đóng khung bằng thẻ viền màu nhấn, nhắc nhở "những tầng này chưa được tóm tắt" —— */
.bbs-pending {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
}
/* Dòng tiêu đề: nhãn dạt sang trái, nút/tiến độ tóm tắt bù hàng loạt đẩy sang bên phải */
.bbs-pending-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-pending-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-accent);
}
/* Nút tóm tắt bù hàng loạt: đẩy về ngoài cùng bên phải dòng tiêu đề, nhỏ hơn một cỡ kèm biểu tượng */
.bbs-batch-btn {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  font-size: 12px;
}
/* Khối tiến độ khi đang chạy hàng loạt: vòng xoay + chữ tiến độ + nút hủy */
.bbs-batch-progress {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
}
.bbs-batch-progress .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-batch-cancel {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.bbs-batch-cancel:hover:not(:disabled) {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-batch-cancel:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Sau nhãn kèm một chấm đếm nhỏ, nhấn mạnh "có N tầng chờ xử lý" */
.bbs-pending-label::after {
  content: attr(data-count);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-pending-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-pending-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-pending-chip:hover:not(:disabled) {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-pending-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Đang tạo: vòng xoay nhỏ thay thế cho số tầng */
.bbs-pending-spin {
  width: 13px;
  height: 13px;
  border: 2px solid var(--bbs-line-strong);
  border-top-color: var(--bbs-accent);
  border-radius: 50%;
  animation: bbs-pending-rot 0.7s linear infinite;
}
@keyframes bbs-pending-rot {
  to {
    transform: rotate(360deg);
  }
}

/* —— Thẻ cục diện trước mắt: đồng dạng với thẻ nhân vật —— vạch màu bên trái + dòng đầu (người có mặt + ghi thời gian + vùng thao tác) + văn bản chính + bảng trường nhãn phân loại —— */
.bbs-focus-acts {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
}
.bbs-focus {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* Để vạch màu bên trái bám sát mép bo góc */
}
/* Vạch màu vàng bên меp trái: cùng kiểu với vạch màu "Có mặt" của thẻ nhân vật */
.bbs-focus::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
/* Dòng đầu: tên người có mặt + nhãn nhỏ ghi thời gian + vùng thao tác (dạt sang phải, trên máy tính hover mới hiện lên, giống thẻ nhân vật) */
.bbs-focus-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bbs-focus-names {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  min-width: 0;
  word-break: break-word;
}
.bbs-focus-names.is-empty {
  font-weight: 400;
  color: var(--bbs-ink-muted);
}
.bbs-focus-time {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
@media (hover: hover) {
  .bbs-focus .bbs-focus-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-focus:hover .bbs-focus-acts,
  .bbs-focus-acts:focus-within {
    opacity: 1;
  }
}
/* Cục diện: văn bản chính, tương tự đoạn văn bản chính của thẻ nhân vật */
.bbs-focus-situation {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* Bảng trường: dòng căn chỉnh "nhãn phân loại có màu + nội dung" cùng kiểu với thẻ nhân vật */
.bbs-focus-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-focus-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-focus-field dt {
  flex: 0 0 auto;
  width: 68px;
  text-align: center;
  padding: 1px 4px;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.02em;
  /* Mặc định trung tính (dòng tiêu điểm dữ liệu cũ tiếp tục dùng), các phân loại cụ thể bên dưới tự nhuộm màu riêng */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-focus-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* Căng thẳng: nhãn màu ấm —— áp lực quan hệ đang tiếp diễn, nổi bật ngang cấp với "trạng thái tức thời có thể thay đổi" */
.bbs-focus-field.f-tension dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-focus-field.f-tension dd {
  color: var(--bbs-ink);
}
/* Sắp tới: nhãn vàng nhấn mạnh —— nhịp tiếp theo được báo trước rõ ràng trong chính văn, là thông tin dự báo mấu chốt */
.bbs-focus-field.f-next dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-focus-field.f-next dd {
  color: var(--bbs-ink);
}

/* —— Ngăn cách phân chương: ranh giới rõ ràng giữa hai vùng Kế hoạch/Nghi vấn và Tóm tắt —— */
/* Đường kẻ mảnh hai bên ngắt ở giữa, khảm một hình thoi nhỏ màu vàng —— dấu đuôi cá phân chương sách cổ, hưởng ứng chủ đề giấy mực */
.bbs-divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 26px 0;
}
.bbs-divider::before,
.bbs-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bbs-line-strong);
}
.bbs-divider-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: var(--bbs-accent);
  border-radius: 1px;
}

/* —— Dòng công cụ vùng Tóm tắt: "Chọn nhiều / Đại tóm tắt ngay" xếp cạnh nhau bên phải tiêu đề —— */
.bbs-summary-heading {
  min-width: 0;
}
.bbs-token-estimate {
  margin: 3px 0 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  color: var(--bbs-ink-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-summary-tools {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.bbs-summary-tools .bbs-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* Trạng thái kích hoạt của nút chuyển đổi tìm kiếm: bật sáng màu nhấn, hưởng ứng "đang tìm kiếm" */
.bbs-summary-tools .bbs-add-mini.is-on {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}

/* —— Khung tìm kiếm: kính lúp nhúng bên trái, nút xóa trống bên phải; bo góc toàn dòng đồng nhất với ô nhập —— */
.bbs-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: 12px;
}
.bbs-search-icon {
  position: absolute;
  left: 11px;
  color: var(--bbs-ink-muted);
  pointer-events: none;
  font-size: 15px;
}
.bbs-search-input {
  /* Bên trái chừa chỗ cho kính lúp, bên phải chừa chỗ cho nút xóa trống */
  padding-left: 34px;
  padding-right: 34px;
}
.bbs-search-clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-search-clear:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}

/* —— Tô sáng kết quả trúng tìm kiếm: nền nhạt màu nhấn, không đổi màu chữ để đảm bảo dễ đọc —— */
.bbs-hit {
  background: var(--bbs-accent-soft);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

/* —— Danh sách tóm tắt —— */
.bbs-summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}
/* Thị giác thẻ (.bbs-summary-card / meta / nhãn / thanh mở rộng / thanh thu gọn) đã được đưa lên toàn cục trong base.css,
   cung cấp cho SummaryNode.vue và danh sách trải phẳng của trang này dùng chung (scoped không xuyên qua component). Ở đây chỉ giữ lại phần riêng của trang này: chế độ chọn + thanh thao tác đáy. */

/* Chế độ chọn: bên trái thẻ nhường ra cột hộp kiểm, bố cục ngang; cả thẻ nhấn được, con trỏ gợi ý nhấn được */
.bbs-summary-list.is-selecting .bbs-summary-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  /* Hiển thị khi focus bằng bàn phím (khi role=checkbox thì tabindex=0) */
  outline: none;
}
.bbs-summary-list.is-selecting .bbs-summary-card:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 1px;
}
.bbs-summary-list.is-selecting .bbs-summary-card:hover:not(.is-selected) {
  border-color: var(--bbs-line-strong);
}
.bbs-summary-card.is-selected {
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-summary-check {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding-top: 2px;
  /* Không tranh giành thao tác nhấn: cả thẻ đã phụ trách toggle, hộp kiểm chỉ mang trạng thái thị giác */
  pointer-events: none;
}
.bbs-summary-check .bbs-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--bbs-accent);
}
/* Ở chế độ chọn main chiếm hết chiều rộng còn lại */
.bbs-summary-list.is-selecting .bbs-summary-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* Công tắc mở rộng (.bbs-expand-bar), thanh thu gọn (.bbs-collapse-footer), viền trái trạng thái mở rộng (.is-expanded)
   đều nằm trong base.css, dùng chung cho SummaryNode.vue. */

/* —— Thanh thao tác đáy ở chế độ chọn: sticky bám đáy, viền màu nhấn nổi bật —— */
.bbs-select-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
  backdrop-filter: blur(3px);
}
.bbs-select-info {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink-soft);
  font-variant-numeric: tabular-nums;
}
.bbs-select-warn {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-radius: var(--bbs-radius-sm);
  padding: 2px 8px;
}
.bbs-select-bar .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-select-bar .bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-select-bar .bbs-btn-danger:hover:not(:disabled) {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-empty {
  flex: 1;
}

/* —— Hộp thoại chỉnh sửa: kiểu dáng vỏ ngoài đã đưa lên base.css dùng chung, ở đây chỉ bổ sung textarea chuyên dụng của trang này —— */
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}

/* ============ Màn hình cảm ứng: các nút hành động của Sổ nghi vấn hiển thị thường trực nhưng trầm lắng (nút hành động thẻ tóm tắt xử lý trong base.css) ============ */
@media (hover: none) {
  .bbs-plan-acts {
    opacity: 1;
  }
  /* Vùng chạm hơi phóng to lên ~32px (đủ nhấn), biểu tượng giữ nhỏ gọn */
  .bbs-plan-act {
    width: 32px;
    height: 32px;
    font-size: 15px;
  }
}

/* ============ Giảm chuyển động: mũi tên và thu mở Sổ nghi vấn cắt tức thì (hoạt ảnh mở rộng tóm tắt nằm ở SummaryNode/base.css) ============ */
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret,
  .bbs-fold-wrap {
    transition: none;
  }
}

/* ============ Màn hình hẹp: chuyển đổi loại căng đầy, thanh trạng thái ngay ngắn ============ */
@media (max-width: 640px) {
  /* Chuyển đổi loại trong hộp thoại thêm mới: Kế hoạch | Nghi vấn mỗi bên chiếm một nửa, căng đầy cả dòng */
  .bbs-kind-toggle {
    width: 100%;
  }
  .bbs-kind {
    flex: 1;
  }

  /* Thời gian / Địa điểm: trên màn hình hẹp xếp chồng ngay ngắn thành hai dòng, địa điểm dài không còn làm rối dòng */
  .bbs-state {
    flex-direction: column;
    gap: 8px;
  }

  /* Bố trí đầu đề tóm tắt trên màn hình hẹp: thời gian tuyệt đối (văn bản thuần) khá dài, sẽ ép thời gian tương đối + nhãn tầng chật kín dòng đầu, đẩy nút thao tác sang dòng thứ hai.
     Dùng order xếp thời gian tuyệt đối xuống cuối và flex-basis:100% chiếm riêng một dòng, dòng đầu chỉ để lại "nhãn thời gian tương đối + nhãn tầng + nút thao tác". */
  .bbs-summary-dateline,
  .bbs-summary-time {
    order: 99;
    flex-basis: 100%;
  }

  /* Dòng công cụ tóm tắt: dưới màn hình hẹp "Chọn nhiều / Đại tóm tắt ngay" thu thành biểu tượng thuần (ẩn chữ, bỏ viền),
     cùng trọng lượng, cùng kích thước với kính lúp bên trái —— trên di động nút bấm có khung có chữ mang trọng lượng thị giác quá nặng, lấn át chủ thể. */
  .bbs-summary-tools .bbs-btn-label {
    display: none;
  }
  /* Ba nút thống nhất biểu tượng vuông 32×32: kính lúp (.bbs-add-mini) căn chỉnh với hai nút .bbs-btn-sm, triệt tiêu sự lệch cỡ */
  .bbs-summary-tools .bbs-add-mini,
  .bbs-summary-tools .bbs-btn-sm {
    width: 32px;
    height: 32px;
    padding: 0;
    justify-content: center;
    border-color: transparent;
    background: transparent;
    color: var(--bbs-ink-muted);
    font-size: 16px;
  }
  /* Giữ nguyên trạng thái kích hoạt bật sáng của kính lúp (is-on), đồng nhất với máy tính */
  .bbs-summary-tools .bbs-add-mini.is-on {
    color: var(--bbs-accent);
    background: var(--bbs-accent-soft);
  }
  /* Vòng xoay khi đang thực hiện Đại tóm tắt ngay vẫn cần chiếm chỗ căn giữa (lúc này không có chữ) */
  .bbs-summary-tools .bbs-resummary-btn {
    gap: 0;
  }
}
</style>
