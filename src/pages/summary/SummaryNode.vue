<script setup lang="ts">
/**
 * Một nút trong rừng tóm tắt (đệ quy). Dùng cho chế độ xem mặc định: một thẻ + thanh mở rộng ở đáy,
 * khi mở rộng vùng chứa grid (0fr↔1fr) bên dưới sẽ giãn ra mượt mà, bên trong kết xuất đệ quy các nút con + thanh thu gọn cuối nhóm.
 * Chuyển tiếp chiều cao cùng kiểu với Collapsible.vue / Sổ nghi vấn —— nội dung thường trực trong DOM, không rời luồng, nên không nhấp nháy.
 */
import Icon from '@/components/Icon.vue';
import { computed, inject } from 'vue';
import type { ViewNode } from '@/memory/inject';
import { SUMMARY_CTX, type SummaryCtx } from './ctx';

const props = defineProps<{ node: ViewNode; depth: number }>();

const ctx = inject(SUMMARY_CTX) as SummaryCtx;

const row = computed(() => ctx.toRow(props.node, ctx.byId.value));
const children = computed<ViewNode[]>(() => {
  if (props.node.kind !== 'comp') return [];
  const map = ctx.byId.value;
  const list = props.node.childIds.map(cid => map.get(cid)).filter((c): c is ViewNode => !!c);
  // Các nút con sắp xếp ngược theo tầng bao phủ (tầng mới ở trên), cùng thứ tự với danh sách gốc
  return list.sort((a, b) => ctx.nodeFloors(b, map)[1] - ctx.nodeFloors(a, map)[1]);
});
const expandable = computed(() => children.value.length > 0);
const isExpanded = computed(() => ctx.expanded.value.has(props.node.id));
const isChild = computed(() => props.depth > 0);
</script>

<template>
  <div class="bbs-node">
    <article
      class="bbs-summary-card"
      :class="{ 'is-deep': row.level > 0, 'is-child': isChild, 'is-expanded': isExpanded && expandable }"
    >
      <div class="bbs-summary-main">
        <header class="bbs-summary-meta">
          <template v-if="row.kind === 'comp'">
            <span class="bbs-summary-badge">{{ ctx.levelLabel(row.level, row.imported) }}</span>
            <span class="bbs-summary-loc">{{ ctx.floorLabel(row) }}</span>
            <span v-if="ctx.rowRelative(row)" class="bbs-summary-rel">({{ ctx.rowRelative(row) }})</span>
            <span v-if="ctx.rowTime(row)" class="bbs-summary-time">{{ ctx.rowTime(row) }}</span>
          </template>
          <template v-else>
            <span v-if="ctx.rowRelative(row)" class="bbs-summary-rel">{{ ctx.rowRelative(row) }}</span>
            <span class="bbs-summary-loc">{{ ctx.floorLabel(row) }}</span>
            <span v-if="ctx.rowTime(row)" class="bbs-summary-dateline">{{ ctx.rowTime(row) }}</span>
          </template>
          <!-- Nút thao tác: chỉnh sửa mở cho mọi cấp độ (an toàn cấu trúc: không đổi id, không đứt chuỗi; lá sửa xong chỉ mục vector tự động embed lại,
               đại tóm tắt không vào kho vector, chỉ ảnh hưởng tiêm ngữ cảnh); xóa chỉ dành cho dòng gốc —— xóa lá tầng sâu sẽ xóa dây chuyền toàn bộ chuỗi đại tóm tắt tổ tiên -->
          <span class="bbs-summary-acts">
            <button class="bbs-summary-act" type="button" :title="row.imported ? 'Chỉnh sửa lịch sử nhập' : row.kind === 'comp' ? 'Chỉnh sửa đại tóm tắt' : 'Chỉnh sửa tóm tắt'" @click="ctx.openEdit(row)">
              <Icon name="edit" />
            </button>
            <button v-if="!isChild" class="bbs-summary-act bbs-summary-del" type="button" :title="row.imported ? 'Xóa lịch sử nhập' : row.kind === 'comp' ? 'Xóa đại tóm tắt (tầng dưới sẽ mở rộng ra)' : 'Xóa tóm tắt'" @click="ctx.onDelete(row)">
              <Icon name="trash" />
            </button>
          </span>
        </header>
        <p class="bbs-summary-text">{{ row.text }}</p>
        <!-- Công tắc mở rộng: nguyên thanh ở đáy thẻ, ghi rõ "Mở rộng / Thu gọn N mục tầng dưới"; trạng thái mở rộng lật văn bản + bật sáng viền thẻ -->
        <button
          v-if="expandable"
          class="bbs-expand-bar"
          type="button"
          :aria-expanded="isExpanded"
          @click="ctx.toggleExpand(node.id)"
        >
          <Icon name="chevron" class="bbs-expand-caret" :class="{ 'is-collapsed': !isExpanded }" />
          {{ isExpanded ? 'Thu gọn tầng dưới' : `Mở rộng ${children.length} mục tầng dưới` }}
        </button>
      </div>
    </article>

    <!-- Tầng dưới: chuyển tiếp chiều cao grid 0fr↔1fr (nội dung thường trực, không rời luồng, không nhấp nháy); thụt lề một nấc biểu thị sự phụ thuộc -->
    <div v-if="expandable" class="bbs-node-children" :class="{ 'is-open': isExpanded }">
      <div class="bbs-node-children-inner">
        <div class="bbs-node-children-body">
          <SummaryNode v-for="c in children" :key="`${c.kind}:${c.id}`" :node="c" :depth="depth + 1" />
          <!-- Thanh thu gọn cuối nhóm: cuộn tới cuối nội dung mở rộng cũng có thể thu gọn tại chỗ, không cần lật ngược lên đỉnh -->
          <button class="bbs-collapse-footer" type="button" title="Thu gọn tóm tắt tầng dưới" @click="ctx.toggleExpand(node.id)">
            <Icon name="chevron" class="bbs-collapse-caret" />
            Thu gọn {{ children.length }} mục tầng dưới
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Cấp khối (không phải flex): chiều cao mục con grid phải do grid-template-rows quyết định; nếu cấp cha là flex,
   bố cục flex sẽ tiếp quản chiều cao mục con, xóa sạch chuyển tiếp fr thành cắt tức thì —— đây chính là nguyên nhân gốc của việc "mở rộng không có hoạt ảnh".
   Đối chiếu với Collapsible.vue / .bbs-fold-wrap của Sổ nghi vấn, cấp cha của chúng đều là cấp khối thông thường. */
.bbs-node {
  display: block;
}
/* Vùng chứa tầng dưới: chuyển tiếp chiều cao grid, giống Collapsible.vue */
.bbs-node-children {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-node-children.is-open {
  grid-template-rows: 1fr;
}
.bbs-node-children-inner {
  min-height: 0;
  overflow: hidden;
}
/* Dòng con: khoảng cách trên + thụt lề trái + đường kẻ dọc biểu thị sự phụ thuộc; giữa các nút con cũng chừa khoảng cách */
.bbs-node-children-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
  margin-left: 18px;
  padding-left: 14px;
  border-left: 1px solid var(--bbs-line);
  /* Đồng bộ với việc giãn chiều cao: toàn bộ nội dung mờ dần hiện vào + trượt nhẹ xuống dưới, có cảm giác "trượt ra" hơn là chỉ kéo cao đơn thuần.
     Khi thu gọn thì mờ dần dịch lên theo chiều ngược lại. Nguồn dẫn động chuyển tiếp là .is-open ở cấp cha. */
  opacity: 0;
  transform: translateY(-8px);
  transition: opacity var(--bbs-dur) var(--bbs-ease), transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-node-children.is-open .bbs-node-children-body {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .bbs-node-children,
  .bbs-node-children-body {
    transition: none;
  }
}
</style>
