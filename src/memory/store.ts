import { apiSettings, currentCharKey } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';
import { deriveMemory, getLeaf, leafValid } from './apply';
import { isAiFloor, pendingAiFloors } from './engine';
import { latestStoryTime } from './timeTag';
import type { BaibaiMemory, LeafExtra, MemSummary, StoredDelta, VarTemplate, VarTier } from './types';
import { createEmptyMemory, MEMORY_KEY, MEMORY_VERSION, normalizeTemplate } from './types';

/**
 * Bản sao phản ứng (reactive) của bộ nhớ.
 * Nguồn chân lý: ① Rừng nút nén = chat_metadata[MEMORY_KEY].summaries; ② Lá = extra.bbs_leaf của từng tin nhắn trong chat.
 * state / items / plans là bộ nhớ đệm dẫn xuất được phát lại từ chat, phục vụ cho Vue kết xuất.
 */
export const memory = reactive<BaibaiMemory>(createEmptyMemory());

/**
 * Siêu thông tin dẫn xuất cho trang giao diện đọc (chat không phải reactive, UI bắt buộc phải đi qua kênh reactive này):
 *  - hasLeaf: có bất kỳ lá hợp lệ nào hay không (không có thì vô hiệu hóa thêm thủ công).
 *  - leaves: danh sách lá phục vụ trang summary hiển thị (kèm nhãn lỗi thời).
 */
export interface LeafView {
  id: string;
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // Dự phòng cho dữ liệu cũ
  createdAt: number;
  msgIndex: number;
  active: boolean; // Tin nhắn chứa nó đã ẩn (is_system)
  stale: boolean; // Chính văn đã đổi, chưa tóm tắt lại
}
export const derivedMeta = reactive<{ hasLeaf: boolean; leaves: LeafView[]; pendingFloors: number[]; latestStoryTime: string; rev: number }>({
  hasLeaf: false,
  leaves: [],
  pendingFloors: [],
  // Thời gian mới nhất trong truyện: đọc thời gian thực từ thẻ chính văn (không phụ thuộc đã tóm tắt hay chưa), phục vụ hiển thị trang tóm tắt và tham chiếu thời gian tương đối
  latestStoryTime: '',
  // Số phiên bản tăng dần: mỗi lần recomputeDerived đều +1. chat không phải reactive, các khung nhìn bên ngoài như bảng trong tầng chỉ cần đọc nó là có thể
  // theo dõi "dữ liệu dẫn xuất đã tính lại" —— bất kể việc tính lại do sự kiện ST, tóm tắt trên giao diện chính hay chỉnh sửa trong tầng kích hoạt, đều làm mới thống nhất.
  rev: 0,
});

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function optText(v: unknown): string | undefined {
  return scalarText(v) || undefined;
}

/** Phát lại chat thu được state/items/plans, ghi đè tại chỗ; đồng thời làm mới derivedMeta */
export function recomputeDerived(): void {
  const ctx = getContext();
  // Trang chào mừng (chưa vào bất kỳ cuộc trò chuyện nào) getCurrentChatId trống, nhưng trong chat có thể còn sót lại #0 của lần trước,
  // tầng không thuộc về bất kỳ cuộc trò chuyện nào không nên bị phán đoán là "chưa tóm tắt", nên lúc này coi như không có chat.
  const chat = ctx?.getCurrentChatId?.() ? ctx.chat ?? null : null;
  const d = deriveMemory(chat);
  memory.state.time = d.state.time;
  memory.state.location = d.state.location;
  memory.state.locationPath = d.state.locationPath;
  memory.state.sceneFocus = d.state.sceneFocus;
  // Tuổi tác (cặp mốc neo age+ageTime) cũng nằm trên protagonist, chép sót sẽ khiến UI/tiêm không bao giờ đọc được tuổi nhân vật chính
  for (const key of ['gender', 'age', 'ageTime', 'identity', 'appearance', 'outfit', 'condition'] as const) {
    memory.protagonist[key] = d.protagonist[key];
  }
  memory.items.splice(0, memory.items.length, ...d.items);
  memory.plans.splice(0, memory.plans.length, ...d.plans);
  memory.scenes.splice(0, memory.scenes.length, ...d.scenes);
  memory.npcs.splice(0, memory.npcs.length, ...d.npcs);
  memory.itemLog.splice(0, memory.itemLog.length, ...d.itemLog);
  memory.lifeDetails.splice(0, memory.lifeDetails.length, ...d.lifeDetails);
  memory.knowledge.splice(0, memory.knowledge.length, ...d.knowledge);
  // vars là đối tượng JSON: xóa trống rồi điền lại theo kết quả dẫn xuất (không đổi tham chiếu reactive, giữ ràng buộc phản ứng của trang)
  for (const k of Object.keys(memory.vars)) delete memory.vars[k];
  Object.assign(memory.vars, d.vars);

  // derivedMeta: quét chat thu thập lá (gồm cả lá lỗi thời)
  const leaves: LeafView[] = [];
  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      const m = chat[i];
      if (m?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không đưa vào danh sách lá trang tóm tắt
      const leaf = getLeaf(m);
      if (!leaf) continue;
      const valid = leafValid(m);
      leaves.push({
        id: leaf.id,
        text: scalarText(leaf.text),
        timeStart: optText(leaf.timeStart),
        timeEnd: optText(leaf.timeEnd),
        timeLabel: optText(leaf.timeLabel),
        createdAt: typeof leaf.createdAt === 'number' ? leaf.createdAt : Date.now(),
        msgIndex: i,
        active: m.is_system === true,
        stale: !valid,
      });
    }
  }
  derivedMeta.leaves = leaves;
  derivedMeta.hasLeaf = leaves.some(l => !l.stale);
  derivedMeta.latestStoryTime = latestStoryTime(chat);
  // Tầng chờ tóm tắt (tầng AI và không có lá hợp lệ), phục vụ danh sách "Tầng chưa tóm tắt" ở trang tóm tắt để tóm tắt bù từng tầng
  derivedMeta.pendingFloors = chat ? pendingAiFloors(chat) : [];
  derivedMeta.rev++; // Thông báo cho khung nhìn bên ngoài (bảng trong tầng) rằng dữ liệu dẫn xuất đã làm mới
}

/* ============ Lưu đĩa: Lá ở file chat, Rừng ở metadata ============ */

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Chống rung (debounce) lưu lá xuống đĩa (ghi vào file chat). Gộp nhiều tầng tóm tắt liên tiếp thành một lần saveChat. */
export function scheduleLeafFlush(): void {
  const ctx = getContext();
  if (!ctx?.saveChat) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void ctx.saveChat();
  }, 1500);
}

/** Lưu đĩa ngay lập tức (gọi trước khi chuyển cuộc trò chuyện / gỡ cài đặt, tránh mất lá chưa lưu xuống đĩa) */
export function flushLeavesNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const ctx = getContext();
  void ctx?.saveChat?.();
}

/**
 * Ghi rừng (nút nén) + khuôn mẫu biến **chỉ tầng chat** trở lại chat_metadata và lưu bền vững.
 * Khuôn mẫu tầng toàn cục / nhân vật không nằm ở đây (chúng lưu ở extension_settings, do replaceVarsTemplate lưu đĩa). Lá cũng không nằm ở đây.
 */
export function saveMemory() {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  const snapshot: { version: number; summaries: MemSummary[]; varsTemplate: VarTemplate } = {
    version: MEMORY_VERSION,
    summaries: JSON.parse(JSON.stringify(memory.summaries)),
    varsTemplate: JSON.parse(JSON.stringify(memory.varTemplates.chat)),
  };
  (ctx.chatMetadata as Record<string, unknown>)[MEMORY_KEY] = snapshot;
  ctx.saveMetadataDebounced?.();
}

/* ============ Di chuyển v2 → v3 ============ */

/**
 * v2 (lá nằm trong rừng, mang coveredIndices+delta) → v3 (lá chuyển sang extra của tin nhắn).
 * Cần ngữ cảnh chat; khi không có chat trả về null (hoãn lại, lần CHAT_CHANGED sau chạy lại).
 * Các lá không chuyển được (vượt quá chỉ mục / tin nhắn đã xóa) sẽ gộp delta của chúng vào một lá dự phòng gắn vào tầng AI cuối cùng, bảo toàn cấu trúc hóa 1:1.
 */
function migrateV2toV3(raw: Record<string, unknown>, chat: STMessage[] | null): BaibaiMemory | null {
  if (!chat || chat.length === 0) return null; // Hoãn lại

  const out = createEmptyMemory();
  out.version = MEMORY_VERSION;
  const oldSums = (Array.isArray(raw.summaries) ? raw.summaries : []) as Array<Record<string, unknown>>;

  const orphanDeltas: StoredDelta[] = [];

  // 1) Lá cũ (level0) → chuyển sang extra của tầng AI tương ứng (giữ nguyên id gốc)
  for (const s of oldSums) {
    if ((typeof s.level === 'number' ? s.level : 0) !== 0) continue;
    const cov = (Array.isArray(s.coveredIndices) ? s.coveredIndices : []) as number[];
    const delta = (s.delta ?? {}) as StoredDelta;

    // Định vị tầng AI để gắn vào: isAiFloor cuối cùng trong coveredIndices; nếu không có thì lấy tầng tồn tại cuối cùng
    let target = -1;
    for (let k = cov.length - 1; k >= 0; k--) {
      if (isAiFloor(chat[cov[k]])) {
        target = cov[k];
        break;
      }
    }
    if (target < 0) {
      for (let k = cov.length - 1; k >= 0; k--) {
        if (chat[cov[k]]) {
          target = cov[k];
          break;
        }
      }
    }
    if (target < 0 || !chat[target] || chat[target].extra?.bbs_leaf) {
      orphanDeltas.push(delta); // Không chuyển được / mục tiêu đã bị chiếm → đưa vào dự phòng
      continue;
    }
    const leaf: LeafExtra = {
      id: String(s.id),
      text: String(s.text ?? ''),
      delta,
      timeLabel: s.timeLabel as string | undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      v: 1,
    };
    chat[target].extra = { ...(chat[target].extra ?? {}), bbs_leaf: leaf };
  }

  // 1b) Lá dự phòng: gộp các delta không chuyển được gắn vào tầng AI cuối cùng
  if (orphanDeltas.length) {
    let last = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
      if (isAiFloor(chat[i])) {
        last = i;
        break;
      }
    }
    if (last >= 0 && !chat[last].extra?.bbs_leaf) {
      const merged: StoredDelta = {};
      for (const d of orphanDeltas) mergeStoredDelta(merged, d);
      chat[last].extra = {
        ...(chat[last].extra ?? {}),
        bbs_leaf: {
          id: `leaf_migrate_${Date.now().toString(36)}`,
          text: '(Di chuyển: Trạng thái có cấu trúc lịch sử)',
          delta: merged,
          createdAt: Date.now(),
          v: 1,
        },
      };
    }
  }

  // 2) Nút nén (level≥1) giữ nguyên đưa vào rừng
  for (const s of oldSums) {
    if ((typeof s.level === 'number' ? s.level : 0) < 1) continue;
    out.summaries.push({
      id: String(s.id),
      text: String(s.text ?? ''),
      level: s.level as number,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      auto: s.auto !== false,
      timeLabel: s.timeLabel as string | undefined,
      childIds: Array.isArray(s.childIds) ? (s.childIds as string[]) : [],
    });
  }
  return out;
}

/** Hỗ trợ di chuyển: gộp delta b vào a (dùng cho lá dự phòng, nối đơn giản mảng add/op, resolve dùng id ổn định) */
function mergeStoredDelta(a: StoredDelta, b: StoredDelta): void {
  if (b.time) a.time = b.time;
  if (b.location) a.location = b.location;
  if (b.protagonist) a.protagonist = { ...(a.protagonist ?? {}), ...b.protagonist };
  if (b.items) {
    const ai = (a.items ??= {});
    if (b.items.add?.length) (ai.add ??= []).push(...b.items.add);
    if (b.items.update?.length) (ai.update ??= []).push(...b.items.update);
    if (b.items.remove?.length) (ai.remove ??= []).push(...b.items.remove);
  }
  if (b.scenes) {
    const as = (a.scenes ??= {});
    if (b.scenes.add?.length) (as.add ??= []).push(...b.scenes.add);
    if (b.scenes.update?.length) (as.update ??= []).push(...b.scenes.update);
    if (b.scenes.reparent?.length) (as.reparent ??= []).push(...b.scenes.reparent);
    if (b.scenes.remove?.length) (as.remove ??= []).push(...b.scenes.remove);
    if (b.scenes.ops?.length) (as.ops ??= []).push(...b.scenes.ops);
  }
  if (b.plans) {
    const ap = (a.plans ??= {});
    if (b.plans.add?.length) (ap.add ??= []).push(...b.plans.add);
    if (b.plans.resolve?.length) (ap.resolve ??= []).push(...b.plans.resolve);
    if (b.plans.remove?.length) (ap.remove ??= []).push(...b.plans.remove);
    if (b.plans.reopen?.length) (ap.reopen ??= []).push(...b.plans.reopen);
  }
}

/* ============ Tải / Lưu ============ */

function cleanSummaryNode(s: MemSummary, idx: number): MemSummary {
  return {
    id: scalarText(s.id) || `sum_bad_${idx}_${Date.now().toString(36)}`,
    text: scalarText(s.text),
    level: typeof s.level === 'number' ? s.level : 1,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    auto: s.auto !== false,
    timeStart: optText(s.timeStart),
    timeEnd: optText(s.timeEnd),
    timeLabel: optText(s.timeLabel),
    childIds: Array.isArray(s.childIds) ? s.childIds.map(x => scalarText(x)).filter(Boolean) : [],
    imported: s.imported === true ? true : undefined,
    importedFloorStart:
      s.imported === true && Number.isFinite(s.importedFloorStart) && (s.importedFloorStart as number) >= 0
        ? Math.floor(s.importedFloorStart as number)
        : undefined,
    importedFloorEnd:
      s.imported === true && Number.isFinite(s.importedFloorEnd) && (s.importedFloorEnd as number) >= 0
        ? Math.floor(s.importedFloorEnd as number)
        : undefined,
  };
}

function assignForest(target: BaibaiMemory, summaries: MemSummary[], varTemplates: Record<VarTier, VarTemplate>) {
  target.version = MEMORY_VERSION;
  target.summaries = summaries.map(cleanSummaryNode);
  target.varTemplates = varTemplates;
}

/** Đọc khuôn mẫu biến ba tầng (chat đến từ giá trị thô chatMetadata truyền vào; global/char đến từ settings). */
function loadVarTemplates(rawChatTemplate: unknown): Record<VarTier, VarTemplate> {
  const key = currentCharKey();
  return {
    global: normalizeTemplate(apiSettings.varsGlobalTemplate),
    char: key ? normalizeTemplate(apiSettings.varsTemplateByChar[key]) : { json: {}, meaning: '', rule: '' },
    chat: normalizeTemplate(rawChatTemplate),
  };
}

/** Tải rừng + khuôn mẫu biến ba tầng + tính lại dữ liệu dẫn xuất từ cuộc trò chuyện hiện tại (di chuyển nếu cần) */
export function loadMemory() {
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[MEMORY_KEY] as Record<string, unknown> | undefined;
  const chat = ctx?.chat ?? null;
  // Khuôn mẫu biến trực giao với việc di chuyển summary: tầng chat đọc thẳng từ metadata, rồi lấy thêm tầng toàn cục / nhân vật (thiếu = khuôn mẫu rỗng)
  const varTemplates = loadVarTemplates(raw?.varsTemplate);

  if (raw && typeof raw === 'object') {
    const version = typeof raw.version === 'number' ? raw.version : 1;
    if (version >= MEMORY_VERSION) {
      assignForest(memory, (Array.isArray(raw.summaries) ? raw.summaries : []) as MemSummary[], varTemplates);
    } else {
      const migrated = migrateV2toV3(raw, chat);
      if (migrated) {
        assignForest(memory, migrated.summaries, varTemplates);
        // Lưu lá xuống đĩa (saveChat) thành công trước, rồi mới nâng version ghi metadata, đảm bảo có thể vào lại (re-entrant)
        flushLeavesNow();
        saveMemory();
      } else {
        // Hoãn di chuyển: tạm dùng nút nén (level≥1) trong rừng cũ, lá đợi lần sau chat sẵn sàng rồi chuyển
        const comps = (Array.isArray(raw.summaries) ? raw.summaries : []).filter(
          (s: Record<string, unknown>) => (typeof s.level === 'number' ? s.level : 0) >= 1,
        ) as MemSummary[];
        assignForest(memory, comps, varTemplates);
      }
    }
  } else {
    assignForest(memory, [], varTemplates);
  }
  recomputeDerived();
}

/**
 * Thay thế khuôn mẫu biến của một tầng (phục vụ trình chỉnh sửa trang biến lưu lại): ghi về lưu trữ tương ứng → cập nhật bộ nhớ → tính lại dữ liệu dẫn xuất.
 *  - global → apiSettings.varsGlobalTemplate (đồng bộ xuyên thiết bị);
 *  - char → apiSettings.varsTemplateByChar[avatar] (không có nhân vật hiện tại thì bỏ qua, UI đã vô hiệu hóa);
 *  - chat → chatMetadata (qua saveMemory).
 * Thay đổi khuôn mẫu chỉ sửa "trạng thái ban đầu", các lệnh lịch sử vẫn phát lại như cũ (vì vậy sửa giá trị ban đầu sẽ ảnh hưởng giá trị hiện tại của cả cuộc trò chuyện).
 * Lưu ý: việc làm mới tiêm do bên gọi (trang giao diện) phụ trách refreshInjection —— store không import inject để tránh phụ thuộc vòng.
 */
export function replaceVarsTemplate(tier: VarTier, tpl: VarTemplate): void {
  const norm = normalizeTemplate(tpl);
  memory.varTemplates[tier] = norm;
  if (tier === 'global') {
    apiSettings.varsGlobalTemplate = norm;
  } else if (tier === 'char') {
    const key = currentCharKey();
    if (key) {
      if (Object.keys(norm.json).length || norm.meaning.trim() || norm.rule.trim()) apiSettings.varsTemplateByChar[key] = norm;
      else delete apiSettings.varsTemplateByChar[key]; // Xóa trống thì gỡ bỏ khóa, không để lại vỏ rỗng
    }
  } else {
    saveMemory(); // tầng chat ghi vào chatMetadata
  }
  recomputeDerived();
}

/** Lắng nghe chuyển đổi cuộc trò chuyện: trước khi chuyển đi thì flush các lá chưa lưu đĩa, sau khi chuyển đến thì tải lại */
export function bindChatLifecycle() {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    flushLeavesNow();
    loadMemory();
  });
  // Tải lần đầu
  loadMemory();
}
