<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { buildSceneLocationIndex, editSceneDesc, findCurrentSceneId, removeScene, reparentScene, resolveSceneLocationId, sceneId, upsertScene } from '@/memory/apply';
import { buildTravelDraft } from '@/memory/inject';
import { derivedMeta, memory } from '@/memory/store';
import { closeBook } from '@/state/ui';
import { appendChatInput, getContext } from '@/st/context';
import { toast } from '@/st/toast';
import type { MemItem, MemScene } from '@/memory/types';
import { computed, nextTick, ref, watch } from 'vue';

// Khung cảnh là dữ liệu dẫn xuất được phát lại từ tóm tắt lá, thao tác thủ công ghi vào "lá hợp lệ mới nhất"; khi không có lá hợp lệ thì không có chỗ gắn kết.
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// Phán đoán màn hình cảm ứng: bỏ qua tự động focus hộp thoại (trên di động tự động focus sẽ bật bộ gõ che khuất giao diện), đồng nhất với trang Tóm tắt.
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* —— Trạng thái thu gọn: trạng thái UI thuần trên máy, chia thùng theo cuộc trò chuyện lưu ở localStorage (chuyển đi rồi quay lại vẫn giữ) —— */
const COLLAPSE_KEY = 'bbs.scenes.collapsed.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
function loadCollapsed(): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    return new Set<string>(Array.isArray(all[chatKey()]) ? all[chatKey()] : []);
  } catch {
    return new Set();
  }
}
// Tập hợp id các nút bị thu gọn (phản ứng); mặc định mở rộng toàn bộ
const collapsed = ref<Set<string>>(loadCollapsed());
function persistCollapsed() {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    all[chatKey()] = [...collapsed.value];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* Khi localStorage không khả dụng thì im lặng */
  }
}
function toggleCollapse(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next; // Đổi tham chiếu kích hoạt tính phản ứng
  persistCollapsed();
}

/* —— Lắp ghép các scenes phẳng thành cây lồng nhau theo parentId, ưu tiên chiều sâu trải phẳng thành các dòng có thể kết xuất kèm depth —— */
interface SceneRow {
  node: MemScene;
  depth: number;
  /** Dòng đó có nằm trên mạch tổ tiên của "nơi ở hiện tại" (gốc → địa điểm hiện tại) hay không */
  onCurrentPath: boolean;
  /** Có phải chính là bản thân địa điểm hiện tại hay không */
  isCurrent: boolean;
  /** Có phải con cuối cùng trong cùng cấp hay không (dùng để vẽ kết thúc đường dẫn hướng) */
  lastChild: boolean;
  /** Có nút con hay không (quyết định có hiển thị mũi tên thu gọn hay không) */
  hasChildren: boolean;
  /** Hiện có đang ở trạng thái thu gọn (cây con đã thu lại) hay không */
  isCollapsed: boolean;
}

// Nút đang ở hiện tại: dùng chung apply.findCurrentSceneId với đầu tiêm (ưu tiên locationPath có thẩm quyền, nếu không thì siết chặt khớp mờ).
// Một nguồn duy nhất, đảm bảo tô sáng ở trang Khung cảnh = chuỗi "Địa điểm hiện tại" trong lời nhắc, không còn phân nhánh.
const currentId = computed(() =>
  findCurrentSceneId(memory.scenes, memory.state.location || '', memory.state.locationPath),
);

// Tập hợp id mạch tổ tiên (bao gồm bản thân) của nơi ở hiện tại
const currentChain = computed(() => {
  const ids = new Set<string>();
  const byId = new Map(memory.scenes.map(s => [s.id, s]));
  let cur = byId.get(currentId.value);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ids.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return ids;
});

// Khi địa điểm hiện tại thay đổi, tự động mở rộng mạch mới một lần (tránh việc "tôi đang ở đâu" bị thu gọn giấu mất); nhưng chỉ kích hoạt khi currentId thực sự
// thay đổi, sau đó người dùng vẫn có thể thu gọn thủ công mạch đó —— đây chính là điểm khác biệt mấu chốt so với "ép mở rộng" cũ.
watch(
  () => currentId.value,
  () => {
    const next = new Set(collapsed.value);
    let changed = false;
    for (const cid of currentChain.value) {
      if (next.delete(cid)) changed = true;
    }
    if (changed) {
      collapsed.value = next;
      persistCollapsed();
    }
  },
);

const rows = computed<SceneRow[]>(() => {
  const byParent = new Map<string, MemScene[]>();
  for (const s of memory.scenes) {
    const arr = byParent.get(s.parentId) ?? [];
    arr.push(s);
    byParent.set(s.parentId, arr);
  }
  for (const arr of byParent.values()) {
    // Cùng cấp: xếp theo thứ tự tạo, rồi theo tên
    arr.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }
  const out: SceneRow[] = [];
  const walk = (parentId: string, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    children.forEach((node, i) => {
      const kids = byParent.get(node.id) ?? [];
      // onCurrentPath chỉ dùng để tô sáng đường trục chính; việc thu gọn hoàn toàn do collapsed của người dùng quyết định (không ép mở rộng nữa,
      // nếu không các dòng trên mạch "Đang ở" nhấn vào sẽ không thu lại được). Khi mạch thay đổi sẽ do watch tự động mở rộng một lần, xem bên trên.
      const onCurrentPath = currentChain.value.has(node.id);
      const isCollapsed = kids.length > 0 && collapsed.value.has(node.id);
      out.push({
        node,
        depth,
        onCurrentPath,
        isCurrent: node.id === currentId.value,
        lastChild: i === children.length - 1,
        hasChildren: kids.length > 0,
        isCollapsed,
      });
      if (!isCollapsed) walk(node.id, depth + 1); // Nếu thu gọn thì bỏ qua toàn bộ đoạn cây con
    });
  };
  walk('', 0); // Gốc = parentId rỗng
  return out;
});

// Vật phẩm cất giữ tại một địa điểm nào đó: phân giải tới sceneId duy nhất trước, tránh việc địa điểm con bị gắn nhầm lên toàn bộ tổ tiên / nhánh phụ.
const sceneItems = computed(() => {
  const index = buildSceneLocationIndex(memory.scenes);
  const out = new Map<string, MemItem[]>();
  for (const item of memory.items) {
    if (item.carried !== false || !item.location) continue;
    const sceneId = resolveSceneLocationId(memory.scenes, item.location, index);
    if (!sceneId) continue;
    const arr = out.get(sceneId) ?? [];
    arr.push(item);
    out.set(sceneId, arr);
  }
  return out;
});

function itemsAt(node: MemScene) {
  return sceneItems.value.get(node.id) ?? [];
}

// Số lượng địa điểm hậu duệ hiển thị khi thu gọn (toàn bộ đoạn cây con, khớp tiền tố id)
function childCount(node: MemScene): string {
  const prefix = `${node.id}/`;
  const n = memory.scenes.filter(s => s.id.startsWith(prefix)).length;
  return n ? `+${n}` : '';
}

/** Tùy chọn thả xuống của địa điểm cấp trên: toàn bộ các nút sắp xếp theo đường dẫn đầy đủ (cha trước con), depth quyết định tiền tố thụt lề. Không bị ảnh hưởng bởi thu gọn. */
const sceneOptions = computed(() =>
  [...memory.scenes]
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))
    .map(s => ({ id: s.id, name: s.name, depth: s.path.length - 1 })),
);

/** Chuyển thành tùy chọn BbsSelect: phân cấp vẫn dùng khoảng trắng toàn giác để thụt lề (trong menu tự vẽ vẫn giữ nguyên khoảng trắng đầu dòng, không bị gộp như HTML) */
function parentOptions(list: { id: string; name: string; depth: number }[]) {
  return [
    { value: '', label: '(Địa điểm cấp cao nhất)' },
    ...list.map(o => ({ value: o.id, label: '　'.repeat(o.depth) + o.name })),
  ];
}

/* —— Thêm địa điểm mới (hộp thoại): chọn cấp trên (đường dẫn đã có / cấp cao nhất) + điền tên mới + mô tả —— */
const composerOpen = ref(false);
const newParentId = ref(''); // id cấp trên đã chọn; '' = cấp cao nhất
const newName = ref('');
const newDesc = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

function openComposer() {
  if (!hasLeaf.value) return;
  newParentId.value = currentId.value || ''; // Mặc định gắn dưới địa điểm hiện tại, thuận tay
  newName.value = '';
  newDesc.value = '';
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addScene() {
  const name = newName.value.trim();
  // Mô tả có thể để trống: cùng quy tắc với AI (tạo điểm rộng rãi, mô tả nghiêm ngặt), chưa viết ra mô tả cũng ghi nhận địa điểm lại trước
  if (!name) return;
  const parent = memory.scenes.find(s => s.id === newParentId.value);
  const path = parent ? [...parent.path, name] : [name];
  if (memory.scenes.some(s => s.id === sceneId(path))) {
    toast(`Địa điểm "${path.join(' › ')}" đã tồn tại, vui lòng chỉnh sửa trực tiếp địa điểm gốc.`, 'warning');
    return;
  }
  if (!upsertScene(path, newDesc.value)) {
    toast('Không thể lưu địa điểm, vui lòng xác nhận cuộc trò chuyện hiện tại đã có tóm tắt hợp lệ.', 'error');
    return;
  }
  composerOpen.value = false;
}

/* —— Hộp thoại chỉnh sửa: đổi tên cấp này + cấp trên (chọn thả xuống) + mô tả —— */
interface SceneEditing {
  id: string; // id nút gốc
  path: string[]; // Đường dẫn đầy đủ gốc
  name: string;
  parentId: string; // id cấp trên đã chọn; '' = cấp cao nhất
  desc: string;
}
const editing = ref<SceneEditing | null>(null);

function openEdit(node: MemScene) {
  editing.value = {
    id: node.id,
    path: node.path,
    name: node.name,
    parentId: node.parentId,
    desc: node.desc ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}

/** Cấp trên có thể chọn ở trạng thái chỉnh sửa: loại trừ bản thân nút và hậu duệ của nó (nếu không sẽ biến nút thành tổ tiên của chính mình, tạo thành vòng lặp). */
const editParentOptions = computed(() => {
  const e = editing.value;
  if (!e) return sceneOptions.value;
  const selfPrefix = `${e.id}/`;
  return sceneOptions.value.filter(o => o.id !== e.id && !o.id.startsWith(selfPrefix));
});

function saveEdit() {
  const e = editing.value;
  const name = e?.name.trim();
  if (!e || !name) return;
  const desc = e.desc.trim(); // Có thể trống: xóa trống = xóa bỏ mô tả, giữ lại nút
  const parent = memory.scenes.find(s => s.id === e.parentId);
  const newPath = parent ? [...parent.path, name] : [name];
  const pathChanged = sceneId(newPath) !== sceneId(e.path);

  let saved = false;
  if (pathChanged) {
    if (memory.scenes.some(s => s.id === sceneId(newPath))) {
      toast(`Địa điểm "${newPath.join(' › ')}" đã tồn tại, không thể ghi đè hoặc gộp.`, 'warning');
      return;
    }
    // Đổi cha / đổi tên / chèn tầng: hoàn tất nguyên tử bằng một lệnh reparent, dịch chuyển cả cây con + tiện thể ghi mô tả tên mới (xóa trống = xóa mô tả gốc)
    saved = reparentScene(e.path, newPath, { [name]: desc });
  } else {
    saved = editSceneDesc(e.path, desc);
  }
  if (!saved) {
    toast('Không thể lưu địa điểm, vui lòng xác nhận cuộc trò chuyện hiện tại đã có tóm tắt hợp lệ.', 'error');
    return;
  }
  editing.value = null;
}

/* —— Xác nhận xóa (kèm theo cấp con) —— */
const removing = ref<MemScene | null>(null);
function askRemove(node: MemScene) {
  removing.value = node;
}
function confirmRemove() {
  if (removing.value) removeScene(removing.value.path);
  removing.value = null;
}
const removeChildCount = computed(() => {
  const n = removing.value;
  if (!n) return 0;
  const prefix = `${n.id}/`;
  return memory.scenes.filter(s => s.id.startsWith(prefix)).length;
});

/* —— Đi tới địa điểm: chỉ tạo bản nháp, không sửa đổi trước trạng thái dẫn xuất —— */
const traveling = ref<MemScene | null>(null);
function askTravel(node: MemScene) {
  traveling.value = node;
}
function confirmTravel() {
  const target = traveling.value;
  if (!target) return;
  if (!appendChatInput(buildTravelDraft(target))) {
    toast('Không thể ghi vào khung nhập liệu của ST', 'error');
    return;
  }
  traveling.value = null;
  closeBook();
  toast('Bản nháp đi tới địa điểm đã được điền vào khung nhập liệu', 'success');
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">Khung cảnh</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? 'Thêm địa điểm thủ công' : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>
    <SummaryOnlyNotice subject="địa điểm, phân cấp khung cảnh và vị trí hiện tại" />

    <hr class="bbs-rule" />

    <TransitionGroup v-if="rows.length" tag="div" name="scene" class="bbs-scene-tree">
      <div
        v-for="r in rows"
        :key="r.node.id"
        class="bbs-scene-row"
        :class="{ 'is-current': r.isCurrent, 'on-path': r.onCurrentPath }"
        :style="{ '--depth': r.depth }"
      >
        <!-- Đường ray dẫn hướng phân cấp: mỗi cấp một đường kẻ dọc mảnh, trên mạch hiện tại sẽ bật sáng thành trục chính -->
        <span v-for="d in r.depth" :key="d" class="bbs-scene-rail" :class="{ active: r.onCurrentPath && d <= r.depth }"></span>

        <!-- Toàn bộ thẻ có nút con có thể nhấn để thu gọn (bao gồm vùng mô tả/vật phẩm); thẻ lá không nhấn được. Nút thao tác @click.stop không kích hoạt -->
        <div
          class="bbs-scene-card"
          :class="{ clickable: r.hasChildren }"
          @click="r.hasChildren && toggleCollapse(r.node.id)"
        >
          <div class="bbs-scene-head">
            <span
              v-if="r.hasChildren"
              class="bbs-scene-toggle"
              :class="{ collapsed: r.isCollapsed }"
              :title="r.isCollapsed ? 'Mở rộng địa điểm trực thuộc' : 'Thu gọn địa điểm trực thuộc'"
            >
              <Icon name="chevron" />
            </span>
            <span class="bbs-scene-name">{{ r.node.name }}</span>
            <span v-if="r.isCurrent" class="bbs-scene-here"><Icon name="scenes" />Đang ở</span>
            <span v-else-if="r.isCollapsed" class="bbs-scene-count">{{ childCount(r.node) }}</span>
            <span class="bbs-scene-acts">
              <button v-if="!r.isCurrent" class="bbs-item-act" type="button" title="Đi tới" @click.stop="askTravel(r.node)"><Icon name="navigate" /></button>
              <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click.stop="openEdit(r.node)"><Icon name="edit" /></button>
              <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click.stop="askRemove(r.node)"><Icon name="trash" /></button>
            </span>
          </div>
          <p v-if="r.node.desc" class="bbs-scene-desc">{{ r.node.desc }}</p>
          <div v-if="itemsAt(r.node).length" class="bbs-scene-items">
            <span v-for="it in itemsAt(r.node)" :key="it.id" class="bbs-scene-chip">
              <Icon name="items" />{{ it.name }}<i v-if="typeof it.qty === 'number'">×{{ it.qty }}</i>
            </span>
          </div>
        </div>
      </div>
    </TransitionGroup>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="scenes" /></span>
      <p>Chưa có địa điểm nào từng đi qua. Khi tóm tắt sẽ ghi lại các khung cảnh đã đi qua, cũng có thể nhấn nút "+" ở góc trên bên phải để thêm thủ công.</p>
    </div>

    <!-- Hộp thoại thêm mới: chọn cấp trên (địa điểm đã có / cấp cao nhất) + điền tên mới + mô tả -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="Thêm địa điểm">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Thêm địa điểm</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Địa điểm cấp trên (chọn từ địa điểm đã có, hoặc đặt làm cấp cao nhất)</span>
          <BbsSelect v-model="newParentId" :options="parentOptions(sceneOptions)" aria-label="Địa điểm cấp trên" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input ref="nameInput" v-model="newName" class="bbs-input" type="text" placeholder="Tên địa điểm mới" @keydown.enter="addScene" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả (tùy chọn)</span>
          <textarea v-model="newDesc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="Nơi này là gì, có đặc điểm gì"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newName.trim()" @click="addScene">Thêm</button>
        </footer>
      </div>
    </ModalMask>

    <!-- Hộp thoại chỉnh sửa: Teleport ra khỏi vùng chứa cuộn, xem ModalMask -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa địa điểm">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa địa điểm</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <p class="bbs-scene-crumb">{{ editing.path.join(' › ') }}</p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="Tên địa điểm" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">Địa điểm cấp trên (sửa ở đây sẽ di chuyển cùng toàn bộ các địa điểm trực thuộc)</span>
          <BbsSelect v-model="editing.parentId" :options="parentOptions(editParentOptions)" aria-label="Địa điểm cấp trên" />
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả (tùy chọn)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="Nơi này là gì, có đặc điểm gì"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">Lưu</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!traveling"
      title="Đi tới địa điểm"
      confirm-text="Điền vào khung nhập liệu"
      confirm-icon="navigate"
      @update:open="v => { if (!v) traveling = null; }"
      @confirm="confirmTravel"
      @cancel="traveling = null"
    >
      Xác nhận đi tới "{{ traveling?.path.join(' › ') }}"? Sẽ tạo bản nháp theo trạng thái địa điểm sau khi đến nơi; không tự động gửi đi, cũng không sửa đổi trước trí nhớ. Khi khung nhập liệu đã có sẵn nội dung sẽ nối thêm vào cuối.
    </ConfirmDialog>

    <ConfirmDialog
      :open="!!removing"
      title="Xóa địa điểm"
      tone="danger"
      confirm-text="Xóa"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      Xóa "{{ removing?.name }}"<template v-if="removeChildCount">, cùng {{ removeChildCount }} địa điểm trực thuộc của nó</template>. Thao tác này được ghi vào tóm tắt mới nhất, xóa tầng có thể hoàn tác.
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* —— Cây lồng nhau: đường ray dẫn hướng phân cấp là yếu tố nhận diện của trang này —— */
.bbs-scene-tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative; /* Làm ngữ cảnh định vị cho position:absolute của dòng rời đi */
}
.bbs-scene-row {
  display: flex;
  align-items: stretch;
}

/* Hoạt ảnh mở rộng / thu gọn: vào ra mờ dần + trượt nhẹ lên trên; các dòng còn lại dùng move lấp chỗ mượt mà.
   Dùng 0.16s nhanh hơn --bbs-dur (0.28s), tương tác thu gọn phải dứt khoát. */
.scene-enter-active,
.scene-leave-active {
  transition: opacity 0.16s var(--bbs-ease), transform 0.16s var(--bbs-ease);
}
.scene-enter-from,
.scene-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
/* Dòng rời đi tách khỏi luồng tài liệu, tránh việc nó chiếm chỗ làm các dòng phía dưới lấp chỗ không mượt */
.scene-leave-active {
  position: absolute;
  width: 100%;
}
.scene-move {
  transition: transform 0.16s var(--bbs-ease);
}
/* Mỗi cấp một rãnh đường ray rộng 14px, ở giữa là một đường kẻ dọc hairline */
.bbs-scene-rail {
  flex: 0 0 14px;
  position: relative;
}
.bbs-scene-rail::before {
  content: '';
  position: absolute;
  left: 6px;
  top: -6px; /* Nối khe hở với dòng trên, liền thành đường xuyên suốt */
  bottom: -6px;
  width: 1px;
  background: var(--bbs-line);
}
/* Mạch đang ở hiện tại: đường ray bật sáng thành trục chính */
.bbs-scene-rail.active::before {
  background: var(--bbs-accent);
  opacity: 0.55;
  width: 2px;
  left: 5px;
}

.bbs-scene-card {
  flex: 1 1 auto;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
/* Bản thân địa điểm hiện tại: nhấn mạnh đặc ruột, làm điểm cuối của mạch */
.bbs-scene-row.is-current .bbs-scene-card {
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-scene-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Thẻ có nút con: toàn bộ thẻ nhấn được để thu gọn, gợi ý con trỏ + khi hover mũi tên đậm lên */
.bbs-scene-card.clickable {
  cursor: pointer;
}
.bbs-scene-card.clickable:hover .bbs-scene-toggle {
  color: var(--bbs-ink);
}
/* Mũi tên thu gọn: khi mở rộng hướng xuống (nguyên dạng chevron), khi thu gọn hướng sang phải (-90°). Chỉ báo thuần thị giác, thao tác nhấn do toàn dòng đảm nhận. */
.bbs-scene-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-right: -2px;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  transition: transform 0.16s var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-scene-toggle.collapsed {
  transform: rotate(-90deg);
}
/* Trạng thái thu gọn: hiển thị số lượng hậu duệ đang ẩn */
.bbs-scene-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: var(--bbs-font-mono);
  color: var(--bbs-ink-muted);
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
}
.bbs-scene-name {
  font-family: var(--bbs-font-mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-scene-here {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 7px 1px 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  letter-spacing: 0.02em;
}
.bbs-scene-acts {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.bbs-scene-desc {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbs-ink-soft);
}
.bbs-scene-items {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}
.bbs-scene-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-scene-chip i {
  font-style: normal;
  color: var(--bbs-accent);
}

/* Đường dẫn breadcrumb trong hộp thoại chỉnh sửa */
.bbs-scene-crumb {
  margin: 0 0 2px;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* Tái sử dụng kiểu dáng nút thao tác nội tuyến của trang items (scoped không kế thừa, ở đây khai báo lại cùng kiểu) */
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
.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
.bbs-empty {
  flex: 1;
}
</style>
