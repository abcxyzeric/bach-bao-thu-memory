<script setup lang="ts">
/**
 * Hộp thoại xác nhận chung. Thay thế confirm() gốc của trình duyệt —— hộp thoại gốc nằm ngoài Shadow DOM, kiểu dáng không đồng nhất.
 * Được điều khiển: dùng v-model:open điều khiển ẩn hiện; nhấn Xác nhận emit confirm, nhấn Hủy / lớp phủ / đóng emit cancel.
 *
 * Teleport tới modalHost (con trực tiếp của .bbs-root, nằm ngoài vùng chứa cuộn .bbs-body):
 * Tránh lỗi "định vị hậu duệ fixed bên trong tổ tiên có thể cuộn bị lệch" trên iOS. Chủ thể vẫn nằm trong shadow root,
 * kiểu dáng scoped và biến --bbs-* vẫn có hiệu lực như thường —— do đó đích to là phần tử trong shadow, chứ không phải Teleport to="body".
 */
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** Văn bản nút xác nhận */
    confirmText?: string;
    /** Văn bản nút hủy */
    cancelText?: string;
    /** Phong cách nút xác nhận: primary=màu chính, danger=nguy hiểm (viền trầm, hover hiện đỏ) */
    tone?: 'primary' | 'danger';
    /** Tên biểu tượng trước nút xác nhận (tùy chọn, như trash) */
    confirmIcon?: string;
    /** Đang bận: vô hiệu hóa nút xác nhận và hiển thị busyText (dùng cho các thao tác bất đồng bộ cần giữ hộp thoại như "Đang cập nhật…") */
    busy?: boolean;
    /** Văn bản nút xác nhận khi đang bận */
    busyText?: string;
    /** Chồng lên trên các hộp thoại khác (z-index cao hơn), ví dụ mở thêm xác nhận xóa bên trong hộp thoại kênh */
    topLayer?: boolean;
  }>(),
  {
    confirmText: 'Xác nhận',
    cancelText: 'Hủy',
    tone: 'primary',
    confirmIcon: '',
    busy: false,
    busyText: '',
    topLayer: false,
  },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

function cancel() {
  emit('update:open', false);
  emit('cancel');
}
function confirm() {
  emit('confirm');
}
</script>

<template>
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbs-modal">
      <div
        v-if="open"
        class="bbs-modal-mask"
        :class="{ 'bbs-modal-mask-top': topLayer }"
        @mousedown.self="cancel"
      >
        <div class="bbs-modal bbs-modal-confirm" role="dialog" aria-modal="true" :aria-label="title">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">{{ title }}</span>
          </header>
          <p class="bbs-confirm-text">
            <slot />
          </p>
          <footer class="bbs-modal-foot">
            <span class="bbs-modal-foot-spacer"></span>
            <button class="bbs-btn" type="button" @click="cancel">{{ cancelText }}</button>
            <button
              class="bbs-btn"
              :class="tone === 'danger' ? 'bbs-btn-danger' : 'bbs-btn-primary'"
              type="button"
              :disabled="busy"
              @click="confirm"
            >
              <Icon v-if="confirmIcon" :name="confirmIcon" />
              {{ busy && busyText ? busyText : confirmText }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Kiểu dáng riêng của hộp thoại xác nhận (các .bbs-modal* cơ bản nằm ở toàn cục trong base.css). */
.bbs-modal-mask-top {
  z-index: 10002;
}
.bbs-modal-confirm {
  max-width: 380px;
}
.bbs-confirm-text {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
}
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* Nút thao tác nguy hiểm: viền trầm, hover mới hiện đỏ, tránh chạm nhầm */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
</style>
