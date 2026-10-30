<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** Ban đầu có mở rộng hay không */
    open?: boolean;
  }>(),
  { open: true },
);

const expanded = ref(props.open);

// Dùng grid-template-rows 0fr<->1fr làm chuyển tiếp chiều cao, không cần đo scrollHeight, nội dung tự thích ứng.
</script>

<template>
  <section class="bbs-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbs-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="bbs-collapsible-title">{{ title }}</span>
      <Icon name="chevron" class="bbs-collapsible-chevron" />
    </button>
    <div class="bbs-collapsible-outer">
      <div class="bbs-collapsible-inner">
        <div class="bbs-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbs-collapsible {
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden;
}

.bbs-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font-family: var(--bbs-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible-head:hover {
  background: var(--bbs-surface-2);
}
.bbs-collapsible-head:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: -2px;
}

.bbs-collapsible-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
/* Dùng con trực tiếp > để giới hạn: khi lồng Collapsible, .is-open tầng ngoài không được lan tới outer/chevron tầng trong,
   nếu không tầng trong sẽ bị tầng ngoài ghim cứng ở trạng thái mở rộng, không bao giờ thu gọn lại được. */
.bbs-collapsible.is-open > .bbs-collapsible-head .bbs-collapsible-chevron {
  transform: rotate(180deg);
}

/* Chuyển tiếp chiều cao: grid 0fr -> 1fr */
.bbs-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible.is-open > .bbs-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbs-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbs-collapsible-body {
  padding: 14px 16px;
  border-top: 1px solid var(--bbs-line);
}

/* Di động: tiêu đề vùng thu gọn nhỏ hơn một cỡ, hài hòa hơn với nhịp điệu tổng thể của màn hình hẹp */
@media (max-width: 640px) {
  .bbs-collapsible-head {
    font-size: 13px;
  }
}
</style>
