<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { openBook, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

/**
 * Quả cầu nổi —— "thẻ đánh dấu sách" của Bách Bảo Thư vươn vào trang chủ.
 *
 * Hình thái: dải ruy băng dọc + khuyết đuôi én ở đáy (clip-path), hưởng ứng biểu tượng bookmark của thương hiệu; ảnh tùy chỉnh cũng được
 * cắt thành cùng đường viền thẻ đánh dấu sách, ảnh bất kỳ đều gom vào hình dáng thống nhất (đây là thủ pháp đặc trưng tạo khoảng cách với "lại một nút fab tròn nữa").
 *
 * Hành vi (theo yêu cầu người dùng): kéo tự do —— kéo ra giữa màn hình thì dừng ở giữa; kéo tới gần mép trái/phải mới hít bám cạnh.
 * Khi bám cạnh sẽ ẩn một nửa ở mép (chỉ lộ một dải hẹp), hover/focus/chạm mới trượt nguyên dải ra; dừng ở giữa thì hiển thị thường trực.
 *
 * Vị trí lưu ở localStorage trên máy (trạng thái thuần thị giác, kích thước màn hình mỗi thiết bị khác nhau, đồng bộ ngược lại sẽ chạy ra ngoài màn hình).
 * Công tắc và biểu tượng tùy chỉnh (ui.orbImage, đường dẫn máy chủ) đồng bộ đa thiết bị, do phần cài đặt đảm nhận.
 */

// Kích thước đi theo hình dáng + kích thước cơ sở của người dùng (ui.orbSize): thẻ sách theo tỷ lệ rộng/cao 0.78 (chữ nhật đứng), tròn/vuông là hình vuông cạnh bằng nhau.
// Tính toán kéo/hít bám và kích thước nội tuyến đều đọc từ nó.
const orbW = computed(() => (ui.orbShape === 'bookmark' ? Math.round(ui.orbSize * 0.78) : ui.orbSize));
const orbH = computed(() => ui.orbSize);
const SNAP_ZONE = 56; // Khi thả tay cách mép trái/phải ≤ giá trị này sẽ hít bám cạnh
const CLICK_SLOP = 6; // Độ dịch chuyển < giá trị này được coi là nhấn chứ không phải kéo
const POS_KEY = 'bbs.orb.pos.v1';

type Dock = 'left' | 'right' | 'none';
interface OrbPos {
  dock: Dock;
  /** Khi bám cạnh thì vô nghĩa; khi free là tọa độ x góc trên bên trái (px) */
  x: number;
  /** Tọa độ y góc trên bên trái (px), cả ba trạng thái đều dùng */
  y: number;
}

function loadPos(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* ignore */
  }
  // Mặc định: bám cạnh phải, căn giữa theo chiều dọc hơi lệch xuống dưới
  return { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.6) };
}

const pos = reactive<OrbPos>(loadPos());
const dragging = ref(false);
const awake = ref(false); // hover/focus/kéo → trạng thái bám cạnh trượt nguyên dải ra
let activePointer: number | null = null;
let startX = 0;
let startY = 0;
let moved = 0; // Độ dịch chuyển tích lũy, dùng để phán đoán nhấn/kéo

// Sau khi vào khung nhìn thì kẹp tọa độ vào phạm vi nhìn thấy được (đổi màn hình nhỏ hơn / xoay màn hình không bị chạy ra ngoài)
function clampToViewport(): void {
  const maxY = Math.max(0, window.innerHeight - orbH.value);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - orbW.value);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// —— Kiểu dáng định vị: bám cạnh dùng neo left/right + translateX điều khiển ẩn/hiện; free dùng x/y tuyệt đối ——
const orbStyle = computed(() => {
  const base: Record<string, string> = {
    top: `${pos.y}px`,
    width: `${orbW.value}px`,
    height: `${orbH.value}px`,
    // Độ mờ tĩnh đi theo biến CSS, trạng thái đánh thức / đang kéo do class ghi đè về hiển thị toàn phần
    '--orb-rest-opacity': String(Math.min(100, Math.max(20, ui.orbOpacity)) / 100),
    // Cỡ chữ biểu tượng co giãn theo kích thước cơ sở (quả cầu gốc 48 ≈ 22px), giữ tỷ lệ biểu tượng và thân cầu hài hòa
    '--orb-icon-size': `${Math.round(ui.orbSize * 0.46)}px`,
  };
  if (pos.dock === 'left') {
    base.left = '0px';
    // Tĩnh ẩn một nửa (lộ ~40%); khi kéo/đánh thức thì trượt nguyên dải ra
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(-58%)';
  } else if (pos.dock === 'right') {
    base.right = '0px';
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(58%)';
  } else {
    base.left = `${pos.x}px`;
    base.transform = 'translateX(0)';
  }
  return base;
});

const orbImage = computed(() => ui.orbImage.trim());

// —— Kéo ——
function onDown(e: PointerEvent) {
  activePointer = e.pointerId;
  dragging.value = true;
  moved = 0;
  startX = e.clientX;
  startY = e.clientY;
  // Ghi lại điểm nắm của ngón tay tương đối với góc trên bên trái, giữ nguyên khi kéo
  grabDX = e.clientX - currentLeft();
  grabDY = e.clientY - pos.y;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

let grabDX = 0;
let grabDY = 0;

/** Tọa độ x thực tế của góc trên bên trái hiện tại (trạng thái bám cạnh quy đổi từ right/translate thành pixel tuyệt đối, dùng khi bắt đầu kéo) */
function currentLeft(): number {
  if (pos.dock === 'right') return window.innerWidth - orbW.value;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function onMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY));
  // Đang kéo nhất loạt chuyển sang free bám theo tay (hiển thị nguyên dải)
  pos.dock = 'none';
  pos.x = e.clientX - grabDX;
  pos.y = e.clientY - grabDY;
  clampToViewport();
}

function onUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;

  if (moved < CLICK_SLOP) {
    // Coi là nhấn → mở Bách Bảo Thư (giữ nguyên trạng thái bám cạnh)
    openBook();
    return;
  }

  // Phán đoán hít bám khi thả tay: gần mép trái/phải mới bám cạnh, nếu không thì dừng tại chỗ (ở giữa)
  const left = pos.x;
  const right = window.innerWidth - (pos.x + orbW.value);
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  savePos();
}

// —— Truy cập bằng bàn phím ——
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openBook();
  }
}

const onResize = () => {
  clampToViewport();
  savePos();
};
onMounted(() => {
  clampToViewport();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div
    class="bbs-orb"
    :class="[`shape-${ui.orbShape}`, { 'is-dragging': dragging, 'has-image': !!orbImage }]"
    :style="orbStyle"
    role="button"
    tabindex="0"
    aria-label="Mở Bách Bảo Thư"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerenter="awake = true"
    @pointerleave="awake = false"
    @focus="awake = true"
    @blur="awake = false"
    @keydown="onKey"
  >
    <img v-if="orbImage" :src="orbImage" class="bbs-orb-img" alt="" draggable="false" />
    <Icon v-else name="bookmark" class="bbs-orb-icon" />
  </div>
</template>

<style scoped>
.bbs-orb {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* drop-shadow đều đi theo đường viền đối với cả clip-path (thẻ sách) và border-radius (tròn/vuông), thống nhất dùng nó */
  filter: drop-shadow(0 6px 14px oklch(0 0 0 / 0.28));
  opacity: var(--orb-rest-opacity, 0.62);
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}

/* —— Hình dáng —— */
/* Thẻ sách: đường viền ruy băng + khuyết đuôi én ở đáy. clip-path tự nhiên cắt ảnh tùy chỉnh. */
.bbs-orb.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
}
/* Tròn / Vuông: border-radius + overflow cắt ảnh tùy chỉnh */
.bbs-orb.shape-circle {
  border-radius: 999px;
  overflow: hidden;
}
.bbs-orb.shape-square {
  border-radius: 12px;
  overflow: hidden;
}

/* Đánh thức (hover/focus/kéo) hoặc dừng ở giữa (free) → hiển thị toàn phần */
.bbs-orb:hover,
.bbs-orb:focus-visible,
.bbs-orb.is-dragging {
  opacity: 1;
}
.bbs-orb:focus-visible {
  outline: none;
  color: var(--bbs-accent);
}
.bbs-orb:active {
  cursor: grabbing;
}

.bbs-orb-icon {
  font-size: var(--orb-icon-size, 22px);
  pointer-events: none;
}
/* Thẻ sách: biểu tượng dịch lên trên, tránh khuyết đuôi én ở đáy (tròn/vuông không có khuyết, căn giữa là được) */
.bbs-orb.shape-bookmark .bbs-orb-icon {
  margin-bottom: 6px;
}

.bbs-orb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bbs-orb {
    transition: none;
  }
}
</style>
