/**
 * Ngữ cảnh chia sẻ cần thiết để kết xuất đệ quy nút tóm tắt (SummaryNode).
 * Sau khi việc kết xuất thẻ được đưa xuống component đệ quy, trang cha (index.vue) thông qua provide tiêm trạng thái, helper, hành động một lần,
 * khỏi phải truyền props qua từng tầng. Ba chế độ xem Mặc định / Tìm kiếm / Chọn dùng chung cùng một thẻ, chỉ có một bản triển khai duy nhất này.
 */
import type { ComputedRef, InjectionKey, Ref } from 'vue';
import type { ViewNode } from '@/memory/inject';

/** Các trường hiển thị của một nút rừng trong danh sách (sản phẩm của toRow), cung cấp cho helper tính toán nhãn/thời gian. */
export interface SummaryRow {
  key: string;
  id: string;
  kind: 'leaf' | 'comp';
  level: number;
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string;
  floorLo: number;
  floorHi: number;
  msgIndex?: number;
  stale?: boolean;
  imported?: boolean;
}

export interface SummaryCtx {
  byId: ComputedRef<Map<string, ViewNode>>;
  expanded: Ref<Set<string>>;
  selectMode: Ref<boolean>;
  searching: ComputedRef<boolean>;
  selectedIds: Ref<Set<string>>;
  toggleExpand: (id: string) => void;
  toggleSelect: (id: string) => void;
  openEdit: (r: SummaryRow) => void;
  onDelete: (r: SummaryRow) => void;
  nodeFloors: (n: ViewNode, map: Map<string, ViewNode>) => [number, number];
  toRow: (n: ViewNode, map: Map<string, ViewNode>) => SummaryRow;
  levelLabel: (level: number, imported?: boolean) => string;
  floorLabel: (r: SummaryRow) => string;
  rowTime: (r: SummaryRow) => string;
  rowRelative: (r: SummaryRow) => string;
  highlightParts: (text: string) => Array<{ t: string; hit: boolean }>;
}

export const SUMMARY_CTX: InjectionKey<SummaryCtx> = Symbol('summaryCtx');
