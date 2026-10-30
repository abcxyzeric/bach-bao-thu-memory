import { openBook } from '@/state/ui';

const MENU_ITEM_ID = 'bbs-menu-item';

/**
 * Tiêm mục vào "Bách Bảo Thư" vào cuối #extensionsMenu (menu đũa phép) của ST.
 * Menu được tải lười (lazy load), dùng polling đợi nó xuất hiện; chỉ cần tiêm một lần là đủ.
 */
export function injectMenuButton() {
  const tryInject = () => {
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) return false;
    if ($(`#${MENU_ITEM_ID}`).length > 0) return true;

    const $item = $(`
      <div class="extension_container interactable" tabindex="0">
        <a id="${MENU_ITEM_ID}" class="list-group-item" href="#" title="Bách Bảo Thư">
          <i class="fa-solid fa-book-bookmark"></i>
          <span>Bách Bảo Thư</span>
        </a>
      </div>
    `);

    $item.on('click', (e: { preventDefault: () => void }) => {
      e.preventDefault();
      openBook();
      // Sau khi nhấn thì thu gọn menu đũa phép, bám sát hành vi gốc
      $('#extensionsMenu').hide();
    });

    $menu.append($item);
    return true;
  };

  if (tryInject()) return;
  const timer = setInterval(() => {
    if (tryInject()) clearInterval(timer);
  }, 500);
}
