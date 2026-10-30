# ST-BaiBai-Book — Mô tả Dự án (Dành cho Claude)

Tiện ích mở rộng bên thứ ba cho SillyTavern, cung cấp giao diện quản lý trí nhớ / tóm tắt. Được xây dựng bằng Vue 3 + TypeScript + Vite,
sản phẩm đóng gói được tiêm vào trang SillyTavern, UI gắn kết bên trong **Shadow DOM**.

## Quy ước khi cộng tác

- **Không chủ động chụp ảnh màn hình để kiểm chứng thay đổi**. Chụp ảnh màn hình sẽ nhét hình ảnh vào ngữ cảnh, rất tốn token. Mặc định chỉ cần dùng kiểm tra kiểu `vue-tsc` +
  `build` để kiểm chứng là đủ; chỉ khi tôi yêu cầu rõ ràng muốn xem hiệu ứng thì mới chạy kịch bản chụp ảnh màn hình `.preview/`.
- **Mỗi yêu cầu đơn lẻ tải lên tối đa 20 hình ảnh**. Khi kiểm chứng ảnh chụp màn hình hãy đọc theo từng đợt (mỗi lần ≤ 20 tấm), đừng nhét toàn bộ ảnh chụp màn hình dưới
  `.preview/` vào một lần Read/yêu cầu, nếu không sẽ kích hoạt lỗi `400 At most 20 images per request`.
- Trả lời bằng tiếng Việt.
- Chú thích mã nguồn giữ nguyên phong cách hiện có: tiếng Việt, ngắn gọn, giải thích "tại sao" thay vì "làm cái gì".

## Các ràng buộc kiến trúc mấu chốt

- **Shadow DOM**: Toàn bộ UI được kết xuất bên trong shadow root. Kiểu dáng scoped và các biến giao diện `--bbs-*` đều được định nghĩa trên
  `.bbs-root` bên trong shadow.
  - ⚠️ Đừng dùng `<Teleport to="body">`: sẽ đẩy nội dung ra ngoài shadow root, làm mất kiểu dáng scoped và biến CSS,
    dẫn tới hộp thoại không có kiểu dáng / bị lớp phủ đè khuất (trên PC) / hoàn toàn không nhìn thấy (trên di động). Hộp thoại chỉ cần kết xuất nội tuyến `position: fixed` (hoặc Teleport tới `modalHost` bên trong `.bbs-root`) là được.
- **Component trang bắt buộc phải có một nút gốc duy nhất**: `App.vue` dùng `<Transition mode="out-in">` để chuyển trang, nhiều nút gốc sẽ dẫn tới sau khi chuyển trang
  toàn bộ trang bị trắng trơn.
- **Bắc cầu phản ứng**: Thay đổi của `matchMedia` không được Vue tự động theo dõi, cần dùng `ref` + lắng nghe sự kiện để bắc cầu (xem `App.vue`).
- **Lưu trữ dữ liệu bền vững** (⚠️ Đừng đổi ngược về localStorage):
  - Cài đặt → `extension_settings` của ST (`getContext().extensionSettings['baibai_book']` +
    `saveSettingsDebounced()`), ghi vào `settings.json` trên máy chủ, **đồng bộ đa thiết bị / mạng LAN**. Xem `api/settings.ts`.
    localStorage chỉ nằm cục bộ trên từng thiết bị, đổi thiết bị sẽ không đồng bộ —— đây là bug đã được sửa.
  - `settings.ts` dùng `ready` để gác cổng: sau khi ST sẵn sàng, `hydrateSettings()` tải giá trị thực từ máy chủ trước, **sau đó mới cho phép ghi ngược lại**,
    nếu không giá trị mặc định sẽ ghi đè lên cài đặt đã lưu trên máy chủ. Giá trị localStorage cũ của người dùng cũ sẽ được di chuyển sang một lần.
  - Rừng tóm tắt → `chatMetadata` (đi theo cuộc trò chuyện); Lá → `extra.bbs_leaf` của từng tin nhắn (nằm trong tệp chat). Xem `memory/store.ts`.

## Thư mục

- `src/pages/` — Các trang (`summary` Tóm tắt, `items` Vật phẩm, `scenes` Khung cảnh, `npcs` Nhân vật, `vars` Biến số, `settings` Cài đặt), đăng ký tại `registry.ts`.
- `src/memory/` — Mô hình dữ liệu và logic trí nhớ / tóm tắt: `store.ts` lưu trữ, `engine.ts` bộ máy, `inject.ts` tiêm,
  `types.ts` kiểu dữ liệu, `prompts.ts` lời nhắc.
- `src/state/ui.ts` — Trạng thái UI toàn cục (giao diện, điều hướng, công tắc).
- `src/st/context.ts` — Kết nối với môi trường chủ SillyTavern.
- `src/styles/` — `base.css`, `theme.css`.
- `dist/` — Sản phẩm đóng gói (`index.js` / `index.css` / `.map`), **cần commit**.
- `.preview/` — Ảnh chụp màn hình, dữ liệu hạt giống và kịch bản dùng để kiểm chứng cục bộ (`_shot.mjs`, `_seed.html`, v.v.).

## Mô hình rừng tóm tắt (summary)

- Tóm tắt là một **cánh rừng**: nút nén `id` → nút, `childIds` có thể trỏ tới lá (L1) hoặc nút nén tầng dưới (L2+).
- Các tầng được bao phủ bởi một nút nén = phân giải đệ quy `msgIndex` của toàn bộ các lá hậu duệ (xem `inject.ts` và
  `nodeFloors` trong `summary/index.vue`).
- "Đã được đại tóm tắt" = id đã được bất kỳ `childIds` nào thu nạp; danh sách chỉ hiển thị các nút gốc của rừng.
- Nhãn cấp độ: L0 `Tóm tắt`, còn lại `Đại tóm tắt L{level}`. Nhãn phạm vi tầng: tầng đơn `#5`, liên tầng `#0 - #10`.
- Danh sách **ngược thứ tự**: tầng càng về sau càng nằm ở phía trên.

## Đóng gói và kiểm chứng

```bash
npx vue-tsc --noEmit        # Kiểm tra kiểu dữ liệu
pnpm build                  # Hoặc npm run build (vite build → dist/)
pnpm watch                  # Lắng nghe phát triển
```

Kiểm chứng UI dùng dữ liệu hạt giống + kịch bản chụp ảnh màn hình dưới `.preview/` (phong cách Playwright), chia làm hai bộ PC / Di động,
khi đọc ảnh chụp màn hình hãy nhớ ≤ 20 tấm/lần.
