<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import NavBar from '@/components/NavBar.vue';
import FloatingOrb from '@/components/FloatingOrb.vue';
import { getPage } from '@/pages/registry';
import { closeBook, cycleTheme, lastOpenedAt, modalHost, THEMES, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';

// Nút giao diện ở đầu trang: hiển thị biểu tượng và tên của giao diện "tiếp theo", nhấn vào sẽ chuyển sang giao diện đó
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// Có phải màn hình hẹp (di động) hay không: dùng để phán đoán hướng của nav 'auto' + công tắc cử chỉ ngăn kéo.
// Thay đổi của matchMedia không được Vue tự động theo dõi, dùng ref bắc cầu thành phản ứng (reactive).
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));

// —— Nhấn lớp phủ để đóng: chỉ khi cả nhấn xuống và thả ra đều nằm trên chính lớp phủ.
// Tránh: 1) click tổng hợp từ cử chỉ mở trên di động xuyên thấu làm đóng ngay lập tức; 2) nhấn trong cửa sổ rồi kéo ra ngoài cửa sổ làm đóng nhầm.
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closeBook();
  pressedOnOverlay = false;
}

// —— Di động: vuốt xuống để đóng ngăn kéo ——
const dragY = ref(0); // Độ dịch chuyển kéo xuống hiện tại (px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // Vượt quá độ dịch chuyển này khi thả tay sẽ đóng

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // Chỉ đi theo độ dịch chuyển hướng xuống
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closeBook();
  }
  dragY.value = 0;
}

// Kiểu dáng ngăn kéo bám theo tay: khi kéo thì tắt chuyển tiếp (transition), khi thả tay bật lại có chuyển tiếp
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbs-root" :data-theme="ui.theme">
    <!-- Chủ thể Teleport hộp thoại: con trực tiếp của .bbs-root, nằm ngoài vùng chứa cuộn .bbs-body.
         Hộp thoại các trang Teleport đến đây, tránh lỗi "định vị hậu duệ fixed bên trong tổ tiên có thể cuộn bị lệch" trên iOS (xem chi tiết tại state/ui.ts). -->
    <div ref="modalHost"></div>
    <!-- Quả cầu nổi: nằm lại trong shadow mới dùng được biến giao diện --bbs-*; bản thân nó position:fixed bám cạnh, không bị host ảnh hưởng -->
    <FloatingOrb v-if="ui.showOrb" />
    <Transition name="bbs-fade">
      <div
        v-if="ui.open"
        class="bbs-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        @keydown.esc="closeBook"
        tabindex="-1"
      >
        <!-- Cửa sổ thường trực bên trong lớp phủ (không v-if độc lập, không lồng Transition):
             Transition lồng nhau khi v-if cha con cùng lật, leave của con sẽ không kích hoạt (thực tế kiểm nghiệm cửa sổ bị gỡ thẳng theo cha,
             không có bất kỳ hoạt ảnh nào). Đổi sang dùng class của Transition lớp phủ làm bộ chọn hậu duệ dẫn động hoạt ảnh ra vào của cửa sổ
             (xem .bbs-window dưới .bbs-fade-enter-from/.bbs-fade-leave-to trong <style>). -->
        <div class="bbs-window" :style="windowStyle" role="dialog" aria-modal="true" aria-label="Bách Bảo Thư">
            <!-- Tay nắm di động: có thể vuốt xuống để đóng -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbs-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbs-grabber-bar"></span>
            </div>

            <!-- Đầu trang -->
            <header class="bbs-head">
              <span class="bbs-brand-name">Bách Bảo Thư</span>
              <div class="bbs-head-actions">
                <button class="bbs-icon-btn" type="button" :title="`Chuyển giao diện: ${nextTheme.label}`" @click="cycleTheme">
                  <Icon :name="nextTheme.icon" />
                </button>
                <button class="bbs-icon-btn" type="button" title="Đóng" @click="closeBook">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" :narrow="narrowFlag" />

            <main class="bbs-body">
              <Transition name="bbs-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" :narrow="narrowFlag" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— Tay nắm di động: ẩn trên máy tính —— */
.bbs-grabber {
  display: none;
}

.bbs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  flex: 0 0 auto;
}

.bbs-brand-name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--bbs-ink);
}

.bbs-head-actions {
  display: flex;
  gap: 8px;
}
.bbs-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-icon-btn:hover {
  color: var(--bbs-ink);
  background: var(--bbs-line-strong);
}
.bbs-icon-btn:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

/* —— Chuyển tiếp: lớp phủ mờ dần vào/ra, cửa sổ liên động nhờ class chuyển tiếp của lớp phủ (xem bên dưới) —— */
.bbs-fade-enter-active,
.bbs-fade-leave-active {
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fade-enter-from,
.bbs-fade-leave-to {
  opacity: 0;
}

/* Cửa sổ ra vào: được dẫn động bởi class của Transition lớp phủ làm bộ chọn hậu duệ (bản thân cửa sổ không bọc Transition nữa ——
   khi v-if cha con cùng lật thì leave của Transition con không kích hoạt, thực tế cửa sổ sẽ bị gỡ thẳng không có hoạt ảnh).
   Hai đầu vào ra dùng cùng transform → đối xứng. Trên PC hơi nâng lên + phóng to nhẹ; trên di động trong media query đổi thành trượt về đáy. */
.bbs-fade-enter-from .bbs-window,
.bbs-fade-leave-to .bbs-window {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbs-page-enter-active,
.bbs-page-leave-active {
  transition:
    opacity 0.13s var(--bbs-ease),
    transform 0.13s var(--bbs-ease);
}
.bbs-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbs-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* Chuyển tiếp cửa sổ: dùng chung cho ra vào (transform+opacity) và bật lại khi kéo (transform);
   khi kéo bám theo tay sẽ bị transition:none của inline style ghi đè, khi thả tay bật lại sẽ đi theo đường này. */
.bbs-window {
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}

/* ============ Di động: tay nắm + ngăn kéo trượt lên khi vào ============ */
@media (max-width: 640px) {
  .bbs-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbs-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbs-radius-pill);
    background: var(--bbs-line-strong);
  }
  .bbs-head {
    padding: 4px 16px 12px;
  }
  /* Ngăn kéo trượt từ đáy lên / trượt về đáy (thuần dịch chuyển, không làm mờ trong suốt) */
  .bbs-fade-enter-from .bbs-window,
  .bbs-fade-leave-to .bbs-window {
    opacity: 1;
    transform: translateY(100%) scale(1);
  }
  /* Lớp phủ trễ mờ dần khi rời đi: để ngăn kéo trượt về đáy trước, nền rút lui sau cùng, nếu không cửa sổ sẽ bị kéo trong suốt cùng lớp phủ,
     quá trình trượt sẽ không nhìn thấy (cửa sổ là phần tử con của lớp phủ, opacity cha sẽ tổng hợp lên con). */
  .bbs-fade-leave-active {
    transition: opacity 0.16s var(--bbs-ease) 0.18s;
  }
  /* Cửa sổ trượt về đáy phải đi hết trọn vẹn --bbs-dur, không bị thời lượng ngắn của lớp phủ phía trên kéo theo (transition mỗi bên độc lập, ở đây chỉ nhấn mạnh) */
}
</style>
