<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { appendOpToLatestLeaf, editItem } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { computed, ref } from 'vue';

const newName = ref('');

// Vật phẩm / kế hoạch là dữ liệu dẫn xuất được phát lại từ tóm tắt lá, thao tác thủ công ghi vào "lá hợp lệ mới nhất".
// Khi chưa có bất kỳ lá hợp lệ nào thì không có chỗ gắn kết, cấm thêm thủ công.
const hasLeaf = computed(() => derivedMeta.hasLeaf);

function addItem() {
  const name = newName.value.trim();
  if (!name) return;
  if (!appendOpToLatestLeaf({ items: { add: [{ name }] } })) return;
  newName.value = '';
}

function removeItem(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  appendOpToLatestLeaf({ items: { remove: [it.name] } });
}

/* —— Hộp thoại chỉnh sửa: đổi tên / số lượng / mô tả. Số lượng để trống = giữ nguyên (update không thể xóa trống, muốn xóa trống số lượng vui lòng xóa đi rồi tạo lại) —— */
interface ItemEditing {
  oldName: string;
  name: string;
  qty: string; // Lưu dạng văn bản, trống = không đổi số lượng
  desc: string;
  carried: boolean; // Có mang theo người hay không
  location: string; // Nơi cất giữ khi không mang theo người
}
const editing = ref<ItemEditing | null>(null);

function openEdit(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  editing.value = {
    oldName: it.name,
    name: it.name,
    qty: typeof it.qty === 'number' ? String(it.qty) : '',
    desc: it.desc ?? '',
    carried: it.carried !== false, // Lược bỏ / true được coi là mang theo người
    location: it.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  // qty dùng String() dự phòng: v-model của type="number" sẽ chuyển giá trị thành number (hành vi mặc định của Vue đối với number input),
  // gọi .trim() trực tiếp sẽ ném lỗi vì "number không có trim" → saveEdit bị ngắt, hộp thoại không đóng (biểu hiện là nhấn Lưu không có phản hồi).
  const qtyStr = String(e.qty).trim();
  const qty = qtyStr === '' ? undefined : Number(qtyStr);
  // Mang theo người → xóa trống nơi cất giữ; không mang theo người → dùng địa điểm đã điền
  editItem(e.oldName, {
    name: e.name,
    qty: qty !== undefined && Number.isFinite(qty) ? qty : undefined,
    desc: e.desc,
    carried: e.carried,
    location: e.carried ? '' : e.location,
  });
  editing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title bbs-title-sub">Vật phẩm</h2>
    <SummaryOnlyNotice subject="danh sách và biến động vật phẩm" />

    <div class="bbs-additem">
      <input
        v-model="newName"
        class="bbs-input"
        type="text"
        :placeholder="hasLeaf ? 'Thêm vật phẩm thủ công…' : 'Cần có tóm tắt trước mới có thể thêm thủ công'"
        :disabled="!hasLeaf"
        @keydown.enter="addItem"
      />
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf" @click="addItem">Thêm</button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="memory.items.length" class="bbs-item-list">
      <div v-for="it in memory.items" :key="it.id" class="bbs-item">
        <div class="bbs-item-head">
          <div class="bbs-item-main">
            <span class="bbs-item-name" :title="it.name">{{ it.name }}</span>
            <span v-if="typeof it.qty === 'number'" class="bbs-item-qty">×{{ it.qty }}</span>
            <span v-if="it.carried === false && it.location" class="bbs-item-loc">
              <Icon name="scenes" /><span class="bbs-item-loc-text">{{ it.location }}</span>
            </span>
          </div>
          <span class="bbs-item-acts">
            <button class="bbs-item-act" type="button" title="Chỉnh sửa" @click="openEdit(it.id)">
              <Icon name="edit" />
            </button>
            <button class="bbs-item-act bbs-item-del" type="button" title="Xóa" @click="removeItem(it.id)">
              <Icon name="close" />
            </button>
          </span>
        </div>
        <span v-if="it.desc" class="bbs-item-desc">{{ it.desc }}</span>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="items" /></span>
      <p>Tạm thời trống rỗng. Vật phẩm nhận được khi tóm tắt sẽ tự động đăng ký, cũng có thể thêm thủ công.</p>
    </div>

    <!-- Hộp thoại chỉnh sửa: Teleport ra khỏi vùng chứa cuộn, xem ModalMask -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa vật phẩm">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">Chỉnh sửa vật phẩm</span>
          <button class="bbs-item-act" type="button" title="Đóng" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Tên</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="Tên vật phẩm" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Số lượng (để trống = không đếm)</span>
          <input v-model="editing.qty" class="bbs-input" type="number" min="0" placeholder="Không điền thì không hiển thị số lượng" />
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.carried" type="checkbox" />
          <span class="bbs-modal-label">Mang theo bên mình (bỏ tích để chỉ định nơi cất giữ)</span>
        </label>
        <label v-if="!editing.carried" class="bbs-modal-field">
          <span class="bbs-modal-label">Địa điểm cất giữ</span>
          <input v-model="editing.location" class="bbs-input" type="text" placeholder="VD: Kho vũ khí, Ở nhà" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">Mô tả</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="Tùy chọn"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">Hủy</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">Lưu</button>
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
.bbs-additem {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.bbs-item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-item-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-item-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0; /* Cho phép tên dài thu hẹp trong flex, không chèn ép các nút thao tác */
  flex: 1;
}
.bbs-item-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--bbs-ink);
  /* Cho phép thu hẹp + lược bớt một dòng: tên dài cắt ngắn hiển thị (di chuột qua title thấy toàn bộ tên),
     không tràn khỏi vùng chứa đè lên nút thao tác bên phải; số lượng / nơi cất giữ vẫn bám sát phía sau */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-item-qty {
  font-size: 12px;
  color: var(--bbs-accent);
  flex-shrink: 0;
}
.bbs-item-loc {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  min-width: 0; /* Khi tên địa điểm dài thì nhãn này thu hẹp và cắt ngắn, không đẩy tên vật phẩm xuống dòng */
  flex: 1 1 auto; /* Chiếm chiều rộng còn lại sau tên/số lượng; quá dài thì lược bớt trong phạm vi bản thân */
}
.bbs-item-loc-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-item-desc {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
.bbs-item-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
/* Trên PC (hỗ trợ hover) các nút thao tác mặc định ẩn đi, di chuột qua cả dòng mới hiện lên, danh sách sạch sẽ hơn;
   màn hình cảm ứng không có hover, giữ hiển thị thường trực (nếu không điện thoại không nhấn ra được). */
@media (hover: hover) {
  .bbs-item-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-item:hover .bbs-item-acts,
  .bbs-item-acts:focus-within {
    opacity: 1;
  }
}
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
</style>
