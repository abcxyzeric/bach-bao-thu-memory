import type { Component } from 'vue';
import Items from './items/index.vue';
import Npcs from './npcs/index.vue';
import Scenes from './scenes/index.vue';
import Settings from './settings/index.vue';
import Summary from './summary/index.vue';
import Vars from './vars/index.vue';

export interface PageDef {
  /** id duy nhất, lưu vào ui.activePage / localStorage; đồng thời làm name của Icon */
  id: string;
  /** Tên đầy đủ trên thanh điều hướng */
  label: string;
  component: Component;
}

/**
 * Bảng đăng ký phân trang —— thêm một trang mới: tạo một pages/<id>/index.vue, rồi thêm một dòng vào đây,
 * đồng thời thêm một biểu tượng cùng id vào PATHS của Icon.vue. Thứ tự chính là thứ tự điều hướng, Cài đặt đặt ở cuối cùng.
 *
 * Kế hoạch / Nghi vấn đã được gộp vào trang Tóm tắt (phía trên), không tách thành trang riêng nữa.
 */
export const PAGES: PageDef[] = [
  { id: 'summary', label: 'Tóm tắt', component: Summary },
  { id: 'items', label: 'Vật phẩm', component: Items },
  { id: 'scenes', label: 'Khung cảnh', component: Scenes },
  { id: 'npcs', label: 'Nhân vật', component: Npcs },
  { id: 'vars', label: 'Biến số', component: Vars },
  { id: 'settings', label: 'Cài đặt', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
