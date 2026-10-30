/**
 * Dự phòng biểu tượng phông chữ: một số chủ đề làm đẹp giao diện ST sẽ xóa trống biểu tượng phông chữ của .drawer-icon.fa-solid::before (hoặc tương tự)
 * trên thanh trên cùng / khung trò chuyện (content:'', color:transparent, font-size:0), đổi sang dùng background-image dán biểu tượng tùy chỉnh riêng
 * theo **id của từng nút**. Nút do chúng ta tiêm vào không nằm trong danh sách của họ nên sẽ biến thành một khoảng trắng trơn.
 *
 * Ở đây dùng độ đặc hiệu cao hơn (id tổ tiên + id bản thân) + !important đè qua quy tắc chung đó, cưỡng chế khôi phục hình chữ.
 * \e0bb = Unicode của fa-book-bookmark (lấy từ fontawesome.min.css của ST, đừng đoán theo trí nhớ).
 *
 * Các điểm tiêm dùng chung hàm này: truyền vào id nút của bản thân và bộ chọn phần tử biểu tượng, sinh ra một đoạn <style> một lần.
 */
const BOOK_BOOKMARK = '\\e0bb';
const injected = new Set<string>();

/**
 * Đảm bảo kiểu dáng dự phòng biểu tượng của một nút đã được tiêm (khử trùng theo styleId, có thể gọi lặp lại).
 * @param styleId   id của phần tử <style> (khóa khử trùng)
 * @param selector  bộ chọn độ đặc hiệu cao trúng ::before của biểu tượng nút đó (không bao gồm ::before)
 */
export function ensureIconFallback(styleId: string, selector: string): void {
  if (injected.has(styleId) || document.getElementById(styleId)) {
    injected.add(styleId);
    return;
  }
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
${selector}::before {
  content: '${BOOK_BOOKMARK}' !important;
  width: auto !important;
  height: auto !important;
  font-size: inherit !important;
  color: inherit !important;
  background: none !important;
}
`;
  document.head.appendChild(style);
  injected.add(styleId);
}
