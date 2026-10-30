<script setup lang="ts" generic="T extends string">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * Hộp chọn thả xuống tự vẽ (thay thế <select> gốc): bộ kích hoạt và menu bật lên đều đi theo giao diện --bbs-*,
 * tùy chọn có thể kèm biểu tượng. Lớp bật lên của select gốc do hệ thống kết xuất, biến giao diện không quản lý tới được, nên phải tự vẽ.
 * (Cùng nguồn với BbiSelect.vue của Bách Bảo Hội, tên lớp đổi sang tiền tố bbs-.)
 *
 * Kiểu tổng quát T: giá trị của phía gọi thường là hợp kiểu chuỗi (như Verbosity = 'detailed' | 'concise'),
 * viết cứng string sẽ làm kiểu ghi ngược v-model không tương thích; dưới kiểu tổng quát thì tùy chọn và giá trị gắn kết cùng kiểu, viết sai giá trị sẽ báo lỗi ngay.
 *
 * Tại sao menu lại Teleport tới modalHost thay vì định vị tuyệt đối tại chỗ:
 * Các mục cài đặt đều nằm trong Collapsible (overflow:hidden) và vùng chứa cuộn .bbs-body, định vị tại chỗ sẽ bị cắt mất.
 * modalHost là con trực tiếp của .bbs-root, menu dùng định vị fixed cấp khung nhìn (viewport),
 * được suy tính từ getBoundingClientRect của bộ kích hoạt, khi không gian phía dưới không đủ sẽ lật lên trên.
 *
 * Tương tác: nhấn bên ngoài / Esc / cuộn / thu phóng sẽ đóng; ↑↓ di chuyển tô sáng, Enter/Space chọn, Home/End nhảy đầu cuối.
 */
const props = defineProps<{
  modelValue: T;
  options: { value: T; label: string; icon?: string }[];
  /** Tên trợ năng (tiêu đề dòng là span văn bản thuần, không có liên kết label với điều khiển, nhờ nó bổ sung vào) */
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: T): void }>();

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
/** Chỉ số mục đang được tô sáng bởi bàn phím / di chuột */
const activeIndex = ref(0);

const current = computed(() => props.options.find(o => o.value === props.modelValue) ?? null);

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;

function openMenu() {
  const el = trigger.value;
  if (!el || open.value) return;
  const rect = el.getBoundingClientRect();
  // Ước tính chiều cao menu để quyết định hướng: phía dưới không đủ và phía trên rộng rãi hơn thì lật lên trên
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 34 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
  activeIndex.value = Math.max(
    0,
    props.options.findIndex(o => o.value === props.modelValue),
  );
  open.value = true;
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('keydown', onDocKeydown, true);
  // Menu là fixed cấp khung nhìn, không cuộn theo nội dung; khi cuộn/thu phóng thì đóng thẳng luôn, gọn sạch hơn tính lại vị trí.
  document.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

function closeMenu(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('mousedown', onDocMousedown, true);
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
  if (restoreFocus) trigger.value?.focus();
}

function closeOnViewportChange() {
  closeMenu();
}

function toggle() {
  if (open.value) closeMenu(true);
  else openMenu();
}

function pick(option: { value: T }) {
  emit('update:modelValue', option.value);
  closeMenu(true);
}

function onDocMousedown(event: MouseEvent) {
  // composedPath xuyên qua shadow root; nhấn vào bộ kích hoạt hoặc bên trong menu đều không tính là bên ngoài
  const path = event.composedPath();
  if (trigger.value && path.includes(trigger.value)) return;
  if (menu.value && path.includes(menu.value)) return;
  closeMenu();
}

function scrollActiveIntoView() {
  menu.value
    ?.querySelectorAll('.bbs-select-option')
    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = props.options.length;
  if (event.key === 'Escape') {
    // Chặn ở giai đoạn capture, chỉ đóng menu, đừng kích hoạt Esc cấp cửa sổ (đóng toàn bộ bảng)
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) pick(option);
  }
}

/** Thói quen của select gốc: ở trạng thái thu gọn nhấn ↑/↓ sẽ mở rộng trực tiếp */
function onTriggerKeydown(event: KeyboardEvent) {
  if (open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu();
  }
}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <!-- Tên lớp gốc gọi là bbs-select-box chứ không gọi là bbs-select: cái sau từng là lớp làm đẹp <select> gốc
       (kèm tam giác ảnh nền + padding-right), nay đã xóa cùng select gốc cuối cùng,
       nhưng nếu bên ngoài lại đưa lớp trùng tên vào thì vẫn sẽ vẽ thừa một tam giác bên phải bộ kích hoạt, nên giữ sự phân biệt -->
  <div class="bbs-select-box">
    <button
      ref="trigger"
      class="bbs-select-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="bbs-select-current">
        <Icon v-if="current?.icon" :name="current.icon" :size="14" />
        <span class="bbs-select-label">{{ current?.label ?? modelValue }}</span>
      </span>
      <Icon name="chevron" class="bbs-select-caret" :class="{ 'is-open': open }" :size="12" />
    </button>

    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul v-if="open" ref="menu" class="bbs-select-menu" role="listbox" :style="menuStyle">
        <li
          v-for="(option, i) in options"
          :key="option.value"
          class="bbs-select-option"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          <Icon v-if="option.icon" :name="option.icon" :size="14" />
          <span class="bbs-select-option-label">{{ option.label }}</span>
          <Icon
            v-if="option.value === modelValue"
            name="check"
            class="bbs-select-check"
            :size="13"
          />
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbs-select-box {
  width: 100%;
  min-width: 0;
}
.bbs-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-select-trigger:hover {
  background: var(--bbs-surface-2);
}
.bbs-select-trigger:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 1px;
}
.bbs-select-current {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bbs-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-select-caret {
  flex: none;
  color: var(--bbs-ink-soft);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-select-caret.is-open {
  transform: rotate(180deg);
}

/* Menu Teleport tới modalHost (kiểu dáng scoped trong cùng shadow root vẫn có hiệu lực như thường) */
.bbs-select-menu {
  position: fixed;
  /* 10003: cao hơn lớp phủ hộp thoại thường (10001) và lớp phủ chồng lớp (10002).
     Component này cũng được dùng bên trong hộp thoại ("Cường độ suy luận" của hộp thoại kênh), menu và lớp phủ sẽ tồn tại đồng thời;
     khi ngang cấp thì nhờ "kẻ chèn sau thắng" có thể may mắn đè lên được, nhưng lớp phủ -top kiểu xác nhận xóa (10002) sẽ đè ngược lại menu,
     nên nâng cao tường minh, không phụ thuộc thứ tự chèn. */
  z-index: 10003;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  box-shadow: var(--bbs-shadow);
}
.bbs-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--bbs-radius-sm);
  font-size: 13px;
  color: var(--bbs-ink);
  cursor: pointer;
}
.bbs-select-option.is-active {
  background: var(--bbs-surface-2);
}
.bbs-select-option.is-selected {
  color: var(--bbs-accent);
  font-weight: 600;
}
.bbs-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-select-check {
  flex: none;
  color: var(--bbs-accent);
}
</style>
