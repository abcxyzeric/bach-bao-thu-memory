/**
 * Tạo cuộc trò chuyện mới kèm dữ liệu (Carryover).
 *
 * Đem cuộc trò chuyện hiện tại (một loạt tầng lịch sử + cửa sổ toàn văn gần đây) → tạo mới một cuộc trò chuyện, mang sang:
 *  - Tóm tắt lịch sử gộp (cốt truyện trước cửa sổ, chọn tầng nén còn sống cao nhất ghép lại) = text của lá hạt giống;
 *  - Trạng thái có cấu trúc hiện tại (items/plans tính đến điểm đầu cửa sổ) → mã hóa thành delta "add toàn bộ" = delta của lá hạt giống;
 *  - Các tầng trong cửa sổ giữ lại gần đây (nguyên văn toàn bộ + lá riêng của từng tầng) chuyển sang.
 *
 * Cuộc trò chuyện mới dựa vào đường ống phát lại sẵn có (deriveMemory: khởi đầu trống rồi gấp từng lá) để khôi phục trạng thái —— không cần vật mang đặc biệt,
 * chỉ cần tạo một "lá hạt giống" mã hóa trạng thái thành add toàn bộ gắn ở #0, và đặt thêm một tổng kết L2 thu nạp nó (mang văn bản tóm tắt gộp).
 *
 * Đồng thời (nếu bật trí nhớ vector): chụp nhanh vector của cuộc trò chuyện nguồn thành một bundle, ghi mã băm vào metadata.bbs_bundles của cuộc trò chuyện mới (tích lũy),
 * giúp cuộc trò chuyện mới có thể truy xuất vector cốt truyện cũ của cuộc trò chuyện nguồn.
 */

import { getContext, getDoNewChat, setMessageText, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { apiSettings } from '@/api/settings';
import { deriveMemory, makeLeafId, planId } from './apply';
import { resolveKeepStart } from './engine';
import { knowledgeId } from './knowledge';
import { refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { latestStoryTime } from './timeTag';
import { memory, recomputeDerived, saveMemory, flushLeavesNow } from './store';
import type { JsonValue, LeafExtra, MemSummary, StoredDelta } from './types';
import { isBaiBaoKuAvailable, vecBundleCreate } from '@/api/baibaoku';
import { appendBundleHash, BUNDLES_META_KEY, currentBundleHashes, currentVectorDb } from './vector/scope';

/** Kế hoạch mang theo: phục vụ UI xem trước "sẽ mang theo bao nhiêu". */
export interface CarryoverPlan {
  /** Điểm đầu cửa sổ giữ lại (các tầng từ chỉ mục này trở đi sẽ chuyển sang cuộc trò chuyện mới) */
  carryStart: number;
  /** Số lượng tin nhắn thực tế cần chuyển (các tầng phi hệ thống trong cửa sổ) */
  carryCount: number;
  /** Trong đó số lượng tầng AI */
  aiCount: number;
  /** Số ký tự tóm tắt lịch sử gộp (0 = không có lịch sử để tóm) */
  recapLen: number;
  /** Hiện tại có dữ liệu mang theo được hay không */
  hasData: boolean;
}

function cloneJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortJson(v);
    }
    return out;
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

function deltaHasData(delta: StoredDelta): boolean {
  return !!(
    delta.time ||
    delta.location ||
    delta.locationPath?.length ||
    delta.sceneFocus ||
    delta.lifeDetails?.add?.length ||
    delta.lifeDetails?.update?.length ||
    delta.lifeDetails?.archive?.length ||
    delta.lifeDetails?.remove?.length ||
    delta.knowledge?.length ||
    (delta.protagonist && Object.keys(delta.protagonist).length) ||
    delta.items?.add?.length ||
    delta.items?.update?.length ||
    delta.items?.remove?.length ||
    delta.scenes?.add?.length ||
    delta.scenes?.update?.length ||
    delta.scenes?.reparent?.length ||
    delta.scenes?.remove?.length ||
    delta.scenes?.ops?.length ||
    delta.npcs?.add?.length ||
    delta.npcs?.update?.length ||
    delta.npcs?.remove?.length ||
    delta.plans?.add?.length ||
    delta.plans?.resolve?.length ||
    delta.plans?.remove?.length ||
    delta.plans?.reopen?.length ||
    delta.varOps?.length
  );
}

/** Mã hóa "trạng thái dẫn xuất tính đến điểm đầu cửa sổ" thành StoredDelta add toàn bộ (delta của lá hạt giống).
 *  leafId: id của lá hạt giống (id ổn định của chi tiết đời sống dẫn xuất từ nó, cần tạo trước). */
function encodeStateAsDelta(state: ReturnType<typeof deriveMemory>, leafId: string): StoredDelta {
  const delta: StoredDelta = {};
  if (state.state.time) delta.time = state.state.time;
  if (state.state.location) {
    delta.location = state.state.location;
    if (state.state.locationPath?.length) delta.locationPath = state.state.locationPath;
  }
  if (Object.values(state.protagonist).some(Boolean)) {
    delta.protagonist = { ...state.protagonist };
  }
  // Thẻ cục diện: mang theo cả ảnh chụp cảnh tượng hiện tại (cuộc trò chuyện mới diễn tiếp từ cùng một cục diện)
  if (state.state.sceneFocus) {
    delta.sceneFocus = { ...state.state.sceneFocus, participants: [...state.state.sceneFocus.participants] };
  }
  // Hồ sơ nhỏ đời sống: mang theo toàn bộ (gồm cả tầng lắng đọng —— thứ mang đi là bản thân hồ sơ, tầng phân phối tiếp tục hoạt động theo tier)
  if (state.lifeDetails.length) {
    delta.lifeDetails = {
      add: state.lifeDetails.map(d => ({
        subject: d.subject,
        text: d.text,
        topics: [...d.topics],
        anchors: [...d.anchors],
        until: d.until,
      })),
      // Các cấp không phải active dùng update để khôi phục (pinned/archive trong hạt giống hạ cánh dưới dạng active trước, sau đó gạt lại từng mục)
      update: state.lifeDetails
        .map((d, i) => ({ id: `detail:${leafId}#${i}`, tier: d.tier }))
        .filter(u => u.tier !== 'active'),
    };
  }
  // Danh sách hiểu biết: mang theo toàn bộ, mục thứ i hạ cánh thành know:lá hạt giống#i (cùng thứ tự với knowledgeIds bên dưới)
  if (state.knowledge.length) {
    delta.knowledge = state.knowledge.map(k => ({ op: 'add' as const, subject: k.subject, text: k.text }));
  }

  if (state.items.length) {
    delta.items = {
      add: state.items.map(i => ({
        name: i.name,
        qty: i.qty,
        desc: i.desc,
        carried: i.carried,
        location: i.location,
      })),
    };
  }
  if (state.scenes.length) {
    delta.scenes = {
      add: [...state.scenes]
        .sort((a, b) => a.path.length - b.path.length || a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map(s => ({
          path: [...s.path],
          desc: s.desc,
        })),
    };
  }
  if (state.npcs.length) {
    delta.npcs = {
      add: state.npcs.map(n => ({
        name: n.name,
        gender: n.gender,
        // Tuổi tác mang đi cùng mốc neo gốc: nếu không mang ageTime, khi phát lại lá hạt giống sẽ quét mốc neo thành ngày tạo cuộc trò chuyện mới, suy tính tuổi sai hết
        age: n.age,
        ageTime: n.ageTime,
        relation: n.relation,
        affinityInner: n.affinityInner,
        affinityOuter: n.affinityOuter,
        affinityNote: n.affinityNote,
        ties: n.ties,
        title: n.title,
        desc: n.desc,
        personality: n.personality,
        outfit: n.outfit,
        condition: n.condition,
        important: n.important,
        follow: n.follow,
        location: n.location,
      })),
    };
  }
  const openPlans = state.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    delta.plans = {
      add: openPlans.map(p => ({
        kind: p.kind,
        content: p.content,
        createdTime: p.createdTime,
        targetTime: p.targetTime,
      })),
    };
  }
  const initialVars = deriveMemory(null).vars;
  if (!sameJson(state.vars, initialVars)) {
    delta.varOps = [{ op: 'set', path: '', value: cloneJsonRecord(state.vars) }];
  }
  return delta;
}

/** Sao chép sâu một tin nhắn cần chuyển đi, bỏ ẩn, giữ lại lá. (export phục vụ kiểm thử) */
export function sanitizeCarryMessage(
  m: STMessage,
  detailIds: ReadonlyMap<string, string>,
  planIds: ReadonlyMap<string, string>,
  knowledgeIds: ReadonlyMap<string, string> = new Map(),
): STMessage {
  const clone: STMessage = JSON.parse(JSON.stringify(m));
  clone.is_system = false;
  if (clone.extra && 'bbs_hidden' in clone.extra) {
    const { bbs_hidden: _h, ...rest } = clone.extra;
    clone.extra = rest;
  }
  // Các mục đời sống trước cửa sổ đã đổi sang gắn ở lá hạt giống: đồng bộ tham chiếu trong cửa sổ, nếu không việc đính chính quy thuộc / sửa / lắng đọng / xóa sẽ mất hiệu lực.
  const life = clone.extra?.bbs_leaf?.delta.lifeDetails;
  if (life) {
    for (const update of life.update ?? []) update.id = detailIds.get(update.id) ?? update.id;
    for (const key of ['archive', 'remove'] as const) {
      if (life[key]) life[key] = life[key].map(id => detailIds.get(id) ?? id);
    }
  }
  // Kế hoạch chưa khép lại cũng đổi sang gắn ở lá hạt giống, tương tự đồng bộ các tham chiếu khép lại / cập nhật / mở lại / xóa trong cửa sổ.
  const plans = clone.extra?.bbs_leaf?.delta.plans;
  if (plans) {
    const remap = (id: string) => planIds.get(id) ?? id;
    if (plans.resolve) plans.resolve = plans.resolve.map(r => typeof r === 'string' ? remap(r) : { ...r, id: remap(r.id) });
    for (const update of plans.update ?? []) update.id = remap(update.id);
    for (const key of ['reopen', 'remove'] as const) {
      if (plans[key]) plans[key] = plans[key].map(remap);
    }
  }
  // Mục hiểu biết cũng đổi sang gắn ở lá hạt giống: tham chiếu sửa / xóa trong cửa sổ đổi id theo
  for (const op of clone.extra?.bbs_leaf?.delta.knowledge ?? []) {
    if (op.op !== 'add') op.id = knowledgeIds.get(op.id) ?? op.id;
  }
  return clone;
}

/** Tính toán kế hoạch mang theo (không gây tác dụng phụ), phục vụ UI xem trước. */
export function computeCarryoverPlan(): CarryoverPlan {
  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const carryStart = resolveKeepStart(chat);

  let carryCount = 0;
  let aiCount = 0;
  for (let i = carryStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    // Tầng hệ thống gốc của ST (có type) không chuyển; tầng thực (gồm cả tầng bị ẩn) thì chuyển
    if (m.is_system && m.extra?.type) continue;
    carryCount++;
    if (!m.is_user) aiCount++;
  }

  const recap = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, carryStart));
  const seedDelta = encodeStateAsDelta(deriveMemory(chat, carryStart), 'preview');
  return {
    carryStart,
    carryCount,
    aiCount,
    recapLen: recap.length,
    hasData: chat.length > 0 && (carryCount > 0 || recap.length > 0 || deltaHasData(seedDelta)),
  };
}

/**
 * Thực thi tạo cuộc trò chuyện mới kèm dữ liệu. Trả về có thành công hay không.
 * Toàn trình try/catch: thất bại thì hiện toast và cố gắng không làm hỏng cuộc trò chuyện hiện tại (trước doNewChat chỉ đọc không ghi vào nguồn).
 */
export async function createNewChatWithCarryover(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('Ngữ cảnh SillyTavern không khả dụng', 'error');
    return false;
  }
  if (ctx.groupId) {
    toast('Trò chuyện nhóm tạm thời chưa hỗ trợ tạo cuộc trò chuyện mới kèm dữ liệu', 'warning');
    return false;
  }
  const sourceChat = ctx.chat ?? [];
  if (!sourceChat.length) {
    toast('Cuộc trò chuyện hiện tại không có dữ liệu có thể mang theo', 'warning');
    return false;
  }

  const doNewChat = await getDoNewChat();
  if (!doNewChat) {
    toast('Không thể tạo cuộc trò chuyện mới (giao diện ST không khả dụng)', 'error');
    return false;
  }

  // ===== 1. Trước khi tạo cuộc trò chuyện mới, trích xuất mọi thứ cần mang theo từ cuộc trò chuyện nguồn (chỉ đọc) =====
  const carryStart = resolveKeepStart(sourceChat);
  const sourceChatId = ctx.getCurrentChatId?.() ?? null;
  const parentBundles = currentBundleHashes(); // Mã băm bundle đã mang theo của cuộc trò chuyện nguồn (sẽ kế thừa cho cuộc trò chuyện mới)

  // Trạng thái dẫn xuất tính đến điểm đầu cửa sổ → delta lá hạt giống (lá riêng của các tầng trong cửa sổ sẽ tiếp tục cộng dồn, nên cắt đến trước cửa sổ để tránh trùng lặp)
  const stateBefore = deriveMemory(sourceChat, carryStart);
  // Tạo id lá hạt giống trước: id ổn định của chi tiết đời sống dẫn xuất từ "id lá#số thứ tự", ngay lúc mã hóa delta đã phải dùng
  const seedLeafId = makeLeafId();
  const seedDelta = encodeStateAsDelta(stateBefore, seedLeafId);
  const detailIds = new Map(stateBefore.lifeDetails.map((d, i) => [d.id, `detail:${seedLeafId}#${i}`]));
  // Cùng thứ tự với plans.add của encodeStateAsDelta: kế hoạch chưa khép lại thứ i → mục thứ i của lá hạt giống
  const planIds = new Map(stateBefore.plans.filter(p => p.status === 'open').map((p, i) => [p.id, planId(seedLeafId, i)]));
  const knowledgeIds = new Map(stateBefore.knowledge.map((k, i) => [k.id, knowledgeId(seedLeafId, i)]));

  // Tóm tắt lịch sử gộp (cốt truyện trước cửa sổ) = text lá hạt giống
  const mergedSummary = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, sourceChat, carryStart));

  // Mốc thời gian của lá hạt giống: thời gian trạng thái trước điểm cắt cửa sổ (không có thì lấy thời gian mới nhất của câu chuyện)
  const seedTime = stateBefore.state.time || latestStoryTime(sourceChat) || '';

  // Các tầng cửa sổ được chuyển đi (sao chép sâu, bỏ ẩn, giữ lại lá)
  const carryMessages: STMessage[] = [];
  for (let i = carryStart; i < sourceChat.length; i++) {
    const m = sourceChat[i];
    if (!m) continue;
    if (m.is_system && m.extra?.type) continue; // Không chuyển tầng hệ thống gốc
    carryMessages.push(sanitizeCarryMessage(m, detailIds, planIds, knowledgeIds));
  }

  if (!mergedSummary && !carryMessages.length && !deltaHasData(seedDelta)) {
    toast('Cuộc trò chuyện hiện tại không có dữ liệu có thể mang theo', 'warning');
    return false;
  }

  // ===== 2. Tạo bundle lấy mã băm trước (khi bật trí nhớ vector + cuộc trò chuyện nguồn có id); thất bại chỉ cảnh báo, không chặn việc tạo cuộc trò chuyện =====
  let newBundleHash: string | null = null;
  const vecDb = currentVectorDb();
  if (apiSettings.vector.enabled && vecDb && sourceChatId) {
    try {
      if (await isBaiBaoKuAvailable()) {
        const { hash } = await vecBundleCreate(vecDb, sourceChatId);
        newBundleHash = hash;
      }
    } catch (e) {
      console.warn('[Vector Bách Bảo Thư] Tạo bundle thất bại (cuộc trò chuyện mới sẽ không mang theo truy xuất vector nguồn):', e);
    }
  }

  // ===== 3. Tạo cuộc trò chuyện mới và chuyển vào =====
  try {
    await ctx.saveChat();
    await doNewChat({ deleteCurrentChat: false });
  } catch (e) {
    toast(`Tạo cuộc trò chuyện mới thất bại: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }

  // ===== 4. Ghi vào cuộc trò chuyện mới (lúc này ctx.chat đã trỏ sang cuộc trò chuyện mới) =====
  try {
    const targetCtx = getContext();
    if (!targetCtx) throw new Error('Ngữ cảnh cuộc trò chuyện mới không khả dụng');
    const targetChat = targetCtx.chat ?? [];

    // Đảm bảo có tầng mốc neo #0: lá hạt giống (mang delta trạng thái toàn bộ + văn bản tóm tắt gộp) bắt buộc phải gắn trên một tầng #0.
    // Thẻ nhân vật có lời mở đầu → tái sử dụng #0 làm mốc neo (xóa trống chính văn, đặt làm tầng hệ thống, xóa các lời mở đầu còn lại);
    // Thẻ nhân vật **trống lời mở đầu** → getChat sẽ không push bất kỳ tầng nào, targetChat trống, tại đây chủ động tạo một tầng mốc neo.
    //   (Đây là nhánh bị sót trước kia: thẻ trống lời mở đầu sẽ làm cả khối mốc neo bị bỏ qua, dẫn đến mất sạch tóm tắt / trạng thái ngoài cửa sổ.)
    let anchor: STMessage;
    if (targetChat.length > 0) {
      // Chỉ xóa lời mở đầu khi "cuộc trò chuyện mới hoàn toàn chưa có tầng user", tránh xóa nhầm nội dung đã có của người dùng
      const hasUser = targetChat.some(m => m.is_user);
      if (!hasUser && carryMessages.length > 0) {
        targetChat.splice(1); // Giữ #0, xóa các lời mở đầu còn lại
      }
      anchor = targetChat[0];
    } else {
      // Thẻ trống lời mở đầu: tạo một tầng mốc neo đưa vào #0
      anchor = {
        name: targetCtx.name2 || '',
        is_user: false,
        is_system: true,
        mes: '',
        extra: {},
      };
      targetChat.push(anchor);
    }
    anchor.is_system = true;
    setMessageText(anchor, '');
    // Gắn lá hạt giống vào #0.extra
    const seedLeaf: LeafExtra = {
      id: seedLeafId,
      text: mergedSummary,
      delta: seedDelta,
      timeEnd: seedTime || undefined,
      timeStart: seedTime || undefined,
      createdAt: Date.now(),
      seed: true, // Lá hạt giống: mang tổng kết gộp của cuộc trò chuyện cũ, không đưa vào kho vector (xem index.ts collectLeaves + chú thích LeafExtra.seed)
      v: 1,
    };
    anchor.extra = { ...(anchor.extra ?? {}), bbs_leaf: seedLeaf };

    // Rừng cuộc trò chuyện mới: sau khi đặt lại thì đặt một tổng kết L2 thu nạp lá hạt giống (mang văn bản tóm tắt gộp).
    memory.summaries.splice(0, memory.summaries.length);
    if (mergedSummary) {
      const l2: MemSummary = {
        id: `sum_carry_${Date.now().toString(36)}`,
        text: mergedSummary,
        level: 2,
        createdAt: Date.now(),
        auto: true,
        timeStart: seedTime || undefined,
        timeEnd: seedTime || undefined,
        childIds: [seedLeaf.id],
      };
      memory.summaries.push(l2);
    }

    // Chuyển các tầng cửa sổ vào
    for (const m of carryMessages) targetChat.push(m);

    // Ghi metadata.bbs_bundles của cuộc trò chuyện mới (kế thừa nguồn + mã băm mới lần này, cộng dồn khử trùng)
    if (newBundleHash || parentBundles.length) {
      const meta = targetCtx.chatMetadata as Record<string, unknown>;
      if (newBundleHash) {
        appendBundleHash(meta, parentBundles, newBundleHash);
      } else {
        meta[BUNDLES_META_KEY] = [...parentBundles];
      }
    }

    // Lưu đĩa + tính lại + làm mới
    recomputeDerived();
    saveMemory();
    flushLeavesNow();
    await targetCtx.saveChat();
    if (typeof targetCtx.saveMetadata === 'function') await targetCtx.saveMetadata();
    if (typeof targetCtx.reloadCurrentChat === 'function') await targetCtx.reloadCurrentChat();
    refreshInjection();

    toast(`Đã tạo cuộc trò chuyện mới: mang theo ${carryMessages.filter(m => !m.is_user).length} mục AI, ${mergedSummary ? '1' : '0'} mục tóm tắt cốt truyện cũ`, 'success');
    return true;
  } catch (e) {
    toast(`Ghi vào cuộc trò chuyện mới thất bại: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
}
