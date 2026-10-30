const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const guardedRoots = new WeakSet<ShadowRoot>();

function pathContainsEditable(event: KeyboardEvent): boolean {
  return event.composedPath().some(node =>
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    (node instanceof HTMLElement && node.isContentEditable),
  );
}

/**
 * Ngăn các phím mũi tên của phần tử chỉnh sửa bên trong Shadow DOM tiếp tục nổi bọt (bubble) lên phím tắt toàn cục của ST.
 * Chỉ cắt đứt việc lan truyền, không preventDefault, nên di chuyển con trỏ, chuyển đổi tùy chọn và tăng giảm số vẫn được phần tử xử lý bình thường.
 */
export function guardEditableArrowKeys(root: ShadowRoot): void {
  if (guardedRoots.has(root)) return;
  guardedRoots.add(root);
  root.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent) || !ARROW_KEYS.has(event.key)) return;
    // Bản thân ST sẽ bỏ qua phím mũi tên có kèm phím bổ trợ; tiếp tục cho qua giúp tránh ảnh hưởng các tổ hợp phím tắt toàn cục khác.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (pathContainsEditable(event)) event.stopPropagation();
  });
}
