<script setup lang="ts">
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import { fmtLifeDetail, lifeDetailSubject } from '@/memory/lifeDetails';
import { NPC_AFFINITY_FIELDS, affinityLevelFromInput, fmtNpcAffinity } from '@/memory/npcRelations';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { classifyNpcPresence, editNpc, removeNpc, setNpcFollow, setNpcImportant, setProtagonist, upsertNpc, addLifeDetail, removeLifeDetail, updateLifeDetail, addKnowledge, removeKnowledge, updateKnowledge } from '@/memory/apply';
import { knowledgeOf, sameKnowledge } from '@/memory/knowledge';
import { derivedMeta, memory } from '@/memory/store';
import { ageDisplay } from '@/memory/timeRel';
import type { MemKnowledge, MemLifeDetail, MemNpc } from '@/memory/types';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { computed, nextTick, ref } from 'vue';

// NPC là dữ liệu dẫn xuất được phát lại từ tóm tắt lá, thao tác thủ công ghi vào "lá hợp lệ mới nhất"; khi không có lá hợp lệ thì không có chỗ gắn kết.
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || 'Nhân vật chính';
});
const protagonistHasData = computed(() => Object.values(memory.protagonist).some(value => !!value?.trim()));
const protagonistHasDetails = computed(() => [
  memory.protagonist.age,
  memory.protagonist.identity,
  memory.protagonist.appearance,
  memory.protagonist.outfit,
  memory.protagonist.condition,
].some(value => !!value?.trim()));

// Hiển thị tuổi: suy tính theo mốc + thời gian trong truyện hiện tại (cùng một hàm với đầu tiêm, giao diện hiển thị = nội dung AI nhận được)
function shownAge(age?: string, ageTime?: string): string {
  return ageDisplay(age, ageTime, memory.state.time);
}
// Chú giải nổi của tuổi: hiển thị mốc gốc, giúp người dùng hiểu "Khoảng 26 tuổi" từ đâu mà có
function ageTitle(age?: string, ageTime?: string): string {
  if (!age?.trim()) return '';
  return ageTime?.trim() ? `Ghi nhận lúc ${ageTime.trim()}: ${age.trim()} (tự động suy tính theo thời gian cốt truyện)` : `Tuổi: ${age.trim()}`;
}
const protagonistAge = computed(() => shownAge(memory.protagonist.age, memory.protagonist.ageTime));

interface ProtagonistDraft {
  gender: string;
  age: string;
  identity: string;
  appearance: string;
  outfit: string;
  condition: string;
}
const protagonistEditing = ref<ProtagonistDraft | null>(null);

function openProtagonistEdit() {
  if (!hasLeaf.value) return;
  protagonistEditing.value = {
    gender: memory.protagonist.gender ?? '',
    age: memory.protagonist.age ?? '',
    identity: memory.protagonist.identity ?? '',
    appearance: memory.protagonist.appearance ?? '',
    outfit: memory.protagonist.outfit ?? '',
    condition: memory.protagonist.condition ?? '',
  };
}
function cancelProtagonistEdit() {
  protagonistEditing.value = null;
}
function saveProtagonistEdit() {
  const draft = protagonistEditing.value;
  if (!draft) return;
  // Khi tuổi không thay đổi thì mang theo mốc cũ, ngăn việc phát lại làm mới mốc thành "ngay lúc này" (tương đương với đóng băng tuổi sai); thực sự sửa mới để phần phát lại đè mốc mới
  const ageTime = draft.age.trim() && draft.age.trim() === memory.protagonist.age ? memory.protagonist.ageTime : undefined;
  if (setProtagonist({ ...draft, ageTime })) protagonistEditing.value = null;
}

/* —— Hồ sơ nhỏ đời sống (ba tầng phân phối: Ghim đầu thường trực / Hiện lên theo thời hạn liên quan / Lắng đọng chỉ khi kích hoạt) —— */
const lifeGroups = computed(() => {
  const pinned: MemLifeDetail[] = [];
  const active: MemLifeDetail[] = [];
  const archive: MemLifeDetail[] = [];
  for (const d of memory.lifeDetails) {
    (d.tier === 'pinned' ? pinned : d.tier === 'archive' ? archive : active).push(d);
  }
  return { pinned, active, archive };
});
/* Thứ tự danh sách = Ghim đầu → Thời hạn/Dài hạn → Lắng đọng; sự khác biệt phân tầng giao cho kiểu dáng thẻ biểu đạt (ghim đầu vạch vàng / lắng đọng viền đứt), không gắn tiêu đề phân nhóm nữa */
const lifeList = computed(() => [...lifeGroups.value.pinned, ...lifeGroups.value.active, ...lifeGroups.value.archive]);

/* —— Thu gọn Hồ sơ nhỏ đời sống: cùng kiểu với Kế hoạch / Nghi vấn ở trang Tóm tắt. Trạng thái thu gọn là tùy chọn chế độ xem trên máy, đi theo localStorage, không vào apiSettings —— */
const LIFE_COLLAPSE_KEY = 'bbs.ui.lifeCollapsed.v1';
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
const lifeCollapsed = ref(loadCollapsed(LIFE_COLLAPSE_KEY));
// Không có mục nào tức là không có gì để thu gọn: không hiển thị mũi tên, đồng thời ép mở rộng (tránh sau khi xóa sạch bị kẹt ở trạng thái trống đang thu gọn)
const lifeFoldable = computed(() => memory.lifeDetails.length > 0);
const lifeShown = computed(() => !lifeCollapsed.value || !lifeFoldable.value);
function toggleLifeFold() {
  lifeCollapsed.value = !lifeCollapsed.value;
  persistCollapsed(LIFE_COLLAPSE_KEY, lifeCollapsed.value);
}

const LIFE_PIN_CAP = 5;
function toggleDetailPin(d: MemLifeDetail) {
  if (d.tier === 'pinned') {
    updateLifeDetail(d.id, { tier: 'active' });
    return;
  }
  if (lifeGroups.value.pinned.length >= LIFE_PIN_CAP) {
    toast(`Ghim đầu tối đa ${LIFE_PIN_CAP} mục, vui lòng bỏ ghim một mục trước rồi mới ghim tiếp`, 'warning');
    return;
  }
  updateLifeDetail(d.id, { tier: 'pinned' });
}
function toggleDetailArchive(d: MemLifeDetail) {
  updateLifeDetail(d.id, { tier: d.tier === 'archive' ? 'active' : 'archive' });
}
function removeDetail(d: MemLifeDetail) {
  removeLifeDetail(d.id);
}

/* Hộp thoại Thêm / Chỉnh sửa chi tiết đời sống */
const detailEditing = ref<{ id: string | null; subject: string; text: string; topics: string; anchors: string; until: string } | null>(null);
const detailSubjectOptions = computed(() => [
  { value: 'user', label: `Nhân vật chính · ${protagonistName.value}` },
  // Giữ lại tùy chọn quy thuộc lịch sử của nhân vật đã xóa / đổi tên, khi mở chỉnh sửa không được âm thầm đổi thành user.
  ...[...new Set([...memory.npcs.map(n => n.name), ...memory.lifeDetails.map(lifeDetailSubject)])]
    .filter(name => name !== 'user').map(name => ({ value: name, label: name })),
]);
function openDetailComposer() {
  detailEditing.value = { id: null, subject: 'user', text: '', topics: '', anchors: '', until: '' };
}
function openDetailEdit(d: MemLifeDetail) {
  detailEditing.value = { id: d.id, subject: lifeDetailSubject(d), text: d.text, topics: d.topics.join('/'), anchors: d.anchors.join('/'), until: d.until ?? '' };
}
function cancelDetailEdit() {
  detailEditing.value = null;
}
function saveDetailEdit() {
  const e = detailEditing.value;
  if (!e || !e.text.trim()) return;
  const topics = e.topics.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
  const anchors = e.anchors.split(/[\/、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  const until = e.until.trim();
  const ok = e.id
    ? updateLifeDetail(e.id, { subject: e.subject, text: e.text.trim(), topics, anchors, until })
    : addLifeDetail({ subject: e.subject, text: e.text.trim(), topics, anchors, until: until || undefined });
  if (ok) detailEditing.value = null;
}

// Phán đoán màn hình cảm ứng: bỏ qua tự động focus hộp thoại (trên di động tự động focus sẽ bật bộ gõ che khuất giao diện), đồng nhất với trang Khung cảnh / Tóm tắt.
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// Phân mức có mặt: dùng chung classifyNpcPresence có thẩm quyền với đầu tiêm (inject.ts) —— đọc location + locationPath,
// ngăn chặn hai bộ logic trôi lệch nhau, đảm bảo "giao diện hiển thị = nội dung AI nhận được". Bốn mức:
//   Nhân vật chính yếu (ghim đầu, bất kể có mặt hay không) / Có mặt (toàn lượng) / Cùng khu vực (tên + thân phận + tính cách) / Không có mặt (tên + thân phận).
const sortByCreated = (a: MemNpc, b: MemNpc) => a.createdAt - b.createdAt;

// Chia thùng trong một lượt: mỗi nhân vật không phải chính yếu chỉ phán đoán có mặt một lần, tránh việc ba computed phán đoán lại ba lượt.
const buckets = computed(() => {
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  for (const n of memory.npcs) {
    if (n.important) continue; // Nhân vật chính yếu liệt kê riêng, không đưa vào phán đoán có mặt
    const p = classifyNpcPresence(n, memory.scenes, here, locPath);
    (p === 'present' ? present : p === 'nearby' ? nearby : absent).push(n);
  }
  present.sort(sortByCreated);
  nearby.sort(sortByCreated);
  absent.sort(sortByCreated);
  return { present, nearby, absent };
});
const mains = computed(() => memory.npcs.filter(n => n.important).sort(sortByCreated));
const present = computed(() => buckets.value.present);
const nearby = computed(() => buckets.value.nearby);
const absent = computed(() => buckets.value.absent);

/* —— Công tắc một chạm Đi cùng: Đi cùng → hủy (ở lại địa điểm hiện tại); Không đi cùng → đánh dấu đi cùng —— */
function toggleFollow(npc: MemNpc) {
  if (npc.follow === true) {
    // Hủy đi cùng: ở lại nơi đang ở hiện tại (không có thì để trống, trở thành NPC trôi nổi không rõ vị trí)
    setNpcFollow(npc.name, false, memory.state.location || '');
  } else {
    setNpcFollow(npc.name, true);
  }
}

/* —— Tăng / Giảm cấp Nhân vật chính yếu bằng một chạm —— */
function toggleImportant(npc: MemNpc) {
  setNpcImportant(npc.name, !npc.important);
}

function askRemove(npc: MemNpc) {
  removing.value = npc;
}

/* —— Hộp thoại thêm mới —— */
const composerOpen = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
interface NpcDraft {
  name: string;
  gender: string;
  age: string;
  relation: string;
  affinityInner: string;
  affinityOuter: string;
  affinityNote: string;
  ties: string;
  title: string;
  personality: string;
  desc: string;
  outfit: string;
  condition: string;
  important: boolean;
  follow: boolean;
  location: string;
}
function emptyDraft(): NpcDraft {
  return { name: '', gender: '', age: '', relation: '', affinityInner: '', affinityOuter: '', affinityNote: '', ties: '', title: '', personality: '', desc: '', outfit: '', condition: '', important: false, follow: false, location: memory.state.location || '' };
}
const draft = ref<NpcDraft>(emptyDraft());

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyDraft();
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addNpc() {
  const d = draft.value;
  if (!d.name.trim()) return;
  const ok = upsertNpc({
    name: d.name,
    gender: d.gender,
    age: d.age,
    relation: d.relation,
    affinityInner: affinityLevelFromInput(d.affinityInner),
    affinityOuter: affinityLevelFromInput(d.affinityOuter),
    affinityNote: d.affinityNote,
    ties: d.ties,
    title: d.title,
    personality: d.personality,
    desc: d.desc,
    outfit: d.outfit,
    condition: d.condition,
    important: d.important,
    follow: d.follow,
    location: d.follow ? '' : d.location,
  });
  if (!ok) return;
  composerOpen.value = false;
}

/* —— Hộp thoại chỉnh sửa —— */
interface NpcEditing extends NpcDraft {
  oldName: string;
}
const editing = ref<NpcEditing | null>(null);

function openEdit(npc: MemNpc) {
  editing.value = {
    oldName: npc.name,
    name: npc.name,
    gender: npc.gender ?? '',
    age: npc.age ?? '',
    relation: npc.relation ?? '',
    affinityInner: npc.affinityInner == null ? '' : String(npc.affinityInner),
    affinityOuter: npc.affinityOuter == null ? '' : String(npc.affinityOuter),
    affinityNote: npc.affinityNote ?? '',
    ties: npc.ties ?? '',
    title: npc.title ?? '',
    personality: npc.personality ?? '',
    desc: npc.desc ?? '',
    outfit: npc.outfit ?? '',
    condition: npc.condition ?? '',
    important: npc.important === true,
    follow: npc.follow === true,
    location: npc.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  editNpc(e.oldName, {
    name: e.name,
    gender: e.gender,
    age: e.age,
    relation: e.relation,
    affinityInner: affinityLevelFromInput(e.affinityInner),
    affinityOuter: affinityLevelFromInput(e.affinityOuter),
    affinityNote: e.affinityNote,
    ties: e.ties,
    title: e.title,
    personality: e.personality,
    desc: e.desc,
    outfit: e.outfit,
    condition: e.condition,
    important: e.important,
    follow: e.follow,
    location: e.follow ? '' : e.location,
  });
  editing.value = null;
}

/* —— Xác nhận xóa —— */
const removing = ref<MemNpc | null>(null);
function confirmRemove() {
  if (removing.value) removeNpc(removing.value.name);
  removing.value = null;
}

/* —— Danh sách hiểu biết: những chuyện về nhân vật chính mà nhân vật biết / tưởng là vậy (chuyện riêng tư chưa ghi = nhân vật đó không biết) —— */
function knowCount(n: MemNpc): number {
  return knowledgeOf(memory.knowledge, n.name).length;
}
function knowTitle(n: MemNpc): string {
  const c = knowCount(n);
  return `Hiểu biết của ${n.name} về nhân vật chính · ${c ? `${c} mục` : 'Chưa có bản ghi'}`;
}
/** Xem trước trên thẻ: hai mục gần nhất, mục mới đứng trước —— khi chiều rộng dòng không đủ phải cắt ngắn, ưu tiên giữ lại nhận thức mới nhất trước */
function knowPreview(n: MemNpc): string {
  return knowledgeOf(memory.knowledge, n.name).slice(-2).reverse().map(k => k.text).join(' / ');
}
const knowFor = ref<string | null>(null);
const knowList = computed(() => (knowFor.value ? knowledgeOf(memory.knowledge, knowFor.value) : []));
const knowDraft = ref('');
const knowEditing = ref<{ id: string; text: string } | null>(null);
function openKnow(n: MemNpc) {
  knowFor.value = n.name;
  knowDraft.value = '';
  knowEditing.value = null;
}
function closeKnow() {
  knowFor.value = null;
  knowEditing.value = null;
}
// Các mục đồng nghĩa khi phát lại sẽ bị khử trùng lặp: chặn lại trước để tránh việc "nhấn lưu mà không thấy thay đổi / mục biến mất"
function knowDuplicated(text: string, exceptId?: string): boolean {
  const who = knowFor.value ?? '';
  return knowList.value.some(k => k.id !== exceptId && sameKnowledge(k, { subject: who, text }));
}
function addKnow() {
  const text = knowDraft.value.trim();
  if (!knowFor.value || !text) return;
  if (knowDuplicated(text)) {
    toast('Đã có mục tương tự', 'warning');
    return;
  }
  if (addKnowledge(knowFor.value, text)) knowDraft.value = '';
}
function startKnowEdit(k: MemKnowledge) {
  knowEditing.value = { id: k.id, text: k.text };
}
function saveKnowEdit() {
  const e = knowEditing.value;
  if (!e) return;
  const text = e.text.trim();
  if (text === knowList.value.find(k => k.id === e.id)?.text) {
    knowEditing.value = null;
    return;
  }
  if (knowDuplicated(text, e.id)) {
    toast('Đã có mục tương tự', 'warning');
    return;
  }
  if (updateKnowledge(e.id, text)) knowEditing.value = null;
}
function deleteKnow(k: MemKnowledge) {
  if (knowEditing.value?.id === k.id) knowEditing.value = null;
  removeKnowledge(k.id);
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Nhân vật</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? 'Thêm nhân vật thủ công' : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>
    <SummaryOnlyNotice subject="hồ sơ nhân vật chính, danh sách NPC và trạng thái nhân vật" />

    <hr class="bbs-rule" />

    <!-- ===== Hồ sơ nhỏ đời sống: sở thích / thói quen / tình trạng gần đây của nhân vật chính và nhân vật chính yếu (ba tầng phân phối). Đặt phía trên thẻ nhân vật chính và có thể thu gọn, không làm ngắt luồng thẻ nhân vật bên dưới ===== -->
    <div class="bbs-protagonist-section">
      <div class="bbs-npc-grouphead">
        <button
          class="bbs-fold-head"
          type="button"
          :class="{ 'is-static': !lifeFoldable }"
          :disabled="!lifeFoldable"
          :aria-expanded="lifeShown"
          :title="lifeFoldable ? (lifeShown ? 'Thu gọn hồ sơ nhỏ đời sống' : 'Mở rộng hồ sơ nhỏ đời sống') : ''"
          @click="toggleLifeFold"
        >
          <Icon v-if="lifeFoldable" name="chevron" class="bbs-fold-caret" :class="{ 'is-collapsed': !lifeShown }" />
          <h2 class="bbs-life-title" title="Mục ghim đầu gửi thường trực; mục thời hạn/dài hạn hiện lên theo độ liên quan; mục lắng đọng chỉ kích hoạt theo từ khóa">Hồ sơ nhỏ đời sống</h2>
          <span v-if="lifeFoldable" class="bbs-fold-count">{{ memory.lifeDetails.length }}</span>
        </button>
        <span v-if="apiSettings.summaryOnlyMode" class="bbs-npc-grouphint is-local-only">Chỉ dùng để Bách Bảo Thư ghi nhận, không gửi cho AI đối thoại chính</span>
        <button
          class="bbs-add-mini"
          type="button"
          :disabled="!hasLeaf"
          :title="hasLeaf ? 'Thêm chi tiết đời sống thủ công' : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
          @click="openDetailComposer"
        >
          <Icon name="plus" />
        </button>
      </div>
      <!-- Thu mở grid 1fr↔0fr: chiều cao tự thích ứng, không cần viết cứng max-height; dưới reduced-motion sẽ cắt tức thì (xem kiểu dáng) -->
      <div class="bbs-fold-wrap" :class="{ 'is-collapsed': !lifeShown }">
        <div class="bbs-fold-inner">
          <div v-if="lifeList.length" class="bbs-life-group">
            <article v-for="d in lifeList" :key="d.id" class="bbs-life" :class="`is-${d.tier}`">
              <div class="bbs-life-main">
                <p class="bbs-life-text">{{ fmtLifeDetail(d, protagonistName) }}</p>
                <div v-if="d.topics.length || d.until" class="bbs-life-meta">
                  <span v-if="d.topics.length" class="bbs-life-tag">{{ d.topics.join(' / ') }}</span>
                  <span v-if="d.until" class="bbs-life-until">Đến {{ d.until }}</span>
                </div>
              </div>
              <span class="bbs-npc-acts">
                <button
                  class="bbs-item-act"
                  :class="{ active: d.tier === 'pinned' }"
                  type="button"
                  :title="d.tier === 'pinned' ? 'Bỏ ghim đầu' : 'Ghim đầu (gửi thường trực, tối đa 5 mục)'"
                  @click="toggleDetailPin(d)"
                >
                  <Icon name="pin" />
                </button>
                <button
                  class="bbs-item-act"
                  type="button"
                  :title="d.tier === 'archive' ? 'Khôi phục về tầng thời hạn' : 'Lắng đọng (chỉ hiện lên khi có liên quan)'"
                  @click="toggleDetailArchive(d)"
                >
                  <Icon :name="d.tier === 'archive' ? 'upload' : 'download'" />
                </button>
                <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openDetailEdit(d)"><Icon name="edit" /></button>
                <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="removeDetail(d)"><Icon name="trash" /></button>
              </span>
            </article>
          </div>
          <p v-if="!memory.lifeDetails.length" class="bbs-npc-mainhint">Chưa có chi tiết đời sống. Tóm tắt sẽ ghi lại sở thích, thói quen và tình trạng gần đây mà nhân vật chính cùng các nhân vật chính yếu đã nói rõ / chính văn hé lộ, mỗi mục ghi rõ nhân vật sở hữu; cũng có thể thêm thủ công hoặc chỉnh sửa lại quy thuộc.</p>
        </div>
      </div>
    </div>

    <div class="bbs-protagonist-section">
      <div class="bbs-npc-grouphead">
        <span class="bbs-npc-grouptag is-protagonist"><Icon name="characters" />Nhân vật chính</span>
        <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
          {{ apiSettings.summaryOnlyMode ? 'Chỉ dùng để Bách Bảo Thư ghi nhận, không gửi cho AI đối thoại chính' : 'Luôn gửi đầy đủ, ghi nhận tách biệt với danh sách NPC' }}
        </span>
      </div>
      <article class="bbs-npc bbs-protagonist">
        <div class="bbs-npc-body">
          <div class="bbs-npc-head">
            <span class="bbs-npc-name" :title="protagonistName">{{ protagonistName }}</span>
            <span v-if="memory.protagonist.gender" class="bbs-npc-gender">{{ memory.protagonist.gender }}</span>
            <span v-if="protagonistAge" class="bbs-npc-gender" :title="ageTitle(memory.protagonist.age, memory.protagonist.ageTime)">{{ protagonistAge }}</span>
            <span class="bbs-npc-acts">
              <button
                class="bbs-item-act"
                type="button"
                :disabled="!hasLeaf"
                :title="hasLeaf ? 'Chỉnh sửa hồ sơ hiện tại của nhân vật chính' : 'Cần có tóm tắt trước mới có thể chỉnh sửa'"
                @click="openProtagonistEdit"
              >
                <Icon name="edit" />
              </button>
            </span>
          </div>
          <dl v-if="protagonistHasDetails" class="bbs-npc-fields">
            <div v-if="memory.protagonist.identity" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ memory.protagonist.identity }}</dd></div>
            <div v-if="memory.protagonist.appearance" class="bbs-npc-field f-desc"><dt>Ngoại hình</dt><dd>{{ memory.protagonist.appearance }}</dd></div>
            <div v-if="memory.protagonist.outfit" class="bbs-npc-field f-outfit"><dt>Trang phục</dt><dd>{{ memory.protagonist.outfit }}</dd></div>
            <div v-if="memory.protagonist.condition" class="bbs-npc-field f-cond"><dt>Trạng thái</dt><dd>{{ memory.protagonist.condition }}</dd></div>
          </dl>
          <p v-else-if="!protagonistHasData" class="bbs-npc-mainhint">Chưa có bản ghi trạng thái nhân vật chính. Các tóm tắt tiếp theo sẽ từng bước bổ sung từ các sự thật rõ ràng trong cốt truyện.</p>
        </div>
      </article>
    </div>

    <div v-if="memory.npcs.length" class="bbs-npc-groups">
      <!-- Nhân vật chính yếu: diễn viên chính cốt lõi, luôn gửi toàn lượng. Ở đây làm nổi bật "bảng trạng thái tức thời" (trang phục / trạng thái / nơi ở), làm dịu hồ sơ thân phận -->
      <div v-if="mains.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-main"><Icon name="star" />Nhân vật chính yếu</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? 'Vẫn sẽ chú trọng duy trì trạng thái, nhưng không gửi cho AI đối thoại chính' : 'Luôn gửi kèm theo cốt truyện, chú trọng duy trì trạng thái hiện tại' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in mains" :key="n.id" class="bbs-npc is-present is-main">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button class="bbs-item-act bbs-npc-star active" type="button" title="Nhân vật chính yếu · Nhấn để bỏ đánh dấu" @click="toggleImportant(n)"><Icon name="star" /></button>
                  <button v-if="apiSettings.injection.knowledge || knowCount(n)" class="bbs-item-act" :class="{ active: knowCount(n) }" type="button" :title="knowTitle(n)" @click="openKnow(n)"><Icon name="bulb" /></button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.outfit || n.condition || n.follow || n.location || knowCount(n)" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>Quan hệ</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="Đánh giá hảo cảm nội tâm và thái độ bên ngoài đối với nhân vật chính">Hảo cảm</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>Nơi ở</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ n.follow ? 'Đi cùng nhân vật chính' : n.location }}</dd>
                </div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>Trang phục</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>Trạng thái</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="knowCount(n)" class="bbs-npc-field f-know" :title="knowTitle(n)" @click="openKnow(n)"><dt>Hiểu biết</dt><dd><span class="bbs-npc-know-text">{{ knowPreview(n) }}</span><span class="bbs-npc-know-count">{{ knowCount(n) }} mục</span></dd></div>
              </dl>
              <p v-else class="bbs-npc-mainhint">Chưa có bản ghi trạng thái —— nhấn chỉnh sửa để bổ sung trang phục / trạng thái / nơi ở hiện tại.</p>
            </div>
          </article>
        </div>
      </div>

      <!-- Có mặt: đi cùng / đang ở khung cảnh hiện tại. Thông tin toàn lượng gửi cho AI, ở đây cũng hiển thị toàn lượng -->
      <div v-if="present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">Có mặt</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? 'Vẫn ghi nhận đầy đủ theo trạng thái có mặt, nhưng không gửi cho AI đối thoại chính' : 'Thông tin đầy đủ gửi kèm theo cốt truyện' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in present" :key="n.id" class="bbs-npc is-present" :class="{ 'is-follow': n.follow }">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? 'Đánh dấu là nhân vật chính yếu (chỉ điều chỉnh phân nhóm nhân vật trong Bách Bảo Thư)' : 'Đánh dấu là nhân vật chính yếu (luôn gửi toàn lượng, theo dõi trạng thái)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? 'Đang đi cùng · Nhấn để bỏ (ở lại địa điểm hiện tại)' : 'Đánh dấu là bạn đồng hành đi cùng'"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button v-if="apiSettings.injection.knowledge || knowCount(n)" class="bbs-item-act" :class="{ active: knowCount(n) }" type="button" :title="knowTitle(n)" @click="openKnow(n)"><Icon name="bulb" /></button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.ties || n.personality || n.desc || n.outfit || n.condition || n.follow || n.location || knowCount(n)" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>Quan hệ</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="Đánh giá hảo cảm nội tâm và thái độ bên ngoài đối với nhân vật chính">Hảo cảm</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>Nơi ở</dt>
                  <dd :class="{ 'is-follow': n.follow }">{{ n.follow ? 'Đi cùng nhân vật chính' : n.location }}</dd>
                </div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>Trang phục</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>Trạng thái</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>Tính cách</dt><dd>{{ n.personality }}</dd></div>
                <div v-if="n.desc" class="bbs-npc-field f-desc"><dt>Ngoại hình</dt><dd>{{ n.desc }}</dd></div>
                <div v-if="n.ties" class="bbs-npc-field f-ties"><dt>Mối quan hệ</dt><dd>{{ n.ties }}</dd></div>
                <div v-if="knowCount(n)" class="bbs-npc-field f-know" :title="knowTitle(n)" @click="openKnow(n)"><dt>Hiểu biết</dt><dd><span class="bbs-npc-know-text">{{ knowPreview(n) }}</span><span class="bbs-npc-know-count">{{ knowCount(n) }} mục</span></dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- Cùng khu vực: ở gần đây nhưng chưa chắc đã chạm mặt. Gửi tên + thân phận + tính cách cho AI, ở đây cũng chỉ hiển thị ba thông tin đó -->
      <div v-if="nearby.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-nearby">Cùng khu vực</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? 'Vẫn ghi nhận phân mức theo cùng khu vực, nhưng không gửi cho AI đối thoại chính' : 'Ở gần đây, gửi tên, thân phận và tính cách' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in nearby" :key="n.id" class="bbs-npc is-nearby">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? 'Đánh dấu là nhân vật chính yếu (chỉ điều chỉnh phân nhóm nhân vật trong Bách Bảo Thư)' : 'Đánh dấu là nhân vật chính yếu (luôn gửi toàn lượng, theo dõi trạng thái)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="Đánh dấu là bạn đồng hành đi cùng (sẽ có mặt cùng nhân vật chính)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button v-if="apiSettings.injection.knowledge || knowCount(n)" class="bbs-item-act" :class="{ active: knowCount(n) }" type="button" :title="knowTitle(n)" @click="openKnow(n)"><Icon name="bulb" /></button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.relation || fmtNpcAffinity(n) || n.personality || n.location || knowCount(n)" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>Quan hệ</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="Đánh giá hảo cảm nội tâm và thái độ bên ngoài đối với nhân vật chính">Hảo cảm</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div v-if="n.location" class="bbs-npc-field f-loc"><dt>Nơi ở</dt><dd>{{ n.location }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>Tính cách</dt><dd>{{ n.personality }}</dd></div>
                <div v-if="knowCount(n)" class="bbs-npc-field f-know" :title="knowTitle(n)" @click="openKnow(n)"><dt>Hiểu biết</dt><dd><span class="bbs-npc-know-text">{{ knowPreview(n) }}</span><span class="bbs-npc-know-count">{{ knowCount(n) }} mục</span></dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- Không có mặt: chỉ gửi tên + thân phận cho AI, ở đây cũng làm tối đi và thu gọn chi tiết -->
      <div v-if="absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">Không có mặt</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? 'Vẫn giữ nguyên phân mức danh sách, nhưng không gửi cho AI đối thoại chính' : 'Chỉ gửi danh sách tóm lược và mức hảo cảm đã có, tiết kiệm token' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in absent" :key="n.id" class="bbs-npc is-absent">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name" :title="n.name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="shownAge(n.age, n.ageTime)" class="bbs-npc-gender" :title="ageTitle(n.age, n.ageTime)">{{ shownAge(n.age, n.ageTime) }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? 'Đánh dấu là nhân vật chính yếu (chỉ điều chỉnh phân nhóm nhân vật trong Bách Bảo Thư)' : 'Đánh dấu là nhân vật chính yếu (luôn gửi toàn lượng, theo dõi trạng thái)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="Đánh dấu là bạn đồng hành đi cùng (sẽ có mặt cùng nhân vật chính)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button v-if="apiSettings.injection.knowledge || knowCount(n)" class="bbs-item-act" :class="{ active: knowCount(n) }" type="button" :title="knowTitle(n)" @click="openKnow(n)"><Icon name="bulb" /></button>
                  <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>Thân phận</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.relation" class="bbs-npc-field f-rel"><dt>Quan hệ</dt><dd>{{ n.relation }}</dd></div>
                <div v-if="fmtNpcAffinity(n)" class="bbs-npc-field"><dt title="Đánh giá hảo cảm nội tâm và thái độ bên ngoài đối với nhân vật chính">Hảo cảm</dt><dd>{{ fmtNpcAffinity(n) }}</dd></div>
                <div class="bbs-npc-field f-loc">
                  <dt>Nơi ở</dt>
                  <dd v-if="n.location">{{ n.location }}</dd>
                  <dd v-else class="is-nowhere">Chưa rõ nơi ở</dd>
                </div>
                <div v-if="knowCount(n)" class="bbs-npc-field f-know" :title="knowTitle(n)" @click="openKnow(n)"><dt>Hiểu biết</dt><dd><span class="bbs-npc-know-text">{{ knowPreview(n) }}</span><span class="bbs-npc-know-count">{{ knowCount(n) }} mục</span></dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <p>Chưa có NPC nào xuất hiện. Khi tóm tắt sẽ ghi lại các nhân vật có giao tiếp với nhân vật chính, cũng có thể nhấn nút "+" ở góc trên bên phải để thêm thủ công.</p>
    </div>

    <ModalMask :open="!!protagonistEditing" @close="cancelProtagonistEdit">
      <div v-if="protagonistEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa hồ sơ nhân vật chính">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa hồ sơ nhân vật chính</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelProtagonistEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Giới tính</span>
          <input v-model="protagonistEditing.gender" class="bbs-input" type="text" placeholder="VD: Nam, Nữ" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tuổi (ghi nhận giá trị tại thời điểm đó, tự động suy tính theo thời gian cốt truyện)</span>
          <input v-model="protagonistEditing.age" class="bbs-input" type="text" placeholder="VD: 25, Ngoài hai mươi" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thân phận / Nghề nghiệp / Chủng tộc / Địa vị công khai hiện tại</span>
          <textarea v-model="protagonistEditing.identity" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Ngoại hình ổn định / Đặc điểm cơ thể</span>
          <textarea v-model="protagonistEditing.appearance" class="bbs-input bbs-modal-textarea" rows="2" placeholder="VD: Tóc ngắn màu đen, lông mày trái có sẹo"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trang phục hiện tại</span>
          <textarea v-model="protagonistEditing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trạng thái cơ thể / Sức khỏe hiện tại</span>
          <textarea v-model="protagonistEditing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Khi không có gì bất thường thì để trống"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelProtagonistEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveProtagonistEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Hộp thoại Thêm / Chỉnh sửa chi tiết đời sống -->
    <ModalMask :open="!!detailEditing" @close="cancelDetailEdit">
      <div v-if="detailEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chi tiết đời sống">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">{{ detailEditing.id ? 'Chỉnh sửa chi tiết đời sống' : 'Thêm chi tiết đời sống' }}</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelDetailEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nhân vật sở hữu</span>
          <BbsSelect v-model="detailEditing.subject" :options="detailSubjectOptions" aria-label="Nhân vật sở hữu chi tiết đời sống" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nội dung chi tiết (sở thích, thói quen hoặc tình trạng gần đây mà người này đã nói rõ / chính văn hé lộ)</span>
          <textarea v-model="detailEditing.text" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Cho rằng bánh kếp không thêm bánh giòn thì mất hết linh hồn (tên sẽ tự động hiển thị theo nhân vật sở hữu)"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Nhãn chủ đề (tùy chọn, 1-3 nhãn, ngăn cách bằng dấu gạch chéo)</span>
          <input v-model="detailEditing.topics" class="bbs-input" type="text" placeholder="VD: Ăn uống/Sinh hoạt/Công việc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Từ khóa (tùy chọn, dùng để khớp kích hoạt, ngăn cách bằng dấu gạch chéo)</span>
          <input v-model="detailEditing.anchors" class="bbs-input" type="text" placeholder="VD: Rau mùi/Dự án/Deadline" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thời hạn (tùy chọn, thời gian hết hạn trong truyện; sở thích dài hạn thì để trống)</span>
          <input v-model="detailEditing.until" class="bbs-input" type="text" placeholder="VD: 1988/10/1; để trống = ổn định lâu dài" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelDetailEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!detailEditing.text.trim()" @click="saveDetailEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Hộp thoại thêm mới: position:fixed nội tuyến (không dùng Teleport to="body", xem giải thích ở base.css) -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Thêm nhân vật">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thêm nhân vật</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="Tên nhân vật" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Giới tính</span>
          <input v-model="draft.gender" class="bbs-input" type="text" placeholder="VD: Nam, Nữ" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tuổi (ghi nhận giá trị tại thời điểm đó, tự động suy tính theo thời gian cốt truyện)</span>
          <input v-model="draft.age" class="bbs-input" type="text" placeholder="VD: 25, Ngoài hai mươi" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thân phận (nghề nghiệp / mối quan hệ với nhân vật chính)</span>
          <textarea v-model="draft.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Chủ quán trọ Quy Nhạn, Thanh mai trúc mã"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Quan hệ với nhân vật chính (danh xưng đứng trước + một câu thái độ)</span>
          <textarea v-model="draft.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Sư tỷ của nhân vật chính, ngoài mặt lạnh nhạt ngầm bảo vệ"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }} (đối với {{ protagonistName }})</span>
          <BbsSelect v-model="draft[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Ghi chú hảo cảm (đánh giá định tính, không phải tâm trạng lượt này; chưa rõ không đồng nghĩa với trung tính)</span>
          <textarea v-model="draft.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Trong lòng để ý, nhưng quen lấy vẻ lạnh nhạt che giấu; khi không có căn cứ mới thì giữ nguyên"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Quan hệ với các nhân vật khác (chỉ ghi quan hệ lâu dài như huyết thống / hôn nhân / kẻ thù truyền kiếp)</span>
          <textarea v-model="draft.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Cha của Adele; có thù cũ với trấn trưởng"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tính cách</span>
          <textarea v-model="draft.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Trầm mặc ít lời, bênh vực người mình"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả ngoại hình (đặc điểm cố định: màu tóc / vóc dáng / vết sẹo, không viết trang phục)</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trang phục hiện tại (sẽ thay đổi theo cốt truyện)</span>
          <textarea v-model="draft.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Áo choàng đỏ, đeo trường kiếm"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trạng thái hiện tại (bị thương / mệt mỏi..., không có thì để trống)</span>
          <textarea v-model="draft.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? 'Nhân vật chính yếu (diễn viên chính cốt lõi, chỉ chú trọng theo dõi trạng thái trong Bách Bảo Thư)' : 'Nhân vật chính yếu (diễn viên chính cốt lõi, luôn gửi toàn lượng, chú trọng theo dõi trạng thái)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Bạn đồng hành đi cùng (di chuyển theo nhân vật chính, luôn có mặt)</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">Địa điểm hiện tại (để trống = chưa rõ nơi ở, không còn coi là có mặt)</span>
          <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Quán trọ Quy Nhạn, Vương cung; để trống = chưa rõ nơi ở"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft.name.trim()" @click="addNpc">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Hộp thoại chỉnh sửa -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa nhân vật">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa nhân vật</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="Tên nhân vật" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Giới tính</span>
          <input v-model="editing.gender" class="bbs-input" type="text" placeholder="VD: Nam, Nữ" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tuổi (ghi nhận giá trị tại thời điểm đó, tự động suy tính theo thời gian cốt truyện; không sửa sẽ giữ nguyên mốc gốc)</span>
          <input v-model="editing.age" class="bbs-input" type="text" placeholder="VD: 25, Ngoài hai mươi" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thân phận (nghề nghiệp / mối quan hệ với nhân vật chính)</span>
          <textarea v-model="editing.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Chủ quán trọ Quy Nhạn, Thanh mai trúc mã"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Quan hệ với nhân vật chính (danh xưng đứng trước + một câu thái độ)</span>
          <textarea v-model="editing.relation" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Sư tỷ của nhân vật chính, ngoài mặt lạnh nhạt ngầm bảo vệ"></textarea>
        </label>
        <div v-for="f in NPC_AFFINITY_FIELDS" :key="f.key" class="bbs-modal-field">
          <span class="bbs-modal-label">{{ f.label }} (đối với {{ protagonistName }})</span>
          <BbsSelect v-model="editing[f.key]" :options="f.options" :aria-label="f.label" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Ghi chú hảo cảm (đánh giá định tính, không phải tâm trạng lượt này; chưa rõ không đồng nghĩa với trung tính)</span>
          <textarea v-model="editing.affinityNote" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Trong lòng để ý, nhưng quen lấy vẻ lạnh nhạt che giấu; khi không có căn cứ mới thì giữ nguyên"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Quan hệ với các nhân vật khác (chỉ ghi quan hệ lâu dài như huyết thống / hôn nhân / kẻ thù truyền kiếp)</span>
          <textarea v-model="editing.ties" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Cha của Adele; có thù cũ với trấn trưởng"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tính cách</span>
          <textarea v-model="editing.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Trầm mặc ít lời, bênh vực người mình"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả ngoại hình (đặc điểm cố định: màu tóc / vóc dáng / vết sẹo, không viết trang phục)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trang phục hiện tại (sẽ thay đổi theo cốt truyện)</span>
          <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Áo choàng đỏ, đeo trường kiếm"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Trạng thái hiện tại (bị thương / mệt mỏi..., không có thì để trống)</span>
          <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="Tùy chọn"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? 'Nhân vật chính yếu (diễn viên chính cốt lõi, chỉ chú trọng theo dõi trạng thái trong Bách Bảo Thư)' : 'Nhân vật chính yếu (diễn viên chính cốt lõi, luôn gửi toàn lượng, chú trọng theo dõi trạng thái)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">Bạn đồng hành đi cùng (di chuyển theo nhân vật chính, luôn có mặt)</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">Địa điểm hiện tại (để trống = chưa rõ nơi ở, không còn coi là có mặt)</span>
          <textarea v-model="editing.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="VD: Quán trọ Quy Nhạn, Vương cung; để trống = chưa rõ nơi ở"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Hộp thoại danh sách hiểu biết: xem/sửa những chuyện về nhân vật chính mà một nhân vật nào đó biết hoặc tưởng là vậy -->
    <ModalMask :open="!!knowFor" @close="closeKnow">
      <div v-if="knowFor" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Hiểu biết của nhân vật về nhân vật chính">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Hiểu biết của {{ knowFor }} về {{ protagonistName }}</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="closeKnow"><Icon name="close" /></button>
        </header>
        <p class="bbs-know-hint">Chỉ ghi nhận những chuyện mà nhân vật đó tận tai nghe thấy, tận mắt nhìn thấy hoặc nghe người khác kể lại. Những chuyện riêng tư chưa được ghi lại (thân thế, trải nghiệm, bí mật, sở thích, tên tuổi) mặc định nhân vật đó không biết; các mục là điều tự bản thân nhân vật tưởng là vậy, nếu bị lừa thì ghi nhận đúng theo nhận thức sau khi bị lừa.</p>
        <ul v-if="knowList.length" class="bbs-know-list">
          <li v-for="k in knowList" :key="k.id" class="bbs-know-row">
            <template v-if="knowEditing?.id === k.id">
              <textarea v-model="knowEditing.text" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" aria-label="Chỉnh sửa mục hiểu biết"></textarea>
              <span class="bbs-know-acts">
                <button class="bbs-btn" type="button" @click="knowEditing = null">Hủy</button>
                <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!knowEditing.text.trim()" @click="saveKnowEdit">Lưu</button>
              </span>
            </template>
            <template v-else>
              <span class="bbs-know-text">{{ k.text }}</span>
              <span class="bbs-know-acts">
                <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="startKnowEdit(k)"><Icon name="edit" /></button>
                <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="deleteKnow(k)"><Icon name="trash" /></button>
              </span>
            </template>
          </li>
        </ul>
        <p v-else class="bbs-know-hint">Chưa có bản ghi: những chuyện riêng tư của nhân vật chính chưa từng được tiết lộ trong cốt truyện thì mặc định nhân vật này không biết. Những chuyện mà người quen cũ đã biết từ trước có thể bổ sung thủ công ở bên dưới.</p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Thêm một mục</span>
          <textarea
            v-model="knowDraft"
            v-autosize
            class="bbs-input bbs-modal-textarea bbs-modal-autogrow"
            rows="1"
            :disabled="!hasLeaf"
            :placeholder="hasLeaf ? 'VD: Cho rằng nhân vật chính là thương nhân / Nghi ngờ nhân vật chính đang giấu thân thế / Không biết nhân vật chính là hoàng tử' : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
          ></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeKnow">Đóng</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf || !knowDraft.trim()" @click="addKnow">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!removing"
      title="Xóa nhân vật"
      tone="danger"
      confirm-text="Xóa"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      Xóa "{{ removing?.name }}". Thao tác này được ghi vào tóm tắt mới nhất, xóa tầng có thể hoàn tác.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bbs-npc-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-protagonist-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 18px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Đầu nhóm: Có mặt / Không có mặt là khung xương thông tin của trang này (= phân mức thực tế AI nhận được), dùng nhãn mảnh + một câu giải thích chỉ rõ sự chọn lọc */
.bbs-npc-grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.bbs-npc-grouptag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouptag.is-present {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
/* Cùng khu vực: viên nang rỗng có viền —— nằm giữa "Có mặt (nhấn mạnh đặc ruột)" và "Không có mặt (nền xám đặc)" */
.bbs-npc-grouptag.is-nearby {
  background: transparent;
  border: 1px solid var(--bbs-line-strong);
  padding: 1px 8px; /* Bù lại viền 1px, giữ chiều cao bằng với nhãn đặc ruột */
}
/* Nhãn nhóm Nhân vật chính yếu: cùng màu nền nhấn + biểu tượng ngôi sao, hưởng ứng vị thế "cốt lõi" của nhóm ghim đầu */
.bbs-npc-grouptag.is-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-npc-grouptag.is-protagonist {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-grouphint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouphint.is-local-only {
  color: var(--bbs-warning);
  font-weight: 600;
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— Thẻ nhân vật: thẻ tĩnh lặng cùng kiểu với Vật phẩm / Khung cảnh. Có mặt / Đi cùng chỉ dùng "một vạch màu bên trái" để biểu thị trạng thái,
      không dùng quả cầu tròn lớn nữa —— giữ sự tiết chế cho toàn bộ danh sách, dành sự nhấn mạnh cho vạch dọc đó. —— */
.bbs-npc {
  position: relative;
  display: flex;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* Để vạch màu bên trái bám sát mép bo góc */
}
/* Có mặt: một vạch màu thanh từ ở mép trái */
.bbs-npc.is-present::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
.bbs-protagonist::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-warning);
  opacity: 0.65;
}
/* Cùng khu vực: vạch màu trái mảnh hơn và nhạt hơn —— một nấc nằm giữa "Có mặt (3px@0.5)" và "Không có mặt (không vạch)" */
.bbs-npc.is-nearby::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--bbs-accent);
  opacity: 0.28;
}
/* Đi cùng: vạch màu đậm hơn và đặc hơn, làm dấu hiệu cao nhất của bạn đồng hành */
.bbs-npc.is-follow::before {
  width: 3px;
  opacity: 1;
}
/* Nhân vật chính yếu: toàn bộ vạch màu trái dày hơn và đặc màu, thẻ bắt mắt hơn, hưởng ứng vị thế "diễn viên chính cốt lõi" */
.bbs-npc.is-main::before {
  width: 4px;
  opacity: 1;
}
.bbs-npc.is-main {
  border-color: var(--bbs-line-strong);
}
/* Không có mặt: cả dòng ép tối + khung nét đứt, hưởng ứng sự làm dịu của việc "chỉ gửi tên + thân phận" */
.bbs-npc.is-absent {
  background: transparent;
  border-style: dashed;
}
.bbs-npc.is-absent .bbs-npc-name {
  color: var(--bbs-ink-soft);
}

.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* Dòng đầu: Tên + Giới tính/Tuổi + Vùng thao tác. Chỉ đặt nội dung có độ dài cố định —— các văn bản có độ dài biến thiên như nơi ở, thân phận nhất loạt đưa xuống
   bảng trường bên dưới, nếu không chúng sẽ nuốt hết chiều rộng dòng, ép tên chỉ còn một hai chữ. */
.bbs-npc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  /* Cho phép thu hẹp + lược bớt một dòng: tên dài cắt ngắn hiển thị (di chuột qua title thấy toàn bộ tên),
     không đẩy nút thao tác bên phải vọt ra ngoài thẻ —— thẻ có overflow:hidden, tràn ra là bị cắt mất không nhấn được */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Nhãn nhỏ giới tính: chú thích màu xám nhỏ gọn, đi theo sau tên */
.bbs-npc-gender {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  flex: 0 0 auto;
  white-space: nowrap;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

/* —— Bảng trường: Thân phận / Tính cách / Ngoại hình thống nhất thành dòng căn chỉnh "nhãn phân loại có màu + nội dung".
      Nhãn cùng chiều rộng căn trái thành một cột dọc, dùng màu ngữ nghĩa phân biệt phân loại, nội dung thống nhất cỡ chữ —— trị bệnh "ba dòng cùng xám, phân tầng rối loạn". —— */
.bbs-npc-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-npc-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-npc-field dt {
  flex: 0 0 auto;
  width: 72px;
  text-align: center;
  padding: 1px 4px;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.02em;
  /* Mặc định trung tính, các phân loại cụ thể bên dưới tự nhuộm màu riêng */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* Thân phận: nhãn vàng nhấn mạnh —— đây là loại thông tin thân phận mấu chốt nhất */
.bbs-npc-field.f-title dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-title dd {
  color: var(--bbs-ink);
}
/* Trang phục: nhãn màu ấm —— cốt lõi của tầng tức thời, hưởng ứng với "trạng thái hiện tại có thể thay đổi", nội dung cũng được làm đậm hơn */
.bbs-npc-field.f-outfit dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-field.f-outfit dd {
  color: var(--bbs-ink);
}
/* Trạng thái / Sức khỏe: nhãn màu cảnh báo —— bị thương / bất thường nhìn thoáng qua là nhận ra */
.bbs-npc-field.f-cond dt {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* Tính cách: trung tính hơi ấm (tiếp tục dùng trung tính mặc định, đồng nhất với sự làm dịu của tầng hồ sơ) */
.bbs-npc-field.f-trait dt {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
/* Quan hệ với nhân vật chính: nhãn màu nhấn —— quan hệ là "người đó là gì của ai", quan trọng ngang cấp với thân phận */
.bbs-npc-field.f-rel dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-rel dd {
  color: var(--bbs-ink);
}
/* Mối quan hệ (với các nhân vật khác): nhãn trung tính (chi tiết thứ yếu của tầng hồ sơ) */
/* Ngoại hình: nhãn trung tính (tiếp tục dùng mặc định), làm chi tiết thứ yếu */
/* Nơi ở: viền thanh từ —— vị trí là "người đó hiện đang ở đâu", thuộc tầng tức thời, nhưng nhẹ hơn trang phục/trạng thái một nấc, nên chỉ nhuộm màu chữ không tô nền */
.bbs-npc-field.f-loc dt {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--bbs-accent) 35%, transparent);
  color: var(--bbs-accent);
  /* Viền chiếm 2px, giảm lề trong để nhãn này vẫn cùng chiều rộng chiều cao với các nhãn tô nền khác */
  padding: 0 3px;
}
/* Đang đi cùng: nội dung nơi ở bật sáng màu nhấn, thay thế cho nhãn "Đi cùng" ở dòng đầu trước đây */
.bbs-npc-field.f-loc dd.is-follow {
  color: var(--bbs-accent);
}
/* Chưa rõ nơi ở: chữ nghiêng làm mờ, đồng nhất với tông màu ép tối của nhóm "Không có mặt" */
.bbs-npc-field.f-loc dd.is-nowhere {
  font-style: italic;
  opacity: 0.7;
}
/* Hiểu biết: chỉ xem trước hai mục gần nhất, cắt ngắn một dòng, số mục ghim ở cuối dòng không bị cắt mất; nhấn vào cả dòng để mở xem toàn bộ —— giúp biết đã ghi những gì mà không làm thẻ bị kéo cao */
.bbs-npc-field.f-know {
  cursor: pointer;
}
.bbs-npc-field.f-know dd {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.bbs-npc-know-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.bbs-npc-know-count {
  flex: none;
  font-size: 11px;
  color: var(--bbs-ink-muted);
}
.bbs-npc-field.f-know:hover .bbs-npc-know-text {
  color: var(--bbs-accent);
}

/* Gợi ý giữ chỗ khi nhân vật chính yếu chưa có trạng thái: hướng dẫn ghi bổ sung trạng thái hiện tại, tránh thẻ trống */
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
}

/* Trên PC (hỗ trợ hover) các nút thao tác mặc định ẩn đi, di chuột qua cả thẻ mới hiện lên; màn hình cảm ứng hiển thị thường trực (đồng nhất với trang Vật phẩm) */
@media (hover: hover) {
  .bbs-npc-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-npc:hover .bbs-npc-acts,
  .bbs-npc-acts:focus-within {
    opacity: 1;
  }
}

/* Nút thao tác nội tuyến: sao chép lại từ trang items (scoped không kế thừa, khai báo lại cùng kiểu) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
/* Công tắc Đi cùng: trạng thái kích hoạt bật sáng màu nhấn, biểu đạt "đây là bạn đồng hành" ngay trên bản thân nút bấm */
.bbs-npc-pin.active {
  color: var(--bbs-accent);
}
.bbs-npc-pin.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* Ngôi sao Nhân vật chính yếu: trạng thái kích hoạt bật sáng (cảm giác đặc ruột được biểu đạt bằng tô màu nhấn) */
.bbs-npc-star.active {
  color: var(--bbs-accent);
}
.bbs-npc-star.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* Hộp thoại danh sách hiểu biết: dòng mục = văn bản chính + thao tác cuối dòng; khi có nhiều mục sẽ cuộn trong danh sách, khung thêm mới luôn nhìn thấy */
.bbs-know-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bbs-ink-muted);
}
.bbs-know-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 40vh;
  overflow-y: auto;
}
.bbs-know-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 4px 4px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-know-row textarea {
  flex: 1;
  min-width: 0;
}
.bbs-know-text {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.bbs-know-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
/* Vùng thao tác của thẻ nhân vật chính yếu hiển thị thường trực (nhóm ghim đầu không cần hover mới hiện, bản thân ngôi sao đã là chỉ báo trạng thái) */
.bbs-npc.is-main .bbs-npc-acts {
  opacity: 1;
}
.bbs-protagonist .bbs-npc-acts {
  opacity: 1;
}

.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
/* Tự động điều chỉnh chiều cao: mặc định khớp sát một dòng, nhiều nội dung mới cao lên (v-autosize đo scrollHeight ghi lại);
   min-height đưa về 0, resize giao cho directive, chạm trần sẽ cuộn. */
.bbs-modal-autogrow {
  resize: none;
  min-height: 0;
  max-height: 140px;
  overflow-y: auto;
}
.bbs-modal-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.bbs-modal-check input {
  flex-shrink: 0;
}
.bbs-empty {
  flex: 1;
}

/* —— Hồ sơ nhỏ đời sống —— */
/* Tiêu đề phân khu: chữ tiêu đề nhỏ thông thường cùng kiểu với tiêu đề phân khu trang Tóm tắt, không dùng nhãn viên nang */
.bbs-life-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-npc-grouphead .bbs-add-mini {
  margin-left: auto;
}
/* —— Đầu thu gọn / Vùng chứa: cùng kiểu với thu gọn Kế hoạch / Nghi vấn ở trang Tóm tắt. Toàn bộ dòng tiêu đề có thể nhấn: mũi tên trái + nhãn tiêu đề + nhãn đếm màu vàng —— */
.bbs-fold-head {
  flex: 0 0 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
/* Khi không có gì để thu gọn (không có mục nào) thì thoái hóa thành tiêu đề thường: không mang cảm giác nút bấm, con trỏ mặc định */
.bbs-fold-head.is-static {
  cursor: default;
}
/* Mũi tên thu gọn: mở rộng hướng xuống, thu gọn xoay -90° hướng sang phải; hover cả dòng mới bật sáng màu nhấn */
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
/* Nhãn đếm: viên nang nhỏ viền nền vàng, luôn hiển thị; khi thu gọn lại càng hữu ích —— chỉ rõ đang ẩn bao nhiêu mục */
.bbs-fold-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 9px;
  font-variant-numeric: tabular-nums;
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
/* min-height:0 + overflow:hidden mới có thể ép 0fr thực sự về chiều cao bằng không */
.bbs-fold-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .bbs-fold-caret,
  .bbs-fold-wrap {
    transition: none;
  }
}

.bbs-life-group {
  margin-top: 8px;
}
/* Một mục chi tiết: vùng chứa thẻ cùng họ với thẻ NPC (viền giao diện / bo góc / mặt giấy) */
.bbs-life {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  margin-bottom: 6px;
  overflow: hidden; /* Để vạch màu ghim đầu bám sát mép bo góc */
}
/* Ghim đầu: một vạch màu vàng ở mép trái, hưởng ứng thẻ nhân vật "Có mặt", chỉ rõ "gửi thường trực" */
.bbs-life.is-pinned::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
/* Lắng đọng: khung nét đứt + ép tối, hưởng ứng sự làm dịu của thẻ nhân vật "Không có mặt" */
.bbs-life.is-archive {
  background: transparent;
  border-style: dashed;
}
.bbs-life.is-archive .bbs-life-text {
  color: var(--bbs-ink-soft);
}
.bbs-life-main {
  flex: 1;
  min-width: 0;
}
.bbs-life-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-life-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
/* Nhãn nhỏ chủ đề / thời hạn: nhãn nhỏ có viền cùng kiểu với nhãn thời gian của thẻ kế hoạch */
.bbs-life-tag,
.bbs-life-until {
  font-size: 10.5px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-line);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-life-until {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: color-mix(in srgb, var(--bbs-accent) 40%, transparent);
}
.bbs-life .bbs-npc-acts {
  flex-shrink: 0;
}
.bbs-item-act.active {
  color: var(--bbs-accent);
}

/* ============ Màn hình hẹp: sắp xếp lại thẻ chi tiết đời sống ============ */
@media (max-width: 640px) {
  /* Hồ sơ nhỏ đời sống: nhãn chủ đề/thời hạn và nút thao tác cùng chiếm dòng đỉnh, văn bản chính xếp nguyên dòng ở bên dưới.
     main đổi thành display:contents, để văn bản/nhãn trực tiếp tham gia sắp xếp flex của thẻ, không cần sửa cấu trúc template */
  .bbs-life {
    flex-wrap: wrap;
  }
  .bbs-life-main {
    display: contents;
  }
  .bbs-life-meta {
    order: 1;
    flex: 1 1 auto;
    min-width: 0;
    margin-top: 0;
    align-self: center;
  }
  .bbs-life .bbs-npc-acts {
    order: 2;
    flex-shrink: 0;
    margin-left: auto;
  }
  .bbs-life-text {
    order: 3;
    flex-basis: 100%;
  }
}
</style>
