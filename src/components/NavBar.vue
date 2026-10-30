<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closeBook, ui } from '@/state/ui';
import { updateState } from '@/memory/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

// Khi trang cài đặt có bản cập nhật khả dụng, bật sáng một chấm đỏ ở góc mục điều hướng "Cài đặt" (nhắc người dùng vào trang cài đặt để cập nhật).
function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// Di động: nhấn thêm một lần vào nút điều hướng của trang hiện tại sẽ đóng toàn bộ cửa sổ (đỡ phải với tay lên nút × ở góc trên bên phải); không phải trang hiện tại thì chuyển trang bình thường.
// Chịu sự điều khiển của công tắc ui.navTapClose (mặc định bật, người dùng sợ chạm nhầm có thể tắt trong cài đặt).
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closeBook();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav class="bbs-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbs-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbs-nav-icon-wrap">
        <Icon :name="p.id" class="bbs-nav-icon" />
        <!-- Có bản cập nhật khả dụng: mục cài đặt sáng chấm đỏ ở góc -->
        <span v-if="showUpdateDot(p.id)" class="bbs-nav-dot" aria-label="Có bản cập nhật khả dụng"></span>
      </span>
      <!-- Phía trên có kèm chữ; nhưng ở màn hình hẹp (di động) phía trên cũng chỉ đặt biểu tượng, nếu không một hàng viên nang có chữ xếp ngang không vừa, sẽ đẩy các mục phía sau tràn ra ngoài màn hình -->
      <span v-if="placement === 'top' && !narrow" class="bbs-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbs-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— Phía trên: phân đoạn viên nang, xếp ngang biểu tượng + chữ —— */
.bbs-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-nav.is-top .bbs-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: transparent;
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-nav.is-top .bbs-nav-item:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-nav.is-top .bbs-nav-item.is-active {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-nav.is-top .bbs-nav-icon {
  font-size: 17px;
}

/* —— Phía trên + màn hình hẹp (di động): hạ cấp xuống chỉ còn biểu tượng, kiểu dáng hoàn toàn đồng nhất với điều hướng đáy (kích thước / phối màu / trạng thái chọn),
   chỉ khác vị trí ở trên đỉnh, tránh việc viên nang có chữ tràn ngang đẩy các mục phía sau ra ngoài màn hình —— */
.bbs-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.bbs-nav.is-top.is-narrow .bbs-nav-item {
  flex: 1;
  justify-content: center;
  gap: 0;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
}
.bbs-nav.is-top.is-narrow .bbs-nav-item:hover {
  background: transparent;
  color: var(--bbs-ink-muted);
}
.bbs-nav.is-top.is-narrow .bbs-nav-item.is-active {
  background: transparent;
  color: var(--bbs-accent);
}
.bbs-nav.is-top.is-narrow .bbs-nav-icon {
  font-size: 23px;
}

/* —— Phía dưới: chỉ biểu tượng, chia đều, vùng chạm lớn —— */
.bbs-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--bbs-line);
  background: var(--bbs-surface);
}
.bbs-nav.is-bottom .bbs-nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease);
}
.bbs-nav.is-bottom .bbs-nav-icon {
  font-size: 23px;
}
.bbs-nav.is-bottom .bbs-nav-item.is-active {
  color: var(--bbs-accent);
}

.bbs-nav-item:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
  border-radius: var(--bbs-radius-sm);
}

/* —— Chấm đỏ cập nhật ở góc: gắn ở góc trên bên phải biểu tượng —— */
.bbs-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bbs-nav-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-danger);
  box-shadow: 0 0 0 1.5px var(--bbs-surface);
  pointer-events: none;
}
</style>
