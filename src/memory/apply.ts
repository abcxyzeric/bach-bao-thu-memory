import { apiSettings } from '@/api/settings';
import { getContext, setMessageText, type STMessage } from '@/st/context';
import { fmtItemLogInline } from './prompts';
import { lifeDetailSubject, mergeLifeDetailsOp, sameLifeDetail } from './lifeDetails';
import { applyKnowledgeOps, cleanKnowledgeOps, finalizeKnowledge, knowledgeOf } from './knowledge';
import { mergeProtagonistDelta } from './protagonist';
import { applyNpcAffinity, cleanNpcAffinityLevel } from './npcRelations';
import { memory, recomputeDerived, saveMemory, scheduleLeafFlush } from './store';
import { readItemsTagText, writeItemLogTag, writeVarLogTag } from './timeTag';
import { scheduleVectorIndex } from './vector';
import { invalidateRecallCache } from './vector/cache';
import { applyConditionPatch, hasConditionPatchContent, stripConditionFragmentIds } from './conditionPatch';
import { createEmptyMemory } from './types';
import type { BaibaiMemory, ConditionPatch, ConditionPatchOp, ItemDelta, ItemLogEntry, JsonValue, LeafExtra, LifeDetailAdd, LifeDetailUpdate, MemLifeDetail, MemNpc, MemPlan, MemScene, MemSummary, NpcAffinity, NpcDelta, NpcPresence, PlanResolveItem, PlanUpdateItem, ProtagonistDelta, SceneDelta, SceneFocus, SceneOp, SceneReparent, StoredDelta, SummaryDelta, VarOp, VarTemplate, VarTier } from './types';

// Cung cấp cho các bên gọi hiện có tiếp tục lấy kiểu có mặt từ apply; định nghĩa tại types.ts dùng chung với phần hiển thị danh sách.
export type { NpcPresence } from './types';

let idSeq = 0;
/** Tạo id duy nhất ổn định (không phụ thuộc random; thời gian đi qua nowMs để tiện tiêm khi kiểm thử) */
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${nowMs()}_${idSeq}`;
}

// Đóng gói một điểm lấy thời gian, có thể mock khi kiểm thử
function nowMs(): number {
  return Date.now();
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function optText(v: unknown): string | undefined {
  return scalarText(v) || undefined;
}

/** Văn bản bản vá ghi đè: undefined = không cung cấp; chuỗi rỗng = xóa trống rõ ràng. */
function patchText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return undefined;
}

function optBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

function optNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function namedText(v: unknown, keys: string[] = ['name', 'id', 'content']): string {
  const direct = scalarText(v);
  if (direct) return direct;
  if (!isRecord(v)) return '';
  for (const key of keys) {
    const s = scalarText(v[key]);
    if (s) return s;
  }
  return '';
}

function cleanTextList(v: unknown, keys?: string[]): string[] {
  return arr(v).map(x => namedText(x, keys)).filter(Boolean);
}

function cleanPath(v: unknown): string[] {
  if (Array.isArray(v)) return normScenePath(v);
  const s = scalarText(v);
  return s ? [s] : [];
}

function cleanItemDelta(raw: unknown): ItemDelta | null {
  if (!isRecord(raw)) {
    const name = scalarText(raw);
    return name ? { name } : null;
  }
  const name = namedText(raw, ['name', 'item', 'id']);
  if (!name) return null;
  return {
    name,
    desc: optText(raw.desc),
    qty: optNumber(raw.qty),
    carried: optBool(raw.carried),
    location: optText(raw.location),
  };
}

function cleanItemList(v: unknown): ItemDelta[] {
  return arr(v).map(cleanItemDelta).filter((x): x is ItemDelta => !!x);
}

/**
 * Tạo điểm rộng, mô tả nghiêm: add có thể không kèm desc (không viết ra được đặc trưng ổn định thì chỉ tạo nút, không ép mô hình bịa mô tả để vượt ngưỡng);
 * update bắt buộc phải kèm desc, chuỗi rỗng = xóa mô tả điền sai (giữ lại nút), update không kèm desc thì không có việc gì để làm, hủy bỏ.
 */
function cleanSceneDelta(raw: unknown, op: 'add' | 'update'): SceneDelta | null {
  if (!isRecord(raw)) return null;
  const path = cleanPath(raw.path);
  if (!path.length) return null;
  if (op === 'add') {
    const desc = optText(raw.desc);
    return desc ? { path, desc } : { path };
  }
  const desc = patchText(raw.desc);
  return desc === undefined ? null : { path, desc };
}

function cleanSceneList(v: unknown, op: 'add' | 'update'): SceneDelta[] {
  return arr(v).map(x => cleanSceneDelta(x, op)).filter((x): x is SceneDelta => !!x);
}

function cleanSceneReparent(raw: unknown): SceneReparent | null {
  if (!isRecord(raw)) return null;
  const node = cleanPath(raw.node);
  const newPath = cleanPath(raw.newPath);
  if (!node.length || !newPath.length) return null;
  const descs: Record<string, string> = {};
  if (isRecord(raw.descs)) {
    for (const [k, v] of Object.entries(raw.descs)) {
      const key = scalarText(k);
      const val = optText(v);
      if (key && val) descs[key] = val;
    }
  }
  return { node, newPath, descs };
}

function cleanSceneReparentList(v: unknown): SceneReparent[] {
  return arr(v).map(cleanSceneReparent).filter((x): x is SceneReparent => !!x);
}

function cleanSceneOp(raw: unknown): SceneOp | null {
  if (!isRecord(raw)) return null;
  if (raw.op === 'add' || raw.op === 'update') {
    const entry = cleanSceneDelta(raw, raw.op);
    return entry ? { op: raw.op, ...entry } : null;
  }
  if (raw.op === 'reparent') {
    const entry = cleanSceneReparent(raw);
    return entry ? { op: 'reparent', ...entry } : null;
  }
  if (raw.op === 'remove') {
    const path = cleanPath(raw.path);
    return path.length ? { op: 'remove', path } : null;
  }
  return null;
}

function cleanSceneOpList(v: unknown): SceneOp[] {
  return arr(v).map(cleanSceneOp).filter((x): x is SceneOp => !!x);
}

/**
 * Bản vá thương tích trong bản lưu cũ (giao thức đánh số v0.17), chỉ dùng để phát lại. Khi đưa vào kho đã được bộ làm sạch lúc đó rửa qua:
 * đánh số đều là chữ thường cN, text đều là chuỗi (chuỗi rỗng = xóa phân đoạn đó), ở đây chỉ kiểm tra hình dạng.
 */
function cleanConditionPatchOp(raw: unknown, requireId: boolean): ConditionPatchOp | null {
  if (!isRecord(raw) || typeof raw.text !== 'string') return null;
  const text = raw.text.trim();
  if (!requireId) return text ? { text } : null;
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  return /^c\d+$/.test(id) ? { id, text } : null;
}

function cleanConditionPatch(raw: unknown): ConditionPatch | undefined {
  if (!isRecord(raw)) return undefined;
  const replace = arr(raw.replace).map(x => cleanConditionPatchOp(x, true)).filter((x): x is ConditionPatchOp => !!x);
  const add = arr(raw.add).map(x => cleanConditionPatchOp(x, false)).filter((x): x is ConditionPatchOp => !!x);
  if (!replace.length && !add.length) return undefined;
  const out: ConditionPatch = {};
  if (replace.length) out.replace = replace;
  if (add.length) out.add = add;
  return out;
}

/** Toàn văn condition: bóc bỏ số thứ tự `[cN]` bị chép vào trong bản lưu cũ; ngữ nghĩa lược bỏ=undefined, chuỗi rỗng=xóa trống giữ nguyên. */
function cleanConditionText(v: unknown): string | undefined {
  const text = patchText(v);
  return text === undefined ? undefined : stripConditionFragmentIds(text);
}

// Cổng chặn cứng locationEvidence của bản v0.17 đã rút bỏ: câu trích dẫn của mô hình thường không khớp với chính văn, định vị hợp lệ bị âm thầm hủy bỏ, vị trí NPC càng ghi càng ít.
// locationEvidence do thói quen cũ đưa thừa không nằm trong danh sách trắng bên dưới, tự nhiên không đi vào kho.
function cleanNpcDelta(raw: unknown, stored = false): NpcDelta | null {
  if (!isRecord(raw)) {
    const name = scalarText(raw);
    return name ? { name } : null;
  }
  const name = namedText(raw, ['name', 'npc', 'id']);
  if (!name) return null;
  const conditionPatch = cleanConditionPatch(raw.conditionPatch);
  const condition = cleanConditionText(raw.condition);
  // Chuỗi rỗng ở tầng hồ sơ = xóa rõ ràng. Prompt ngoại hình/quan hệ/thân phận đã dạy mô hình dùng chuỗi rỗng để xóa chỗ điền sai, cả hai nhánh đều nhận;
  // giới tính/tuổi/nhân tế/tính cách không dạy, mô hình đưa chuỗi rỗng đa phần là giữ chỗ, chỉ nhận khi phát lại delta đã lưu trong kho (đó là do xóa trống thủ công ghi vào lá)
  const archiveText = stored ? patchText : optText;
  const out: NpcDelta = {
    name,
    gender: archiveText(raw.gender),
    age: archiveText(raw.age),
    ageTime: optText(raw.ageTime),
    relation: patchText(raw.relation),
    affinityInner: cleanNpcAffinityLevel(raw.affinityInner),
    affinityOuter: cleanNpcAffinityLevel(raw.affinityOuter),
    affinityNote: patchText(raw.affinityNote),
    ties: archiveText(raw.ties),
    title: patchText(raw.title),
    desc: patchText(raw.desc),
    personality: archiveText(raw.personality),
    // Tầng tức thời (ảnh chụp kiểu ghi đè) dùng patchText: lược bỏ = giữ giá trị cũ, chuỗi rỗng = xóa trống rõ ràng (lành bệnh/cởi bỏ).
    // Cùng ngữ nghĩa với cleanProtagonistDelta; optText sẽ rửa chuỗi rỗng thành undefined, dẫn đến không bao giờ xóa trống được.
    outfit: patchText(raw.outfit),
    condition,
    important: optBool(raw.important),
    follow: optBool(raw.follow),
    // Cùng ngữ nghĩa bản vá với outfit/condition: lược bỏ = giữ giá trị cũ, chuỗi rỗng = xóa trống rõ ràng (rời hiện trường và chưa rõ đi đâu → không rõ nơi ở).
    // Trước đây dùng optText sẽ rửa chuỗi rỗng thành undefined, khiến AI không thể xóa địa điểm cũ, sau khi rời trường vẫn bị phán đoán là có mặt.
    location: patchText(raw.location),
  };
  // Bản vá thương tích chỉ nhận ở bản lưu cũ (khi phát lại stored=true); đầu ra mới đã đổi về ghi đè toàn văn, mô hình có đưa bản vá nữa cũng không nhận,
  // tránh việc đưa nguyên vào kho rồi đánh số bị lệch vị trí khi các tầng phía trước biến động. Khi đưa cả toàn văn lẫn bản vá thì lấy toàn văn làm chuẩn (đánh số bản vá ứng với phân đoạn cũ).
  if (stored && conditionPatch && condition === undefined) out.conditionPatch = conditionPatch;
  return out;
}

function cleanNpcList(v: unknown, stored = false): NpcDelta[] {
  return arr(v).map(x => cleanNpcDelta(x, stored)).filter((x): x is NpcDelta => !!x);
}

/**
 * Làm sạch ảnh chụp thẻ cục diện, ngữ nghĩa ba trạng thái cùng họ với patchText:
 *  - undefined → undefined (chưa cung cấp = không cập nhật)
 *  - null      → null (xóa trống rõ ràng: cảnh tượng kết thúc triệt để / chương khép lại)
 *  - đối tượng → cả thẻ sau khi chuẩn hóa (thiếu một câu cục diện thì coi là cập nhật vô hiệu, không coi là xóa trống)
 */
function cleanSceneFocus(raw: unknown): SceneFocus | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const situation = optText(raw.situation);
  if (!situation) return undefined;
  const out: SceneFocus = { situation, participants: cleanTextList(raw.participants) };
  // currentFocus đã bỏ: không còn nhắc AI xuất ra, ở đây chỉ giữ lại tương thích để phát lại delta cũ
  const currentFocus = optText(raw.currentFocus);
  if (currentFocus) out.currentFocus = currentFocus;
  const tension = optText(raw.tension);
  if (tension) out.tension = tension;
  const pendingBeat = optText(raw.pendingBeat);
  if (pendingBeat) out.pendingBeat = pendingBeat;
  return out;
}

/** Làm sạch chi tiết đời sống add: text bắt buộc điền; topics/anchors mỗi thứ giữ vài từ ngắn đầu tiên. */
function cleanLifeDetailAdd(raw: unknown): LifeDetailAdd | null {
  if (!isRecord(raw)) return null;
  const text = optText(raw.text);
  if (!text) return null;
  const out: LifeDetailAdd = { text };
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (subject) out.subject = subject;
  const topics = cleanTextList(raw.topics).slice(0, 3);
  if (topics.length) out.topics = topics;
  const anchors = cleanTextList(raw.anchors).slice(0, 5);
  if (anchors.length) out.anchors = anchors;
  const until = optText(raw.until);
  if (until) out.until = until;
  return out;
}
function cleanLifeDetailAddList(v: unknown): LifeDetailAdd[] {
  return arr(v).map(cleanLifeDetailAdd).filter((x): x is LifeDetailAdd => !!x);
}

/** Làm sạch chi tiết đời sống update: id ổn định bắt buộc điền; tier chỉ xuất hiện ở op thủ công, truyền thẳng giá trị hợp lệ. */
function cleanLifeDetailUpdate(raw: unknown): (LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' }) | null {
  if (!isRecord(raw)) return null;
  const id = optText(raw.id);
  if (!id) return null;
  const out: LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' } = { id };
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (subject) out.subject = subject;
  const text = optText(raw.text);
  if (text) out.text = text;
  if (raw.topics !== undefined) out.topics = cleanTextList(raw.topics).slice(0, 3);
  if (raw.anchors !== undefined) out.anchors = cleanTextList(raw.anchors).slice(0, 5);
  if (raw.until !== undefined) out.until = optText(raw.until) ?? ''; // Chuỗi rỗng = xóa thời hiệu
  const tier = optText(raw.tier);
  if (tier === 'pinned' || tier === 'active' || tier === 'archive') out.tier = tier;
  return out;
}
function cleanLifeDetailUpdateList(v: unknown): (LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' })[] {
  return arr(v).map(cleanLifeDetailUpdate).filter((x): x is LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' } => !!x);
}

function cleanProtagonistDelta(raw: unknown, legacyPatch = false): ProtagonistDelta | null {
  if (!isRecord(raw)) return null;
  const out: ProtagonistDelta = {};
  for (const key of ['gender', 'age', 'ageTime', 'identity', 'appearance', 'outfit'] as const) {
    const value = patchText(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  const condition = cleanConditionText(raw.condition);
  if (condition !== undefined) out.condition = condition;
  // Bản vá thương tích chỉ nhận ở bản lưu cũ, ưu tiên toàn văn, lý do giống cleanNpcDelta.
  const conditionPatch = cleanConditionPatch(raw.conditionPatch);
  if (legacyPatch && conditionPatch && condition === undefined) out.conditionPatch = conditionPatch;
  return Object.keys(out).length ? out : null;
}

type PlanAdd = { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string };

function cleanPlanAdd(raw: unknown): PlanAdd | null {
  if (!isRecord(raw)) {
    const content = scalarText(raw);
    return content ? { kind: 'plan', content } : null;
  }
  const content = namedText(raw, ['content', 'text', 'name']);
  if (!content) return null;
  return {
    kind: raw.kind === 'suspense' ? 'suspense' : 'plan',
    content,
    createdTime: optText(raw.createdTime),
    targetTime: optText(raw.targetTime),
  };
}

function cleanPlanAddList(v: unknown): PlanAdd[] {
  return arr(v).map(cleanPlanAdd).filter((x): x is PlanAdd => !!x);
}

function cleanStoredPlanResolve(raw: unknown): PlanResolveItem | null {
  const id = namedText(raw, ['id', 'planId', 'ref']);
  if (!id) return null;
  if (!isRecord(raw)) return id;
  const out: Exclude<PlanResolveItem, string> = { id };
  if (raw.outcome === 'done' || raw.outcome === 'cancelled' || raw.outcome === 'failed') out.outcome = raw.outcome;
  const reason = optText(raw.reason);
  if (reason) out.reason = reason;
  return out;
}

function cleanStoredPlanResolveList(v: unknown): PlanResolveItem[] {
  return arr(v).map(cleanStoredPlanResolve).filter((x): x is PlanResolveItem => !!x);
}

/** Làm sạch mục dời lịch / tạm hoãn (trong StoredDelta id đã là id plan ổn định). content/targetTime đưa ít nhất một cái. */
function cleanStoredPlanUpdate(raw: unknown): PlanUpdateItem | null {
  if (!isRecord(raw)) return null;
  const id = namedText(raw, ['id', 'planId', 'ref']);
  if (!id) return null;
  const out: PlanUpdateItem = { id };
  const content = optText(raw.content);
  if (content) out.content = content;
  if (raw.targetTime !== undefined) out.targetTime = typeof raw.targetTime === 'string' ? raw.targetTime.trim() : '';
  if (out.content === undefined && out.targetTime === undefined) return null;
  return out;
}

function cleanStoredPlanUpdateList(v: unknown): PlanUpdateItem[] {
  return arr(v).map(cleanStoredPlanUpdate).filter((x): x is PlanUpdateItem => !!x);
}

function cleanStoredDelta(raw: StoredDelta): StoredDelta {
  if (!isRecord(raw)) return {};
  const out: StoredDelta = {};
  const time = optText(raw.time);
  const location = optText(raw.location);
  const locationPath = cleanPath(raw.locationPath);
  if (time) out.time = time;
  if (location) out.location = location;
  if (raw.locationPath !== undefined) out.locationPath = locationPath;
  const sceneFocus = cleanSceneFocus(raw.sceneFocus);
  if (sceneFocus !== undefined) out.sceneFocus = sceneFocus;
  const protagonist = cleanProtagonistDelta(raw.protagonist, true);
  if (protagonist) out.protagonist = protagonist;

  if (isRecord(raw.items)) {
    const items: NonNullable<StoredDelta['items']> = {};
    const add = cleanItemList(raw.items.add);
    const update = cleanItemList(raw.items.update);
    const remove = cleanTextList(raw.items.remove, ['name', 'item', 'id']);
    if (add.length) items.add = add;
    if (update.length) items.update = update;
    if (remove.length) items.remove = remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (isRecord(raw.scenes)) {
    const scenes: NonNullable<StoredDelta['scenes']> = {};
    const add = cleanSceneList(raw.scenes.add, 'add');
    const update = cleanSceneList(raw.scenes.update, 'update');
    const reparent = cleanSceneReparentList(raw.scenes.reparent);
    const remove = arr(raw.scenes.remove).map(cleanPath).filter(p => p.length);
    const ops = cleanSceneOpList(raw.scenes.ops);
    if (add.length) scenes.add = add;
    if (update.length) scenes.update = update;
    if (reparent.length) scenes.reparent = reparent;
    if (remove.length) scenes.remove = remove;
    if (ops.length) scenes.ops = ops;
    if (Object.keys(scenes).length) out.scenes = scenes;
  }

  if (isRecord(raw.npcs)) {
    const npcs: NonNullable<StoredDelta['npcs']> = {};
    const add = cleanNpcList(raw.npcs.add, true);
    const update = cleanNpcList(raw.npcs.update, true);
    const remove = cleanTextList(raw.npcs.remove, ['name', 'npc', 'id']);
    if (add.length) npcs.add = add;
    if (update.length) npcs.update = update;
    if (remove.length) npcs.remove = remove;
    if (Object.keys(npcs).length) out.npcs = npcs;
  }

  if (isRecord(raw.plans)) {
    const plans: NonNullable<StoredDelta['plans']> = {};
    const add = cleanPlanAddList(raw.plans.add);
    const resolve = cleanStoredPlanResolveList(raw.plans.resolve);
    const update = cleanStoredPlanUpdateList(raw.plans.update);
    const remove = cleanTextList(raw.plans.remove, ['id', 'planId']);
    const reopen = cleanTextList(raw.plans.reopen, ['id', 'planId']);
    if (add.length) plans.add = add;
    if (resolve.length) plans.resolve = resolve;
    if (update.length) plans.update = update;
    if (remove.length) plans.remove = remove;
    if (reopen.length) plans.reopen = reopen;
    if (Object.keys(plans).length) out.plans = plans;
  }

  if (isRecord(raw.lifeDetails)) {
    const lifeDetails: NonNullable<StoredDelta['lifeDetails']> = {};
    const add = cleanLifeDetailAddList(raw.lifeDetails.add);
    const update = cleanLifeDetailUpdateList(raw.lifeDetails.update);
    const archive = cleanTextList(raw.lifeDetails.archive, ['id', 'ref', 'detailId']);
    const remove = cleanTextList(raw.lifeDetails.remove, ['id', 'ref', 'detailId']);
    if (add.length) lifeDetails.add = add;
    if (update.length) lifeDetails.update = update;
    if (archive.length) lifeDetails.archive = archive;
    if (remove.length) lifeDetails.remove = remove;
    if (Object.keys(lifeDetails).length) out.lifeDetails = lifeDetails;
  }

  const knowledge = cleanKnowledgeOps(raw.knowledge);
  if (knowledge.length) out.knowledge = knowledge;

  const varOps = finalizeVarOps(raw.varOps);
  if (varOps.length) out.varOps = varOps;
  return out;
}

/* ============ ID tất định ============ */

/** ID vật phẩm: theo tên chuẩn hóa, nên phát lại bất biến, op thủ công có thể tham chiếu ổn định */
export function itemId(name: string): string {
  return `item:${norm(name)}`;
}
/** ID NPC: theo tên chuẩn hóa, nên phát lại bất biến, op thủ công có thể tham chiếu ổn định */
export function npcId(name: string): string {
  return `npc:${norm(name)}`;
}
/** ID kế hoạch: id lá tạo ra nó + số thứ tự trong mảng add tại lá đó */
export function planId(leafId: string, addIndex: number): string {
  return `plan:${leafId}#${addIndex}`;
}

/** ID chi tiết đời sống: id lá tạo ra nó + số thứ tự trong mảng add tại lá đó (đồng cấu với planId) */
export function detailId(leafId: string, addIndex: number): string {
  return `detail:${leafId}#${addIndex}`;
}

/** Lấy id plan ổn định từ một chỉ thị resolve (tương thích dữ liệu cũ dạng chuỗi trần) */
export function resolveEntryId(r: PlanResolveItem): string {
  return typeof r === 'string' ? r : r.id;
}

/** Chuẩn hóa đường dẫn bối cảnh: trim từng đoạn, bỏ đoạn rỗng. Trả về đường dẫn nguyên văn sạch (giữ hoa thường, chỉ bỏ khoảng trắng đầu cuối) */
export function normScenePath(path: string[] | undefined): string[] {
  if (!Array.isArray(path)) return [];
  return path.map(s => String(s ?? '').trim()).filter(Boolean);
}
/** ID bối cảnh: theo đường dẫn chuẩn hóa (chữ thường, phân cách bằng '/'), nên phát lại bất biến, op thủ công có thể tham chiếu ổn định */
export function sceneId(path: string[]): string {
  return `scene:${normScenePath(path).map(norm).join('/')}`;
}

/** Chỉ mục dùng để phân giải văn bản nơi cất giữ vật phẩm đối chiếu với cây bối cảnh. */
export interface SceneLocationIndex {
  byId: Map<string, MemScene>;
  byParent: Map<string, MemScene[]>;
  byName: Map<string, MemScene[]>;
}

function sceneLocationKey(s: string | undefined): string {
  return (s ?? '').replace(/[\uFE0E\uFE0F]/g, '').trim().toLowerCase();
}

function sortLocationCandidates(arr: MemScene[]): MemScene[] {
  return arr.sort((a, b) =>
    sceneLocationKey(b.name).length - sceneLocationKey(a.name).length
    || b.path.length - a.path.length
    || a.createdAt - b.createdAt,
  );
}

export function buildSceneLocationIndex(scenes: MemScene[]): SceneLocationIndex {
  const byId = new Map<string, MemScene>();
  const byParent = new Map<string, MemScene[]>();
  const byName = new Map<string, MemScene[]>();

  for (const s of scenes) {
    byId.set(s.id, s);

    const siblings = byParent.get(s.parentId) ?? [];
    siblings.push(s);
    byParent.set(s.parentId, siblings);

    const nameKey = sceneLocationKey(s.name);
    if (nameKey) {
      const sameName = byName.get(nameKey) ?? [];
      sameName.push(s);
      byName.set(nameKey, sameName);
    }
  }

  for (const arr of byParent.values()) sortLocationCandidates(arr);
  for (const arr of byName.values()) sortLocationCandidates(arr);
  return { byId, byParent, byName };
}

function sceneNameInLocation(locationKey: string, sceneName: string): boolean {
  const nameKey = sceneLocationKey(sceneName);
  return !!nameKey && locationKey.includes(nameKey);
}

function bestMatchedChild(children: MemScene[], locationKey: string): MemScene | null {
  const hits = children.filter(s => sceneNameInLocation(locationKey, s.name));
  if (!hits.length) return null;
  const bestLen = sceneLocationKey(hits[0].name).length;
  const tied = hits.filter(s => sceneLocationKey(s.name).length === bestLen);
  return tied.length === 1 ? tied[0] : null;
}

/**
 * Phân giải địa điểm vật phẩm dạng tự do thành nút bối cảnh sâu nhất mà nó gọi tên.
 *
 * Quá trình duyệt cố ý đi từ trên xuống: khớp tên bối cảnh gốc trước, sau đó chỉ
 * kiểm tra các nút con của gốc đó, lặp lại cho đến khi không còn nút con trực tiếp sâu hơn nào khớp.
 * Cách này tránh việc coi một địa điểm con như thể nó cũng thuộc về mọi tổ tiên
 * hoặc anh em có tên xuất hiện trong toàn văn.
 */
export function resolveSceneLocationId(
  scenes: MemScene[],
  location: string | undefined,
  index: SceneLocationIndex = buildSceneLocationIndex(scenes),
): string {
  const locationKey = sceneLocationKey(location);
  if (!locationKey || !scenes.length) return '';

  let cur = bestMatchedChild(index.byParent.get('') ?? [], locationKey);
  if (cur) {
    for (;;) {
      const next = bestMatchedChild(index.byParent.get(cur.id) ?? [], locationKey);
      if (!next) break;
      cur = next;
    }
    return cur.id;
  }

  const candidates: MemScene[] = [];
  for (const list of index.byName.values()) {
    for (const s of list) {
      if (sceneNameInLocation(locationKey, s.name)) candidates.push(s);
    }
  }
  sortLocationCandidates(candidates);
  if (!candidates.length) return '';
  const bestLen = sceneLocationKey(candidates[0].name).length;
  const tied = candidates.filter(s => sceneLocationKey(s.name).length === bestLen);
  return tied.length === 1 ? tied[0].id : '';
}

function scenePathStartsWith(path: string[], prefix: string[]): boolean {
  return prefix.length > 0
    && prefix.length <= path.length
    && prefix.every((seg, i) => norm(seg) === norm(path[i]));
}

export function itemReachableAtScene(
  scenes: MemScene[],
  itemLoc: string | undefined,
  current: MemScene | null,
  here = '',
  index: SceneLocationIndex = buildSceneLocationIndex(scenes),
): boolean {
  if (!current) return sceneNameReachable(itemLoc, here);
  const itemSceneId = resolveSceneLocationId(scenes, itemLoc, index);
  const itemScene = itemSceneId ? index.byId.get(itemSceneId) : null;
  if (!itemScene) return false;
  return scenePathStartsWith(current.path, itemScene.path);
}

/**
 * "Định vị có thẩm quyền" giữa Địa điểm hiện tại ↔ Cây bối cảnh: trả về id nút đang ở hiện tại (không tìm thấy trả về '').
 * Đầu tiêm và trang bối cảnh **dùng chung hàm này**, triệt tiêu việc rẽ nhánh ở hai nơi dẫn đến bất nhất giữa trang giao diện và prompt.
 */
export function findCurrentSceneId(scenes: MemScene[], here: string, locationPath?: string[]): string {
  const byId = new Map(scenes.map(s => [s.id, s]));

  // 1) Đường dẫn có thẩm quyền: chính xác → tiền tố tồn tại dài nhất
  const lp = normScenePath(locationPath);
  if (lp.length) {
    for (let depth = lp.length; depth >= 1; depth--) {
      const id = sceneId(lp.slice(0, depth));
      if (byId.has(id)) return id;
    }
  }

  // 2) Khớp mờ thu hẹp (dự phòng): chỉ xét tên cấp này + chuỗi đường dẫn đầy đủ, lấy sâu nhất
  const h = (here ?? '').trim();
  if (!h) return '';
  let best: MemScene | null = null;
  for (const s of scenes) {
    const hit = sceneNameReachable(s.name, h) || sceneNameReachable(s.path.join(''), h);
    if (hit && (!best || s.path.length > best.path.length)) best = s;
  }
  return best?.id ?? '';
}

/**
 * Quan hệ tương đối giữa đường dẫn hai nút bối cảnh, lấy pPath (nút hiện tại của nhân vật chính) làm chuẩn. Dùng cho phân mức có mặt của NPC:
 *  - 'same': cùng một nút.
 *  - 'near': N là cha trực tiếp của P (cấp ngay trên) / N là hậu duệ của P (hướng xuống không giới hạn trần) / nhánh bên và có chung cha trực tiếp.
 *  - 'far' : N là tổ tiên cấp cao hơn của P (≥2 cấp) / nhánh bên và tổ tiên chung xa hơn.
 * "Cùng khu vực" = near: ngước lên tối đa một cấp là tìm được địa điểm chung với nhân vật chính (hướng lên khóa trần một cấp, chặn khu phố / thị trấn; hướng xuống không giới hạn trần).
 */
export type SceneRel = 'same' | 'near' | 'far';
export function sceneRelation(pPath: string[], nPath: string[]): SceneRel {
  let common = 0;
  const min = Math.min(pPath.length, nPath.length);
  while (common < min && norm(pPath[common]) === norm(nPath[common])) common++;
  const p = pPath.length;
  const q = nPath.length;
  if (common === p && common === q) return 'same';       // Cùng một nút
  if (common === q) return p - q === 1 ? 'near' : 'far';  // N là tổ tiên của P: chỉ cấp ngay trên mới tính là gần
  if (common === p) return 'near';                        // N là hậu duệ của P: hướng xuống không giới hạn trần
  return p - common === 1 ? 'near' : 'far';               // Nhánh bên: có chung cha trực tiếp mới tính là gần
}

/**
 * **Thẩm quyền duy nhất** để phân mức có mặt của NPC: đầu tiêm (inject.ts) và trang NPC (pages/npcs) đều gọi nó, triệt tiêu sự lệch nhau giữa hai bộ logic
 * (trang NPC từng sao chép logic cũ, lại không dùng locationPath, định vị nhầm nhân vật chính sang nút nhánh bên trùng tên, phán đoán sai có mặt —— chính là điều hàm này giải quyết tận gốc).
 *  - 'present': đi cùng, hoặc nơi ở = nút hiện tại của nhân vật chính (gồm cả địa điểm con chi tiết hơn được phân giải gộp vào nút hiện tại).
 *  - 'nearby' : ngước lên tối đa một cấp là ở chung với nhân vật chính (tổ tiên cấp ngay trên / hậu duệ / nhánh bên có chung cha trực tiếp).
 *  - 'absent' : tổ tiên cấp cao hơn (khu phố / khuôn viên trường) hoặc nhánh bên xa hơn.
 * Khi nhân vật chính / NPC bất kỳ bên nào không rơi vào nút cây thì lùi về bao hàm hai chiều chuỗi thuần (hai trạng thái present/absent).
 */
export function classifyNpcPresence(
  npc: MemNpc,
  scenes: MemScene[],
  here: string,
  locationPath?: string[],
): NpcPresence {
  if (npc.follow === true) return 'present';
  // Nút hiện tại của nhân vật chính: đi qua findCurrentSceneId có thẩm quyền (ưu tiên định vị chính xác locationPath, sau đó dự phòng mờ)
  const cur = scenes.find(s => s.id === findCurrentSceneId(scenes, here, locationPath)) ?? null;
  if (!cur) return sceneNameReachable(npc.location, here) ? 'present' : 'absent';
  // Nơi ở của NPC cũng phân giải thành nút rồi mới so đường dẫn
  const n = scenes.find(s => s.id === findCurrentSceneId(scenes, npc.location ?? '')) ?? null;
  if (!n) return sceneNameReachable(npc.location, here) ? 'present' : 'absent';
  const rel = sceneRelation(cur.path, n.path);
  return rel === 'same' ? 'present' : rel === 'near' ? 'nearby' : 'absent';
}

/** Khớp hai chiều kiểu bao hàm (dự phòng khi cách đặt tên địa danh có độ chi tiết khác nhau); chuỗi rỗng không khớp. Dùng nội bộ cho findCurrentSceneId. */
function sceneNameReachable(a: string | undefined, b: string): boolean {
  const x = (a ?? '').trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** ID lá: không buộc chỉ mục, không buộc nội dung, vừa ghi vào là cố định */
export function makeLeafId(): string {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `leaf_${nowMs().toString(36)}_${rand}`;
}

/* ============ Nhận diện lỗi thời ============ */

// Việc làm sạch chính văn đã thống nhất về cleanBody / clampToTimeTags của timeTag.ts (xóa nguyên khối thẻ nhiễu, không còn "xóa trần thẻ giữ nội dung").

/** Lấy lá trên tin nhắn (không kiểm tra tính hợp lệ) */
export function getLeaf(m: STMessage | undefined): LeafExtra | undefined {
  return m?.extra?.bbs_leaf as LeafExtra | undefined;
}

/** Cấu trúc lá có nguyên vẹn hay không (có id + delta). Không kiểm tra quyền sở hữu số trang; phục vụ pruneBrokenComps phán đoán "lá có tồn tại vật lý hay không". */
export function leafIntact(m: STMessage | undefined): boolean {
  const leaf = getLeaf(m);
  return !!(leaf && leaf.id && leaf.delta);
}

/**
 * Tra ngược một id plan ổn định (plan:${leafId}#${addIdx}) thành văn bản nội dung kế hoạch.
 * resolve/reopen/remove chỉ lưu id, không lưu văn bản; bảng trong tầng muốn hiển thị "Khép lại: Tìm thấy em gái" cần dựa vào đây tra ngược về lá tạo ra nó.
 * Không tìm thấy (lá đã xóa / id không hợp lệ) trả về chuỗi rỗng, bên gọi tự hạ cấp.
 */
export function planContentById(planIdStr: string): string {
  const m = planIdStr.match(/^plan:(.+)#(\d+)$/);
  if (!m) return '';
  const leafId = m[1];
  const addIdx = Number(m[2]);
  const chat = getContext()?.chat;
  if (!chat) return '';
  for (let i = 0; i < chat.length; i++) {
    const lf = getLeaf(chat[i]);
    if (lf?.id === leafId) return scalarText(lf.delta?.plans?.add?.[addIdx]?.content);
  }
  return '';
}

/** Số trang được lá ghi nhận (mặc định tính là trang đầu tiên 0); số trang hiện tại của tin nhắn cùng tiêu chuẩn (swipe_id mặc định 0). */
function leafSwipe(leaf: LeafExtra): number {
  return typeof leaf.swipe === 'number' ? leaf.swipe : 0;
}
function msgSwipe(m: STMessage): number {
  return typeof m.swipe_id === 'number' ? m.swipe_id : 0;
}

/**
 * Lá có hợp lệ đối với "trang đang hiển thị hiện tại" hay không: cấu trúc nguyên vẹn + số trang thuộc về swipe hiện tại.
 *
 * Kiểm tra số trang giải quyết việc nhiễu chéo nhiều trang: khi ST tạo swipe mới sẽ structuredClone extra cũ, chép bbs_leaf của trang trước
 * sang trang mới; dựa vào "swipe của lá ≠ swipe_id hiện tại" để nhận diện và vô hiệu hóa —— lật sang trang chưa tóm tắt sẽ hiển thị đúng là "Thiếu tóm tắt",
 * lật về trang gốc số trang lại khớp, tóm tắt khôi phục. Dữ liệu lá luôn nằm lại trong extra của swipe tương ứng, không xóa.
 *
 * ⚠️ Không đối chiếu mã băm chính văn: sửa chính văn (lỗi chính tả / trau chuốt) không làm đổi swipe_id, nên sẽ không vì thế mà mất hiệu lực —— đây chính là lợi ích của việc dùng số trang thay vì
 * srcHash. Đánh đổi như trước: chỉnh sửa chính văn không tự động tóm tắt lại, kế thừa lá cũ; khi cần thì xóa lá thủ công rồi tóm tắt lại.
 */
export function leafValid(m: STMessage | undefined): boolean {
  const leaf = getLeaf(m);
  if (!leaf || !leaf.id || !leaf.delta) return false;
  if (!m) return false;
  return leafSwipe(leaf) === msgSwipe(m);
}

/* ============ Engine phát lại ============ */

/**
 * Áp dụng StoredDelta của một lá lên bộ nhớ dẫn xuất mem. Gấp (fold) không gây tác dụng phụ ngoài phạm vi.
 * Thứ tự áp dụng (trong cùng một lá): items(add→update→remove) → plans(add→resolve→reopen→remove).
 * Thứ tự đảm bảo nguyên tắc "trong cùng lá thêm trước thao tác sau" luôn đúng (như xóa thủ công mục vừa thêm ngay trong lá mới nhất).
 *
 * Tác dụng phụ: mỗi biến động vật phẩm nối thêm một bản ghi có kèm "thời gian trong truyện" (leaf.time) vào mem.itemLog.
 * Phát lại theo thứ tự tầng lầu, nên itemLog tự nhiên có thứ tự thời gian; cuối deriveMemory mới cắt lấy một số mục gần nhất.
 */
/**
 * Áp dụng thông tin mang theo người / địa điểm trong delta lên vật phẩm (chỉ khi delta đưa rõ ràng mới ghi đè, last-write-wins).
 * Khi carried=true thì xóa location (vật phẩm mang theo người không có nơi cất); khi carried=false thì giữ lại / áp dụng location.
 */
function applyPlacement(it: { carried?: boolean; location?: string }, src: ItemDelta): void {
  if (typeof src.carried === 'boolean') {
    it.carried = src.carried;
    if (src.carried) it.location = undefined; // Cầm trên người → không có nơi cất
  }
  if (typeof src.location === 'string') {
    const loc = src.location.trim();
    if (loc) {
      it.location = loc;
      if (it.carried === undefined) it.carried = false; // Đã đưa địa điểm tức là coi như không mang theo người
    }
  }
}

/**
 * Áp dụng thông tin đi cùng / nơi ở trong delta lên NPC (chỉ khi delta đưa rõ ràng mới ghi đè, last-write-wins).
 * Khi follow=true thì xóa location (NPC đi cùng không có nơi ở cố định); khi follow=false thì giữ lại / áp dụng location.
 * Khi location là chuỗi rỗng biểu thị "không rõ nơi ở", chỉ xóa địa điểm cũ để NPC cố định không còn bị phán đoán là có mặt;
 * **tuyệt đối không đụng vào follow** —— nhân vật đi cùng vốn không cần location, mô hình có thể tiện tay viết chuỗi rỗng,
 * việc có rời đội hay không chỉ có thể do follow tường minh quyết định, nếu không sẽ phán đoán nhầm đồng hành đi cùng thành rời trường (xóa trống cả hai cùng lúc sẽ gây hỏng nhầm diện rộng).
 * Đồng cấu với applyPlacement của vật phẩm (carried↔follow).
 */
function applyNpcPlacement(n: { follow?: boolean; location?: string }, src: NpcDelta): void {
  if (typeof src.follow === 'boolean') {
    n.follow = src.follow;
    if (src.follow) n.location = undefined; // Đi cùng → không có nơi ở cố định
  }
  if (typeof src.location === 'string') {
    const loc = src.location.trim();
    if (loc) {
      n.location = loc;
      if (n.follow === undefined) n.follow = false; // Đã đưa nơi ở tức là coi như cố định
    } else {
      // Chuỗi rỗng = không rõ nơi ở: xóa địa điểm cũ, tránh tiếp tục phán đoán là có mặt.
      // Không sửa follow: khi mô hình cho rằng "đi cùng thì không cần điền location" rồi tiện tay viết chuỗi rỗng,
      // không thể vì thế mà hủy trạng thái đồng hành đi cùng (muốn rời đội bắt buộc phải follow:false tường minh).
      n.location = undefined;
    }
  }
}

/**
 * Áp dụng trạng thái "tầng tức thời" (outfit/condition) và important trong delta lên NPC.
 * Khác với tầng hồ sơ (desc/title): tầng tức thời một khi delta đã đưa là **ghi đè trực tiếp** (bản thân nó vốn là ảnh chụp hiện tại,
 * không giống desc là "có thay đổi thực chất mới đụng tới"); add và update xử lý giống nhau, đảm bảo thay đồ / bị thương làm mới tức thì.
 */
function applyNpcState(n: { outfit?: string; condition?: string; important?: boolean }, src: NpcDelta): void {
  if (typeof src.outfit === 'string') n.outfit = src.outfit.trim() || undefined;
  if (typeof src.condition === 'string') n.condition = src.condition.trim() || undefined;
  // Bản vá thương tích của bản lưu cũ: các phân đoạn cũ không nằm trong replace được giữ lại (đầu ra mới đã đổi về ghi đè toàn văn).
  if (src.conditionPatch && hasConditionPatchContent(src.conditionPatch)) {
    n.condition = applyConditionPatch(n.condition, src.conditionPatch);
  }
  if (typeof src.important === 'boolean') n.important = src.important || undefined;
}

/**
 * Áp dụng tuổi tác trong delta lên NPC / nhân vật chính. Then chốt: **mốc neo do hệ thống đóng dấu, AI không điền** ——
 * khi delta mang age mà không có ageTime, mốc neo lấy thời gian trong truyện của lá đó (storyTime),
 * sau đó khi tiêm / hiển thị sẽ suy tính theo "mốc neo → thời gian hiện tại", thời gian nhảy vọt tự động tăng tuổi.
 * Khi ageTime xuất hiện riêng lẻ cũng chấp nhận (dùng cho op thủ công / hạt giống carryover điền lại mốc neo). add và update ghi đè giống nhau.
 */
function applyAge(n: { age?: string; ageTime?: string }, src: { age?: string; ageTime?: string }, storyTime: string): void {
  if (typeof src.age === 'string') {
    const a = src.age.trim();
    n.age = a || undefined;
    n.ageTime = a ? (src.ageTime?.trim() || storyTime || undefined) : undefined;
  } else if (typeof src.ageTime === 'string') {
    n.ageTime = src.ageTime.trim() || undefined;
  }
}

/** Hồ sơ nhân vật chính là ảnh chụp ghi đè thuần túy; chuỗi rỗng biểu thị xóa giá trị cũ. Tuổi tác đi theo cơ chế mốc neo (applyAge). */
function applyProtagonistState(target: BaibaiMemory['protagonist'], src: ProtagonistDelta, storyTime: string): void {
  for (const key of ['gender', 'identity', 'appearance', 'outfit', 'condition'] as const) {
    if (typeof src[key] === 'string') target[key] = src[key]!.trim() || undefined;
  }
  // Bản vá thương tích của bản lưu cũ: chỉ sửa phân đoạn chỉ định (đầu ra mới đã đổi về ghi đè toàn văn).
  if (src.conditionPatch && hasConditionPatchContent(src.conditionPatch)) {
    target.condition = applyConditionPatch(target.condition, src.conditionPatch);
  }
  applyAge(target, src, storyTime);
}

/**
 * Upsert từng cấp một đường dẫn bối cảnh vào cây bối cảnh dẫn xuất.
 * Duyệt qua mỗi tiền tố của path đảm bảo nút ở mỗi cấp đều tồn tại (thiếu thì tạo mới, id cha tính từ tiền tố cấp ngay trên);
 * chỉ nút **cấp cuối cùng** mới áp dụng desc (setDesc là true = update ghi đè; nếu không thì add chỉ bù khi vốn chưa có mô tả).
 * update đưa chuỗi rỗng = xóa mô tả điền sai, giữ lại nút; add không kèm desc chỉ tạo nút.
 * Quan hệ cha con tự hình thành ngầm qua id tất định, không cần childIds.
 */
function upsertScenePath(mem: BaibaiMemory, path: string[], desc: string | undefined, setDesc: boolean, t: number): void {
  const clean = normScenePath(path);
  if (!clean.length) return;
  const text = desc?.trim() ?? '';
  // Mô tả rỗng của update chỉ dùng để xóa mô tả của nút đã có, không vì thế mà tạo nút mới
  if (setDesc && !text && !mem.scenes.some(s => s.id === sceneId(clean))) return;
  for (let depth = 1; depth <= clean.length; depth++) {
    const prefix = clean.slice(0, depth);
    const id = sceneId(prefix);
    const parentId = depth > 1 ? sceneId(clean.slice(0, depth - 1)) : '';
    const isLeafLevel = depth === clean.length;
    const node = mem.scenes.find(s => s.id === id);
    if (!node) {
      mem.scenes.push({
        id,
        name: prefix[prefix.length - 1],
        path: prefix,
        parentId,
        desc: isLeafLevel ? text || undefined : undefined,
        createdAt: t,
        updatedAt: t,
      });
    } else if (isLeafLevel && text) {
      if (setDesc || !node.desc) node.desc = text; // update ghi đè; add chỉ bù khi trống
      node.updatedAt = t;
    } else if (isLeafLevel && setDesc && desc !== undefined && node.desc) {
      node.desc = undefined;
      node.updatedAt = t;
    }
  }
}

/** Gỡ bỏ một đường dẫn bối cảnh cùng toàn bộ hậu duệ của nó (khớp theo tiền tố id) */
function removeScenePath(mem: BaibaiMemory, path: string[]): void {
  const clean = normScenePath(path);
  if (!clean.length) return;
  const id = sceneId(clean);
  const childPrefix = `${id}/`; // ID của hậu duệ có dạng `${id}/cấp con…`
  mem.scenes = mem.scenes.filter(s => s.id !== id && !s.id.startsWith(childPrefix));
}

/**
 * Đặt lại cấp cha: dịch chuyển node (cùng toàn bộ cây con của nó) sang newPath. Bao phủ ba tình huống "thêm cha / chèn nút trung gian / đổi cha".
 *  - Trước tiên dọc theo tổ tiên của newPath tạo bù từng cấp cha (kèm mô tả descs);
 *  - Sau đó viết lại tổng thể path/id/parentId của mỗi nút trong cây con node từ tiền tố cũ sang tiền tố mới.
 * Phòng vệ: ① node không tồn tại thì bỏ qua (có thể đã được tầng phía trước di chuyển rồi, bất biến);
 *          ② newPath đi xuyên qua chính bản thân node (gắn cha vào dưới cây con của chính mình) sẽ tạo vòng → bỏ qua, bảo vệ cấu trúc cây.
 */
function reparentScenePath(mem: BaibaiMemory, r: SceneReparent, t: number): void {
  const from = normScenePath(r.node);
  const to = normScenePath(r.newPath);
  if (!from.length || !to.length) return;
  const fromId = sceneId(from);
  const node = mem.scenes.find(s => s.id === fromId);
  if (!node) return; // Bất biến: nút mục tiêu không tồn tại

  const newId = sceneId(to);
  if (newId === fromId) return; // Đứng nguyên tại chỗ
  // Phát hiện vòng: đường dẫn mới không được nằm bên trong cây con đang bị di chuyển (newId bằng fromId hoặc có tiền tố là fromId/)
  if (newId.startsWith(`${fromId}/`)) return;

  // Tạo bù các cấp tổ tiên "trừ đoạn cuối" trên newPath (đoạn cuối chính là bản thân node, lát nữa do dịch chuyển sinh ra)
  for (let depth = 1; depth < to.length; depth++) {
    const prefix = to.slice(0, depth);
    const id = sceneId(prefix);
    if (mem.scenes.some(s => s.id === id)) continue;
    const segName = prefix[prefix.length - 1];
    mem.scenes.push({
      id,
      name: segName,
      path: prefix,
      parentId: depth > 1 ? sceneId(to.slice(0, depth - 1)) : '',
      desc: r.descs?.[segName]?.trim() || undefined,
      createdAt: t,
      updatedAt: t,
    });
  }

  // Dịch chuyển cây con: tiền tố đường dẫn cũ from → tiền tố đường dẫn mới to.
  // Phiên bản lịch sử từng xếp toàn bộ add trong cùng một lá chạy trước reparent: khi người dùng đổi tên trước, rồi thêm địa điểm con dưới tên mới,
  // add sẽ ngầm tạo ra nút mục tiêu trước, bản cài đặt cũ sau đó lại đổi thẳng nút nguồn thành cùng id, tạo ra hai bối cảnh trùng id.
  // Ở đây gộp từng nút theo id mục tiêu, vừa sửa kết quả dẫn xuất của cuộc trò chuyện cũ, vừa ngăn mọi delta dị dạng tạo lại id trùng lặp.
  const childPrefix = `${fromId}/`;
  const moving = mem.scenes
    .filter(s => s.id === fromId || s.id.startsWith(childPrefix))
    .map(s => ({ scene: s, oldPath: [...s.path] }))
    .sort((a, b) => a.oldPath.length - b.oldPath.length);
  const movingSet = new Set(moving.map(x => x.scene));
  const claimed = new Map<string, MemScene>();
  const mergedAway = new Set<MemScene>();
  const rootDesc = r.descs?.[to[to.length - 1]]?.trim();

  for (const entry of moving) {
    const tail = entry.oldPath.slice(from.length);
    const targetPath = [...to, ...tail];
    const targetId = sceneId(targetPath);
    const existing = claimed.get(targetId)
      ?? mem.scenes.find(s => !movingSet.has(s) && s.id === targetId);

    if (existing) {
      // Mục tiêu đã có nút: gộp vào thay vì tạo thêm nút trùng id. Ưu tiên mô tả đổi tên tường minh; nếu không chỉ dùng mô tả nguồn bù vào chỗ trống của mục tiêu.
      if (!tail.length && rootDesc) existing.desc = rootDesc;
      else if (!existing.desc && entry.scene.desc) existing.desc = entry.scene.desc;
      existing.createdAt = Math.min(existing.createdAt, entry.scene.createdAt);
      existing.updatedAt = t;
      claimed.set(targetId, existing);
      mergedAway.add(entry.scene);
      continue;
    }

    const s = entry.scene;
    s.id = targetId;
    s.path = targetPath;
    s.name = targetPath[targetPath.length - 1];
    s.parentId = targetPath.length > 1 ? sceneId(targetPath.slice(0, -1)) : '';
    if (!tail.length && rootDesc) s.desc = rootDesc;
    s.updatedAt = t;
    claimed.set(targetId, s);
  }

  if (mergedAway.size) mem.scenes = mem.scenes.filter(s => !mergedAway.has(s));
}

/* ============ Biến tùy chỉnh: Cây JSON + Lệnh đường dẫn (mô phỏng MVU) ============ */

function isPlainObj(v: unknown): v is Record<string, JsonValue> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Sao chép sâu giá trị JSON (tránh việc nhiều nơi dùng chung tham chiếu bị sửa tại chỗ). */
export function deepCloneJson<T extends JsonValue>(v: T): T {
  if (Array.isArray(v)) return v.map(x => deepCloneJson(x)) as T;
  if (isPlainObj(v)) {
    const o: Record<string, JsonValue> = {};
    for (const k of Object.keys(v)) o[k] = deepCloneJson(v[k]);
    return o as T;
  }
  return v;
}

/** Gộp sâu: b ghi đè a (chỉ đệ quy với đối tượng; mảng / giá trị vô hướng lấy trọn b). */
function deepMerge(a: Record<string, JsonValue>, b: Record<string, JsonValue>): Record<string, JsonValue> {
  const out = deepCloneJson(a);
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (isPlainObj(bv) && isPlainObj(out[k])) out[k] = deepMerge(out[k] as Record<string, JsonValue>, bv);
    else out[k] = deepCloneJson(bv);
  }
  return out;
}

/** Gộp khuôn mẫu ba tầng thành trạng thái ban đầu: global < char < chat (tầng chính xác hơn ghi đè). */
export function mergeTemplates(t: Record<VarTier, VarTemplate>): Record<string, JsonValue> {
  return deepMerge(deepMerge(deepCloneJson(t.global.json), t.char.json), t.chat.json);
}

/**
 * Tại **điểm khởi đầu phát lại (seed)** mở rộng các macro ST ({{user}}/{{char}}/… trọn bộ, đi qua substituteParams) bên trong khuôn mẫu biến.
 * Duyệt sâu toàn bộ cây JSON: cả **khóa** của đối tượng lẫn mọi **giá trị chuỗi** đều được thay thế; số/boolean/null giữ nguyên.
 *
 * Tại sao chỉ mở rộng ở seed (chứ không phải lúc tiêm): macro chỉ có thể đến từ khuôn mẫu người dùng điền; thứ do AI và lệnh thủ công sinh ra luôn là giá trị thực.
 * Do đó thay thế "khuôn mẫu nguyên văn" thành tên thật ngay vào khoảnh khắc gộp thành trạng thái ban đầu, sau đó gấp VarOps các tầng toàn trình đều là tên thật,
 * tự nhiên khớp nhau —— không cần ánh xạ ngược tên thật do AI xuất ra về lại {{user}} (việc đó rất dễ gãy vì trùng tên / trò chuyện nhóm / đổi tên).
 * Bản thân khuôn mẫu vẫn lưu macro nguyên văn (saveMemory chỉ lưu khuôn mẫu, mem.vars là bộ nhớ đệm dẫn xuất không lưu đĩa), nên biến toàn cục có tính di động xuyên nhân vật:
 * sau khi chuyển nhân vật seed lại là có ngay tên nhân vật mới. Khi ST chưa sẵn sàng / không có substituteParams thì trả về nguyên bản (hạ cấp không nổ).
 */
export function expandVarMacros(json: Record<string, JsonValue>): Record<string, JsonValue> {
  const sub = getContext()?.substituteParams;
  if (typeof sub !== 'function') return json; // Hạ cấp: không lấy được mở rộng macro thì dùng giá trị chữ
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObj(v)) {
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(v)) out[sub(k)] = walk(v[k]); // Khóa cũng mở rộng
      return out;
    }
    return v;
  };
  return walk(json) as Record<string, JsonValue>;
}

/** Phân tích đường dẫn thành các đoạn: "Thế lực.Hội đồng[0].Danh vọng" → ['Thế lực','Hội đồng',0,'Danh vọng']; ''→[]. */
function parsePath(path: string): (string | number)[] {
  const segs: (string | number)[] = [];
  for (const part of String(path ?? '').split('.')) {
    if (part === '') continue;
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) { segs.push(part); continue; }
    if (m[1]) segs.push(m[1]);
    const idxs = m[2].match(/\d+/g);
    if (idxs) for (const i of idxs) segs.push(Number(i));
  }
  return segs;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getChild(parent: any, key: string | number): any {
  return Array.isArray(parent) ? parent[Number(key)] : parent[String(key)];
}
function setChild(parent: any, key: string | number, value: JsonValue): void {
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[String(key)] = value;
}
function removeChild(parent: any, key: string | number): void {
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[String(key)];
}

/** Định vị vật chứa cha và khóa đoạn cuối của path; create=true tự động tạo tầng trung gian bị thiếu (đoạn tiếp theo là số → mảng, nếu không → đối tượng). */
function locate(root: Record<string, JsonValue>, segs: (string | number)[], create: boolean): { parent: any; last: string | number } | null {
  let cur: any = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur == null || typeof cur !== 'object') return null;
    if (getChild(cur, s) === undefined || getChild(cur, s) === null) {
      if (!create) return null;
      setChild(cur, s, typeof segs[i + 1] === 'number' ? [] : {});
    }
    cur = getChild(cur, s);
  }
  if (cur == null || typeof cur !== 'object') return null;
  return { parent: cur, last: segs[segs.length - 1] };
}

/** Áp dụng một lệnh đường dẫn vào gốc JSON (sửa tại chỗ). Lệnh hỏng do bên gọi try/catch đỡ hộ. */
function applyVarOp(root: Record<string, JsonValue>, op: VarOp): void {
  const segs = parsePath(op.path);

  // Gốc (path=''): set dùng value thay thế tổng thể nội dung gốc; assign/remove thao tác đối tượng gốc theo key
  if (segs.length === 0) {
    if (op.op === 'set' && isPlainObj(op.value)) {
      for (const k of Object.keys(root)) delete root[k];
      Object.assign(root, deepCloneJson(op.value));
    } else if (op.op === 'assign' && op.key !== undefined) {
      root[String(op.key)] = deepCloneJson(op.value ?? null);
    } else if (op.op === 'remove' && op.key !== undefined) {
      delete root[String(op.key)];
    }
    return;
  }

  const create = op.op === 'set' || op.op === 'assign' || op.op === 'add';
  const loc = locate(root, segs, create);
  if (!loc) return;
  const { parent, last } = loc;

  switch (op.op) {
    case 'set':
      setChild(parent, last, deepCloneJson(op.value ?? null));
      break;
    case 'add': {
      const cur = getChild(parent, last);
      const d = typeof op.delta === 'number' ? op.delta : 0;
      setChild(parent, last, (typeof cur === 'number' ? cur : 0) + d);
      break;
    }
    case 'assign': {
      let container = getChild(parent, last);
      if (op.key !== undefined) {
        if (container == null || typeof container !== 'object') { container = typeof op.key === 'number' ? [] : {}; setChild(parent, last, container); }
        setChild(container, op.key, deepCloneJson(op.value ?? null));
      } else {
        if (!Array.isArray(container)) { container = []; setChild(parent, last, container); }
        (container as JsonValue[]).push(deepCloneJson(op.value ?? null));
      }
      break;
    }
    case 'remove': {
      const container = getChild(parent, last);
      if (op.key === undefined) {
        removeChild(parent, last); // Xóa bản thân path
      } else if (Array.isArray(container)) {
        if (typeof op.key === 'number') container.splice(op.key, 1);
        else { const i = container.findIndex(x => x === op.key); if (i >= 0) container.splice(i, 1); }
      } else if (isPlainObj(container)) {
        delete container[String(op.key)];
      }
      break;
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Áp dụng tuần tự một loạt lệnh; một lệnh hỏng đơn lẻ được bỏ qua không gây chết chương trình. */
export function applyVarOps(root: Record<string, JsonValue>, ops: VarOp[] | undefined): void {
  if (!ops?.length) return;
  for (const op of ops) {
    try { applyVarOp(root, op); } catch { /* Lệnh hỏng bỏ qua */ }
  }
}

/** Giá trị biến → chuỗi đơn dòng gọn gàng (đối tượng/mảng chuyển thành JSON; gộp xuống dòng; quá dài thì cắt ngắn). Dùng cho chú thích bên lề / bảng hiển thị. */
function fmtVarValue(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * Mô tả một lệnh biến thành "văn bản chính + văn bản phụ" dễ đọc —— chú thích chính văn tầng lầu và bảng trong tầng **dùng chung cùng một nguồn**,
 * đảm bảo câu chữ hai nơi nhất quán. Văn bản chính = đường dẫn bị sửa (khi assign/remove có key thì ghép vào cuối), văn bản phụ = giá trị / lượng tăng thêm.
 */
export function describeVarOp(op: VarOp): { text: string; sub?: string } {
  const path = op.path || '(Gốc)';
  switch (op.op) {
    case 'set':
      return { text: path, sub: `đặt thành ${fmtVarValue(op.value)}` };
    case 'add': {
      const d = typeof op.delta === 'number' ? op.delta : 0;
      return { text: path, sub: `${d >= 0 ? '+' : ''}${d}` };
    }
    case 'assign': {
      const key = op.key !== undefined ? String(op.key) : '';
      const full = key ? (op.path ? `${op.path}.${key}` : key) : `${path}[nối thêm]`;
      return { text: full, sub: `= ${fmtVarValue(op.value)}` };
    }
    case 'remove': {
      const key = op.key !== undefined ? String(op.key) : '';
      return { text: key ? (op.path ? `${op.path}.${key}` : key) : path };
    }
    default:
      return { text: path };
  }
}

/**
 * Kết xuất lệnh biến của tầng này thành văn bản nhiều dòng cho chú thích <bbs_vars> (mỗi dòng một mục, kèm tiền tố động từ).
 * Cùng vai trò với fmtItemLogInline: giúp mô hình chính ở các tầng toàn văn trong cửa sổ thấy được "tầng này đã sửa những biến này rồi", chống sửa lặp lại.
 * Trống thì trả về chuỗi rỗng (bên gọi dựa vào đó không ghi khối).
 */
export function fmtVarOpsInline(ops: VarOp[] | undefined): string {
  if (!ops?.length) return '';
  const verb: Record<VarOp['op'], string> = { set: 'Thiết lập', add: 'Thay đổi', assign: 'Thêm mới', remove: 'Xóa' };
  return ops
    .map(op => {
      const { text, sub } = describeVarOp(op);
      return sub ? `${verb[op.op]} ${text} ${sub}` : `${verb[op.op]} ${text}`;
    })
    .join('\n');
}

/** Kiểm tra mảng lệnh do AI trả về → VarOp[] sạch (hủy bỏ các op phi pháp). */
export function finalizeVarOps(raw: unknown): VarOp[] {
  if (!Array.isArray(raw)) return [];
  const out: VarOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const op = o.op;
    if (op !== 'set' && op !== 'assign' && op !== 'remove' && op !== 'add') continue;
    const vo: VarOp = { op, path: typeof o.path === 'string' ? o.path : '' };
    if (typeof o.key === 'string' || typeof o.key === 'number') vo.key = o.key;
    if ('value' in o) vo.value = o.value as JsonValue;
    if (op === 'add') vo.delta = Number(o.delta) || 0;
    out.push(vo);
  }
  return out;
}

function applyStoredDeltaTo(mem: BaibaiMemory, d: StoredDelta, leaf: { id: string; createdAt: number; time: string }): void {
  const t = leaf.createdAt;
  const logTime = leaf.time;
  const log = (kind: ItemLogEntry['kind'], name: string, from?: number, to?: number): void => {
    mem.itemLog.push({ name, kind, from, to, time: logTime });
  };
  d = cleanStoredDelta(d);

  // Kiểu ghi đè: bỏ qua chuỗi rỗng
  if (typeof d.time === 'string' && d.time.trim()) mem.state.time = d.time.trim();
  if (typeof d.location === 'string' && d.location.trim()) {
    mem.state.location = d.location.trim();
    // Hễ location thay đổi, locationPath đi theo cùng một delta: AI đưa thì áp dụng, không đưa thì xóa trống (tránh việc path cũ hơn location)
    const lp = normScenePath(d.locationPath);
    mem.state.locationPath = lp.length ? lp : undefined;
  } else if (d.locationPath !== undefined) {
    // Hiếm gặp: chỉ cập nhật path không đụng location (bối cảnh thủ công); áp dụng hoặc xóa trống
    const lp = normScenePath(d.locationPath);
    mem.state.locationPath = lp.length ? lp : undefined;
  }
  if (d.protagonist) applyProtagonistState(mem.protagonist, d.protagonist, logTime || mem.state.time);

  // Thẻ cục diện: undefined = giữ nguyên; null = xóa trống; đối tượng = ghi đè cả thẻ, và đóng dấu thời gian trong truyện của lá này
  if (d.sceneFocus !== undefined) {
    mem.state.sceneFocus = d.sceneFocus
      ? { ...d.sceneFocus, updatedTime: logTime || mem.state.time || undefined }
      : null;
  }

  // Vật phẩm (mọi thứ đều đếm số lượng: add mặc định +1, cộng dồn có dấu, số lượng ≤0 tự động gỡ bỏ)
  if (d.items) {
    for (const add of d.items.add ?? []) {
      if (!add?.name?.trim()) continue;
      const id = itemId(add.name);
      const ex = mem.items.find(i => i.id === id);
      const step = typeof add.qty === 'number' ? add.qty : 1; // Thiếu số lượng mặc định là 1
      if (ex) {
        const before = ex.qty;
        const next = (ex.qty ?? 1) + step; // Dữ liệu cũ vốn không đếm số lượng thì tính bắt đầu từ 1
        if (add.desc) ex.desc = add.desc;
        applyPlacement(ex, add); // Mang theo người / địa điểm (đưa rõ ràng mới ghi đè)
        if (next <= 0) {
          mem.items.splice(mem.items.indexOf(ex), 1); // Trừ về 0 → gỡ bỏ
          log('remove', ex.name, before, 0);
        } else {
          ex.qty = next;
          ex.updatedAt = t;
          log('add', ex.name, before, next);
        }
      } else if (step > 0) {
        const it: BaibaiMemory['items'][number] = {
          id,
          name: add.name.trim(),
          desc: add.desc?.trim() || undefined,
          qty: step,
          createdAt: t,
          updatedAt: t,
        };
        applyPlacement(it, add);
        mem.items.push(it);
        log('add', add.name.trim(), undefined, step);
      }
      // step ≤0 và vật phẩm không tồn tại: không có gì để trừ, bỏ qua
    }
    for (const upd of d.items.update ?? []) {
      if (!upd?.name?.trim()) continue;
      const it = mem.items.find(i => i.id === itemId(upd.name));
      if (!it) continue; // Chịu lỗi: cập nhật mục không tồn tại thì bỏ qua
      const before = it.qty;
      if (upd.desc) it.desc = upd.desc;
      applyPlacement(it, upd); // Thay đổi mang theo người / địa điểm (di chuyển vật phẩm)
      if (typeof upd.qty === 'number') {
        if (upd.qty <= 0) {
          mem.items.splice(mem.items.indexOf(it), 1); // Đặt thành ≤0 → gỡ bỏ
          log('remove', it.name, before, 0);
          continue;
        }
        it.qty = upd.qty;
      }
      it.updatedAt = t;
      log('update', it.name, before, it.qty);
    }
    for (const name of d.items.remove ?? []) {
      if (!name?.trim()) continue;
      const idx = mem.items.findIndex(i => i.id === itemId(name));
      if (idx >= 0) {
        const [removed] = mem.items.splice(idx, 1);
        log('remove', removed.name, removed.qty, 0);
      }
    }
  }

  // Bối cảnh / Địa điểm. Các nhóm AI/lịch sử cũ giữ nguyên thứ tự add → update → reparent → remove, đảm bảo tương thích ngược;
  // thao tác thủ công trên UI bản mới thống nhất ghi vào ops, và phát lại nghiêm ngặt theo thứ tự thao tác của người dùng sau các nhóm cũ.
  if (d.scenes) {
    for (const a of d.scenes.add ?? []) upsertScenePath(mem, a.path, a.desc, false, t);
    for (const u of d.scenes.update ?? []) upsertScenePath(mem, u.path, u.desc, true, t);
    for (const r of d.scenes.reparent ?? []) reparentScenePath(mem, r, t);
    for (const p of d.scenes.remove ?? []) removeScenePath(mem, p);
    for (const op of d.scenes.ops ?? []) {
      if (op.op === 'add') upsertScenePath(mem, op.path, op.desc, false, t);
      else if (op.op === 'update') upsertScenePath(mem, op.path, op.desc, true, t);
      else if (op.op === 'reparent') reparentScenePath(mem, op, t);
      else removeScenePath(mem, op.path);
    }
  }

  // NPC (kiểu chỉ thị: add mới xuất hiện / update sửa thân phận vị trí / remove rút lui). Thứ tự áp dụng: add → update → remove.
  // update đối với tên chưa tồn tại sẽ tạo mới theo kiểu upsert, tương thích với dữ liệu lịch sử sau khi di chuyển danh sách bị trống nhưng tóm tắt sau đó lại sinh nhầm update.
  if (d.npcs) {
    // Mốc neo tuổi tác dùng "thời gian trong truyện của lá này"; lá không có thời gian thì lùi về thời gian trạng thái hiện tại (delta.time đã có hiệu lực ở phía trên)
    const npcTime = logTime || mem.state.time;
    for (const add of d.npcs.add ?? []) {
      if (!add?.name?.trim()) continue;
      const id = npcId(add.name);
      const ex = mem.npcs.find(n => n.id === id);
      if (ex) {
        // Đã tồn tại: tầng hồ sơ (gender/title/desc/tính cách/quan hệ) add coi như bổ sung (chỉ điền vào chỗ trống, không ghi đè cái đã có);
        // tầng tức thời (outfit/condition/important) vẫn ghi đè trực tiếp (bản thân nó vốn là ảnh chụp hiện tại), rồi áp dụng vị trí.
        // Tuổi tác cũng là "chỉ điền vào chỗ trống": add trùng lặp đa phần là thuật lại thông tin cũ, nếu ghi đè sẽ làm mới nhầm mốc neo sang thời gian hiện tại (đóng băng tuổi);
        // thay đổi tuổi thực sự (qua sinh nhật / đính chính) đi qua update.
        if (add.gender && !ex.gender) ex.gender = add.gender.trim();
        if (add.age && !ex.age) applyAge(ex, add, npcTime);
        if (add.relation && !ex.relation) ex.relation = add.relation.trim();
        if (add.ties && !ex.ties) ex.ties = add.ties.trim();
        if (add.title && !ex.title) ex.title = add.title.trim();
        if (add.desc && !ex.desc) ex.desc = add.desc.trim();
        if (add.personality && !ex.personality) ex.personality = add.personality.trim();
        applyNpcAffinity(ex, add, true);
        applyNpcState(ex, add);
        applyNpcPlacement(ex, add);
        ex.updatedAt = t;
      } else {
        const npc: BaibaiMemory['npcs'][number] = {
          id,
          name: add.name.trim(),
          gender: add.gender?.trim() || undefined,
          relation: add.relation?.trim() || undefined,
          ties: add.ties?.trim() || undefined,
          title: add.title?.trim() || undefined,
          desc: add.desc?.trim() || undefined,
          personality: add.personality?.trim() || undefined,
          createdAt: t,
          updatedAt: t,
        };
        applyNpcAffinity(npc, add);
        applyAge(npc, add, npcTime);
        applyNpcState(npc, add);
        applyNpcPlacement(npc, add);
        mem.npcs.push(npc);
      }
    }
    for (const upd of d.npcs.update ?? []) {
      if (!upd?.name?.trim()) continue;
      const id = npcId(upd.name);
      let n = mem.npcs.find(x => x.id === id);
      if (!n) {
        n = {
          id,
          name: upd.name.trim(),
          gender: upd.gender?.trim() || undefined,
          relation: upd.relation?.trim() || undefined,
          ties: upd.ties?.trim() || undefined,
          title: upd.title?.trim() || undefined,
          desc: upd.desc?.trim() || undefined,
          personality: upd.personality?.trim() || undefined,
          createdAt: t,
          updatedAt: t,
        };
        mem.npcs.push(n);
      }
      // Chuỗi rỗng ở tầng hồ sơ = xóa rõ ràng (đính chính điền sai / xóa trống thủ công), lược bỏ = giữ nguyên; if (upd.x) kiểu cũ coi chuỗi rỗng như chưa viết, không bao giờ xóa được
      for (const key of ['gender', 'relation', 'ties', 'title', 'desc', 'personality'] as const) {
        const v = upd[key];
        if (typeof v === 'string') n[key] = v.trim() || undefined;
      }
      applyAge(n, upd, npcTime); // Ghi đè tuổi + tự động làm mới mốc neo (qua sinh nhật / đính chính); chuỗi rỗng cũng xóa sạch
      applyNpcAffinity(n, upd); // Hai phía ghi đè độc lập, không cộng dồn hay liên động tự động
      applyNpcState(n, upd); // Tầng tức thời (trang phục/trạng thái/tầm quan trọng) ghi đè làm mới
      applyNpcPlacement(n, upd); // Thay đổi đi cùng / nơi ở (NPC di chuyển)
      n.updatedAt = t;
    }
    for (const name of d.npcs.remove ?? []) {
      if (!name?.trim()) continue;
      const idx = mem.npcs.findIndex(x => x.id === npcId(name));
      if (idx >= 0) mem.npcs.splice(idx, 1);
    }
  }

  // Kế hoạch / Nghi vấn
  if (d.plans) {
    (d.plans.add ?? []).forEach((add, addIdx) => {
      if (!add?.content?.trim()) return;
      const id = planId(leaf.id, addIdx);
      if (mem.plans.some(p => p.id === id)) return; // Phát lại cùng một lá bất biến
      const plan: MemPlan = {
        id,
        kind: add.kind === 'suspense' ? 'suspense' : 'plan',
        content: add.content.trim(),
        status: 'open',
        createdAt: t,
        createdTime: add.createdTime?.trim() || undefined,
        targetTime: add.targetTime?.trim() || undefined,
      };
      mem.plans.push(plan);
    });
    for (const r of d.plans.resolve ?? []) {
      const p = mem.plans.find(x => x.id === resolveEntryId(r));
      if (p) {
        p.status = 'resolved';
        p.resolvedAt = t;
        // Mang theo "khép lại thế nào / tại sao"; dữ liệu cũ dạng chuỗi trần không có thông tin này, giữ nguyên không ghi
        if (typeof r !== 'string') {
          p.outcome = r.outcome;
          p.resolvedReason = r.reason?.trim() || undefined;
        }
      }
    }
    // Dời lịch / tạm hoãn: chỉ cập nhật tổng thể content/targetTime của mục vẫn đang tồn tại; targetTime chuỗi rỗng = hủy bỏ thời hạn cũ mà thời hạn mới chưa định
    for (const u of d.plans.update ?? []) {
      const p = mem.plans.find(x => x.id === u.id);
      if (!p) continue;
      if (typeof u.content === 'string' && u.content.trim()) p.content = u.content.trim();
      if (u.targetTime !== undefined) p.targetTime = u.targetTime.trim() || undefined;
    }
    for (const pid of d.plans.reopen ?? []) {
      const p = mem.plans.find(x => x.id === pid);
      if (p) {
        p.status = 'open';
        p.resolvedAt = undefined;
        p.outcome = undefined; // Mở lại → xóa kết luận của lần khép lại trước
        p.resolvedReason = undefined;
      }
    }
    for (const pid of d.plans.remove ?? []) {
      const idx = mem.plans.findIndex(x => x.id === pid);
      if (idx >= 0) mem.plans.splice(idx, 1);
    }
  }

  // Hồ sơ nhỏ đời sống: add (khử trùng) → update → archive → remove. id tất định: detail:${leafId}#số thứ tự, phát lại bất biến
  if (d.lifeDetails) {
    (d.lifeDetails.add ?? []).forEach((add, i) => {
      const text = add.text?.trim();
      if (!text) return;
      // Cùng một nhân vật và văn bản chuẩn hóa giống nhau đã tồn tại → không tạo dòng trùng lặp; nhưng gộp topics/anchors/until mới mang theo vào mục đã có (không làm mất thông tin bổ sung)
      const dup = mem.lifeDetails.find(x => sameLifeDetail(x, add));
      if (dup) {
        if (add.topics?.length) dup.topics = add.topics.slice(0, 3);
        if (add.anchors?.length) dup.anchors = add.anchors.slice(0, 5);
        if (add.until?.trim()) dup.until = add.until.trim();
        return;
      }
      mem.lifeDetails.push({
        id: detailId(leaf.id, i),
        subject: lifeDetailSubject(add),
        text,
        topics: (add.topics ?? []).slice(0, 3),
        anchors: (add.anchors ?? []).slice(0, 5),
        tier: 'active',
        until: add.until?.trim() || undefined,
        createdTime: logTime || undefined,
        createdAt: t,
      });
    });
    for (const upd of d.lifeDetails.update ?? []) {
      const det = mem.lifeDetails.find(x => x.id === upd.id);
      if (!det) continue;
      if (upd.subject?.trim()) det.subject = upd.subject.trim();
      if (upd.text?.trim()) det.text = upd.text.trim();
      if (upd.topics) det.topics = upd.topics.slice(0, 3);
      if (upd.anchors) det.anchors = upd.anchors.slice(0, 5);
      if (upd.until !== undefined) det.until = upd.until.trim() || undefined; // Chuỗi rỗng = xóa thời hiệu
      if (upd.tier) det.tier = upd.tier;
    }
    for (const id of d.lifeDetails.archive ?? []) {
      const det = mem.lifeDetails.find(x => x.id === id);
      if (det) det.tier = 'archive';
    }
    for (const id of d.lifeDetails.remove ?? []) {
      const idx = mem.lifeDetails.findIndex(x => x.id === id);
      if (idx >= 0) mem.lifeDetails.splice(idx, 1);
    }
  }

  // Danh sách hiểu biết: nhật ký có thứ tự áp dụng theo nguyên thứ tự, id xác định theo số thứ tự thao tác, phát lại bất biến
  if (d.knowledge?.length) applyKnowledgeOps(mem.knowledge, d.knowledge, { id: leaf.id, createdAt: t, time: logTime });

  // Biến tùy chỉnh: áp dụng tuần tự các lệnh đường dẫn của tầng này vào trạng thái JSON
  if (d.varOps?.length) applyVarOps(mem.vars, d.varOps);
}

/**
 * Phát lại trạng thái có cấu trúc từ chat.
 * Quét chat theo **thứ tự vật lý của tầng lầu**, gấp (fold) delta cho từng lá hợp lệ (thứ tự tầng chính là thứ tự tự sự, sau khi xóa tin nhắn tự nhiên vẫn đúng).
 * Nút nén chỉ nén văn bản, không mang delta, không tham gia phát lại.
 * @param upToExclusive Chỉ phát lại các tầng có chỉ mục < giá trị này (cắt đến trước tầng đang phân tích; lược bỏ = toàn bộ).
 */
export function deriveMemory(
  chat: STMessage[] | null,
  upToExclusive?: number,
): Pick<BaibaiMemory, 'state' | 'protagonist' | 'items' | 'plans' | 'scenes' | 'npcs' | 'itemLog' | 'lifeDetails' | 'knowledge' | 'vars'> {
  const mem = createEmptyMemory();
  // Biến tính bắt đầu từ khuôn mẫu gộp ba tầng (không có chat cũng trả về trạng thái ban đầu); khi seed mở rộng các macro ST ({{user}} v.v.) trong khuôn mẫu
  mem.vars = expandVarMacros(mergeTemplates(memory.varTemplates));
  if (!chat) return { state: mem.state, protagonist: mem.protagonist, items: mem.items, plans: mem.plans, scenes: mem.scenes, npcs: mem.npcs, itemLog: mem.itemLog, lifeDetails: mem.lifeDetails, knowledge: mem.knowledge, vars: mem.vars };
  const end = typeof upToExclusive === 'number' ? Math.min(upToExclusive, chat.length) : chat.length;
  for (let i = 0; i < end; i++) {
    if (chat[i]?.extra?.bbs_omit) continue; // Tầng ngoại truyện: không tham gia phát lại dẫn xuất
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i])!;
    // Nhật ký dùng "thời gian trong truyện": ưu tiên thời gian kết thúc (thời khắc cuối của đoạn này), thiếu thì lấy bắt đầu, thiếu nữa lấy timeLabel cũ, cuối cùng là chuỗi rỗng
    const time = optText(leaf.timeEnd) || optText(leaf.timeStart) || optText(leaf.timeLabel) || '';
    applyStoredDeltaTo(mem, leaf.delta, { id: leaf.id, createdAt: leaf.createdAt, time });
  }
  // Chỉ giữ lại một số mục biến động gần nhất (đủ dùng cho tiêm / nạp mô hình là được, tiết kiệm token)
  if (mem.itemLog.length > ITEM_LOG_KEEP) mem.itemLog = mem.itemLog.slice(-ITEM_LOG_KEEP);
  return { state: mem.state, protagonist: mem.protagonist, items: mem.items, plans: mem.plans, scenes: mem.scenes, npcs: mem.npcs, itemLog: mem.itemLog, lifeDetails: mem.lifeDetails, knowledge: mem.knowledge, vars: mem.vars };
}

/** Số mục gần nhất được giữ lại của nhật ký biến động (dùng chung cho tiêm và nạp tóm tắt). */
export const ITEM_LOG_KEEP = 8;

/**
 * Tính các mục biến động vật phẩm do "một delta đơn lẻ so với trạng thái vật phẩm trước đó đã cho" tạo ra (để ghi vào chính văn tầng đó).
 * Tái sử dụng applyStoredDeltaTo: gieo một mem tạm thời bằng các vật phẩm trước đó, chỉ áp dụng một delta này,
 * bắt lấy itemLog của nó chính là biến động ròng của tầng này (kèm from→to). time do bên gọi truyền vào (thời gian kết thúc câu chuyện của tầng này).
 */
export function itemChangesOf(
  delta: StoredDelta,
  priorItems: BaibaiMemory['items'],
  time: string,
): ItemLogEntry[] {
  const mem = createEmptyMemory();
  // Sao chép sâu các vật phẩm trước đó làm điểm xuất phát (tránh làm bẩn bên gọi); chỉ quan tâm items, plans/state không ảnh hưởng itemLog
  mem.items = priorItems.map(i => ({ ...i }));
  applyStoredDeltaTo(mem, { items: delta.items }, { id: 'tmp', createdAt: 0, time });
  return mem.itemLog;
}

/* ============ Chú thích <bbs_items> ↔ delta đồng bộ ngược (người dùng sửa chính văn) ============ */

/**
 * Phân tích văn bản nhiều dòng "kiểu động từ" của khối <bbs_items> → lượng tăng thêm vật phẩm có dấu.
 * Mỗi dòng: `<động từ> <tên> [số lượng]`. Động từ: Nhận=+, Tiêu hao/Mất=-. Thiếu số lượng mặc định là 1.
 * Tên có thể chứa khoảng trắng (lấy toàn bộ phần sau động từ và trước con số tùy chọn ở cuối); dòng không hợp lệ bỏ qua.
 * Trả về dạng add (qty có dấu, tái sử dụng ngữ nghĩa cộng dồn có dấu + ≤0 gỡ bỏ của applyStoredDeltaTo).
 */
export function parseItemLogText(text: string): { name: string; qty: number }[] {
  const out: { name: string; qty: number }[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(Nhận|Tiêu hao|Mất|\u83b7\u5f97|\u6d88\u8017|\u5931\u53bb)\s+(.+?)(?:\s+(\d+))?$/);
    if (!m) continue;
    const sign = m[1] === 'Nhận' || m[1] === '\u83b7\u5f97' ? 1 : -1;
    const name = m[2].trim();
    if (!name) continue;
    const n = m[3] ? Number(m[3]) : 1;
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push({ name, qty: sign * n });
  }
  return out;
}

/**
 * Sau khi người dùng chỉnh sửa chính văn một tầng, đồng bộ ngược thay đổi của chú thích <bbs_items> trong đó về lại delta.items của lá tầng đó.
 *
 * Phán đoán tính nhất quán đi qua "cùng một đường ống kết xuất": kết xuất delta hiện có của lá thành chú thích chuẩn, đem đối chiếu với chú thích trong chính văn;
 * Bằng nhau → người dùng không đụng vào vật phẩm (chỉ sửa chính văn chỗ khác) → bỏ qua, không đụng delta, không ghi lại chính văn (tránh sửa nhầm / rung lắc).
 * Không bằng → lấy chính văn làm chuẩn: phân tích thành add có dấu, **thay thế** phần items trong delta của lá đó (giữ lại time/location/plans),
 *              tính lại dữ liệu dẫn xuất, xóa chuỗi hỏng, và viết lại chú thích chính văn thành định dạng chuẩn (tiện tay dọn sạch cách viết không chuẩn của người dùng), cuối cùng lưu đĩa.
 *
 * Lưu ý: chú thích không mang mô tả / giá trị tuyệt đối của số lượng, phân tích ngược biểu đạt theo "lượng tăng thêm"; nên người dùng sửa chú thích sẽ làm mất desc trong delta gốc (chấp nhận được,
 * muốn sửa mô tả xin vào danh sách vật phẩm chỉnh sửa). Không có khối <bbs_items> (người dùng xóa cả khối) → coi như xóa trống biến động vật phẩm của tầng đó.
 * Trả về có xảy ra ghi lại hay không.
 */
export function syncItemLogFromMessage(index: number): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf || !leaf.delta) return false;

  // Trạng thái vật phẩm trước tầng đó (dùng để kết xuất delta thành chú thích cùng tiêu chuẩn với chính văn để đối chiếu)
  const prior = deriveMemory(chat, index).items;
  const time = optText(leaf.timeEnd) || optText(leaf.timeStart) || optText(leaf.timeLabel) || '';
  const currentInline = fmtItemLogInline(itemChangesOf(leaf.delta, prior, time));

  const tagText = readItemsTagText(chat[index].mes); // null = không có khối
  const editedInline = tagText === null ? '' : fmtItemLogInline(parsedToLog(parseItemLogText(tagText), prior));

  if (currentInline === editedInline) return false; // Chú thích vật phẩm không đổi, bỏ qua

  // Lấy chính văn làm chuẩn: phân tích thành add có dấu, thay thế phần items của delta.
  // Chú thích không mang thông tin mang theo người / địa điểm, kế thừa lại theo tên vật phẩm từ add/update của delta cũ, tránh việc sửa số lượng làm xóa nhầm thông tin không gian.
  const placeBefore = new Map<string, { carried?: boolean; location?: string }>();
  for (const e of [...(leaf.delta.items?.add ?? []), ...(leaf.delta.items?.update ?? [])]) {
    if (e.carried !== undefined || e.location !== undefined) {
      placeBefore.set(itemId(e.name), { carried: e.carried, location: e.location });
    }
  }
  const parsed = parseItemLogText(tagText ?? '');
  if (parsed.length) {
    leaf.delta.items = {
      add: parsed.map(p => {
        const place = placeBefore.get(itemId(p.name));
        return { name: p.name, qty: p.qty, ...(place ?? {}) };
      }),
    };
  } else delete leaf.delta.items;

  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };

  // Viết lại chú thích chính văn thành định dạng chuẩn (kết xuất lại bằng delta sau khi chuẩn hóa)
  if (!apiSettings.summaryOnlyMode) {
    const canonical = fmtItemLogInline(itemChangesOf(leaf.delta, prior, time));
    setMessageText(chat[index], writeItemLogTag(chat[index].mes, canonical));
  }

  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/** Áp dụng lượng tăng thêm có dấu đã phân tích ra vào trạng thái trước đó, thu được ItemLogEntry[] (phục vụ kết xuất đối chiếu, cùng tiêu chuẩn với itemChangesOf). */
function parsedToLog(parsed: { name: string; qty: number }[], prior: BaibaiMemory['items']): ItemLogEntry[] {
  if (!parsed.length) return [];
  return itemChangesOf({ items: { add: parsed.map(p => ({ name: p.name, qty: p.qty })) } }, prior, '');
}

/* ============ AI delta → Cố định thành StoredDelta ============ */

/** Phân tích "p3" / "3" / "P3" -> 3 */
function parseShortRef(ref: string): number | null {
  const m = String(ref).trim().match(/^p?(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Cố định SummaryDelta do AI trả về thành StoredDelta có thể lưu bền vững.
 * Then chốt: số thứ tự ngắn lúc chạy (p1/p2…) của plans.resolve được dịch thành **id plan ổn định** theo openPlansOrdered.
 * knowledge: ngữ cảnh của danh sách hiểu biết (thứ tự k1/k2… hiển thị trong prompt + tên nhân vật trong danh sách); không đưa = tính năng tắt, hiểu biết do AI xuất ra nhất loạt hủy bỏ.
 */
export function finalizeDelta(
  delta: SummaryDelta,
  openPlansOrdered: { id: string }[],
  lifeDetailsOrdered: { id: string }[] = [],
  knowledge?: { shown: { id: string }[]; npcNames: string[] },
): StoredDelta {
  const out: StoredDelta = {};
  const time = optText(delta.time);
  const location = optText(delta.location);
  if (time) out.time = time;
  if (location) out.location = location;
  // Đường dẫn định vị có thẩm quyền: đưa tường minh [] cùng lúc với location biểu thị "không thể ứng với nút đã biết" → xóa mốc neo cũ, thay vì giữ lại quy thuộc cũ.
  // null/""/[] xuất hiện riêng lẻ không tính là xóa: mô hình thường viết trường không dùng thành giá trị rỗng, hễ mất mốc neo là phán đoán có mặt của NPC lùi về khớp mờ ngay.
  if (delta.locationPath != null) {
    const lp = cleanPath(delta.locationPath);
    if (lp.length || (location && Array.isArray(delta.locationPath))) out.locationPath = lp;
  }
  const sceneFocus = cleanSceneFocus(delta.sceneFocus);
  if (sceneFocus !== undefined) out.sceneFocus = sceneFocus;
  const protagonist = cleanProtagonistDelta(delta.protagonist);
  if (protagonist) out.protagonist = protagonist;

  if (isRecord(delta.items)) {
    const items: NonNullable<StoredDelta['items']> = {};
    const add = cleanItemList(delta.items.add);
    const update = cleanItemList(delta.items.update);
    const remove = cleanTextList(delta.items.remove, ['name', 'item', 'id']);
    if (add.length) items.add = add;
    if (update.length) items.update = update;
    if (remove.length) items.remove = remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (isRecord(delta.scenes)) {
    // Chuẩn hóa đường dẫn; add có thể không kèm desc (chỉ tạo nút), update bắt buộc kèm desc (chuỗi rỗng = xóa mô tả).
    const scenes: NonNullable<StoredDelta['scenes']> = {};
    const add = cleanSceneList(delta.scenes.add, 'add');
    const update = cleanSceneList(delta.scenes.update, 'update');
    const reparent = cleanSceneReparentList(delta.scenes.reparent);
    if (add.length) scenes.add = add;
    if (update.length) scenes.update = update;
    if (reparent.length) scenes.reparent = reparent;
    if (Object.keys(scenes).length) out.scenes = scenes;
  }

  if (isRecord(delta.npcs)) {
    // Chuẩn hóa: add/update bắt buộc phải có tên mới giữ lại (NPC vô danh không ghi)
    const npcs: NonNullable<StoredDelta['npcs']> = {};
    const add = cleanNpcList(delta.npcs.add);
    const update = cleanNpcList(delta.npcs.update);
    const remove = cleanTextList(delta.npcs.remove, ['name', 'npc', 'id']);
    if (add.length) npcs.add = add;
    if (update.length) npcs.update = update;
    if (remove.length) npcs.remove = remove;
    if (Object.keys(npcs).length) out.npcs = npcs;
  }

  if (isRecord(delta.plans)) {
    const plans: NonNullable<StoredDelta['plans']> = {};
    const add = cleanPlanAddList(delta.plans.add);
    if (add.length) plans.add = add;
    if (arr(delta.plans.resolve).length) {
      const out: PlanResolveItem[] = [];
      for (const ref of arr(delta.plans.resolve)) {
        // Số thứ tự ngắn có thể là chuỗi trần "p2" hoặc đối tượng mang kết cục { id:"p2", outcome, reason }
        const shortRef = namedText(ref, ['id', 'ref', 'planId']);
        const n = parseShortRef(shortRef);
        if (n === null) continue;
        const target = openPlansOrdered[n - 1];
        if (!target) continue;
        if (!isRecord(ref)) {
          out.push(target.id); // Định dạng cũ: chỉ dịch thành id ổn định
        } else {
          const entry: PlanResolveItem = { id: target.id };
          if (ref.outcome === 'done' || ref.outcome === 'cancelled' || ref.outcome === 'failed') entry.outcome = ref.outcome;
          const reason = optText(ref.reason);
          if (reason) entry.reason = reason;
          out.push(entry);
        }
      }
      if (out.length) plans.resolve = out;
    }
    if (arr(delta.plans.update).length) {
      // Số thứ tự ngắn p1/p2… dịch thành id ổn định theo openPlansOrdered; content/targetTime đưa ít nhất một cái
      const out: PlanUpdateItem[] = [];
      for (const ref of arr(delta.plans.update)) {
        if (!isRecord(ref)) continue;
        const shortRef = namedText(ref, ['id', 'ref', 'planId']);
        const n = parseShortRef(shortRef);
        if (n === null) continue;
        const target = openPlansOrdered[n - 1];
        if (!target) continue;
        const entry: PlanUpdateItem = { id: target.id };
        const content = optText(ref.content);
        if (content) entry.content = content;
        if (ref.targetTime !== undefined) entry.targetTime = typeof ref.targetTime === 'string' ? ref.targetTime.trim() : '';
        if (entry.content === undefined && entry.targetTime === undefined) continue;
        out.push(entry);
      }
      if (out.length) plans.update = out;
    }
    if (Object.keys(plans).length) out.plans = plans;
  }

  if (isRecord(delta.lifeDetails)) {
    // Số thứ tự ngắn d1/d2… dịch thành id ổn định theo "thứ tự hồ sơ hiện tại hiển thị trong prompt"; đã là id ổn định detail: thì giữ nguyên
    const resolveDetailRef = (ref: unknown): string | null => {
      const t = namedText(ref, ['id', 'ref', 'detailId']);
      if (!t) return null;
      if (t.startsWith('detail:')) return t;
      const m = t.match(/^d(\d+)$/i);
      if (!m) return null;
      const target = lifeDetailsOrdered[Number(m[1]) - 1];
      return target?.id ?? null;
    };
    const lifeDetails: NonNullable<StoredDelta['lifeDetails']> = {};
    const add = cleanLifeDetailAddList(delta.lifeDetails.add);
    if (add.length) lifeDetails.add = add;
    const update = cleanLifeDetailUpdateList(delta.lifeDetails.update)
      .map(u => {
        const id = resolveDetailRef(u.id);
        // Đường dẫn AI bóc tách tier: cấp độ là điều khiển phân phối thủ công, prompt chưa từng cung cấp trường này; đầu ra ảo giác không được vượt qua quy tắc "ghim đầu chỉ dành riêng cho thủ công"
        if (!id) return null;
        const { tier: _tier, ...rest } = u;
        return { ...rest, id };
      })
      .filter((u): u is LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' } => !!u);
    if (update.length) lifeDetails.update = update;
    const archive = arr(delta.lifeDetails.archive).map(resolveDetailRef).filter((x): x is string => !!x);
    if (archive.length) lifeDetails.archive = archive;
    const remove = arr(delta.lifeDetails.remove).map(resolveDetailRef).filter((x): x is string => !!x);
    if (remove.length) lifeDetails.remove = remove;
    if (Object.keys(lifeDetails).length) out.lifeDetails = lifeDetails;
  }

  if (knowledge) {
    // Nhân vật mới xuất hiện ở tầng này cũng tính vào danh sách: việc biết được ngay tại chỗ trong lần đầu gặp mặt phải ghi vào được
    const names = [...knowledge.npcNames, ...(out.npcs?.add ?? []).map(n => n.name)];
    const ops = finalizeKnowledge(delta.knowledge, knowledge.shown, names);
    if (ops.length) out.knowledge = ops;
  }

  if (Array.isArray(delta.vars) && delta.vars.length) {
    const ops = finalizeVarOps(delta.vars);
    if (ops.length) out.varOps = ops;
  }
  return out;
}

/* ============ Ghi vào nút nén (rừng) ============ */

/** Nối thêm một nút nén (level≥1). Lá không đi qua đây (nằm trên extra của tin nhắn). */
export function addSummary(
  s: Omit<MemSummary, 'id' | 'createdAt'> & Partial<Pick<MemSummary, 'id' | 'createdAt'>>,
): MemSummary {
  const rec: MemSummary = {
    id: s.id ?? uid('sum'),
    text: s.text,
    level: s.level ?? 1,
    createdAt: s.createdAt ?? nowMs(),
    auto: s.auto ?? true,
    timeStart: s.timeStart,
    timeEnd: s.timeEnd,
    timeLabel: s.timeLabel,
    childIds: s.childIds ?? [],
    imported: s.imported,
    importedFloorStart: s.importedFloorStart,
    importedFloorEnd: s.importedFloorEnd,
  };
  memory.summaries.push(rec);
  saveMemory();
  return rec;
}

/* ============ Lá (trên extra của tin nhắn) ============ */

/** Một lá hợp lệ mới nhất (tin nhắn có leafValid cuối cùng trong chat); không có thì null */
export function latestLeaf(): { index: number; leaf: LeafExtra } | null {
  const chat = getContext()?.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i--) {
    if (leafValid(chat[i])) return { index: i, leaf: getLeaf(chat[i])! };
  }
  return null;
}

/**
 * Gộp một đoạn op thủ công vào delta của "lá hợp lệ mới nhất", sửa extra trong bộ nhớ → tính lại + lưu đĩa (file chat).
 * Khi không có lá hợp lệ trả về false (trang giao diện dựa vào đó vô hiệu hóa thêm thủ công).
 * resolve/reopen loại trừ lẫn nhau và khử trùng: đối với cùng một plan, thao tác sau ghi đè thao tác trước (last-write-wins trong cùng lá).
 * Chỉ sửa delta, không làm thay đổi cấu trúc và quyền sở hữu swipe của lá, nên không ảnh hưởng leafValid.
 */
export function appendOpToLatestLeaf(op: StoredDelta): boolean {
  const found = latestLeaf();
  if (!found) return false;
  const { index, leaf } = found;
  const chat = getContext()!.chat;
  const d: StoredDelta = (leaf.delta ??= {});
  let changed = false;

  if (op.protagonist) {
    d.protagonist = mergeProtagonistDelta(d.protagonist, op.protagonist);
    changed = true;
  }
  if (op.sceneFocus !== undefined) {
    d.sceneFocus = op.sceneFocus
      ? { ...op.sceneFocus, participants: [...op.sceneFocus.participants] }
      : null;
    changed = true;
  }
  if (op.items) {
    if (op.items.add?.length || op.items.update?.length || op.items.remove?.length) changed = true;
    // Then chốt: vật phẩm cùng tên giữa add/update và remove bắt buộc phải loại trừ lẫn nhau (triệt tiêu xuyên nhóm), nếu không việc đổi tên (remove cũ + add mới)
    // qua lại sẽ làm nhóm remove còn sót tên cũ, mà việc phát lại cố định gom nhóm theo add→update→remove —— remove ở cuối sẽ xóa mất
    // vật phẩm cùng tên vừa mới add quay lại (vật phẩm biến mất kỳ lạ). Bên trong nhóm add vẫn giữ push cộng dồn, không đụng tới ngữ nghĩa "+1 thủ công".
    const di = (d.items ??= {});
    for (const name of op.items.remove ?? []) {
      const id = itemId(name);
      // Việc xóa áp đảo add/update đối với tên đó bên trong lá này; sau đó đăng ký chờ xóa (khử trùng, vật phẩm đó ở các lá trước dựa vào nó để xóa)
      if (di.add) di.add = di.add.filter(a => itemId(a.name) !== id);
      if (di.update) di.update = di.update.filter(u => itemId(u.name) !== id);
      di.remove = [...(di.remove ?? []).filter(n => itemId(n) !== id), name];
    }
    for (const a of op.items.add ?? []) {
      if (di.remove) di.remove = di.remove.filter(n => itemId(n) !== itemId(a.name)); // Hoàn tác chờ xóa cùng tên
      (di.add ??= []).push(a);
    }
    for (const u of op.items.update ?? []) {
      if (di.remove) di.remove = di.remove.filter(n => itemId(n) !== itemId(u.name));
      (di.update ??= []).push(u);
    }
    if (di.add && !di.add.length) delete di.add;
    if (di.update && !di.update.length) delete di.update;
    if (di.remove && !di.remove.length) delete di.remove;
  }
  if (op.npcs) {
    if (op.npcs.add?.length || op.npcs.update?.length || op.npcs.remove?.length) changed = true;
    // Loại trừ xuyên nhóm cùng kiểu với vật phẩm: NPC cùng tên giữa add/update và remove không thể cùng tồn tại,
    // nếu không đổi tên (remove cũ + add mới) qua lại sẽ làm nhóm remove còn sót tên cũ, phát lại theo add→update→remove sẽ xóa mất cái vừa add.
    const dn = (d.npcs ??= {});
    for (const name of op.npcs.remove ?? []) {
      const id = npcId(name);
      if (dn.add) dn.add = dn.add.filter(a => npcId(a.name) !== id);
      if (dn.update) dn.update = dn.update.filter(u => npcId(u.name) !== id);
      dn.remove = [...(dn.remove ?? []).filter(n => npcId(n) !== id), name];
    }
    for (const a of op.npcs.add ?? []) {
      if (dn.remove) dn.remove = dn.remove.filter(n => npcId(n) !== npcId(a.name));
      (dn.add ??= []).push(a);
    }
    for (const u of op.npcs.update ?? []) {
      if (dn.remove) dn.remove = dn.remove.filter(n => npcId(n) !== npcId(u.name));
      (dn.update ??= []).push(u);
    }
    if (dn.add && !dn.add.length) delete dn.add;
    if (dn.update && !dn.update.length) delete dn.update;
    if (dn.remove && !dn.remove.length) delete dn.remove;
  }
  if (op.scenes) {
    if (
      op.scenes.add?.length
      || op.scenes.update?.length
      || op.scenes.reparent?.length
      || op.scenes.remove?.length
      || op.scenes.ops?.length
    ) changed = true;
    const ds = (d.scenes ??= {});
    if (op.scenes.add?.length) (ds.add ??= []).push(...op.scenes.add);
    if (op.scenes.update?.length) (ds.update ??= []).push(...op.scenes.update);
    if (op.scenes.reparent?.length) (ds.reparent ??= []).push(...op.scenes.reparent);
    if (op.scenes.remove?.length) (ds.remove ??= []).push(...op.scenes.remove);
    if (op.scenes.ops?.length) (ds.ops ??= []).push(...op.scenes.ops);
  }
  if (op.plans) {
    if (op.plans.add?.length || op.plans.resolve?.length || op.plans.remove?.length || op.plans.reopen?.length || op.plans.update?.length) changed = true;
    const dp = (d.plans ??= {});
    if (op.plans.add?.length) (dp.add ??= []).push(...op.plans.add);
    for (const u of op.plans.update ?? []) {
      // Trong cùng một lá gộp theo id: khi sửa nội dung trước rồi sửa thời hạn sau, lần sau không được xóa mất lần trước
      const prev = dp.update?.find(x => x.id === u.id);
      dp.update = [...(dp.update ?? []).filter(x => x.id !== u.id), { ...prev, ...u }];
    }
    for (const r of op.plans.resolve ?? []) {
      const rid = resolveEntryId(r);
      dp.reopen = (dp.reopen ?? []).filter(x => x !== rid); // Loại trừ lẫn nhau
      dp.resolve = [...(dp.resolve ?? []).filter(x => resolveEntryId(x) !== rid), r];
    }
    for (const id of op.plans.reopen ?? []) {
      dp.resolve = (dp.resolve ?? []).filter(x => resolveEntryId(x) !== id); // Loại trừ lẫn nhau
      dp.reopen = [...(dp.reopen ?? []).filter(x => x !== id), id];
    }
    for (const id of op.plans.remove ?? []) {
      (dp.remove ??= []).push(id);
    }
  }
  const existingLifeDetails = op.lifeDetails?.add?.length
    ? deriveMemory(chat, index).lifeDetails
    : undefined;
  if (mergeLifeDetailsOp(d, op.lifeDetails, { leafId: leaf.id, existingDetails: existingLifeDetails })) changed = true;
  if (op.knowledge?.length) {
    // Nhật ký có thứ tự nối thêm trực tiếp: phát lại áp dụng nghiêm ngặt theo thứ tự trước sau, không cần triệt tiêu xuyên nhóm
    (d.knowledge ??= []).push(...op.knowledge);
    changed = true;
  }
  if (op.varOps?.length) {
    // Nối thêm lệnh lần này vào lá mới nhất (theo thứ tự, cái áp dụng sau ghi đè cái trước)
    (d.varOps ??= []).push(...op.varOps);
    changed = true;
  }

  if (!changed) return false;

  // Đặt lại tham chiếu extra để đảm bảo việc lưu bền vững mang theo thay đổi
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };

  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/**
 * Đặt toàn bộ trạng thái biến thành newJson באופן thủ công (dữ liệu dẫn xuất, ghi về lá mới nhất bằng một lệnh set ở gốc).
 * Dùng cho "Chỉnh sửa giá trị hiện tại (JSON)" ở trang biến: người dùng chỉnh sửa trực tiếp toàn bộ JSON, lưu thành set('', newJson).
 * Không có lá hợp lệ trả về false.
 */
export function setVarsRoot(newJson: Record<string, JsonValue>): boolean {
  return appendOpToLatestLeaf({ varOps: [{ op: 'set', path: '', value: newJson }] });
}

/** Ghi đè thủ công hồ sơ hiện tại của nhân vật chính. Chuỗi rỗng sẽ xóa giá trị cũ tương ứng. */
export function setProtagonist(patch: ProtagonistDelta): boolean {
  const clean = cleanProtagonistDelta(patch);
  return clean ? appendOpToLatestLeaf({ protagonist: clean }) : false;
}

/** Thêm thủ công một chi tiết đời sống (gắn ở lá mới nhất; mục mới đi vào tầng active). Khi không có lá hợp lệ trả về false. */
export function addLifeDetail(input: LifeDetailAdd): boolean {
  const clean = cleanLifeDetailAdd(input);
  return clean ? appendOpToLatestLeaf({ lifeDetails: { add: [clean] } }) : false;
}

/** Cập nhật thủ công một chi tiết đời sống (văn bản/nhãn/thời hiệu/cấp độ). Ghim đầu / lắng đọng / khôi phục đều đi qua đây. Khi không có lá hợp lệ trả về false. */
export function updateLifeDetail(id: string, patch: Omit<LifeDetailUpdate, 'id'> & { tier?: 'pinned' | 'active' | 'archive' }): boolean {
  const clean = cleanLifeDetailUpdate({ ...patch, id });
  return clean ? appendOpToLatestLeaf({ lifeDetails: { update: [clean] } }) : false;
}

/** Xóa thủ công một chi tiết đời sống. Khi không có lá hợp lệ trả về false. */
export function removeLifeDetail(id: string): boolean {
  return appendOpToLatestLeaf({ lifeDetails: { remove: [id] } });
}

/** Thêm thủ công một mục hiểu biết cho một nhân vật (nền tảng của người quen cũ dựa vào đây để bù đắp; có thể viết mục ngược, như "Không biết nhân vật chính là hoàng tử"). Khi không có lá hợp lệ trả về false. */
export function addKnowledge(subject: string, text: string): boolean {
  const s = subject.trim();
  const t = text.trim();
  return s && t ? appendOpToLatestLeaf({ knowledge: [{ op: 'add', subject: s, text: t }] }) : false;
}

/** Sửa thủ công một mục hiểu biết (vạch trần / đính chính nhận thức). Khi không có lá hợp lệ trả về false. */
export function updateKnowledge(id: string, text: string): boolean {
  const t = text.trim();
  return t ? appendOpToLatestLeaf({ knowledge: [{ op: 'update', id, text: t }] }) : false;
}

/** Xóa thủ công một mục hiểu biết. Khi không có lá hợp lệ trả về false. */
export function removeKnowledge(id: string): boolean {
  return appendOpToLatestLeaf({ knowledge: [{ op: 'remove', id }] });
}

/**
 * Chỉnh sửa thủ công một vật phẩm (dữ liệu dẫn xuất, ghi về delta của lá mới nhất).
 *  - Đổi tên: id vật phẩm xác định theo tên chuẩn hóa, đổi tên đồng nghĩa đổi id → biểu đạt bằng remove(tên cũ) + add(tên mới, kèm qty/desc/vị trí).
 *  - Chỉ sửa qty/desc/vị trí: dùng update (khớp theo tên gốc, đặt thành giá trị mới).
 * Cả hai đều đi qua appendOpToLatestLeaf hạ cánh vào lá mới nhất. Khi không có lá hợp lệ trả về false.
 *
 * Vị trí (carried/location): khi patch không đưa tường minh, kịch bản đổi tên sẽ kế thừa từ vật phẩm cũ dẫn xuất —— nếu không chỉ đổi cái tên
 * là mất luôn thông tin cất giữ kiểu "ở kho vũ khí" (dùng add dựng lại sẽ mất các trường không có trong add).
 */
export function editItem(
  oldName: string,
  patch: { name?: string; qty?: number; desc?: string; carried?: boolean; location?: string },
): boolean {
  const newName = patch.name?.trim() || oldName;
  const desc = patch.desc?.trim() || undefined;
  const qty = typeof patch.qty === 'number' && Number.isFinite(patch.qty) ? patch.qty : undefined;

  // Vị trí: patch đưa rõ ràng thì dùng của patch; nếu không kế thừa từ vật phẩm cũ (đổi tên không mất nơi cất)
  const prev = memory.items.find(i => i.id === itemId(oldName));
  const carried = patch.carried !== undefined ? patch.carried : prev?.carried;
  const location = patch.location !== undefined ? (patch.location.trim() || undefined) : prev?.location;

  if (norm(newName) !== norm(oldName)) {
    // Đổi tên: xóa tên cũ + dựng lại bằng tên mới.
    // add mang ngữ nghĩa "cộng dồn", chỉ khi tên mới chưa từng tồn tại ở tất cả các lá thì mới bằng "đặt thành giá trị đó";
    // nhưng khi đổi tên qua lại (A→B→A), A thường đã từng được add ở các lá sớm hơn, remove chỉ tác dụng lên tên cũ bị xóa lần này,
    // không chặn được việc cộng dồn vào A của lá sớm hơn —— sẽ chồng số lượng lên (3 đổi về lại thành 4).
    // Do đó bù thêm một lệnh update: thứ tự phát lại add→update, add tạo danh tính/mô tả/vị trí trước (cho dù cộng dồn nhầm),
    // update đặt số lượng "thành giá trị tuyệt đối", không liên quan vật phẩm bắt nguồn từ lá nào. Khi không đưa qty (để trống = không đếm) thì không gửi update.
    return appendOpToLatestLeaf({
      items: {
        remove: [oldName],
        add: [{ name: newName, qty, desc, carried, location }],
        ...(qty !== undefined ? { update: [{ name: newName, qty }] } : {}),
      },
    });
  }
  // Cùng tên: cập nhật số lượng / mô tả / vị trí (update là "đặt thành giá trị mới")
  return appendOpToLatestLeaf({ items: { update: [{ name: newName, qty, desc, carried, location }] } });
}

/* ============ Op thủ công NPC (ghi về lá mới nhất, cùng mô hình với editItem) ============ */

/** Thêm mới thủ công một NPC. Không có lá hợp lệ trả về false. */
export function upsertNpc(
  fields: NpcAffinity & {
    name: string;
    gender?: string;
    age?: string;
    relation?: string;
    ties?: string;
    title?: string;
    desc?: string;
    personality?: string;
    outfit?: string;
    condition?: string;
    important?: boolean;
    follow?: boolean;
    location?: string;
  },
): boolean {
  const name = fields.name.trim();
  if (!name) return false;
  return appendOpToLatestLeaf({
    npcs: {
      add: [{
        name,
        gender: fields.gender?.trim() || undefined,
        age: fields.age?.trim() || undefined,
        relation: fields.relation?.trim() || undefined,
        affinityInner: cleanNpcAffinityLevel(fields.affinityInner),
        affinityOuter: cleanNpcAffinityLevel(fields.affinityOuter),
        affinityNote: fields.affinityNote?.trim(),
        ties: fields.ties?.trim() || undefined,
        title: fields.title?.trim() || undefined,
        desc: fields.desc?.trim() || undefined,
        personality: fields.personality?.trim() || undefined,
        outfit: fields.outfit?.trim() || undefined,
        condition: fields.condition?.trim() || undefined,
        important: fields.important,
        follow: fields.follow,
        location: fields.location?.trim() || undefined,
      }],
    },
  });
}

/**
 * Chỉnh sửa thủ công một NPC (dữ liệu dẫn xuất, ghi về delta của lá mới nhất), cùng mô hình với editItem.
 *  - Đổi tên: id NPC xác định theo tên chuẩn hóa, đổi tên đồng nghĩa đổi id → remove(tên cũ) + add(tên mới, kèm toàn bộ trường).
 *  - Chỉ sửa trường: update (khớp theo tên gốc, đặt thành giá trị mới).
 * Đi cùng / nơi ở (follow/location): khi patch không đưa tường minh, kịch bản đổi tên sẽ kế thừa từ NPC cũ dẫn xuất (đổi tên không mất vị trí).
 * Không có lá hợp lệ trả về false.
 */
export function editNpc(
  oldName: string,
  patch: NpcAffinity & {
    name?: string;
    gender?: string;
    age?: string;
    relation?: string;
    ties?: string;
    title?: string;
    desc?: string;
    personality?: string;
    outfit?: string;
    condition?: string;
    important?: boolean;
    follow?: boolean;
    location?: string;
  },
): boolean {
  const newName = patch.name?.trim() || oldName;
  // Tầng hồ sơ cũng giữ lại chuỗi rỗng: người dùng xóa trống = xóa rõ ràng. Logic cũ rửa thành undefined, xóa trống lưu xong giá trị cũ vẫn nằm nguyên
  const gender = patch.gender?.trim();
  const relation = patch.relation?.trim();
  const ties = patch.ties?.trim();
  const title = patch.title?.trim();
  const desc = patch.desc?.trim();
  const personality = patch.personality?.trim();

  // Vị trí / tầng tức thời: patch đưa rõ ràng thì dùng của patch; nếu không kế thừa từ NPC cũ (đổi tên không mất nơi ở/đi cùng/trạng thái/tầm quan trọng).
  // location giữ lại chuỗi rỗng (người dùng xóa trống ô nhập = không rõ nơi ở), không thể bị rửa thành undefined như logic cũ làm không xóa được.
  const prev = memory.npcs.find(n => n.id === npcId(oldName));
  const follow = patch.follow !== undefined ? patch.follow : prev?.follow;
  const location = patch.location !== undefined ? patch.location.trim() : (prev?.location ?? '');
  // Tầng tức thời (outfit/condition) là ảnh chụp kiểu ghi đè: chuỗi rỗng = xóa trống rõ ràng, nhất quán với ngữ nghĩa patchText phía AI.
  // Logic cũ rửa chuỗi rỗng thành undefined, khi phát lại applyNpcState chỉ nhận string, thế là "xóa trống trạng thái / cởi bỏ trang phục" không bao giờ có hiệu lực.
  const outfit = patch.outfit !== undefined ? patch.outfit.trim() : prev?.outfit;
  const condition = patch.condition !== undefined ? patch.condition.trim() : prev?.condition;
  const important = patch.important !== undefined ? patch.important : prev?.important;

  // Tuổi tác: khi giá trị không đổi (hoặc không cung cấp) bắt buộc phải mang theo cả mốc neo cũ, nếu không khi phát lại sẽ làm mới nhầm mốc neo sang thời gian lá này (tương đương đóng băng tuổi);
  // chỉ khi người dùng thực sự sửa tuổi mới để trống ageTime, cho việc phát lại đóng dấu thời gian câu chuyện hiện tại làm mốc neo mới. Xóa trống thì giữ chuỗi rỗng, applyAge xóa luôn cả mốc neo.
  const age = patch.age !== undefined ? patch.age.trim() : prev?.age;
  const ageTime = age && age === prev?.age ? prev?.ageTime : undefined;

  // Đổi tên cũng giữ lại hai phía và giải thích; không truyền thì giữ nguyên, null/chuỗi rỗng tường minh có thể khôi phục chưa rõ / xóa trống giải thích.
  const affinity: NpcAffinity = {};
  if (prev && norm(newName) !== norm(oldName)) applyNpcAffinity(affinity, prev);
  applyNpcAffinity(affinity, patch);
  const fields = { gender, age, ageTime, relation, ties, title, desc, personality, outfit, condition, important, follow, location, ...affinity };
  if (norm(newName) !== norm(oldName)) {
    return appendOpToLatestLeaf({
      npcs: { remove: [oldName], add: [{ name: newName, ...fields }] },
      // Đổi tên đồng bộ quy thuộc, không sửa chính văn hay id ổn định; còn xóa bản thân nhân vật thì giữ lại hồ sơ đời sống lịch sử của họ.
      lifeDetails: { update: memory.lifeDetails
        .filter(d => lifeDetailSubject(d) !== 'user' && norm(lifeDetailSubject(d)) === norm(oldName))
        .map(d => ({ id: d.id, subject: newName })) },
      // Danh sách hiểu biết cũng tương tự: gắn trên người nhân vật theo tên, đổi tên không đi theo sẽ thành mồ côi
      knowledge: knowledgeOf(memory.knowledge, oldName).map(k => ({ op: 'update' as const, id: k.id, subject: newName })),
    });
  }
  return appendOpToLatestLeaf({ npcs: { update: [{ name: newName, ...fields }] } });
}

/**
 * Chuyển đổi trạng thái đi cùng của một NPC (đồng hành / bỏ đồng hành).
 *  - follow=true: đánh dấu đi cùng (applyNpcPlacement sẽ xóa location).
 *  - follow=false: bỏ đi cùng; có thể tùy chọn truyền vào location chỉ định "ở lại đâu", không truyền thì giữ nguyên nơi ở cũ.
 */
export function setNpcFollow(name: string, follow: boolean, location?: string): boolean {
  const nm = name.trim();
  if (!nm) return false;
  const loc = follow ? undefined : (location?.trim() || undefined);
  return appendOpToLatestLeaf({ npcs: { update: [{ name: nm, follow, location: loc }] } });
}

/** Chuyển đổi nhãn "Nhân vật chính yếu" của một NPC (nâng / hạ tầm quan trọng); cùng mô hình với setNpcFollow, ghi về lá mới nhất. */
export function setNpcImportant(name: string, important: boolean): boolean {
  const nm = name.trim();
  if (!nm) return false;
  return appendOpToLatestLeaf({ npcs: { update: [{ name: nm, important }] } });
}

/** Xóa thủ công một NPC (rút lui khỏi truyện). */
export function removeNpc(name: string): boolean {
  const nm = name.trim();
  if (!nm) return false;
  return appendOpToLatestLeaf({ npcs: { remove: [nm] } });
}

/* ============ Op thủ công bối cảnh (ghi về lá mới nhất, cùng mô hình với editItem) ============ */

/** Thêm mới / bổ sung thủ công một địa điểm (đường dẫn địa lý từng cấp). Không có lá hợp lệ trả về false. */
export function upsertScene(path: string[], desc?: string): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { ops: [{ op: 'add', path: clean, desc: desc?.trim() || undefined }] } });
}

/** Cập nhật thủ công mô tả của một địa điểm (ghi đè; chuỗi rỗng = xóa mô tả, giữ lại nút). */
export function editSceneDesc(path: string[], desc: string): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { ops: [{ op: 'update', path: clean, desc: desc.trim() }] } });
}

/**
 * Đổi tên một địa điểm (sửa kèm cả cây con). Đổi tên = đổi tên đoạn cuối dưới cùng một cha = một trường hợp của reparent:
 * newPath giữ nguyên cấp trên cũ, chỉ đổi đoạn cuối, reparentScenePath sẽ dịch chuyển toàn bộ cây con sang dưới tên mới, không mất nút con.
 * Tên không đổi thì chỉ cập nhật mô tả (nếu có đưa).
 */
export function renameScene(oldPath: string[], newName: string, desc?: string): boolean {
  const clean = normScenePath(oldPath);
  const nm = newName.trim();
  if (!clean.length || !nm) return false;
  if (norm(nm) === norm(clean[clean.length - 1])) {
    return desc !== undefined ? editSceneDesc(clean, desc) : false; // Tên không đổi, chỉ sửa mô tả
  }
  const newPath = [...clean.slice(0, -1), nm];
  const descs = desc?.trim() ? { [nm]: desc.trim() } : undefined;
  return appendOpToLatestLeaf({ scenes: { ops: [{ op: 'reparent', node: clean, newPath, descs }] } });
}

/**
 * Đặt lại cấp cha / đổi tên / chèn tầng thủ công (dịch chuyển cả cây con), biểu đạt bằng một lệnh reparent.
 *  - newPath: đường dẫn đầy đủ mục tiêu (đoạn cuối có thể khác tên gốc = tiện tay đổi tên; tiền tố chính là cấp trên mới, tiền tố rỗng = cấp cao nhất).
 *  - descs: mô tả của từng cấp trên newPath (khóa = tên địa danh cấp đó), dùng để tạo bù cấp cha + cập nhật mô tả của chính nút bị di chuyển;
 *    nút bị di chuyển đưa chuỗi rỗng = xóa mô tả gốc của nó.
 * Tái sử dụng cùng một bộ logic phát lại reparent với AI.
 */
export function reparentScene(nodePath: string[], newPath: string[], descs?: Record<string, string>): boolean {
  const node = normScenePath(nodePath);
  const to = normScenePath(newPath);
  if (!node.length || !to.length) return false;
  if (sceneId(to) === sceneId(node)) return false; // Đường dẫn không đổi
  const ops: SceneOp[] = [{ op: 'reparent', node, newPath: to, descs }];
  // reparent chỉ nhận mô tả khác rỗng; việc xóa thì nối sát một lệnh update ngay trong cùng đợt, ghi xong một lần, không xảy ra chuyện cây đã chuyển mà mô tả chưa xóa được
  const own = descs?.[to[to.length - 1]];
  if (own !== undefined && !own.trim() && memory.scenes.find(s => s.id === sceneId(node))?.desc) {
    ops.push({ op: 'update', path: to, desc: '' });
  }
  return appendOpToLatestLeaf({ scenes: { ops } });
}

/** Xóa thủ công một địa điểm (kèm theo hậu duệ của nó). */
export function removeScene(path: string[]): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { ops: [{ op: 'remove', path: clean }] } });
}

/** Xóa lá trên một tin nhắn (xóa extra), sau đó xóa dây chuyền chuỗi hỏng + tính lại + lưu đĩa */
export function deleteLeafAt(index: number): boolean {
  const chat = getContext()?.chat;
  if (!chat || !chat[index]?.extra?.bbs_leaf) return false;
  delete (chat[index].extra as Record<string, unknown>).bbs_leaf;
  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  invalidateRecallCache(); // Lá mất rồi → truy xuất không nên trúng kết quả cũ có chứa nó nữa
  scheduleVectorIndex(); // Lá mất rồi → đối chiếu xóa vector của nó đi, tránh việc tiếp tục bị truy xuất
  return true;
}

/**
 * Chỉnh sửa thủ công lá trên một tin nhắn: chính văn tóm tắt + thời gian bắt đầu và kết thúc trong truyện.
 * Trường tóm tắt không phải là tiêu chuẩn phán đoán của leafValid, sau khi chỉnh sửa lá vẫn hợp lệ.
 * timeEnd ghi đồng bộ vào delta.time (trạng thái hiện tại kiểu ghi đè, phát lại là có hiệu lực ngay); sau khi chỉnh sửa thì xóa timeLabel cũ (đã được thay thế bởi bắt đầu-kết thúc).
 */
export function editLeafAt(index: number, text: string, timeStart: string, timeEnd: string): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf) return false;
  leaf.text = text.trim();
  const s = timeStart.trim();
  const e = timeEnd.trim();
  leaf.timeStart = s || undefined;
  leaf.timeEnd = e || undefined;
  leaf.timeLabel = undefined; // Bắt đầu-kết thúc đã là thẩm quyền, chuỗi gộp cũ hủy bỏ
  leaf.delta = leaf.delta ?? {};
  // Thời gian hiện tại kiểu ghi đè lấy thời gian kết thúc; cả hai đầu đều trống mới xóa
  if (e) leaf.delta.time = e;
  else if (s) leaf.delta.time = s;
  else delete leaf.delta.time;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  recomputeDerived();
  scheduleLeafFlush();
  invalidateRecallCache(); // Tóm tắt thay đổi → kết quả truy xuất sẽ đổi, vô hiệu hóa trước rồi tính lại sau
  scheduleVectorIndex(); // Chính văn thay đổi → docHash đổi, chống rung embed lại, truy xuất kịp thời dùng nội dung mới
  return true;
}

/**
 * Chuyên dùng cho bảng trong tầng: chỉnh sửa tổng thể lá của một tầng (chính văn tóm tắt + thời gian bắt đầu-kết thúc + delta có cấu trúc).
 * Khác biệt với editLeafAt: thay thế luôn cả delta, phát lại một lần. Phục vụ việc "sửa trường then chốt / xóa mục" của bảng trong tầng.
 * delta do bên gọi sửa xong trên bản sao rồi truyền tổng thể vào (chỉ sửa giá trị mục hiện có / xóa mục, không liên quan logic triệt tiêu xuyên nhóm, nên thay thế trực tiếp là được).
 * Xử lý thời gian nhất quán với editLeafAt: timeEnd (thiếu thì lấy timeStart) ghi đè vào delta.time; cả hai đầu đều trống thì xóa.
 */
export function editLeafFull(
  index: number,
  patch: { text: string; timeStart: string; timeEnd: string; delta: StoredDelta },
): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf) return false;
  leaf.text = patch.text.trim();
  const s = patch.timeStart.trim();
  const e = patch.timeEnd.trim();
  leaf.timeStart = s || undefined;
  leaf.timeEnd = e || undefined;
  leaf.timeLabel = undefined; // Bắt đầu-kết thúc đã là thẩm quyền, chuỗi gộp cũ hủy bỏ
  const delta: StoredDelta = { ...patch.delta };
  // Thời gian hiện tại kiểu ghi đè lấy thời gian kết thúc; cả hai đầu đều trống mới xóa (cùng tiêu chuẩn với editLeafAt)
  if (e) delta.time = e;
  else if (s) delta.time = s;
  else delete delta.time;
  leaf.delta = delta;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  // Chỉnh sửa đã làm đổi delta → viết lại đồng bộ chú thích <bbs_items>/<bbs_vars> trong chính văn tầng đó (nếu không chú thích sẽ dừng ở giá trị cũ của lần tóm tắt trước),
  // cùng tiêu chuẩn với lúc applyLeafForFloor hạ cánh lá: biến động ròng của vật phẩm lấy "trạng thái trước tầng này" làm chuẩn để tính from→to, biến số kết xuất trực tiếp câu lệnh.
  rewriteFloorTags(chat, index, delta);
  recomputeDerived();
  scheduleLeafFlush();
  invalidateRecallCache(); // Chính văn / thời gian tóm tắt đã đổi → vô hiệu hóa truy xuất cũ
  scheduleVectorIndex(); // Chính văn đã đổi → docHash đổi, chống rung embed lại
  return true;
}

/**
 * Dùng delta hiện tại của lá để viết lại chú thích <bbs_items>/<bbs_vars> trong chính văn tầng đó (phục vụ đồng bộ chính văn sau khi chỉnh sửa trong tầng).
 * Trạng thái vật phẩm làm chuẩn = trước tầng này (deriveMemory đến index, không gồm tầng này), nhất quán với lúc tóm tắt hạ cánh lá.
 */
function rewriteFloorTags(chat: STMessage[], index: number, delta: StoredDelta): void {
  if (apiSettings.summaryOnlyMode) return;

  const leaf = getLeaf(chat[index]);
  const time = optText(leaf?.timeEnd) || optText(leaf?.timeStart) || '';
  const priorItems = deriveMemory(chat, index).items;
  let mes = writeItemLogTag(chat[index].mes, fmtItemLogInline(itemChangesOf(delta, priorItems, time)));
  mes = writeVarLogTag(mes, fmtVarOpsInline(delta.varOps));
  setMessageText(chat[index], mes);
}

/**
 * Chỉnh sửa một kế hoạch / nghi vấn: sửa content / createdTime / targetTime.
 * ID kế hoạch = `plan:${id lá}#${số thứ tự trong mảng add tại lá đó}`, dựa vào đó định vị tới delta.plans.add[idx] của lá đã tạo ra nó.
 * Chỉ sửa delta của lá, lá vẫn hợp lệ; sửa xong tính lại dữ liệu dẫn xuất + lưu đĩa.
 */
export function editPlan(
  planIdStr: string,
  patch: { content?: string; createdTime?: string; targetTime?: string },
): boolean {
  const m = planIdStr.match(/^plan:(.+)#(\d+)$/);
  if (!m) return false;
  const leafId = m[1];
  const addIdx = Number(m[2]);
  const chat = getContext()?.chat;
  if (!chat) return false;

  // Tìm lá hợp lệ có id khớp
  let index = -1;
  for (let i = 0; i < chat.length; i++) {
    const lf = getLeaf(chat[i]);
    if (lf && lf.id === leafId && leafValid(chat[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  const leaf = getLeaf(chat[index])!;
  const add = leaf.delta?.plans?.add?.[addIdx];
  if (!add) return false;

  if (typeof patch.content === 'string') add.content = patch.content.trim();
  if (patch.createdTime !== undefined) add.createdTime = patch.createdTime.trim() || undefined;
  if (patch.targetTime !== undefined) add.targetTime = patch.targetTime.trim() || undefined;

  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  recomputeDerived();
  // Khi phát lại plans.update của AI ở các tầng sau sẽ đè mất việc sửa tại chỗ; khi thực sự bị đè mất mới nối thêm một lệnh update ở lá mới nhất để đỡ hộ
  const cur = memory.plans.find(p => p.id === planIdStr);
  const update: PlanUpdateItem = { id: planIdStr };
  if (cur && add.content && cur.content !== add.content) update.content = add.content;
  if (cur && patch.targetTime !== undefined && (cur.targetTime ?? '') !== (add.targetTime ?? '')) update.targetTime = add.targetTime ?? '';
  if ((update.content !== undefined || update.targetTime !== undefined) && appendOpToLatestLeaf({ plans: { update: [update] } })) return true;
  scheduleLeafFlush();
  return true;
}

/**
 * Chỉnh sửa chính văn của một nút nén (tổng kết). Tổng kết chỉ nén văn bản, không chứa dữ liệu có cấu trúc,
 * nên chỉ cần sửa trường text là được, không cần recompute.
 */
export function editSummary(id: string, text: string): boolean {
  const comp = memory.summaries.find(s => s.id === id);
  if (!comp) return false;
  comp.text = text.trim();
  saveMemory();
  return true;
}

/* ============ Xóa / Mở niêm phong ============ */

/**
 * Xóa một nút nén.
 *  - Gỡ bỏ id này khỏi childIds của tất cả các nút cha;
 *  - Xóa nút này khỏi mảng. Các nút con của nó vì đứt tham chiếu cha sẽ tự động biến lại thành "gốc rời".
 * Lưu ý: xóa nút nén không ảnh hưởng dữ liệu có cấu trúc (chỉ nén văn bản), không cần recompute, nhưng phải làm mới phần tiêm.
 */
export function deleteSummary(id: string): boolean {
  const idx = memory.summaries.findIndex(s => s.id === id);
  if (idx < 0) return false;
  for (const p of memory.summaries) {
    if (p.childIds.includes(id)) p.childIds = p.childIds.filter(c => c !== id);
  }
  memory.summaries.splice(idx, 1);
  saveMemory();
  return true;
}

export interface DeleteSummarySubtreesResult {
  /** Số lượng tóm tắt lá từng tầng thực tế đã xóa. */
  leaves: number;
  /** Số lượng nút tổng kết thực tế đã xóa (bao gồm cả các tổ tiên mất hiệu lực theo vì nút con biến mất). */
  summaries: number;
  /** Số lượng lịch sử nhập vào bị xóa; khi lớn hơn 0 bên gọi cần đồng bộ trạng thái ẩn chính văn. */
  imported: number;
}

/**
 * Xóa hàng loạt một số cây con trong rừng.
 *
 * Chế độ chọn nhiều ở trang tóm tắt chỉ hiển thị "các nút gốc đại diện cho một đoạn lịch sử"; nếu gốc là tổng kết, chỉ xóa bản thân gốc sẽ làm các tóm tắt tầng dưới
 * bung ra trở lại, không thể thực hiện được việc "Chọn tất cả → Xóa sạch một lần". Do đó xóa hàng loạt coi mỗi nút được chọn cùng toàn bộ hậu duệ của nó
 * là một phạm vi xóa: nút nén gỡ khỏi metadata, lá gỡ khỏi extra của tin nhắn tương ứng.
 *
 * Giống như deleteLeafAt, sau khi xóa lá sẽ tính lại trạng thái có cấu trúc theo các lá còn lại, dọn dẹp tổ tiên mất hiệu lực và chống rung lưu đĩa.
 */
export function deleteSummarySubtrees(rootIds: string[]): DeleteSummarySubtreesResult {
  const roots = new Set(rootIds.filter(Boolean));
  if (!roots.size) return { leaves: 0, summaries: 0, imported: 0 };

  const summariesById = new Map(memory.summaries.map(summary => [summary.id, summary]));
  const summaryIds = new Set<string>();
  const leafIds = new Set<string>();
  const visited = new Set<string>();
  let imported = 0;

  const collect = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const summary = summariesById.get(id);
    if (!summary) {
      leafIds.add(id);
      return;
    }
    summaryIds.add(id);
    if (summary.imported) {
      imported++;
      return;
    }
    for (const childId of summary.childIds) collect(childId);
  };
  for (const id of roots) collect(id);

  const chat = getContext()?.chat;
  let leaves = 0;
  if (chat && leafIds.size) {
    for (const message of chat) {
      const leaf = getLeaf(message);
      if (!leaf || !leafIds.has(leaf.id)) continue;
      delete (message.extra as Record<string, unknown>).bbs_leaf;
      leaves++;
    }
  }

  const summariesBefore = memory.summaries.length;
  if (summaryIds.size) {
    memory.summaries = memory.summaries.filter(summary => !summaryIds.has(summary.id));
  }
  if (leaves > 0) recomputeDerived();
  // Các nút được chọn thường là gốc; ở đây vẫn dọn dẹp các tổ tiên tiềm ẩn mất hiệu lực, tương thích với trường hợp khung nhìn bị hạ cấp do chuỗi hỏng nên chọn trúng nút con.
  pruneBrokenComps();
  const summaries = summariesBefore - memory.summaries.length;

  if (summaries > 0) saveMemory();
  if (leaves > 0) scheduleLeafFlush();
  if (leaves > 0) invalidateRecallCache(); // Lá bị xóa → vô hiệu hóa bộ nhớ đệm truy xuất
  if (leaves > 0) scheduleVectorIndex();
  return { leaves, summaries, imported };
}

/**
 * Xóa đệ quy toàn bộ các nút nén tổ tiên có chứa một nút con nào đó.
 *
 * Khi lá được tạo lại sẽ giữ nguyên id gốc, do đó pruneBrokenComps không thể nhận biết văn bản tổng kết tầng trên đã lỗi thời.
 * Ở đây tìm ngược từ childId lên các nút cha và gỡ bỏ toàn bộ chuỗi tổ tiên; lá chưa được bất kỳ tổng kết nào thu nạp sẽ không gây ra thay đổi.
 */
export function invalidateSummaryAncestors(childId: string): number {
  if (!childId) return 0;
  const affected = new Set<string>([childId]);
  let found = true;
  while (found) {
    found = false;
    for (const summary of memory.summaries) {
      if (affected.has(summary.id)) continue;
      if (summary.childIds.some(id => affected.has(id))) {
        affected.add(summary.id);
        found = true;
      }
    }
  }

  const before = memory.summaries.length;
  memory.summaries = memory.summaries.filter(summary => !affected.has(summary.id));
  const removed = before - memory.summaries.length;
  if (removed > 0) saveMemory();
  return removed;
}

/**
 * Xóa trọn chuỗi tổ tiên: khi một id lá không còn hợp lệ (bị xóa / lỗi thời / đổi id mới), phàm là nút nén có chứa nó (theo đệ quy) đều xóa hết.
 * Phán đoán: một nút nén "nguyên vẹn" ⟺ mỗi child của nó hoặc là id lá hợp lệ đang tồn tại, hoặc là nút nén nguyên vẹn;
 * nếu không thì là "hỏng", xóa bỏ. DFS có ghi nhớ (memoized). Sau khi xóa thì saveMemory (nếu có thay đổi).
 *
 * ⚠️ Ở đây dùng leafIntact thay vì leafValid: lá "còn sống" chỉ xét sự tồn tại vật lý (id+delta), **không xét quyền sở hữu số trang**.
 * Khi lật sang swipe chưa tóm tắt, lá đã được nén vào L1 tuy có leafValid=false đối với trang hiện tại, nhưng nó vẫn tồn tại vật lý ở
 * trong extra của trang riêng nó (lật quay lại là hiển thị) —— tuyệt đối không được vì "hiện tại không ở trang này" mà xóa mất chuỗi nén chứa nó.
 */
export function pruneBrokenComps(): boolean {
  const chat = getContext()?.chat ?? null;
  const liveLeafIds = new Set<string>();
  if (chat) {
    for (const m of chat) {
      if (leafIntact(m)) liveLeafIds.add(getLeaf(m)!.id);
    }
  }
  const byId = new Map(memory.summaries.map(s => [s.id, s]));
  const verdict = new Map<string, boolean>(); // id -> intact

  const isIntact = (id: string, stack: Set<string>): boolean => {
    if (verdict.has(id)) return verdict.get(id)!;
    const comp = byId.get(id);
    if (!comp) return liveLeafIds.has(id); // Không phải nút nén: xem có phải lá hợp lệ đang tồn tại hay không
    if (comp.imported) return true; // Lịch sử nhập vào là nút nguyên tử không có child, phạm vi tầng lầu trực tiếp đại diện cho tính nguyên vẹn của nó
    if (stack.has(id)) return false; // Chống vòng lặp
    stack.add(id);
    let ok = comp.childIds.length > 0;
    for (const c of comp.childIds) {
      if (!isIntact(c, stack)) {
        ok = false;
        break;
      }
    }
    stack.delete(id);
    verdict.set(id, ok);
    return ok;
  };

  const before = memory.summaries.length;
  memory.summaries = memory.summaries.filter(s => isIntact(s.id, new Set()));
  const changed = memory.summaries.length !== before;
  if (changed) saveMemory();
  return changed;
}

/** Hỗ trợ kiểm thử: đặt lại chuỗi id */
export function __resetIdSeq(): void {
  idSeq = 0;
}
