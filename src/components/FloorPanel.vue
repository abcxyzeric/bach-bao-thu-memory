<script setup lang="ts">
/**
 * Bảng tóm tắt trong tầng (gắn bên trong shadow của mỗi tầng AI, do floorPanel.ts gắn kết từng tầng).
 *
 * Hình thái: một tấm thẻ cùng nguồn với trang Tóm tắt (ngôn ngữ thiết kế .bbs-summary-card).
 *   - Đầu thẻ (điểm neo): một dòng nghiêm ngặt —— Số tầng + Xem trước tóm tắt + Nút ngoại truyện + Nút tóm tắt tầng đơn.
 *   - Thân thẻ (ngăn kéo): chuyển tiếp chiều cao grid 0fr↔1fr (giống SummaryNode.vue, nội dung thường trực không rời luồng, không nhấp nháy).
 *     Biến động được phân nhóm theo loại, xếp theo "luồng thẻ".
 *
 * Chỉnh sửa: **chỉnh sửa từng mục tại chỗ**. Nhấn vào nội dung chính tóm tắt / thời gian / địa điểm / một nhãn biến động nào đó, mở rộng tại chỗ ô nhập liệu của đơn vị đó,
 *   lưu là ghi, hủy là thu lại, phần còn lại giữ nguyên chỉ đọc. Cùng một thời điểm chỉ có một đơn vị đang chỉnh sửa (editKey).
 *   Ghi dữ liệu đi theo editLeafFull của apply.ts (phát lại tổng thể), sửa đổi có mục tiêu do commitDelta nhân bản - sửa - ghi lại hoàn tất.
 *
 * Dữ liệu: chat không phải reactive. leaf trả về bản sao nông (tham chiếu mới) + theo dõi sig.tick / derivedMeta.rev,
 *   thay đổi từ bất kỳ nguồn nào (sự kiện ST, tóm tắt giao diện chính, chỉnh sửa trong tầng) đều có thể làm mới.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import { NPC_AFFINITY_FIELDS, affinityLevelFromInput, fmtNpcAffinity } from '@/memory/npcRelations';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { getContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { getLeaf, leafValid, deleteLeafAt, editLeafFull, planContentById, describeVarOp } from '@/memory/apply';
import { engineState, floorBackfillState, regenerateFloor, setFloorOmit, summarizeFloor } from '@/memory/engine';
import { derivedMeta } from '@/memory/store';
import { ui } from '@/state/ui';
import type { LeafExtra, StoredDelta, ItemDelta, NpcDelta, ProtagonistDelta, ConditionPatch, VarOp, JsonValue } from '@/memory/types';

const props = defineProps<{ floor: number; sig: { tick: number } }>();

// —— Đọc tin nhắn / lá của tầng hiện tại. Cả hai nguồn làm mới đều được theo dõi:
//   · sig.tick: sự kiện ST của chủ thể tiêm (kết xuất / lật trang / chuyển trò chuyện)
//   · derivedMeta.rev: bất kỳ recomputeDerived nào (tóm tắt giao diện chính, chỉnh sửa trong tầng, engine tự động tóm tắt)
const msg = computed<STMessage | undefined>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return getContext()?.chat?.[props.floor];
});
// ⚠️ msg trả về cùng một tham chiếu đối tượng chat[floor] (sửa đánh dấu/lá tại chỗ, tham chiếu không đổi), Vue computed phán đoán dựa trên ===
// sẽ cho rằng msg "chưa đổi" mà không lan truyền xuống hạ lưu. Do đó omit/valid/leaf đều bắt buộc phải **tự mình** theo dõi trực tiếp rev/tick,
// không thể chỉ dựa vào msg —— nếu không sau khi chuyển đổi đánh dấu ngoại truyện thì omit không làm mới (trạng thái nút ngoại truyện không đổi, là nguyên nhân gốc của bug này).
const omit = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return !!msg.value?.extra?.bbs_omit;
});
// leaf còn trả về thêm bản sao nông (tham chiếu mới), để hạ lưu phụ thuộc vào leaf (d/*Tags/preview) cũng bị ép tính lại.
const leaf = computed<LeafExtra | null>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const l = getLeaf(msg.value);
  return l ? { ...l } : null;
});
const valid = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return leafValid(msg.value);
});
const d = computed<StoredDelta | null>(() => leaf.value?.delta ?? null);

const expanded = ref(false);
const busy = ref(false);
const regenerateConfirmOpen = ref(false);

const summarizingHere = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  return floorBackfillState.running
    && floorBackfillState.floor === props.floor
    && floorBackfillState.chatId === chatId;
});
const summaryActionDisabled = computed(() => busy.value || engineState.running || omit.value);
const summaryActionTitle = computed(() => {
  if (omit.value) return 'Tầng ngoại truyện không tham gia tóm tắt, vui lòng bỏ ngoại truyện trước';
  if (summarizingHere.value) return `Đang tạo tóm tắt cho tầng #${props.floor}`;
  return valid.value ? `Tạo lại tóm tắt cho tầng #${props.floor}` : `Tạo tóm tắt cho tầng #${props.floor}`;
});

const previewText = computed(() => {
  if (omit.value) return 'Không tính vào trí nhớ';
  if (valid.value && leaf.value?.text) return leaf.value.text;
  return valid.value ? '(Không có nội dung tóm tắt)' : 'Chờ tóm tắt';
});
const previewMuted = computed(() => omit.value || !(valid.value && leaf.value?.text));

const timeLabel = computed(() => {
  const l = leaf.value;
  if (!l) return '';
  const s = l.timeStart?.trim();
  const e = l.timeEnd?.trim();
  if (s && e && s !== e) return `${s} → ${e}`;
  return s || e || l.timeLabel?.trim() || '';
});

/* ============ Biến động → Dòng thẻ (kèm thông tin định vị để chỉnh sửa tại chỗ) ============ */
type Op = 'add' | 'update' | 'remove' | 'resolve' | 'reopen' | 'reparent';
// Ký tự đơn từng gây khó hiểu ("Sửa" là gì?), đổi sang dùng từ ngữ rõ ràng + huy hiệu màu ngữ nghĩa (xem tô màu op-* của .bbs-fp-op)
const opLabel: Record<Op, string> = { add: 'Thêm mới', update: 'Cập nhật', remove: 'Gỡ bỏ', resolve: 'Kết thúc', reopen: 'Mở lại', reparent: 'Di dời' };

// key dùng để định vị tới thùng cụ thể + số thứ tự trong delta, như 'item:add:0'
// text=văn bản chính (tên/tiêu đề, một dòng), sub=văn bản phụ (mô tả/chi tiết trường, chữ nhỏ màu nhạt xuống dòng riêng).
// Trước đây nhét tất cả chi tiết vào một dòng, bo góc lớn, lại còn căn giữa, nội dung dài biến thành bong bóng căn giữa cồng kềnh. Tách thành mục kiểu sổ cái
// căn trái "chính + phụ", lấy tên làm cốt, chi tiết làm nhánh, dài ngắn đều dễ đọc.
interface Tag {
  key: string;
  op: Op;
  bucket: string; // add/update/remove/reparent/resolve/reopen
  idx: number;
  text: string;
  sub?: string; // Văn bản phụ (tùy chọn)
  editable: boolean; // items/npcs có thể sửa trường tại chỗ; scenes/plans chỉ có thể xóa
}

function fmtItem(x: ItemDelta): { text: string; sub?: string } {
  const text = typeof x.qty === 'number' ? `${x.name} ×${x.qty}` : x.name;
  return { text, sub: x.desc || undefined };
}
// Bảng đăng ký các trường văn bản có thể chỉnh sửa của nhân vật: thống nhất dẫn động "hiển thị văn bản phụ / tải chỉnh sửa / lưu / kết xuất ô nhập theo nhu cầu",
// định nghĩa một nơi, tránh lặp lại nhiều chỗ và đảm bảo đồng nhất. key=tên trường NpcDelta, draft=tên trường nháp trong edit, label=hiển thị/placeholder.
const NPC_FIELDS = [
  { key: 'title', draft: 'title', label: 'Thân phận' },
  { key: 'age', draft: 'npcAge', label: 'Tuổi' },
  { key: 'relation', draft: 'relation', label: 'Quan hệ' },
  { key: 'affinityNote', draft: 'affinityNote', label: 'Ghi chú hảo cảm' },
  { key: 'outfit', draft: 'outfit', label: 'Trang phục' },
  { key: 'condition', draft: 'condition', label: 'Trạng thái' },
  { key: 'desc', draft: 'npcDesc', label: 'Ngoại hình' },
  { key: 'personality', draft: 'personality', label: 'Tính cách' },
  { key: 'ties', draft: 'ties', label: 'Mối quan hệ' },
  { key: 'location', draft: 'npcLoc', label: 'Vị trí' },
] as const;

/** Bản vá phân mảnh thương tích trong bản lưu cũ (lá mới trước khi vào kho đã được cố định thành toàn văn): liệt kê ra để thấy được khi phát lại thực tế đã áp dụng những gì. */
function fmtConditionPatch(p: ConditionPatch | undefined): string {
  if (!p) return '';
  return [
    ...(p.replace ?? []).map(op => op.text ? `Sửa ${op.id}→${op.text}` : `Xóa ${op.id}`),
    ...(p.add ?? []).map(op => `Thêm:${op.text}`),
  ].join('; ');
}

// Biến động nhân vật: văn bản chính = Tên (·Thân phận); văn bản phụ = các trường xuất hiện trong lượt này ở delta. Delta cập nhật chỉ chứa các trường bị sửa,
// nên văn bản phụ vừa khéo chính là "tầng này đã sửa những gì" —— trước đây nhét vào một dòng lại còn căn giữa, cực kỳ khó đọc, tách thành dòng phụ trông thoáng sạch.
function fmtNpc(x: NpcDelta): { text: string; sub?: string } {
  const text = x.title ? `${x.name}·${x.title}` : x.name;
  const parts: string[] = [];
  // Thân phận đã đưa vào văn bản chính (Tên·Thân phận), văn bản phụ bắt đầu từ "Tuổi", tránh lặp lại
  if (x.age) parts.push(`Tuổi:${x.age}`);
  if (x.relation) parts.push(`Quan hệ:${x.relation}`);
  const affinity = fmtNpcAffinity(x, true);
  if (affinity) parts.push(`Đánh giá hảo cảm:${affinity}`);
  if (x.outfit) parts.push(`Trang phục:${x.outfit}`);
  if (x.condition) parts.push(`Trạng thái:${x.condition}`);
  const patch = fmtConditionPatch(x.conditionPatch);
  if (patch) parts.push(`Bản vá trạng thái:${patch}`);
  if (x.desc) parts.push(`Ngoại hình:${x.desc}`);
  if (x.personality) parts.push(`Tính cách:${x.personality}`);
  if (x.ties) parts.push(`Mối quan hệ:${x.ties}`);
  if (x.location) parts.push(`Vị trí:${x.location}`);
  if (x.follow === true) parts.push('Đi cùng');
  if (x.important === true) parts.push('Nhân vật chính yếu');
  return { text, sub: parts.length ? parts.join(' · ') : undefined };
}

const itemTags = computed<Tag[]>(() => {
  const it = d.value?.items;
  if (!it) return [];
  const out: Tag[] = [];
  (it.add ?? []).forEach((x, i) => out.push({ key: `item:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtItem(x), editable: true }));
  (it.update ?? []).forEach((x, i) => out.push({ key: `item:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtItem(x), editable: true }));
  (it.remove ?? []).forEach((name, i) => out.push({ key: `item:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
});
const npcTags = computed<Tag[]>(() => {
  const np = d.value?.npcs;
  if (!np) return [];
  const out: Tag[] = [];
  (np.add ?? []).forEach((x, i) => out.push({ key: `npc:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtNpc(x), editable: true }));
  (np.update ?? []).forEach((x, i) => out.push({ key: `npc:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtNpc(x), editable: true }));
  (np.remove ?? []).forEach((name, i) => out.push({ key: `npc:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
});
const protagonistTags = computed<Tag[]>(() => {
  const protagonist = d.value?.protagonist;
  if (!protagonist) return [];
  // conditionPatch là đối tượng, không đi theo khóa văn bản; dùng Partial chỉ liệt kê khóa văn bản, bản vá được định dạng nối thêm riêng.
  const labels: Partial<Record<keyof ProtagonistDelta, string>> = {
    gender: 'Giới tính',
    age: 'Tuổi',
    ageTime: 'Mốc tuổi',
    identity: 'Thân phận',
    appearance: 'Ngoại hình',
    outfit: 'Trang phục',
    condition: 'Trạng thái',
  };
  const parts = (Object.keys(labels) as Array<keyof ProtagonistDelta>)
    .filter(key => protagonist[key] !== undefined)
    .map(key => `${labels[key]}:${protagonist[key] || '(Xóa trống)'}`);
  const patch = fmtConditionPatch(protagonist.conditionPatch);
  if (patch) parts.push(`Bản vá trạng thái:${patch}`);
  if (!parts.length) return [];
  return [{
    key: 'protagonist:update:0',
    op: 'update',
    bucket: 'update',
    idx: 0,
    text: 'Hồ sơ nhân vật chính',
    sub: parts.join(' · '),
    editable: false,
  }];
});
const sceneTags = computed<Tag[]>(() => {
  const sc = d.value?.scenes;
  if (!sc) return [];
  const out: Tag[] = [];
  (sc.add ?? []).forEach((x, i) => out.push({ key: `scene:add:${i}`, op: 'add', bucket: 'add', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.update ?? []).forEach((x, i) => out.push({ key: `scene:update:${i}`, op: 'update', bucket: 'update', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.reparent ?? []).forEach((x, i) => out.push({ key: `scene:reparent:${i}`, op: 'reparent', bucket: 'reparent', idx: i, text: `${(x.node ?? []).join('/')} → ${(x.newPath ?? []).join('/')}`, editable: false }));
  (sc.remove ?? []).forEach((p, i) => out.push({ key: `scene:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: (p ?? []).join(' / '), editable: false }));
  return out;
});
const planTags = computed<Tag[]>(() => {
  const pl = d.value?.plans;
  if (!pl) return [];
  const out: Tag[] = [];
  (pl.add ?? []).forEach((x, i) =>
    out.push({ key: `plan:add:${i}`, op: 'add', bucket: 'add', idx: i, text: x.content, sub: x.kind === 'suspense' ? 'Nghi vấn' : 'Kế hoạch', editable: true }),
  );
  // resolve/reopen/remove lưu id, tra ngược nội dung để hiển thị; resolve còn kèm outcome/reason (tương thích dữ liệu cũ dạng chuỗi trần)
  (pl.resolve ?? []).forEach((r, i) => {
    const id = typeof r === 'string' ? r : r.id;
    const oc = typeof r === 'string' ? undefined : r.outcome;
    const verb = oc === 'done' ? 'Hoàn thành' : oc === 'cancelled' ? 'Hủy bỏ' : oc === 'failed' ? 'Thất bại' : 'Kết thúc';
    const reason = typeof r === 'string' ? '' : (r.reason?.trim() ?? '');
    out.push({ key: `plan:resolve:${i}`, op: 'resolve', bucket: 'resolve', idx: i, text: planLabel(verb, id), sub: reason || undefined, editable: false });
  });
  // update trước đây không hiển thị: nội dung/thời hạn đã sửa không cách nào tra cứu trong bảng tầng, cũng không xóa được
  (pl.update ?? []).forEach((u, i) => {
    const sub = [u.content && `Nội dung:${u.content}`, u.targetTime !== undefined && `Thời hạn:${u.targetTime || '(Xóa bỏ)'}`].filter(Boolean).join(' · ');
    out.push({ key: `plan:update:${i}`, op: 'update', bucket: 'update', idx: i, text: planLabel('Cập nhật', u.id), sub: sub || undefined, editable: false });
  });
  (pl.reopen ?? []).forEach((id, i) => out.push({ key: `plan:reopen:${i}`, op: 'reopen', bucket: 'reopen', idx: i, text: planLabel('Mở lại', id), editable: false }));
  (pl.remove ?? []).forEach((id, i) => out.push({ key: `plan:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: planLabel('Xóa', id), editable: false }));
  return out;
});
function planLabel(verb: string, id: string): string {
  void derivedMeta.rev;
  const c = planContentById(id);
  return c ? `${verb}:${c}` : `${verb} một mục`;
}
// Biến động biến số: varOps là mảng lệnh phẳng (không chia thùng add/update/remove), ánh xạ từng mục thành nhãn.
// op tái sử dụng ngữ nghĩa huy hiệu hiện có: set/add=Cập nhật (trung tính), assign=Thêm mới (nhấn mạnh), remove=Gỡ bỏ (nguy hiểm).
// Có thể chỉnh sửa tại chỗ (phơi bày các trường khác nhau tùy theo kiểu lệnh, xem nhánh var trong template); xóa đi theo xử lý riêng cho var của deleteTag.
const VAR_OP_TO_TAGOP: Record<VarOp['op'], Op> = { set: 'update', add: 'update', assign: 'add', remove: 'remove' };
const varTags = computed<Tag[]>(() => {
  const ops = d.value?.varOps;
  if (!ops?.length) return [];
  return ops.map((op, i) => {
    const { text, sub } = describeVarOp(op);
    return { key: `var:op:${i}`, op: VAR_OP_TO_TAGOP[op.op], bucket: 'op', idx: i, text, sub, editable: true };
  });
});
// Lệnh biến số đang được chỉnh sửa (cung cấp cho template quyết định hiển thị những trường nào theo kiểu op: Giá trị / Lượng tăng / Khóa)
const editingVarOp = computed<VarOp | null>(() => {
  const key = editKey.value;
  if (!key || !key.startsWith('var:')) return null;
  return d.value?.varOps?.[Number(key.split(':')[2])] ?? null;
});
// Chuyển đổi qua lại giữa Giá trị ↔ Ô nhập liệu: chuỗi giữ nguyên; số/boolean/đối tượng chuyển thành văn bản JSON. Phân tích ngược lại: thử JSON trước, thất bại thì coi là chuỗi thuần.
// Do đó "Thù địch"→chuỗi, "60"→số, "true"→boolean, '{"a":1}'→đối tượng, round-trip ổn định.
function varValueToInput(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function parseVarValue(text: string): JsonValue {
  const t = text.trim();
  if (t === '') return '';
  try { return JSON.parse(t); } catch { return text; }
}

const hasAnyDelta = computed(
  () => protagonistTags.value.length || itemTags.value.length || npcTags.value.length || sceneTags.value.length || planTags.value.length || varTags.value.length || !!d.value?.location,
);

/* ============ Chỉnh sửa tại chỗ ============ */
// Đơn vị hiện đang chỉnh sửa: 'text' | 'time' | 'loc' | tag.key (như 'item:add:0'); null=không có
const editKey = ref<string | null>(null);
// Bản nháp chỉnh sửa đơn vị (điền theo nhu cầu, các đơn vị khác nhau dùng các trường khác nhau).
// Các trường npc độc lập (title/outfit/condition/npcDesc/personality/npcLoc), không lấy desc kiêm nhiệm title nữa ——
// trước đây chỉnh sửa nhân vật chỉ phơi bày Tên + Thân phận, còn Trang phục / Trạng thái / Ngoại hình / Tính cách / Vị trí nhìn được mà không sửa được, nên bổ sung đầy đủ.
const edit = reactive<{
  text: string; timeStart: string; timeEnd: string; location: string;
  name: string; qty: string; desc: string; content: string;
  title: string; npcAge: string; relation: string; ties: string; outfit: string; condition: string; npcDesc: string; personality: string; npcLoc: string;
  affinityInner: string; affinityOuter: string; affinityNote: string;
  varPath: string; varKey: string; varValue: string; varDelta: string;
}>({
  text: '',
  timeStart: '',
  timeEnd: '',
  location: '',
  name: '',
  qty: '',
  desc: '',
  content: '',
  title: '',
  npcAge: '',
  relation: '',
  affinityInner: '',
  affinityOuter: '',
  affinityNote: '',
  ties: '',
  outfit: '',
  condition: '',
  npcDesc: '',
  personality: '',
  npcLoc: '',
  varPath: '',
  varKey: '',
  varValue: '',
  varDelta: '',
});

// Khi lá biến mất / chuyển sang ngoại truyện thì thoát chỉnh sửa
watch([omit, leaf], () => {
  if (editKey.value && (omit.value || !leaf.value)) editKey.value = null;
});

// Phán đoán màn hình cảm ứng: trên di động khi vào chỉnh sửa không tự động focus —— tự động focus sẽ bật ngay bộ gõ lên, che khuất giao diện.
// Để người dùng chủ động nhấn vào ô nhập liệu mới bật lên sẽ thoải mái hơn (cùng sự đánh đổi với hộp thoại tóm tắt ở giao diện chính).
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// Dùng hàm ref (thay vì chuỗi ref): chuỗi ref xuất hiện trong v-for sẽ bị Vue thu thập thành **mảng**,
// focusEl.value biến thành mảng, không có .focus() → báo lỗi "focus is not a function". Hàm ref chỉ được gọi một lần khi phần tử
// gắn kết, lấy chắc chắn một phần tử đơn lẻ.
const focusEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
function setFocus(el: unknown) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) focusEl.value = el;
}
function beginEdit(key: string) {
  if (omit.value || !leaf.value) return;
  focusEl.value = null; // Xóa bỏ tham chiếu ô nhập liệu (đã gỡ) của lần chỉnh sửa trước, tránh focus vào nút trôi nổi
  editKey.value = key;
  void nextTick(() => {
    // Mọi textarea trong vùng chỉnh sửa đều phải autosize (các trường dùng textarea có thể xuống dòng hiển thị, khi mở ra phải khớp chiều cao nội dung trước)
    autosizeAll();
    if (!isTouch) focusEl.value?.focus();
  });
}
// Tự động điều chỉnh chiều cao textarea: khi vào chỉnh sửa nếu vẫn dùng số dòng cố định, nội dung dài sẽ lập tức co ngắn lại, ngăn kéo bật ngược (thấy "vùng tóm tắt co rút lại").
// Để khung chỉnh sửa khớp sát chiều cao nội dung, liên tục về mặt thị giác với trạng thái chỉ đọc, triệt tiêu hiện tượng nhảy giật.
function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
// Thực hiện autosize lần lượt cho toàn bộ textarea trong thẻ chỉnh sửa nơi focusEl tọa lạc (khi chỉnh sửa nhiều trường sẽ có nhiều hơn một cái)
function autosizeAll() {
  const root = focusEl.value?.closest('.bbs-fp-editform, .bbs-fp-texteditor');
  root?.querySelectorAll('textarea').forEach(t => autosize(t as HTMLTextAreaElement));
  if (focusEl.value instanceof HTMLTextAreaElement) autosize(focusEl.value);
}
function onTextInput(e: Event) {
  autosize(e.target as HTMLTextAreaElement);
}
// Textarea của trường: khi nhập thì autosize; nhấn Enter không xuống dòng (chặn Enter, giữ "ngữ nghĩa một dòng, hiển thị nhiều dòng").
// Shift+Enter cũng chặn —— đây là các trường ngắn, không cần xuống dòng thực sự.
function onFieldKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') e.preventDefault();
}
function cancelEdit() {
  editKey.value = null;
}

/** Nhân bản delta hiện tại, giao cho mutator sửa, rồi phát lại tổng thể để ghi về. */
function commitDelta(mutate: (dd: StoredDelta) => void): void {
  const l = leaf.value;
  if (!l) return;
  const dd: StoredDelta = JSON.parse(JSON.stringify(l.delta ?? {}));
  mutate(dd);
  editLeafFull(props.floor, {
    text: l.text ?? '',
    timeStart: l.timeStart ?? '',
    timeEnd: l.timeEnd ?? '',
    delta: dd,
  });
  editKey.value = null;
}

/* —— Nội dung chính —— */
function editText() {
  edit.text = leaf.value?.text ?? '';
  beginEdit('text');
}
function saveText() {
  const l = leaf.value;
  if (!l) return;
  editLeafFull(props.floor, { text: edit.text, timeStart: l.timeStart ?? '', timeEnd: l.timeEnd ?? '', delta: l.delta ?? {} });
  editKey.value = null;
}

/* —— Thời gian —— */
function editTime() {
  edit.timeStart = leaf.value?.timeStart ?? '';
  edit.timeEnd = leaf.value?.timeEnd ?? '';
  beginEdit('time');
}
function saveTime() {
  const l = leaf.value;
  if (!l) return;
  editLeafFull(props.floor, { text: l.text ?? '', timeStart: edit.timeStart, timeEnd: edit.timeEnd, delta: l.delta ?? {} });
  editKey.value = null;
}

/* —— Địa điểm —— */
function editLoc() {
  edit.location = d.value?.location ?? '';
  beginEdit('loc');
}
function saveLoc() {
  const loc = edit.location.trim();
  commitDelta(dd => {
    if (loc) dd.location = loc;
    else delete dd.location;
  });
}

// Thẻ nhân vật hiện đang được chỉnh sửa, các trường thực tế tồn tại trong lượt này (cung cấp cho template kết xuất theo nhu cầu).
// Điểm mấu chốt: update delta chỉ chứa các trường biến đổi trong lượt này —— nếu kết xuất toàn bộ các trường thành ô trống, người dùng sẽ tưởng nhầm "nhân vật này không có những dữ liệu đó",
// thực ra chỉ là lượt này không sửa. Do đó chỉ kết xuất các trường đã tồn tại (!== undefined) trong delta; còn thêm mới (add) thì đưa ra toàn bộ các trường để tiện điền đủ.
const editingNpcDelta = computed(() => {
  const key = editKey.value;
  if (!key?.startsWith('npc:')) return undefined;
  const [, bucket, idxStr] = key.split(':');
  return (bucket === 'add' ? d.value?.npcs?.add : bucket === 'update' ? d.value?.npcs?.update : undefined)?.[Number(idxStr)];
});
const npcEditFields = computed(() => {
  const npc = editingNpcDelta.value;
  // Mục có kèm bản vá phân mảnh cũ cũng lộ ra cột Trạng thái: điền toàn văn là sẽ ghi đè bản vá đó
  return npc ? NPC_FIELDS.filter(f => editKey.value?.startsWith('npc:add:') || npc[f.key] !== undefined
    || (f.key === 'condition' && !!npc.conditionPatch)) : [];
});
const npcAffinityEditFields = computed(() => {
  const npc = editingNpcDelta.value;
  return npc ? NPC_AFFINITY_FIELDS.filter(f => editKey.value?.startsWith('npc:add:') || npc[f.key] !== undefined) : [];
});

/* —— Sửa trường tại chỗ cho Vật phẩm / Nhân vật / Kế hoạch —— */
function editTag(tag: Tag) {
  const dd = d.value;
  if (!dd) return;
  // Xóa sạch mọi trường nháp: các nhãn không thể chỉnh sửa (resolve/reopen/remove của scene / plan) sẽ không điền bất kỳ trường nào,
  // nếu không xóa sạch sẽ còn sót lại giá trị của lần chỉnh sửa trước (như vừa sửa vật phẩm xong, nhấn tiếp vào "Hoàn thành" của nghi vấn sẽ hiển thị tên vật phẩm cũ) —— đây là nguyên nhân gốc của bug lẫn dữ liệu.
  edit.name = '';
  edit.qty = '';
  edit.desc = '';
  edit.content = '';
  edit.title = '';
  edit.npcAge = '';
  edit.relation = '';
  edit.affinityInner = '';
  edit.affinityOuter = '';
  edit.affinityNote = '';
  edit.ties = '';
  edit.outfit = '';
  edit.condition = '';
  edit.npcDesc = '';
  edit.personality = '';
  edit.npcLoc = '';
  edit.varPath = '';
  edit.varKey = '';
  edit.varValue = '';
  edit.varDelta = '';
  if (tag.key.startsWith('item:')) {
    if (tag.bucket === 'remove') {
      edit.name = dd.items?.remove?.[tag.idx] ?? '';
    } else {
      const x = (tag.bucket === 'add' ? dd.items?.add : dd.items?.update)?.[tag.idx];
      edit.name = x?.name ?? '';
      edit.qty = typeof x?.qty === 'number' ? String(x.qty) : '';
      edit.desc = x?.desc ?? '';
    }
  } else if (tag.key.startsWith('npc:')) {
    if (tag.bucket === 'remove') {
      edit.name = dd.npcs?.remove?.[tag.idx] ?? '';
    } else {
      const x = (tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update)?.[tag.idx];
      edit.name = x?.name ?? '';
      edit.title = x?.title ?? '';
      edit.npcAge = x?.age ?? '';
      edit.relation = x?.relation ?? '';
      edit.affinityInner = x?.affinityInner == null ? '' : String(x.affinityInner);
      edit.affinityOuter = x?.affinityOuter == null ? '' : String(x.affinityOuter);
      edit.affinityNote = x?.affinityNote ?? '';
      edit.ties = x?.ties ?? '';
      edit.outfit = x?.outfit ?? '';
      edit.condition = x?.condition ?? '';
      edit.npcDesc = x?.desc ?? '';
      edit.personality = x?.personality ?? '';
      edit.npcLoc = x?.location ?? '';
    }
  } else if (tag.key.startsWith('plan:add:')) {
    edit.content = dd.plans?.add?.[tag.idx]?.content ?? '';
  } else if (tag.key.startsWith('var:')) {
    const op = dd.varOps?.[tag.idx];
    if (op) {
      edit.varPath = op.path ?? '';
      edit.varKey = op.key !== undefined ? String(op.key) : '';
      edit.varValue = varValueToInput(op.value);
      edit.varDelta = typeof op.delta === 'number' ? String(op.delta) : '';
    }
  }
  beginEdit(tag.key);
}

function saveTag(tag: Tag) {
  commitDelta(dd => {
    if (tag.key.startsWith('item:')) {
      if (tag.bucket === 'remove') {
        if (dd.items?.remove) dd.items.remove[tag.idx] = edit.name.trim();
      } else {
        const arr = tag.bucket === 'add' ? dd.items?.add : dd.items?.update;
        const x = arr?.[tag.idx];
        if (x) {
          x.name = edit.name.trim();
          // Dự phòng String(): v-model của type="number" sẽ chuyển giá trị thành number, gọi .trim() trực tiếp sẽ ném lỗi (number không có trim).
          const qtyStr = String(edit.qty).trim();
          const q = Number(qtyStr);
          if (qtyStr && Number.isFinite(q)) x.qty = q;
          else delete x.qty;
          if (edit.desc.trim()) x.desc = edit.desc.trim();
          else delete x.desc;
        }
      }
    } else if (tag.key.startsWith('npc:')) {
      if (tag.bucket === 'remove') {
        if (dd.npcs?.remove) dd.npcs.remove[tag.idx] = edit.name.trim();
      } else {
        const arr = tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update;
        const x = arr?.[tag.idx];
        if (x) {
          x.name = edit.name.trim();
          // Các trường hồ sơ / tức thời đi theo bảng đăng ký: có giá trị thì ghi, để trống thì xóa khóa đó (trường rỗng không rơi vào delta).
          // Các trường không kết xuất trong lượt này có bản nháp đã bị editTag xóa sạch → sẽ delete, nhưng vốn dĩ nó không có trong delta nên không có tác dụng phụ.
          const rec = x as unknown as Record<string, unknown>;
          const prevAge = x.age;
          for (const f of NPC_FIELDS) {
            const t = (edit[f.draft] as string).trim();
            // Chuỗi rỗng của ghi chú hảo cảm là xóa trống tường minh; lược bỏ mới là giữ nguyên tầng trước, không được trộn lẫn.
            if (t || (f.key === 'affinityNote' && x.affinityNote !== undefined)) rec[f.key] = t;
            else delete rec[f.key];
          }
          // Đã viết tay toàn văn trạng thái thì bản vá phân mảnh của bản lưu cũ cũng hủy bỏ theo (khi phát lại toàn văn được ưu tiên, ở đây tiện tay xóa luôn khỏi gây hiểu lầm)
          if (x.condition !== undefined) delete x.conditionPatch;
          for (const { key } of NPC_AFFINITY_FIELDS) {
            // Phía không được cung cấp trong update bắt buộc phải tiếp tục lược bỏ, không được vì chỉnh sửa phía bên kia mà ghi thành chưa rõ.
            if (x[key] !== undefined || (tag.bucket === 'add' && edit[key] !== '')) {
              x[key] = affinityLevelFromInput(edit[key]);
            }
          }
          // Khi tuổi bị thay đổi thì xóa bỏ mốc cũ có thể còn sót trong delta (ageTime do chỉnh sửa thủ công ghi vào),
          // để khi phát lại sẽ đè mốc mới theo thời gian của lá này; nếu không sửa thì giữ nguyên mốc gốc.
          if (x.age !== prevAge) delete rec.ageTime;
        }
      }
    } else if (tag.key.startsWith('plan:add:')) {
      const x = dd.plans?.add?.[tag.idx];
      if (x) x.content = edit.content.trim();
    } else if (tag.key.startsWith('var:')) {
      const op = dd.varOps?.[tag.idx];
      if (op) {
        op.path = edit.varPath.trim();
        // Ghi lại trường tương ứng theo kiểu lệnh (chỉ sửa trường mà kiểu này có, tránh sót lại trường không liên quan)
        if (op.op === 'add') {
          const n = Number(String(edit.varDelta).trim());
          op.delta = Number.isFinite(n) ? n : 0;
        }
        if (op.op === 'set' || op.op === 'assign') {
          op.value = parseVarValue(edit.varValue);
        }
        if (op.op === 'assign' || op.op === 'remove') {
          const k = edit.varKey.trim();
          if (k) op.key = k; // Khóa thuần chữ số làm chỉ số mảng do phía phát lại dùng Number() dự phòng, lưu dạng chuỗi là được
          else delete op.key;
        }
      }
    }
  });
}

/** Xóa một biến động nào đó (loại bỏ khỏi thùng tương ứng theo số thứ tự). */
function deleteTag(tag: Tag) {
  const [cat, bucket] = tag.key.split(':');
  commitDelta(dd => {
    if (cat === 'protagonist') {
      delete dd.protagonist;
      return;
    }
    if (cat === 'var') {
      if (Array.isArray(dd.varOps)) dd.varOps.splice(tag.idx, 1); // varOps là mảng phẳng, xóa trực tiếp theo số thứ tự
      return;
    }
    const group = (dd as Record<string, Record<string, unknown[]>>)[cat === 'item' ? 'items' : cat === 'npc' ? 'npcs' : cat === 'scene' ? 'scenes' : 'plans'];
    const arr = group?.[bucket];
    if (Array.isArray(arr)) arr.splice(tag.idx, 1);
  });
}

/* —— Thao tác toàn tầng —— */
// Xóa tóm tắt đi theo xác nhận hai bước nội tuyến (bảng nhúng trong vùng chứa cuộn #chat + mỗi tầng có shadow độc lập, nội tuyến ổn định hơn và hợp với bảng nhỏ gọn hơn là hộp thoại Teleport)
const confirmingDelete = ref(false);
function askDelete() {
  if (busy.value) return;
  confirmingDelete.value = true;
}
function cancelDelete() {
  confirmingDelete.value = false;
}
async function removeLeaf() {
  if (busy.value) return;
  busy.value = true;
  try {
    deleteLeafAt(props.floor);
    editKey.value = null;
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}
// Khi thu gọn ngăn kéo / chuyển đổi ngoại truyện, đặt lại trạng thái xác nhận xóa; khi tóm tắt mất hiệu lực thì đóng xác nhận tóm tắt lại.
watch([expanded, omit, leaf], () => {
  if (!expanded.value || omit.value || !leaf.value) confirmingDelete.value = false;
  if (omit.value || !valid.value) regenerateConfirmOpen.value = false;
});
async function toggleOmit() {
  if (busy.value || engineState.running) return;
  busy.value = true;
  try {
    await setFloorOmit(props.floor, !omit.value);
  } finally {
    busy.value = false;
  }
}

function requestSummary() {
  if (summaryActionDisabled.value) return;
  if (valid.value && leaf.value) {
    regenerateConfirmOpen.value = true;
    return;
  }
  void generateMissingSummary();
}

async function generateMissingSummary() {
  if (summaryActionDisabled.value) return;
  await summarizeFloor(props.floor);
  if (engineState.lastError) {
    toast(engineState.lastError, 'error');
    return;
  }
  if (leafValid(getContext()?.chat?.[props.floor])) {
    toast(`Đã tạo tóm tắt cho tầng #${props.floor}`, 'success');
  }
}

async function confirmRegenerate() {
  if (summaryActionDisabled.value) return;
  const ok = await regenerateFloor(props.floor);
  regenerateConfirmOpen.value = false;
  if (ok) {
    toast(`Đã tạo lại tóm tắt cho tầng #${props.floor}`, 'success');
    return;
  }
  toast(engineState.lastError || `Tóm tắt lại tầng #${props.floor} thất bại`, 'error');
}

// Bảng kết xuất phân nhóm (dùng vòng lặp trong template để giảm lặp lại). icon tái sử dụng biểu tượng nét viền cùng kiểu với thanh điều hướng, cho mỗi danh mục một điểm neo thị giác dễ nhận diện.
const groups = computed(() => [
  { title: 'Nhân vật chính', icon: 'characters', tags: protagonistTags.value },
  { title: 'Vật phẩm', icon: 'items', tags: itemTags.value },
  { title: 'Nhân vật', icon: 'npcs', tags: npcTags.value },
  { title: 'Khung cảnh', icon: 'scenes', tags: sceneTags.value },
  { title: 'Sổ nghi vấn', icon: 'plans', tags: planTags.value },
  { title: 'Biến số', icon: 'vars', tags: varTags.value },
]);
</script>

<template>
  <div class="bbs-root bbs-fp" :data-theme="ui.theme">
    <article class="bbs-summary-card bbs-fp-card" :class="{ 'is-omit': omit, 'is-expanded': expanded }">
      <!-- Đầu thẻ = điểm neo: hai dòng. Dòng đầu "Số tầng + Thời gian", dòng thứ hai xem trước tóm tắt -->
      <header class="bbs-fp-head" @click="expanded = !expanded">
        <span class="bbs-fp-head-main">
          <span class="bbs-fp-head-top">
            <span class="bbs-fp-floor" :class="{ 'is-pending': !omit && !valid, 'is-omit': omit }">#{{ floor }}</span>
            <span v-if="timeLabel" class="bbs-fp-head-time">🕑 {{ timeLabel }}</span>
          </span>
          <span class="bbs-fp-preview" :class="{ 'is-muted': previewMuted }">{{ previewText }}</span>
        </span>
        <button
          class="bbs-fp-omitbtn"
          :class="{ 'is-active': omit }"
          type="button"
          :title="omit ? 'Bỏ ngoại truyện (khôi phục tham gia trí nhớ)' : 'Đánh dấu là ngoại truyện (tầng này không tham gia tóm tắt / đại tóm tắt / tiêm)'"
          :disabled="busy || engineState.running"
          @click.stop="toggleOmit"
        >
          <Icon name="sparkles" />
        </button>
        <button
          class="bbs-fp-summarybtn"
          type="button"
          :title="summaryActionTitle"
          :aria-label="summaryActionTitle"
          :disabled="summaryActionDisabled"
          @click.stop="requestSummary"
        >
          <span v-if="summarizingHere" class="bbs-fp-spinner"></span>
          <Icon v-else name="search" />
        </button>
      </header>

      <!-- Thân thẻ = ngăn kéo (chuyển tiếp chiều cao grid) -->
      <div class="bbs-fp-drawer" :class="{ 'is-open': expanded }">
        <div class="bbs-fp-drawer-inner">
          <div class="bbs-fp-drawer-body">
            <p v-if="omit" class="bbs-fp-note">Tầng này đã được đánh dấu là ngoại truyện, dữ liệu dưới đây không tham gia vào trí nhớ; bỏ ngoại truyện sẽ khôi phục.</p>

            <template v-if="leaf">
              <!-- Các chip Thời gian / Địa điểm (có thể nhấn để chỉnh sửa) -->
              <div class="bbs-fp-chips">
                <!-- Thời gian -->
                <div v-if="editKey === 'time'" class="bbs-fp-editform">
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">Bắt đầu</span>
                    <textarea :ref="setFocus" v-model="edit.timeStart" rows="1" class="bbs-input bbs-fp-nfield" placeholder="VD: 1988/9/29 21:00" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">Kết thúc</span>
                    <textarea v-model="edit.timeEnd" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Để trống = giống bắt đầu" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <div class="bbs-fp-editfoot">
                    <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">Hủy</button>
                    <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTime">Lưu</button>
                  </div>
                </div>
                <button v-else-if="!omit" class="bbs-fp-chip is-btn" type="button" @click="editTime">
                  🕑 {{ timeLabel || 'Thiết lập thời gian' }}
                </button>
                <span v-else-if="timeLabel" class="bbs-fp-chip">🕑 {{ timeLabel }}</span>

                <!-- Địa điểm -->
                <div v-if="editKey === 'loc'" class="bbs-fp-editform">
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">Địa điểm</span>
                    <textarea :ref="setFocus" v-model="edit.location" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Địa điểm hiện tại" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <div class="bbs-fp-editfoot">
                    <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">Hủy</button>
                    <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveLoc">Lưu</button>
                  </div>
                </div>
                <button v-else-if="!omit" class="bbs-fp-chip is-btn" type="button" @click="editLoc">
                  📍 {{ d?.location || 'Thiết lập địa điểm' }}
                </button>
                <span v-else-if="d?.location" class="bbs-fp-chip">📍 {{ d.location }}</span>
              </div>

              <!-- Nội dung chính tóm tắt (có thể nhấn để chỉnh sửa) -->
              <template v-if="editKey === 'text'">
                <div class="bbs-fp-texteditor">
                  <textarea :ref="setFocus" v-model="edit.text" class="bbs-input bbs-fp-textarea" rows="3" @input="onTextInput"></textarea>
                  <div class="bbs-fp-editrow-actions">
                    <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
                    <button class="bbs-btn bbs-btn-primary" type="button" @click="saveText">Lưu</button>
                  </div>
                </div>
              </template>
              <p
                v-else
                class="bbs-summary-text bbs-fp-text"
                :class="{ 'is-muted': !leaf.text, 'is-btn': !omit }"
                :title="omit ? '' : 'Nhấn để chỉnh sửa nội dung tóm tắt'"
                @click="!omit && editText()"
              >
                {{ leaf.text || '(Không có nội dung tóm tắt, nhấn vào đây để viết bổ sung)' }}
              </p>

              <!-- Phân nhóm biến động: mỗi danh mục một thẻ nhỏ (tiêu đề biểu tượng + luồng thẻ); nhấn vào thẻ để chỉnh sửa tại chỗ (loại sửa được) hoặc mở rộng xóa -->
              <div v-if="hasAnyDelta" class="bbs-fp-groups">
                <template v-for="g in groups" :key="g.title">
                <section v-if="g.tags.length" class="bbs-fp-group">
                  <span class="bbs-fp-gtitle"><Icon :name="g.icon" class="bbs-fp-gicon" />{{ g.title }}</span>
                  <div class="bbs-fp-flow">
                    <template v-for="tag in g.tags" :key="tag.key">
                      <!-- Chỉnh sửa tại chỗ nhãn đó: kiểu biểu mẫu thống nhất (kèm nhãn trường + nút bấm ngay ngắn ở đáy). Loại sửa được thì đưa ra dòng trường;
                           loại không sửa được (scene, Hoàn thành/Mở lại/Xóa của plan) thì hiển thị lại chỉ đọc + Xóa/Hủy. -->
                      <div v-if="editKey === tag.key" class="bbs-fp-editform">
                        <template v-if="tag.editable && tag.key.startsWith('item:') && tag.bucket !== 'remove'">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Tên</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Tên" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Số lượng</span>
                            <input v-model="edit.qty" class="bbs-input bbs-fp-nfield bbs-fp-nfield-num" type="number" placeholder="Để trống = không đếm" />
                          </label>
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Mô tả</span>
                            <textarea v-model="edit.desc" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Tùy chọn" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.key.startsWith('npc:') && tag.bucket !== 'remove'">
                          <!-- Tên luôn có (khóa khớp); phần còn lại chỉ kết xuất các trường thực tế có biến đổi trong lượt này, không gây hiểu lầm là "không có dữ liệu này" -->
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Tên</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Tên" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <div v-for="f in npcAffinityEditFields" :key="f.key" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">{{ f.label }}</span>
                            <BbsSelect v-model="edit[f.key]" :options="f.options" :aria-label="f.label" class="bbs-fp-nfield" />
                          </div>
                          <label v-for="f in npcEditFields" :key="f.draft" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">{{ f.label }}</span>
                            <textarea v-model="edit[f.draft]" rows="1" class="bbs-input bbs-fp-nfield" :placeholder="f.label" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.key.startsWith('plan:add:')">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Nội dung</span>
                            <textarea :ref="setFocus" v-model="edit.content" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Nội dung" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.key.startsWith('var:')">
                          <!-- Lệnh biến số: hiển thị trường theo kiểu. Đường dẫn luôn có; set/assign có "Giá trị"; add có "Lượng tăng"; assign/remove có "Khóa" -->
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Đường dẫn</span>
                            <textarea :ref="setFocus" v-model="edit.varPath" rows="1" class="bbs-input bbs-fp-nfield" placeholder="VD: Hảo cảm hoặc Thế lực.Hội đồng phép thuật.Danh vọng" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <label v-if="editingVarOp?.op === 'assign' || editingVarOp?.op === 'remove'" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Khóa</span>
                            <textarea v-model="edit.varKey" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Khóa đối tượng / Chỉ số mảng" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <label v-if="editingVarOp?.op === 'add'" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Lượng tăng</span>
                            <input v-model="edit.varDelta" class="bbs-input bbs-fp-nfield bbs-fp-nfield-num" type="number" placeholder="Có thể âm, VD: -10" />
                          </label>
                          <label v-if="editingVarOp?.op === 'set' || editingVarOp?.op === 'assign'" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Giá trị</span>
                            <textarea v-model="edit.varValue" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Văn bản viết trực tiếp; số/true/JSON giữ nguyên mẫu" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.bucket === 'remove'">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">Tên</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="Tên" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <!-- Nhãn không thể chỉnh sửa: hiển thị lại chỉ đọc nội dung sắp xóa (kèm văn bản phụ, như giá trị/lượng tăng của biến số) -->
                        <p v-else class="bbs-fp-editreadonly">{{ tag.sub ? `${tag.text} · ${tag.sub}` : tag.text }}</p>
                        <div class="bbs-fp-editfoot">
                          <button class="bbs-fp-editdel" type="button" title="Xóa mục này" @click="deleteTag(tag)"><Icon name="trash" />Xóa</button>
                          <span class="bbs-fp-editfoot-spacer"></span>
                          <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">Hủy</button>
                          <button v-if="tag.editable" class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTag(tag)">Lưu</button>
                        </div>
                      </div>
                      <!-- Trạng thái chỉ đọc của nhãn: huy hiệu ghim góc trên bên trái + văn bản chính một dòng + văn bản phụ (chi tiết) xuống dòng màu nhạt riêng -->
                      <button
                        v-else
                        class="bbs-fp-tagline is-btn"
                        :class="'op-' + tag.op"
                        type="button"
                        :disabled="omit"
                        :title="omit ? '' : 'Nhấn để chỉnh sửa'"
                        @click="editTag(tag)"
                      >
                        <span class="bbs-fp-op">{{ opLabel[tag.op] }}</span>
                        <span class="bbs-fp-tagbody">
                          <span class="bbs-fp-tagmain">{{ tag.text }}</span>
                          <span v-if="tag.sub" class="bbs-fp-tagsub">{{ tag.sub }}</span>
                        </span>
                      </button>
                    </template>
                  </div>
                </section>
                </template>
              </div>
            </template>

            <p v-else class="bbs-summary-text bbs-fp-text is-muted">Tầng này chưa có tóm tắt.</p>

            <!-- Chân trang: xóa tóm tắt toàn tầng (xác nhận hai bước nội tuyến, chống chạm nhầm) -->
            <div v-if="leaf && !omit" class="bbs-fp-footer">
              <template v-if="confirmingDelete">
                <span class="bbs-fp-confirm-text">Xóa tóm tắt tầng này?</span>
                <button class="bbs-fp-confirm-cancel" type="button" :disabled="busy" @click="cancelDelete">Hủy</button>
                <button class="bbs-fp-confirm-ok" type="button" :disabled="busy" @click="removeLeaf">
                  <Icon name="trash" />Xóa
                </button>
              </template>
              <button v-else class="bbs-fp-delleaf" type="button" title="Xóa tóm tắt tầng này" :disabled="busy" @click="askDelete">
                <Icon name="trash" />Xóa tóm tắt
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>

    <ConfirmDialog
      v-model:open="regenerateConfirmOpen"
      :title="`Tóm tắt lại tầng #${floor}`"
      confirmText="Tạo lại"
      confirmIcon="search"
      :busy="summarizingHere"
      busyText="Đang tạo…"
      @confirm="confirmRegenerate"
    >
      Tóm tắt hiện tại sẽ được thay thế bằng kết quả mới, các ký ức về thời gian, vật phẩm, nhân vật, kế hoạch... do tầng này mang lại sẽ được tính toán lại.
      Nếu tầng này đã được đại tóm tắt tầng trên thu nạp, đại tóm tắt tầng trên chứa nó sẽ mất hiệu lực và bị gỡ bỏ. Tiếp tục?
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.bbs-fp {
  margin: 6px 0 2px;
}
/* Thẻ tầng ngoài dùng --bbs-bg (màu nền trang), đồng nhất với phân tầng "nền trang → thẻ surface → khối thứ cấp surface-2"
   của giao diện chính: bảng tầng tức là một "trang thu nhỏ", các thẻ nhỏ danh mục bên trong mới là surface nổi lên.
   (Mặc định kế thừa surface từ .bbs-summary-card, ở đây ghi đè thành bg.)
   Trạng thái thu gọn nhỏ gọn hơn: thu hẹp lề trong, dòng số tầng vốn đã thấp, khoảng trắng lớn sẽ trông trống trải. Trạng thái mở rộng khôi phục padding thông thường. */
.bbs-fp-card {
  background: var(--bbs-bg);
  padding: 9px 12px;
}
.bbs-fp-card.is-expanded {
  padding: 12px 14px;
}
.bbs-fp-card.is-omit {
  opacity: 0.72;
  border-left: 3px solid var(--bbs-ink-muted);
}

/* Đầu thẻ: vùng chính hai dòng bên trái (số tầng + thời gian / xem trước) + nút ngoại truyện, nút tóm tắt tầng đơn bên phải */
.bbs-fp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-wrap: nowrap;
}
.bbs-fp-head-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* Dòng đầu: số tầng + thời gian */
.bbs-fp-head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bbs-fp-head-time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
/* Số tầng làm thành viên nang, cùng kiểu với nhãn #tầng của thẻ tóm tắt giao diện chính —— nhìn thoáng qua là thấy bảng cùng nguồn với giao diện chính */
.bbs-fp-floor {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-accent);
  background: var(--bbs-accent-soft);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
/* Chờ tóm tắt / ngoại truyện: lùi về viền trung tính, không tranh giành màu nhấn */
.bbs-fp-floor.is-pending,
.bbs-fp-floor.is-omit {
  color: var(--bbs-ink-muted);
  border-color: var(--bbs-line);
  background: var(--bbs-surface-2);
}
.bbs-fp-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--bbs-ink-soft);
}
.bbs-fp-preview.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-fp-omitbtn,
.bbs-fp-summarybtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 13px;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-omitbtn:hover:not(:disabled),
.bbs-fp-summarybtn:hover:not(:disabled) {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-fp-omitbtn:disabled,
.bbs-fp-summarybtn:disabled {
  opacity: 0.5;
  cursor: default;
}
.bbs-fp-omitbtn.is-active {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-fp-spinner {
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: bbs-fp-spin 0.7s linear infinite;
}
@keyframes bbs-fp-spin {
  to { transform: rotate(360deg); }
}
.bbs-fp-card.is-expanded .bbs-fp-head {
  margin-bottom: 12px;
}

/* Ngăn kéo */
.bbs-fp-drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open {
  grid-template-rows: 1fr;
}
.bbs-fp-drawer-inner {
  min-height: 0;
  overflow: hidden;
}
.bbs-fp-drawer-body {
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity var(--bbs-dur) var(--bbs-ease),
    transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open .bbs-fp-drawer-body {
  opacity: 1;
  transform: none;
}

.bbs-fp-note {
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: 12px;
}

/* Các chip Thời gian / Địa điểm */
.bbs-fp-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.bbs-fp-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: var(--bbs-radius-pill);
  border: 1px solid transparent;
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 11.5px;
  font-weight: 500;
}
.bbs-fp-chip.is-btn {
  cursor: pointer;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-chip.is-btn:hover {
  border-color: var(--bbs-accent);
}

/* Nội dung chính: khối chỉ đọc và textarea chỉnh sửa dùng chung một mô hình hộp (triệt tiêu nhảy giật khi chuyển đổi).
   Điểm mấu chốt —— font-size / line-height / padding / border của cả hai bắt buộc phải hoàn toàn đồng nhất, chỉ khác nền / khả năng chỉnh sửa. */
.bbs-fp-text,
.bbs-fp-textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 9px 11px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  line-height: 1.75;
  letter-spacing: 0.02em;
  color: var(--bbs-ink);
  white-space: pre-wrap;
  word-break: break-word;
}
/* Trạng thái chỉ đọc: bề mặt nổi (surface) giống một trường tĩnh nổi trên thẻ ngoài bg, khi di chuột sẽ bật sáng viền nhấn gợi ý "có thể chỉnh sửa" */
.bbs-fp-text {
  background: var(--bbs-surface);
}
.bbs-fp-text.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-fp-text.is-btn {
  cursor: text;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-text.is-btn:hover {
  border-color: var(--bbs-accent);
}

/* Phân nhóm biến động: tổng thể không còn là dòng trải phẳng, mà là một số "thẻ trong thẻ" —— mỗi danh mục một thẻ nhỏ viền nền nhạt,
   tiêu đề biểu tượng ở đỉnh định hình tông chung, bên dưới là luồng nhãn. Cảm giác phân tầng đồng nhất với ngôn ngữ thẻ của giao diện chính. */
.bbs-fp-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--bbs-line);
}
/* Thẻ nhỏ danh mục: bề mặt nổi (surface), nổi trên thẻ ngoài bg —— căn chỉnh với thẻ .bbs-plan của giao diện chính */
.bbs-fp-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
}
/* Tiêu đề danh mục: biểu tượng nét viền + tên, biểu tượng mang màu nhấn làm điểm neo thị giác, nhìn thoáng qua là phân vùng được */
.bbs-fp-gtitle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
}
.bbs-fp-gicon {
  color: var(--bbs-accent);
  font-size: 15px;
}
/* Các thanh biến động xếp chồng dọc (mỗi thanh chiếm riêng một dòng): chúng chứa nội dung có thể dài hoặc ngắn, luồng chip ngang sẽ kéo giãn các thanh dài thành
   bong bóng nhiều dòng xấu xí. Đổi thành mục kiểu sổ cái —— mỗi dòng một mục, căn trái, nội dung xuống dòng tự nhiên. */
.bbs-fp-flow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* Thanh biến động (chỉ đọc = nút bấm, nhấn để chỉnh sửa): huy hiệu ghim góc trên bên trái, văn bản chính/phụ bên phải căn trái.
   Tọa lạc trên thẻ danh mục surface, nên bản thân dùng bề mặt thứ cấp (surface-2), phân tầng chìm xuống một nấc;
   bo góc nhỏ (không phải viên nang), giống một dòng mục trên sổ cái; màu sắc chỉ rơi vào huy hiệu bên trái, bản thân mục thanh nhã. */
.bbs-fp-tagline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-line);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  text-align: left;
}
.bbs-fp-tagline.is-btn {
  cursor: pointer;
  transition:
    border-color var(--bbs-dur) var(--bbs-ease),
    box-shadow var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-tagline.is-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  box-shadow: 0 0 0 2px var(--bbs-accent-soft);
}
.bbs-fp-tagline:disabled {
  cursor: default;
}
/* Huy hiệu op: khối màu bo góc nhỏ, màu sắc chính là ngữ nghĩa (Thêm mới = nhấn mạnh, Gỡ bỏ = nguy hiểm, Hoàn thành/Mở lại = hổ phách, Cập nhật/Di dời = trung tính).
   Trạng thái trung tính trên thanh surface-2 dùng surface làm sáng lên một nấc; đỉnh căn chỉnh dòng đầu, margin-top tinh chỉnh ngang bằng với đường cơ sở văn bản chính. */
.bbs-fp-op {
  flex: 0 0 auto;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
}
.bbs-fp-tagline.op-add .bbs-fp-op {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-fp-tagline.op-remove .bbs-fp-op {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-fp-tagline.op-resolve .bbs-fp-op,
.bbs-fp-tagline.op-reopen .bbs-fp-op {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* Văn bản chính/phụ: xếp chồng dọc, văn bản chính màu bình thường, văn bản phụ chữ nhỏ màu nhạt */
.bbs-fp-tagbody {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bbs-fp-tagmain {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-fp-tagsub {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}

/* ===== Biểu mẫu chỉnh sửa tại chỗ thống nhất =====
   Chỉnh sửa Thời gian / Địa điểm / Vật phẩm / Nhân vật / Nghi vấn đều đi theo bộ này: thẻ viền nền nhạt, bên trong chứa "dòng trường (nhãn + ô nhập)"
   xếp dọc, dưới đáy là một thanh Xóa / Hủy / Lưu ngay ngắn. Cảm giác nhìn căn chỉnh với hộp thoại giao diện chính, không còn là khung nhỏ chen chúc vào một dòng. */
.bbs-fp-editform {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-accent);
  background: var(--bbs-surface);
}
/* Dòng trường: nhãn chiều rộng cố định bên trái + ô nhập căng đầy bên phải, căn chỉnh ngay ngắn */
/* Dòng trường: đỉnh nhãn căn chỉnh (ô nhập có thể nhiều dòng, nhãn vẫn bám dòng đầu) */
.bbs-fp-nrow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.bbs-fp-nlabel {
  flex: 0 0 auto;
  width: 40px;
  padding-top: 6px; /* Căn chỉnh với đường cơ sở chữ dòng đầu của trường */
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
/* Ô nhập trường: đổi sang dùng textarea để "nhập một dòng, hiển thị nhiều dòng" —— khi nội dung dài tự động xuống dòng, cao lên theo nội dung,
   nhìn thấy trọn vẹn; phím Enter bị onFieldKeydown chặn, ngữ nghĩa nhập vẫn là một dòng.
   Nền dùng surface-2: ô nhập trên thẻ biểu mẫu surface phải chìm xuống một nấc, căn chỉnh theo thông lệ ô nhập của giao diện chính. */
.bbs-fp-nfield {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 9px;
  font-size: 12.5px;
  font-family: var(--bbs-font-sans);
  line-height: 1.5;
  background: var(--bbs-surface-2);
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
/* Số lượng vẫn là input number thông thường, một dòng là đủ, không cần xuống dòng tăng chiều cao */
.bbs-fp-nfield-num {
  resize: none;
}
/* Trạng thái xóa nhãn không thể chỉnh sửa: hiển thị lại chỉ đọc nội dung sắp xóa */
.bbs-fp-editreadonly {
  margin: 0;
  font-size: 12.5px;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* Thanh thao tác đáy: Xóa dạt sang trái (trầm lắng, hover hiện đỏ), Hủy/Lưu dạt sang phải thành nhóm */
.bbs-fp-editfoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.bbs-fp-editfoot-spacer {
  flex: 1 1 auto;
}
.bbs-fp-editfoot .bbs-btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}
.bbs-fp-editdel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-editdel:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

/* Trình chỉnh sửa nội dung chính: mô hình hộp textarea đã thống nhất với khối chỉ đọc (xem khối "Nội dung chính" ở trên), ở đây chỉ thêm cho phép kéo giãn + bỏ lề dưới (vùng chứa trình chỉnh sửa quản lý khoảng cách) */
.bbs-fp-texteditor {
  margin-bottom: 10px;
}
.bbs-fp-textarea {
  resize: vertical;
  margin: 0;
  /* autosize dùng JS đặt chiều cao theo scrollHeight; ẩn thanh cuộn tránh nhấp nháy khoảnh khắc kéo cao, đặt một giới hạn dưới tránh văn bản rỗng quá dẹt */
  min-height: 64px;
  overflow: hidden;
}
.bbs-fp-editrow-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

/* Chân trang */
.bbs-fp-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--bbs-line);
}
/* Lối vào xóa: bình thường chỉ là một biểu tượng + chữ tĩnh lặng, dạt sang phải không gây chú ý; hover mới hiện màu nguy hiểm */
.bbs-fp-delleaf {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-delleaf:hover:not(:disabled) {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-fp-delleaf:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Xác nhận hai bước: chữ nhắc nhở + Hủy/Xóa xếp cạnh nhau, nút Xóa dùng màu nguy hiểm đặc ruột, hành động xác nhận rõ ràng */
.bbs-fp-confirm-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
.bbs-fp-confirm-cancel,
.bbs-fp-confirm-ok {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    border-color var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-confirm-cancel {
  border: 1px solid var(--bbs-line-strong);
  background: transparent;
  color: var(--bbs-ink-soft);
}
.bbs-fp-confirm-cancel:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-fp-confirm-ok {
  border: 1px solid var(--bbs-danger);
  background: var(--bbs-danger);
  color: #fff;
}
.bbs-fp-confirm-ok:hover:not(:disabled) {
  opacity: 0.9;
}
.bbs-fp-confirm-cancel:disabled,
.bbs-fp-confirm-ok:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .bbs-fp-drawer,
  .bbs-fp-drawer-body {
    transition: none;
  }
  .bbs-fp-spinner {
    animation-duration: 1.4s;
  }
}
</style>
