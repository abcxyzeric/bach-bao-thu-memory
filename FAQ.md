# Bách Bảo Thư (ST-BaiBai-Book) FAQ / Tài liệu Giải đáp Thắc mắc

Dành cho người dùng SillyTavern. Tài liệu này được tổ chức theo "những câu hỏi người dùng thường gặp nhất", trọng tâm giải đáp về **Biến số tùy chỉnh**, bởi vì rất nhiều tính năng mà người dùng mong muốn (thanh máu, độ hảo cảm, tiền bạc, nhiệm vụ, cờ đánh dấu cốt truyện…) thực chất đều có thể thực hiện được bằng biến số tùy chỉnh mà không cần phải yêu cầu thêm tính năng mới.

---

## Mục lục

1. [Làm quen với Bách Bảo Thư](#1-làm-quen-với-bách-bảo-thư)
2. [Bắt đầu nhanh](#2-bắt-đầu-nhanh)
3. [Giải đáp về hệ thống tóm tắt](#3-giải-đáp-về-hệ-thống-tóm-tắt)
4. [Giải đáp về theo dõi trạng thái (Vật phẩm/Kế hoạch/Khung cảnh/NPC/Nhân vật chính)](#4-giải-đáp-về-theo-dõi-trạng-thái)
5. [Chuyên đề Biến số tùy chỉnh (Trọng tâm)](#5-chuyên-đề-biến-số-tùy-chỉnh-trọng-tâm)
6. [Giải đáp về Trí nhớ vector](#6-giải-đáp-về-trí-nhớ-vector)
7. [Giải đáp về API phụ](#7-giải-đáp-về-api-phụ)
8. [API công khai / Macro / Lệnh gạch chéo](#8-api-công-khai--macro--lệnh-gạch-chéo)
9. [Dữ liệu, di chuyển, cuộc trò chuyện mới](#9-dữ-liệu-di-chuyển-cuộc-trò-chuyện-mới)
10. [Tra cứu nhanh xử lý sự cố](#10-tra-cứu-nhanh-xử-lý-sự-cố)
11. [Tra cứu nhanh các mục cài đặt (Kèm giá trị mặc định)](#11-tra-cứu-nhanh-các-mục-cài-đặt-kèm-giá-trị-mặc-định)

---

## 1. Làm quen với Bách Bảo Thư

### Hỏi: Bách Bảo Thư là gì? Nó giải quyết vấn đề gì?

Bách Bảo Thư là tiện ích mở rộng quản lý trí nhớ dài hạn / trạng thái cốt truyện cho SillyTavern. Nó giải quyết hai điểm yếu cố hữu của ST gốc:

1. **Cửa sổ đối thoại có hạn, sau khi cốt truyện cũ bị đẩy ra ngoài thì AI sẽ quên mất.** Bách Bảo Thư tạo "lá tóm tắt" cho mỗi phản hồi của AI, thu gọn chính văn lại, sau đó gộp các lá thành "rừng tóm tắt" nhiều tầng, rồi tiêm lại các bản tóm tắt lịch sử vào ngữ cảnh, giúp AI luôn "nhớ" được cốt truyện đã cuộn ra khỏi cửa sổ.
2. **AI không nhớ nổi "trạng thái hiện tại": vật phẩm, tiền bạc, thương tích, độ hảo cảm, nhiệm vụ chưa hoàn thành.** Bách Bảo Thư trích xuất có cấu trúc những trạng thái này (vật phẩm / kế hoạch / nghi vấn / khung cảnh / NPC / hồ sơ nhân vật chính / biến số tùy chỉnh) từ chính văn mỗi lượt, phát lại từng tầng theo phương thức gia tăng (delta) và tiêm theo thời gian thực, giúp AI luôn biết rõ trạng thái khách quan "ngay lúc này tại nơi đây", không tự dưng biến ra đồ vật hay quên mất thanh kiếm đang mang theo.

### Hỏi: Nó có gì khác với "Tóm tắt" có sẵn của ST và Sách Thế Giới (World Info)?

| | Tóm tắt có sẵn của ST | Bách Bảo Thư |
|---|---|---|
| Lưu ở đâu | Bản thân tin nhắn có thể bị thay thế bằng tóm tắt (mất nguyên văn) | Giữ nguyên nguyên văn, tóm tắt lưu ở `extra.bbs_leaf` của tin nhắn, dùng regex ẩn để giấu các tầng đã tóm tắt ra khỏi cửa sổ |
| Cấu trúc | Một đoạn văn bản | Rừng nhiều tầng: Lá (L0) → Đại tóm tắt (L1) → Đại tóm tắt cấp hai (L2+) |
| Trạng thái | Không có | Vật phẩm / Kế hoạch / Nghi vấn / Khung cảnh / NPC / Nhân vật chính / Biến số tùy chỉnh, phát lại gia tăng từng tầng |
| Thời gian | Không có | Thẻ thời gian + Dòng thời gian + Thời gian tương đối ("3 ngày trước") |

Sách Thế Giới là **thiết lập tĩnh**, còn Bách Bảo Thư là **trạng thái cốt truyện động** —— hai bên bổ trợ cho nhau, không xung đột (Bách Bảo Thư thậm chí còn đọc Sách Thế Giới được kích hoạt làm bối cảnh tóm tắt).

### Hỏi: Dữ liệu đều được lưu ở đâu?

- **Cài đặt**: `extension_settings['baibai_book']` của SillyTavern (lưu trong `settings.json` trên máy chủ, **đồng bộ đa thiết bị / mạng LAN**, không dùng localStorage).
- **Rừng tóm tắt** (các nút đại tóm tắt): `chatMetadata` (đi theo cuộc trò chuyện).
- **Lá** (tóm tắt tầng đơn + phần tăng thêm có cấu trúc): `extra.bbs_leaf` của từng tin nhắn (nằm trong tệp chat).
- **Trạng thái** (vật phẩm / kế hoạch / biến số...): **không lưu ổ đĩa**, mà là "dữ liệu dẫn xuất" —— mỗi lần đều được tính toán ra từ việc phát lại phần tăng thêm của các lá. Vì vậy khi xóa một lá, trạng thái sẽ tự động lùi về, không bao giờ xảy ra tình trạng "trạng thái và cốt truyện lệch nhau".

---

## 2. Bắt đầu nhanh

### Hỏi: Sau khi cài đặt xong cần làm gì?

1. Mở công tắc tổng ở trên cùng trong trang Cài đặt: "Bách Bảo Thư · Bộ máy trí nhớ".
2. **Cấu hình API phụ** (Cài đặt → API phụ): tóm tắt / đại tóm tắt được hoàn thành bởi kênh độc lập, không chiếm dụng việc tạo phản hồi của cuộc đối thoại chính. Hoặc có thể để mặc định "Theo API chính".
3. Mở một cuộc đối thoại mới (hoặc vào cuộc đối thoại đã có), gửi một tin nhắn để kích hoạt lần tóm tắt đầu tiên.
4. Ở trang Tóm tắt sẽ thấy mỗi tầng AI dần mọc ra "lá"; sau khi tích đủ ngưỡng sẽ tự động gộp thành "Đại tóm tắt".

### Hỏi: Làm sao để biết tôi đã cấu hình thành công hay chưa?

- Trang Tóm tắt xuất hiện lá = API phụ đã thông suốt.
- Nếu API phụ báo lỗi, trong phần Cài đặt / trang Tóm tắt sẽ hiển thị lỗi gần nhất (`engineState.lastError`).

### Hỏi: Những nhân vật nào sẽ có hiệu lực?

Các nhân vật được liệt kê trong Cài đặt → Loại trừ nhân vật sẽ không có hiệu lực; những nhân vật không bị loại trừ đều có hiệu lực. Trong trò chuyện nhóm, "Loại trừ nhân vật" được phán đoán theo nhân vật hiện tại.

### Hỏi: Đối với cuộc đối thoại cũ đã có sẵn, Bách Bảo Thư có tự động tóm tắt bù không?

**Sẽ không tự động tóm tắt bù toàn lượng.** Quy tắc kích hoạt tóm tắt là "chỉ đảm bảo tin nhắn AI đã chốt gần nhất trước đó có tóm tắt" (gia tăng từng tầng đơn). Nếu cuộc đối thoại cũ muốn bù lại lịch sử, hãy dùng nút "Tóm tắt bù hàng loạt" ở trang Tóm tắt, hoặc tóm tắt bù thủ công từng tầng đơn.

---

## 3. Giải đáp về hệ thống tóm tắt

### Hỏi: Lá, Đại tóm tắt, Rừng rốt cuộc là gì?

- **Lá (L0)**: Bản tóm tắt của một phản hồi AI, lưu ở `extra.bbs_leaf` của tin nhắn đó. Bao gồm: tóm tắt chính văn, thời gian bắt đầu và kết thúc, cùng phần tăng thêm có cấu trúc của tầng này (biến động vật phẩm, thay đổi kế hoạch, khung cảnh, NPC, lệnh biến số…).
- **Đại tóm tắt (L1)**: Một số lá được AI dung hợp thành một đoạn văn xuôi dài 300–500 chữ (có thể điều chỉnh), `childIds` trỏ tới các lá được nó thu nạp. **Các lá tầng đáy không bị xóa**, chỉ là không còn hiển thị / tiêm với tư cách là nút gốc nữa.
- **Đại tóm tắt cấp hai (L2+)**: Một số bản L1 lại được dung hợp thành tầng cao hơn nữa, số chữ được cấp động theo quy mô đầu vào.
- **Rừng**: Tập hợp của tất cả các nút, lá gắn vào tin nhắn, các nút nén nằm trong `chatMetadata`.

### Hỏi: Khi nào thì tự động tạo tóm tắt?

- Bạn gửi tin nhắn mới → tóm tắt "phản hồi AI liền trước đó".
- Tạo lại (Regenerate) / Lật trang (Swipe) → tin nhắn AI ở cuối đang được viết lại, bỏ qua nó, tóm tắt "tin nhắn trước đó nữa".
- Chỉnh sửa / Xóa tin nhắn → chỉ để dữ liệu đi theo và làm mới, không chủ động tạo mới.
- Tóm tắt đuổi theo thứ tự lỗ hổng tầng cho tới mới nhất, không bị sót.

Ngoài ra "Bật tóm tắt tự động" đồng thời bật: **Thẻ thời gian chính văn** (mốc thời gian cốt truyện) và **Chặn tồn đọng** —— khi tồn tại tầng cũ bị sót tóm tắt, sẽ chặn việc bạn gửi tin nhắn mới và nhắc tóm tắt bù trước (tránh việc nhảy cóc tóm tắt làm sai lệch thứ tự kế hoạch / vật phẩm). Lật tới trang chưa có tóm tắt hay vừa vào cuộc trò chuyện đều sẽ không tự động lập tức tóm tắt bù toàn lượng.

### Hỏi: Tại sao ở trang Tóm tắt có những tầng là "Chờ tóm tắt" / "Tầng chưa tóm tắt"?

Những tầng AI đó chưa có lá hợp lệ (ví dụ vừa mới tạo xong, API phụ thất bại, hoặc sau khi lật trang bản tóm tắt gốc mất hiệu lực). Nhấn vào tầng đó có thể tóm tắt bù riêng, hoặc dùng "Tóm tắt bù hàng loạt".

### Hỏi: Tóm tắt bù hàng loạt là gì? Có tiết kiệm token không?

Cắt nhiều tầng chờ tóm tắt thành từng khối theo dung lượng nội dung (`batchMaxChars` / `batchMaxFloors` trong Cài đặt), **một yêu cầu xử lý nhiều tầng**, ngữ cảnh cố định (phá giới hạn / thiết lập / tiền đề) được phân bổ theo khối nên tiết kiệm token. Lưu ý: tóm tắt hàng loạt chỉ sinh ra summary + thời gian bắt đầu/kết thúc, **không sinh ra dữ liệu có cấu trúc như vật phẩm / kế hoạch** (vì qua nhiều tầng khó đảm bảo trình tự), dữ liệu có cấu trúc để dành cho tóm tắt tự động từng tầng sau đó bổ sung. Nếu khối nào thất bại sẽ tự động lùi về tóm tắt bù từng tầng.

### Hỏi: Đại tóm tắt kích hoạt khi nào? Ngưỡng có điều chỉnh được không?

`checkResummary` kiểm tra theo từng tầng số lượng "nút gốc chưa được thu nạp", tích đủ ngưỡng sẽ nén một tầng và liên쇄 lên trên:

- L0→L1: ngưỡng `leafBatchThreshold`
- L1→L2: ngưỡng `resummaryThreshold`
- L2+: ngưỡng `higherResummaryThreshold`

Tất cả đều nằm trong Cài đặt → Cài đặt tóm tắt. Ngoài ra còn có `leafKeepRecent`: tầng lá giữ lại N mục gần nhất không nén, tránh việc "nén sập toàn bộ một lần thành L1" gây ra đứt gãy thông tin tiêm.

### Hỏi: Có thể ép đại tóm tắt thủ công không?

Được. Ở trang Tóm tắt nhấn Chọn nhiều (tích chọn một số nút gốc, cần liên tiếp nhau) → ép gộp thành một bản đại tóm tắt tầng trên, bỏ qua ngưỡng. Cũng có thể nhấn "Đại tóm tắt ngay" để chạy kiểm tra ngưỡng một lần.

### Hỏi: Tóm tắt lại (replaceLeaf / regenerateFloor) dùng để làm gì?

Tạo lại bản tóm tắt cho tầng đã có lá (khi chính văn đã được chỉnh sửa, hoặc chất lượng bản tóm tắt kém). Sẽ gửi yêu cầu kèm theo bản tóm tắt gốc, nếu phân tích thất bại sẽ báo lỗi.

### Hỏi: Tại sao các tầng đã tóm tắt lại biến mất khỏi cuộc đối thoại?

Bách Bảo Thư đánh dấu ẩn các tầng **đã có tóm tắt + đã rời khỏi cửa sổ giữ lại** khỏi ngữ cảnh gửi đi (chỉ ẩn ngữ cảnh, không xóa dữ liệu), nguyên văn vẫn nằm trong tệp trò chuyện. Không gian cửa sổ nhường ra đó dành cho "Trạng thái hiện tại + Tóm tắt lịch sử", lượng thông tin của AI ngược lại còn lớn hơn.

### Hỏi: Thẻ thời gian `<bbs_start>` / `<bbs_end>` là gì?

Bách Bảo Thư tiêm vào cuộc đối thoại chính một lời nhắc ở D0 (sát với phản hồi tiếp theo nhất), yêu cầu **đầu** mỗi chính văn xuất `<bbs_start>…</bbs_start>`, **cuối** xuất `<bbs_end>…</bbs_end>`, biến "thời gian" từ suy đoán sau sự việc của bản tóm tắt thành sự thật ngay trong chính văn. Tóm tắt đọc trực tiếp thời gian từ thẻ, mô hình chính cũng luôn biết "bây giờ là mấy giờ". Tính năng thẻ thời gian đi theo công tắc "Bật tóm tắt tự động". Các thẻ này khi hiển thị sẽ được regex ẩn giấu đi.

### Hỏi: Tầng ngoại truyện là gì?

Bên dưới mỗi tầng AI có một giao diện nhỏ, có thể đánh dấu "Ngoại truyện" bằng một cú nhấn. Tầng được đánh dấu là ngoại truyện (`extra.bbs_omit`) **hoàn toàn không tồn tại** đối với hệ thống trí nhớ: không tóm tắt, không đại tóm tắt, không ẩn, không phát lại dẫn xuất, không tiêm, không vào dòng thời gian —— phù hợp cho tiểu kịch trường / phần ngoại truyện. Bỏ ngoại truyện sẽ lập tức khôi phục bản tóm tắt của nó (không mang tính phá hủy, chỉ chuyển đổi đánh dấu, không xóa lá); nếu lá của tầng đó đã được nén vào đại tóm tắt tầng trên, văn bản đại tóm tắt đó vẫn chứa tầng này cho tới khi đại tóm tắt lại.

### Hỏi: Thời gian tương đối ("Hôm qua", "3 ngày trước") từ đâu mà có?

Khi tiêm tóm tắt lịch sử, hệ thống quy đổi thành tiền tố thời gian tương đối theo "thời gian mới nhất trong truyện hiện tại" (đọc thẻ thời gian chính văn, không bị ảnh hưởng bởi việc đã tóm tắt hay chưa), giúp mô hình cảm nhận được khoảng cách cốt truyện. Logic quy đổi thời gian xem tại `timeRel.ts`, có kịch bản kiểm thử độc lập (`npm run test:time`).

### Hỏi: Tại sao dùng plugin rồi mà vẫn tốn nhiều token như vậy?

Plugin chỉ can thiệp vào các tầng **đã cuộn ra khỏi cửa sổ giữ lại**: chính văn trong cửa sổ vẫn được gửi toàn văn như thường (tránh lặp lại giữa tóm tắt và toàn văn), chỉ những tầng cũ đã cuộn ra khỏi cửa sổ mới được thay thế bằng bản tóm tắt. Do đó khi cuộc đối thoại chưa dài, lượng token sử dụng cơ bản tương đương với khi chưa cài plugin, đây là hiện tượng bình thường; khi đối thoại dài và nhiều tầng cũ được ẩn đi thì sự tiết kiệm mới dần thể hiện rõ.

**Hãy phán đoán xem phần chiếm nhiều nhất nằm ở đâu trước.** Trang Tóm tắt có hiển thị ước tính lượng tiêm (quy đổi theo số byte UTF-8, không gửi yêu cầu tới backend):

- "Tiêm tóm tắt ≈": Tóm tắt lịch sử được tiêm sau khi các tầng cuộn ra khỏi cửa sổ
- "Tiêm khác ≈": Trạng thái có cấu trúc hiện tại + Lời nhắc thẻ thời gian

Tổng ngữ cảnh = Nội dung tiêm của plugin + Chính văn trong cửa sổ + Preset người dùng (prompt) + Sách Thế Giới kích hoạt + Khung bọc mẫu trò chuyện. Nếu phần tiêm của plugin chiếm tỷ lệ rất nhỏ mà tổng token vẫn cao, thì phần nặng nhất nằm ở preset / Sách Thế Giới / chính văn, cần điều chỉnh những thứ đó thay vì plugin; ngược lại mới điều chỉnh plugin.

**Các mục có thể điều chỉnh ở phía plugin**: Đổi Mức số chữ sang "Tinh gọn" (tóm tắt / đại tóm tắt ngắn hơn); tắt truy xuất vector hoặc giảm số lượng mục; tinh gọn mẫu biến số / trạng thái; giảm ngưỡng đại tóm tắt để gộp đại tóm tắt cấp cao sớm hơn (một bản đại tóm tắt thay thế cho nhiều lá).

---

## 4. Giải đáp về theo dõi trạng thái

Ngoài tóm tắt, Bách Bảo Thư còn trích xuất trạng thái có cấu trúc từ chính văn mỗi tầng. Toàn bộ đều là **dữ liệu dẫn xuất**: thu được từ việc phát lại delta của lá theo thứ tự tầng, không lưu cứng vào ổ đĩa, tự động hoàn tác khi xóa tầng.

### Hỏi: Chế độ "Chỉ tiêm tóm tắt cốt truyện" là gì?

`summaryOnlyMode` trong Cài đặt → Cài đặt tiêm, **tương thích với hệ thống biến số có sẵn của thẻ nhân vật**. Sau khi bật: vẫn phân tích, lưu trữ và hiển thị vật phẩm / nhân vật / khung cảnh / kế hoạch / biến số trong Bách Bảo Thư, **nhưng không còn tiêm trạng thái hiện tại vào mô hình chính, cũng không ghi chú thích biến động vật phẩm / biến số vào chính văn nữa** (chú thích đã có không tự động xóa). Phù hợp với trường hợp thẻ nhân vật của bạn đã có sẵn một bộ lời nhắc biến số và không muốn khối trạng thái của Bách Bảo Thư xung đột với nó.

### Hỏi: Vật phẩm được ghi nhận như thế nào?

Khi tóm tắt mỗi tầng, AI đối chiếu với "Vật phẩm hiện có" để kiểm kê phần tăng thêm:

- Nhận được → `items.add`
- Dùng hết / Hư hỏng → `items.remove`
- Thay đổi số lượng / Thay đổi mô tả / Đổi chỗ để → `items.update` (có thể sửa số lượng, `carried` mang theo / gửi cất giữ, `location`)
- Loại trừ: đồ dùng hàng ngày tạm thời, trang phục (trang phục ghi vào outfit của nhân vật chính / NPC), thức ăn thông thường.

Biến động vật phẩm còn được ghi vào chính văn dưới dạng chú thích `<bbs_items>`, để mô hình chính "nhìn thấy mình vừa mới sửa đổi". Khi bạn chỉnh sửa thủ công chú thích trong chính văn (như "Nhận Dao găm 1"), hệ thống sẽ phân tích ngược lại vào delta của lá —— **cách chính thống để sửa vật phẩm thủ công trong chính văn chính là sửa chú thích `<bbs_items>`**.

### Hỏi: Kế hoạch (plan) và Nghi vấn (suspense) là gì?

- **Kế hoạch**: Việc nhân vật chủ động hứa hẹn / quyết định sẽ làm (xuyên cảnh mới ghi, nói suông không tính).
- **Nghi vấn**: Sự thật chờ được hé lộ / sự kiện bên ngoài đã khởi động (phục bút).
- Khi kết thúc dùng `plans.resolve` và ghi rõ outcome (`done` hoàn thành / `cancelled` hủy bỏ / `failed` thất bại) + lý do.
- Thiết kế mấu chốt: cùng một việc "được nêu ra rồi hóa giải ngay tại chỗ" sẽ được đánh dấu `cancelled` thay vì `done`, để mô hình chính không tưởng nhầm là vẫn phải làm mà nhắc đi nhắc lại.
- Các mục vừa kết thúc gần đây sẽ được tiêm (kế hoạch và nghi vấn mỗi loại lấy N mục gần nhất, do `recentResolvedPlansCount` điều khiển), ngăn mô hình phụ ghi nhận trùng lặp và mô hình chính thúc đẩy trùng lặp.

### Hỏi: Khung cảnh (scene) được ghi nhận thế nào? Tại sao phải dùng "cây"?

Địa điểm được tổ chức theo phân cấp (Quốc gia / Thành phố / Đường phố…), id tất định theo đường dẫn như `scene:Thành phố/Quán trọ`, cùng một đường dẫn mỗi lần phát lại đều thu được cùng một id. Khi AI ghi nhận địa điểm mới sẽ đưa ra đường dẫn đầy đủ, khi phát hiện quan hệ trực thuộc sẽ dùng `reparent` gắn vào cấp trên chính xác. Khi tiêm sẽ hiển thị chia ba mức theo khung cảnh hiện tại (tầng hiện tại mô tả chi tiết, cấp trên tóm lược, không liên quan chỉ liệt kê tên) để tiết kiệm token.

### Hỏi: NPC được quản lý như thế nào?

- Mới xuất hiện: phải có tương tác trực tiếp, cụ thể, có ý nghĩa cốt truyện với nhân vật chính và viết ra được thân phận mới `npcs.add` (tiểu nhị, người qua đường bị ngưỡng chặn lại); cung cấp tên / giới tính / tuổi / thân phận / quan hệ / trang phục / trạng thái / có đi cùng hay không.
- Đã có trong danh sách: thay đồ, bị thương, rời nhóm → `update outfit/condition/location/follow`; quan hệ thay đổi về chất (đoạn tuyệt / định tình / kết bái / thành hôn, phải có bằng chứng rõ ràng) mới `update relation`, cãi vã không tính.
- ★ Nhân vật chính yếu sau khi rời cảnh nhiều ngày có thể suy diễn hợp lý trang phục / trạng thái của họ, tránh việc "tái ngộ vẫn mặc nguyên bộ đồ cũ".
- Rời khỏi cốt truyện vĩnh viễn mới `remove`.

### Hỏi: Hồ sơ nhân vật chính (protagonist) dùng để làm gì?

Hồ sơ khách quan của riêng nhân vật chính: giới tính / thân phận / ngoại hình / trang phục / trạng thái, độc lập với danh sách NPC, tiêm toàn lượng không tham gia phân mức. Tuổi kèm theo mốc "lúc X", hệ thống tự động suy tính theo thời gian trôi qua, AI chỉ cập nhật khi chính văn nhắc tới rõ ràng, tránh việc tự dưng tăng tuổi lung tung.

### Hỏi: Tại sao trạng thái lại được "phát lại" mà không lưu trực tiếp một bản?

Bởi vì rừng tóm tắt có tính **khả nghịch**: việc bạn lật trang / swipe sẽ làm thay đổi tập hợp lá, xóa tầng sẽ xóa lá. Nếu trạng thái được lưu ổ đĩa riêng, sẽ xảy ra sự lệch pha "trạng thái đã lưu nhưng cốt truyện đã mất". Phát lại theo tầng đảm bảo: **trạng thái luôn bằng "tổng hợp của tất cả các lá hợp lệ hiện tại"**, xóa lá nào thì đóng góp của lá đó tự động biến mất.

---

## 5. Chuyên đề Biến số tùy chỉnh (Trọng tâm)

> Rất nhiều tính năng người dùng đề xuất (thanh máu, độ hảo cảm, tiền bạc, danh sách nhiệm vụ, cờ đánh dấu tiến độ cốt truyện, danh vọng thế lực, ô trang bị, mở khóa thành tựu…) thực chất Bách Bảo Thư **đã hỗ trợ sẵn** —— đó chính là Biến số tùy chỉnh. Dưới đây sẽ trình bày chi tiết.

### Hỏi: Biến số tùy chỉnh là gì?

Một cây trạng thái JSON **có cấu trúc hoàn toàn do bạn định nghĩa**. Bách Bảo Thư chỉ phụ trách ba việc:

1. Tiêm cây hiện tại cho AI (cả mô hình chính + mô hình tóm tắt đều nhìn thấy).
2. Cho phép AI (hoặc bạn thao tác thủ công) dùng **lệnh đường dẫn** để thêm/xóa/sửa cây này, lệnh được cố định vào delta của lá, phát lại theo tầng —— vì vậy nó giống hệt các trạng thái khác: tiến triển theo cốt truyện, có thể hoàn tác, không tự dưng biến mất.
3. Trang Biến số hiển thị cây hiện tại, hỗ trợ chỉnh sửa thủ công toàn bộ để ghi lại.

Sự khác biệt giữa nó và theo dõi tích hợp sẵn (vật phẩm / kế hoạch / NPC…): **tích hợp sẵn là quy ước chặt chẽ cho "lĩnh vực cụ thể"**, còn biến số là cấu trúc tự do cho "bất kỳ lĩnh vực nào". Những gì bạn muốn theo dõi mà phần tích hợp sẵn chưa bao phủ (chỉ số hảo cảm, giai đoạn nhiệm vụ, danh vọng thế lực, cờ cốt truyện), hãy dùng biến số.

### Hỏi: Mẫu ba tầng (global / char / chat) có nghĩa là gì?

Định nghĩa biến số = **Mẫu cấu trúc ban đầu + Hai đoạn giải thích cho AI**, được lưu trữ chia làm ba tầng:

| Cấp độ | Lưu ở đâu | Phạm vi có hiệu lực | Công dụng điển hình |
|---|---|---|---|
| `global` Toàn cục | `extension_settings` | Mọi nhân vật, mọi cuộc trò chuyện | Khung xương chung (như công tắc tổng `flag`, quy ước chỉ số chung) |
| `char` Nhân vật | `extension_settings` (phân biệt theo nhân vật) | Mọi cuộc trò chuyện của nhân vật hiện tại | Thiết lập riêng của nhân vật đó (như "giới hạn ma lực, hệ thống phép thuật") |
| `chat` Trò chuyện | `chatMetadata` | Chỉ cuộc trò chuyện hiện tại | Thiết lập riêng của ván này (như nhiệm vụ ván này) |

**Ba tầng gộp sâu (deep merge)** thành trạng thái ban đầu, thứ tự gộp `chat > char > global` (Trò chuyện ghi đè Nhân vật ghi đè Toàn cục).

**Quan trọng: cấp độ chỉ ảnh hưởng tới việc "mẫu ban đầu lưu ở đâu", còn giá trị của biến số luôn độc lập theo từng cuộc trò chuyện.** Bởi vì giá trị được phát lại từ lệnh lá của riêng cuộc trò chuyện đó, tự nhiên không bao giờ bị lẫn dữ liệu giữa các bản lưu. Bạn đổi máu thành 5 trong cuộc trò chuyện của nhân vật A sẽ không ảnh hưởng tới nhân vật B hay một cuộc trò chuyện khác của A.

### Hỏi: Ba trường trong mẫu (JSON / Ý nghĩa / Quy tắc) lần lượt là gì?

- **JSON**: Cấu trúc ban đầu, bạn dựng sẵn hình dáng muốn theo dõi (cũng có thể để đối tượng rỗng `{}`, cho AI xây dựng từ con số không).
- **Ý nghĩa (meaning)**: Các trường **là gì** (ý nghĩa / phạm vi giá trị). **Cả mô hình chính và mô hình tóm tắt đều sẽ nhìn thấy**, dùng để "hiểu giá trị hiện tại", tham khảo chỉ đọc.
- **Quy tắc (rule)**: **Khi nào sửa thế nào, có được tạo mới không** (tương đương với điều kiện biến đổi của MVU). **Chỉ gửi cho mô hình tóm tắt**, không gửi cho mô hình chính —— bởi vì nếu mô hình chính nhìn thấy chỉ dẫn "làm thế nào để thêm/xóa/sửa", nó sẽ tưởng nhầm là phải xuất / thuật lại biến số trong chính văn. Trong quy tắc còn có thể viết "AI có thể tự tạo mục mới (như thế lực mới)".

> Tóm lại một câu: **Ý nghĩa giúp AI đọc hiểu, Quy tắc dạy AI cách sửa**.

### Hỏi: Có những cú pháp lệnh nào? Đường dẫn viết ra sao?

Mô phỏng bốn loại lệnh của MVU, cố định vào `delta.varOps` của lá:

| Lệnh | Tác dụng | Tham số mấu chốt |
|---|---|---|
| `set` | **Đặt** giá trị tại path thành value (tự động tạo tầng trung gian) | `path`, `value`; `path=""` biểu thị thay thế toàn bộ gốc |
| `add` | Cộng thêm delta vào **con số** tại path (số âm tức là trừ) | `path`, `delta` (số) |
| `assign` | **Chèn** vào đối tượng / mảng tại path | `path`, `key` (tùy chọn), `value`; có `key` thì `obj[key]=value` (mảng là chỉ số đó), không có `key` thì push vào mảng |
| `remove` | **Xóa** | `path`, `key` (tùy chọn); có `key` thì xóa khóa đối tượng / chỉ số mảng / phần tử trong mảng bằng với key; không có `key` thì xóa bản thân path |

**Cú pháp đường dẫn**: Dấu chấm để định vị đối tượng, chỉ số chữ số để định vị mảng, ví dụ:

- `Thế_lực.Hội_đồng_phép_thuật.Danh_vọng`
- `Đội_hình[0].hp`
- `Nhiệm_vụ.Chính_tuyến.Giai_đoạn`

Lệnh lỗi sẽ bị bỏ qua (không gây sập), nên việc AI thỉnh thoảng viết sai sẽ không làm hỏng cả tầng.

### Hỏi: Có thể cho vài ví dụ mẫu cho các kịch bản thường dùng không?

**① Thanh máu / Thanh năng lượng của đội hình (kiểu số)**

```json
{
  "Đội hình": [
    { "Tên": "", "hp": 100, "maxHp": 100, "mp": 50, "Trạng thái": "" }
  ]
}
```

Ý nghĩa: `Đội hình` là mảng, mỗi phần tử là một đồng đội; `hp/mp` là giá trị hiện tại, `maxHp` là giới hạn tối đa, `Trạng thái` như "Trúng độc/Hôn mê".
Quy tắc: Bị thương trong chiến đấu dùng `add` trừ `Đội hình[i].hp`; `hp` không được vượt quá `maxHp`; khi nhân vật tử vong thì `hp` về 0 và ghi `Trạng thái`; cho phép push thành viên mới vào `Đội hình`.

**② Độ hảo cảm / Chỉ số quan hệ**

```json
{
  "Quan hệ": {
    "Alice": { "Hảo cảm": 0, "Tin tưởng": 0, "Ghi chú": "" }
  }
}
```

Ý nghĩa: `Hảo cảm` 0–100, càng lớn càng thân thiết; `Tin tưởng` tương tự.
Quy tắc: Sau khi kết thúc mỗi cuộc đối thoại, dùng `add` điều chỉnh độ hảo cảm của nhân vật liên quan theo hướng đi của cốt truyện (phải có căn cứ rõ ràng mới thay đổi, đừng cộng bừa theo tâm trạng); `Ghi chú` ghi lại một câu về mối quan hệ hiện tại.

**③ Thống kê tiền bạc / vật tư**

```json
{
  "Tiền bạc": 0,
  "Kho hàng": {}
}
```

Quy tắc: Khi giao dịch / thu được chiến lợi phẩm / đánh mất thì dùng `add` sửa `Tiền bạc`; `Kho hàng` có thể chèn mục vật phẩm mới.

**④ Theo dõi nhiệm vụ (kiểu đối tượng)**

```json
{
  "Nhiệm vụ": {
    "Chính tuyến": { "Tên": "", "Giai đoạn": "Tiếp nhận", "Mục tiêu": "", "Tiến độ": 0 },
    "Phụ tuyến": []
  }
}
```

Quy tắc: `Giai đoạn` nhận giá trị "Tiếp nhận/Đang làm/Hoàn thành/Thất bại", khi thay đổi dùng `set`; `Tiến độ` 0–100 dùng `add`; nhiệm vụ đã hoàn thành giữ lại trong danh sách nhưng đánh dấu `Hoàn thành`, đừng xóa đi —— nhiệm vụ đã kết thúc cũng là trí nhớ.

**⑤ Cờ đánh dấu trạng thái cốt truyện (flag)**

```json
{
  "flag": {
    "Đã tiết lộ thân thế": false,
    "Đã vào hầm ngục": false,
    "Ma vương đã bị đánh bại": false
  }
}
```

Quy tắc: Khi cốt truyện đạt điều kiện thì dùng `set` đặt thành true, sự kiện một lần sau khi đã đặt thành true không được sửa ngược lại nhiều lần.

**⑥ Danh vọng thế lực**

```json
{
  "Thế lực": {
    "Hội đồng phép thuật": { "Danh vọng": 0, "Lập trường": "Trung lập" }
  }
}
```

Quy tắc: Cho phép AI **tạo mới** mục thế lực trong cốt truyện (assign vào dưới `Thế lực`); danh vọng ± phải có căn cứ sự kiện.

### Hỏi: AI có tự tạo biến số không? Hay bắt buộc tôi phải dựng mẫu?

Cả hai đều được:

- Bạn dựng sẵn mẫu → AI cập nhật nghiêm ngặt theo cấu trúc.
- Mẫu để trống → AI cũng có thể tự do tạo mới trong cốt truyện (với điều kiện trong quy tắc cho phép, hoặc hoàn toàn không cấu hình quy tắc). Nhưng **khuyên dùng dựng mẫu + viết Ý nghĩa / Quy tắc**, nếu không cách đặt tên trường của AI sẽ bị trôi lệch (lần này `hp`, lần sau `Sinh lực`).

### Hỏi: Tại sao biến số của tôi không được cập nhật? Các nguyên nhân thường gặp

1. **Quy tắc viết chưa rõ ràng**: AI không biết khi nào cần sửa. Quy tắc phải cụ thể tới mức "sự kiện gì kích hoạt lệnh gì".
2. **Ý nghĩa viết chưa rõ ràng**: AI đọc không hiểu ý nghĩa trường nên không dám động vào.
3. **Chưa cấu hình mẫu**: Khi toàn bộ khối biến số chưa được kích hoạt, trong lời nhắc tóm tắt sẽ **lược bỏ nguyên khối** (0 token), AI hoàn toàn không biết có sự tồn tại của biến số. Chỉ cần cấu hình mẫu (dù chỉ là ý nghĩa/quy tắc hoặc JSON), khối biến số mới xuất hiện trong lời nhắc.
4. **Giá trị không đổi**: AI phán đoán tầng này không có cốt truyện ảnh hưởng tới biến số nên đã làm đúng là không xuất lệnh —— đây không phải là bug.
5. **Đang xem trạng thái cũ**: Trạng thái hiện tại là kết quả phát lại "tính đến một tầng nào đó"; nếu tầng nào đó chưa được tóm tắt thì lệnh biến số của nó tự nhiên chưa được đưa vào.

### Hỏi: Sửa mẫu (giá trị ban đầu) có ảnh hưởng tới giá trị hiện tại của cuộc trò chuyện đã có không?

Có. Mẫu ban đầu là **điểm xuất phát phát lại**. Sửa giá trị ban đầu → phát lại toàn bộ lệnh lá từ điểm xuất phát mới → giá trị hiện tại thay đổi tổng thể (vì vậy "Sửa giá trị ban đầu sẽ ảnh hưởng tới giá trị hiện tại của toàn bộ cuộc trò chuyện" —— trang Biến số cũng nhắc như vậy). Nếu chỉ muốn sửa giá trị hiện tại mà không động tới lịch sử, hãy dùng chỉnh sửa thủ công ở phần "Trạng thái hiện tại" (xem bên dưới).

### Hỏi: Chỉnh sửa thủ công Trạng thái hiện tại có tác dụng gì? Khác gì với sửa mẫu?

- **Sửa mẫu** = sửa "điểm xuất phát phát lại", ảnh hưởng toàn bộ cuộc trò chuyện (bao gồm cả suy diễn lịch sử).
- **Chỉnh sửa thủ công trạng thái hiện tại** = viết trực tiếp toàn bộ JSON thành một lệnh `set path=""`, **nối thêm vào lá mới nhất**, tương đương với "tại thời điểm mới nhất do chính tay bạn cập nhật trạng thái". Phù hợp khi: AI ghi nhầm, bạn muốn tinh chỉnh con số, cốt truyện có bước nhảy vọt.
- ⚠️ **Chỉnh sửa thủ công đòi hỏi cuộc trò chuyện đã có tóm tắt** (vì phải ghi vào lá mới nhất, lá không tồn tại thì không thể ghi được).

### Hỏi: Nhập / Xuất dùng để làm gì?

Chia sẻ "phương án biến số": thứ được xuất ra là **cấu trúc ban đầu + ý nghĩa + quy tắc sau khi gộp ba tầng (không chứa giá trị cụ thể)**, người khác nhập vào tầng global/char/chat của họ là có thể tái sử dụng cùng một hệ thống biến số (ví dụ một bộ mẫu chỉ số RPG chung). Định dạng xuất tương thích với định dạng chia sẻ cũ chỉ có một trường `guide` đơn lẻ.

### Hỏi: Làm sao để mô hình chính nhìn thấy biến số trong chính văn? Có tốn nhiều token không?

- Mô hình chính nhìn thấy cây biến số trong **khối tiêm trạng thái hiện tại** (kết xuất JSON thụt lề).
- **Biến đổi** biến số còn được ghi vào chính văn dưới dạng chú thích `<bbs_vars>`, mô hình chính có thể "nhìn thấy mình vừa mới sửa đổi".
- Kiểm soát token: khi chưa cấu hình biến số sẽ lược bỏ nguyên khối (chi phí bằng 0); sau khi cấu hình là "một cây JSON", hãy cố gắng giữ cấu trúc tinh gọn.

### Hỏi: Biến số có làm được việc "AI tự tạo mục mới" không (ví dụ trong cốt truyện xuất hiện thế lực mới)?

Được. Hãy viết rõ trong phần "có được tạo mới không" của Quy tắc, ví dụ "cho phép assign mục mới vào đối tượng `Thế lực`". AI sẽ dùng `assign` (kèm key) để chèn khóa mới vào đối tượng.

### Hỏi: Đường dẫn của biến số có dùng được trong API công khai / Macro không?

Được, đường dẫn đồng nhất với bên trong:

- JS: `STBaiBaiBook.getVar('Quan hệ.Alice.Hảo cảm')`
- Macro: `{{bbsVar::Quan hệ.Alice.Hảo cảm}}`
- Lệnh gạch chéo: `/bbs-get vars` lấy toàn bộ cây.

Xem chi tiết tại [Mục 8](#8-api-công-khai--macro--lệnh-gạch-chéo).

### Hỏi: Nên dùng biến số hay dùng vật phẩm / kế hoạch tích hợp sẵn?

- **Vật phẩm, Kế hoạch / Nghi vấn, Khung cảnh, NPC, Hồ sơ nhân vật chính**: đây là các lĩnh vực quy ước chặt chẽ của Bách Bảo Thư, được tự động duy trì, có giao diện UI và định dạng tiêm chuyên biệt, hãy ưu tiên dùng phần tích hợp sẵn.
- **Tất cả các con số / cờ đánh dấu / cấu trúc tự do khác** (hảo cảm dạng số, HP, tiền bạc, giai đoạn nhiệm vụ, flag, danh vọng, trang bị, thành tựu…): dùng biến số tùy chỉnh.
- Quy tắc: cái gì phần tích hợp sẵn bao phủ được thì dùng tích hợp sẵn, cái gì không bao phủ tới thì dùng biến số. Hai bên cùng tồn tại không xung đột (cây biến số độc lập với trạng thái tích hợp sẵn).

---

## 6. Giải đáp về Trí nhớ vector

### Hỏi: Trí nhớ vector (Bách Bảo Khố) là gì? Tại sao lại cần nó?

Rừng tóm tắt là "trí nhớ nén", có hao hụt thông tin; trí nhớ vector là **truy xuất toàn văn**: embed mỗi chiếc lá (cùng toàn văn của nó) vào kho vector, khi tạo phản hồi sẽ tìm kiếm ngữ nghĩa theo cốt truyện hiện tại, tiêm lại các phân đoạn lịch sử liên quan nhất, phù hợp với những kịch bản mà chi tiết đã bị mất trong bản tóm tắt như "phục bút cài cắm từ nhiều năm trước đột nhiên cần thu hồi". Hỗ trợ đầy đủ nhất khi có plugin backend đi kèm "Bách Bảo Khố" (`/api/plugins/baibaoku/v1/`), hoặc chạy ở chế độ cục bộ trên trình duyệt.

### Hỏi: Truy xuất hoạt động như thế nào?

1. **Viết lại truy vấn**: Dùng mô hình nhỏ viết lại "cốt truyện gần nhất + ảnh chụp nhanh trạng thái" thành `INTENT` + đúng 5 câu truy vấn tìm kiếm Q (không tra cứu nội dung đã có trong cửa sổ, chỉ tìm ở ngoài cửa sổ).
2. **Tìm kiếm đa luồng**: Thực hiện tìm kiếm vector trên scope của chat hiện tại + các bundle scope.
3. **Sắp xếp tinh chỉnh / Dung hợp**: Dung hợp điểm số + sắp xếp lại (rerank), chia làm hai mức "Mức toàn văn / Mức tóm tắt".
4. **Khử trùng lặp**: Loại trừ các lá đã nhìn thấy trong cửa sổ trượt.
5. **Tiêm**: Tiêm vào ngữ cảnh thông qua setExtensionPrompt.

Toàn bộ quá trình **hạ cấp âm thầm**: khi backend không khả dụng / thất bại sẽ không làm chặn việc tạo phản hồi.

### Hỏi: Cấu hình như thế nào?

Cài đặt → Trí nhớ vector: bật công tắc, cấu hình ba điểm cuối mô hình (Embedding / Rerank / Viết lại Query), rồi điều chỉnh tham số truy xuất (số lượng, ngưỡng...). Lá mới sẽ được đồng bộ chống rung (debounce) vào kho vector; việc đối soát sẽ dọn sạch các lá cũ lỗi thời ở backend.

### Hỏi: Scope của kho vector là gì?

- Cuộc trò chuyện hiện tại là một scope;
- Mỗi lần "Tạo cuộc trò chuyện mới kèm dữ liệu" sẽ tạo ra một **bundle** (ảnh chụp nhanh vector của cuộc trò chuyện nguồn), cuộc trò chuyện mới có thể tìm kiếm xuyên qua các bundle, giúp cuộc trò chuyện mới "nhớ được" những nội dung đã cuộn đi mất trong cuộc trò chuyện cũ.

### Hỏi: Ba điểm cuối vector (embedding / rerank / queryRewrite) lần lượt cần mô hình gì?

- **embedding** (bắt buộc): Bắt buộc phải điền điểm cuối hỗ trợ giao diện `/embeddings` tương thích OpenAI + **mô hình embedding** (mặc định SiliconFlow `Qwen/Qwen3-Embedding-8B`). Mô hình đối thoại / tạo văn bản không có khả năng embeddings, nếu điền vào chắc chắn sẽ thất bại (không dựng được chỉ mục).
- **queryRewrite (Viết lại Query)**: Cần **mô hình đối thoại** (đi qua `/chat/completions`), nó phải đọc cốt truyện để viết từ khóa tìm kiếm. ⚠️ Khi url/key của điểm cuối này để trống sẽ **mặc định tái sử dụng địa chỉ và khóa của điểm cuối embedding**, nhưng bạn bắt buộc phải chọn riêng một mô hình đối thoại cho nó —— mô hình embedding không có khả năng chat/completions, nếu dùng nhầm mô hình embedding thì việc viết lại truy vấn chắc chắn sẽ thất bại (xem mục dưới).
- **rerank (Sắp xếp lại)**: Cần mô hình sắp xếp lại chuyên dụng; nếu không điền sẽ hạ cấp (dùng thứ tự độ tương đồng embedding).

### Hỏi: Cấu hình vector bình thường nhưng mãi không thấy truy xuất, cần kiểm tra từ đâu?

Theo thứ tự sau:

1. **Đọc "Chi tiết lần truy xuất trước"**: Cài đặt → Trí nhớ vector → Chi tiết lần truy xuất trước sẽ ghi lại nguyên nhân mỗi lần không truy xuất (chưa đạt ngưỡng / tìm kiếm không có ứng viên / thất bại: thông tin cụ thể), hãy xem nó trước tiên.
2. **Viết lại truy vấn**: Bắt buộc bật, không hạ cấp, nếu thất bại thì toàn bộ lần truy xuất này bị hủy và xóa trống khe tiêm; nguyên nhân thất bại thường gặp là queryRewrite chưa được cấu hình mô hình đối thoại riêng. Hãy cấu hình riêng cho nó một mô hình đối thoại là được.
3. **Ngưỡng bắt đầu truy xuất**: Số tầng AI < `minAiFloors` (mặc định 30) sẽ bỏ qua; mọi tầng vẫn đang nằm trong cửa sổ giữ lại (không có tầng cũ ngoài cửa sổ để truy xuất) sẽ bỏ qua. Các lá đã nhìn thấy trong cửa sổ sẽ bị loại trừ để tránh trùng lặp với toàn văn.
4. **Ngưỡng điểm**: Mức tóm tắt đòi hỏi độ tương đồng embedding ≥ `embeddingThreshold` (mặc định 0.8); mức toàn văn đòi hỏi điểm rerank ≥ `rerankThreshold` (mặc định 0.9). Khi không đạt chuẩn, trạng thái sẽ là "Truy xuất hoàn tất: không có nội dung đạt ngưỡng, lượt này chưa chèn".
5. **Dữ liệu / Nền tảng**: Cuộc trò chuyện cũ hoặc bật vector muộn thì các lá cũ có thể chưa từng được lập chỉ mục (cần nhấn "Dựng lại chỉ mục vector của trò chuyện hiện tại" trước).
6. **Loại kích hoạt**: Chỉ các lần tạo "sinh ra chính văn mới" mới kích hoạt truy xuất; `continue` / `quiet` / `impersonate` không kích hoạt.

### Hỏi: Tại sao khi tạo lại (regenerate) / lật trang (swipe) thì kết quả truy xuất không đổi?

Đó là bình thường, nhờ bộ nhớ đệm truy xuất: khi đầu vào truy xuất (tầng user mới nhất, tầng AI liền trước, tham số truy xuất) không thay đổi một chữ nào thì sẽ tái sử dụng trực tiếp nội dung tiêm lần trước, tiết kiệm hạn mức và thời gian của Viết lại + Embed + Tìm kiếm + Sắp xếp lại. Sau khi chỉnh sửa nội dung nhập mới nhất hoặc sửa tham số truy xuất (ngưỡng / số lượng), bộ nhớ đệm sẽ tự động mất hiệu lực và tính toán lại; khóa đệm có chứa chatId nên sẽ không bị trúng nhầm xuyên cuộc trò chuyện.

---

## 7. Giải đáp về API phụ

### Hỏi: Tại sao tóm tắt lại phải dùng "API phụ"? Không thể tái sử dụng mô hình đối thoại chính sao?

Tóm tắt / đại tóm tắt là tác vụ độc lập, văn bản dài, tần suất cao; nếu dùng kênh đối thoại chính sẽ: chiếm hàng đợi tạo phản hồi, trộn lẫn vào ngữ cảnh đối thoại chính, tiêu hao hạn mức của đối thoại chính. API phụ đi theo kênh độc lập (có thể cấu hình nhiều kênh), không làm nhiễu lẫn nhau.

### Hỏi: Nếu không cấu hình kênh nào cả thì sao?

Tóm tắt / đại tóm tắt sẽ tự động lùi về **API chính** (dùng API hiện đang sử dụng ở giao diện chính, yêu cầu không kèm theo lịch sử trò chuyện). Chỉ khi API chính cũng không khả dụng mới báo lỗi (lỗi ghi vào `lastError`, hiển thị ở trang Tóm tắt). Tuy nhiên tóm tắt / đại tóm tắt là tác vụ độc lập tần suất cao, chiếm dụng kênh chính sẽ phải xếp hàng, trộn ngữ cảnh, tốn hạn mức, nên khuyên bạn cấu hình ít nhất một kênh phụ; khi có nhiều kênh thì "Tóm tắt" và "Đại tóm tắt" có thể được chỉ định riêng (`resolveSender('summary' / 'resummary')`).

### Hỏi: Cấu hình API phụ như thế nào?

Cài đặt → API phụ:

- Có thể cấu hình nhiều kênh + tham số loại trừ riêng cho từng kênh (những trường tham số nào không gửi).
- Tóm tắt và Đại tóm tắt (resummary) có thể chỉ định kênh riêng biệt.

### Hỏi: Định dạng trả về không đúng ("AI xin lỗi hoặc làm rơi định dạng") thì phải làm sao?

- Xác nhận mô hình hỗ trợ xuất JSON chuẩn, không tự ý cắt xén.
- Xác nhận mô hình xuất khối kiểm tra `<thinking>` trước rồi mới xuất JSON (lời nhắc tích hợp sẵn đã yêu cầu; mẫu tùy chỉnh cần giữ lại yêu cầu này).
- Trong lời nhắc tùy chỉnh hãy giữ lại yêu cầu xuất JSON (mẫu tùy chỉnh sẽ tự động được nối thêm giao thức tương thích, nhưng đừng xóa các trường JSON cốt lõi).
- Tóm tắt có cài đặt số lần thử lại (`summaryMaxRetries`).

### Hỏi: Phá giới hạn (jailbreak) là gì?

Lời nhắc system mặc định được đính kèm trong yêu cầu tóm tắt / đại tóm tắt, giúp giảm tỷ lệ từ chối trả lời của API phụ đối với nội dung nhạy cảm / bạo lực —— tóm tắt đối mặt với chính văn đã được tạo ra, nhiệm vụ là **ghi chép trung thực** chứ không phải kiểm duyệt lần hai. Trong Cài đặt có thể ghi đè hoặc để trống (để trống sẽ dùng bản tích hợp sẵn).

### Hỏi: Mô hình tóm tắt có quan hệ gì với thiết lập nhân vật / Sách Thế Giới?

Yêu cầu tóm tắt sẽ đính kèm: thiết lập thẻ nhân vật, persona người dùng, Sách Thế Giới được kích hoạt, cùng với "trạng thái hiện tại + lịch sử + tiền đề", toàn bộ đều được đánh dấu là **tham khảo chỉ đọc** (không viết vào summary). Điều này đảm bảo AI tóm tắt hiểu được "nhân vật chính là ai, thế giới có quy tắc gì", nhưng sẽ không chép thiết lập vào bản tóm tắt.

### Hỏi: Lời nhắc tùy chỉnh có những macro nào?

Mẫu tóm tắt hỗ trợ `{{user}}` `{{char}}` `{{history_block}}` `{{state_time}}` `{{state_location}}` `{{protagonist_block}}` `{{items_block}}` `{{itemlog_block}}` `{{scenes_block}}` `{{npcs_block}}` `{{plans_block}}` `{{resolved_plans_block}}` `{{content}}` `{{time_field}}` `{{time_rule}}` `{{summary_words}}` `{{vars_state_block}}` `{{vars_field}}` `{{vars_rule}}` `{{vars_block}}` `{{varlog_block}}`... Mẫu đại tóm tắt có `{{resummary_words}}`, `{{target}}`, `{{content}}`. Mức số chữ (Chi tiết / Tinh gọn) được chuyển đổi trong Cài đặt.

### Hỏi: Tóm tắt bù hàng loạt có dùng mẫu tùy chỉnh không?

Không dùng —— tóm tắt hàng loạt dùng `BATCH_SUMMARY_PROMPT` tích hợp sẵn (chỉ sinh ra summary + thời gian), mẫu tóm tắt tùy chỉnh không tác động tới tóm tắt hàng loạt.

---

## 8. API công khai / Macro / Lệnh gạch chéo

Bách Bảo Thư phơi bày giao diện chỉ đọc ra bên ngoài để các plugin / kịch bản / preset khác đọc trí nhớ và trạng thái. Xem chi tiết tại `PUBLIC_API.md`. Các điểm chính:

### API toàn cục JS `globalThis.STBaiBaiBook`

```js
const api = globalThis.STBaiBaiBook;
api.apiVersion;      // 1
api.pluginVersion;   // Phiên bản plugin
api.capabilities;    // { globalApi, slashCommand, macros, parameterizedMacros, events }

api.getSnapshot();                 // Ảnh chụp nhanh đầy đủ (state/protagonist/vars/items/plans/scenes/npcs/itemLog + coverage)
api.getSnapshot({ floor: 42, at: 'before' }); // Trạng thái trước / sau một tầng nào đó
api.getVar('Quan hệ.Alice.Hảo cảm');   // Đọc biến số, đường dẫn giống bên trong; đường dẫn rỗng "" trả về toàn bộ cây
api.getFloor(42);                  // Tầng đơn (chính văn sau khi làm sạch + tóm tắt trí nhớ + coverage)
api.getHistory({ before: 42 });    // Văn bản nén lịch sử (text / relativeText / nodes)
api.getInjectedHistory();          // Lịch sử cùng tiêu chuẩn với phần tiêm thông thường (thời gian tương đối)
api.query({ resource: 'vars' });   // Truy vấn tài nguyên (vars/state/…)
api.subscribe(fn);                 // Đăng ký nhận thông báo khi có thay đổi
```

Lưu ý:

- Giá trị trả về là **DTO sao chép sâu (deep clone)**, sửa đổi giá trị trả về sẽ không ảnh hưởng tới dữ liệu của plugin.
- Số thứ tự tầng dùng `mesid` tính từ 0 của ST; `at: "before"` = phát lại `mesid < floor`, `after` = `<= floor` (mặc định).
- Tầng ngoại truyện luôn bị bỏ qua; khi `coverage.complete === false` thì kết quả có thể có lỗ hổng, phía tiêu thụ đừng coi là trí nhớ hoàn chỉnh.
- Việc đọc dữ liệu không phụ thuộc vào việc công tắc tổng có bật hay không.

### Lệnh gạch chéo STscript

`/bbs-get`: `resource` có thể nhận giá trị `var` / `vars` / `state` / `protagonist` / `items` / `plans` / `scenes` / `npcs` / `itemLog` / `snapshot` / `history` / `injectedHistory` / `floor` / `context` (khi lược bỏ mặc định là snapshot); các tham số `path` (đường dẫn biến số), `floor` (mesid tính từ 0 của ST), `at` (before/after), `before` (tầng kết thúc lịch sử), `format` (json/raw/text). Ví dụ:

```stscript
/bbs-get resource=var path="Quan hệ.Alice.Hảo cảm" floor=42 at=after format=raw
/bbs-get resource=context floor=42 format=json
```

### Macro

Bộ máy macro mới (khi bật hệ thống macro thử nghiệm) đăng ký các macro có tham số, bộ máy macro cũ chỉ hỗ trợ các macro cố định không tham số:

- `{{bbsVars}}` → JSON biến số tùy chỉnh hiện tại
- `{{bbsState}}` → Trạng thái thời gian và địa điểm hiện tại
- `{{bbsSnapshot}}`, `{{bbsSnapshot::42::after}}` → Ảnh chụp nhanh đầy đủ (có thể chỉ định tầng / trước sau)
- `{{bbsHistory}}`, `{{bbsHistory::42}}` → Lịch sử nén kèm thời gian tương đối
- `{{bbsInjectedHistory}}` → Lịch sử cùng tiêu chuẩn với phần tiêm trí nhớ thông thường
- `{{bbsVar::Quan hệ.Alice.Hảo cảm}}`, `{{bbsVar::Đội hình[0].hp::42::after}}` → Biến số đơn lẻ (đường dẫn dấu chấm / mảng, có thể kèm tầng)
- `{{bbsFloor::42}}` → Tầng đơn (chính văn + JSON tóm tắt lá)

### Sự kiện sẵn sàng

```js
window.addEventListener('st-baibai-book:ready', () => { ... }, { once: true });
// Sự kiện thay đổi: st-baibai-book:changed
```

---

## 9. Dữ liệu, di chuyển, cuộc trò chuyện mới

### Hỏi: "Tạo cuộc trò chuyện mới kèm dữ liệu" là gì?

Cuộc trò chuyện mới mặc định bắt đầu từ trống rỗng (giá trị biến số cũng độc lập). "Tạo cuộc trò chuyện mới kèm dữ liệu" mã hóa toàn bộ trạng thái của cuộc trò chuyện hiện tại thành một **lá hạt giống** (delta mã hóa trạng thái toàn lượng + ảnh chụp nhanh bundle vector), cuộc trò chuyện mới bắt đầu từ trạng thái này —— ví dụ khi "viết tiếp tiền truyện / phân nhánh", nhánh mới sẽ nhớ được vật phẩm, kế hoạch, biến số của nhánh cũ.

### Hỏi: Di chuyển dữ liệu từ Horae?

Cài đặt → Di chuyển dữ liệu từ Horae: nhập dữ liệu tóm tắt lịch sử của Horae chuyển thành định dạng Bách Bảo Thư (kèm thời gian bắt đầu/kết thúc, tạo nút nhập theo phạm vi tầng).

### Hỏi: Sau khi nâng cấp dữ liệu cũ có bị mất không?

Không. Rừng / lá đều nằm trong tệp trò chuyện, cài đặt đồng bộ đa thiết bị; tầng tương thích định dạng cũ (`normalizeTemplate` tương thích trường đơn `guide` cũ, dự phòng dữ liệu cũ `timeLabel`...) đảm bảo dữ liệu cũ vẫn dùng được. Khi nâng cấp còn có logic gộp regex ẩn (quy tắc ẩn cũ được thu hẹp tại chỗ thành quy tắc thẻ thời gian).

### Hỏi: Làm sao để sao lưu / xuất dữ liệu?

- Bản thân cuộc trò chuyện: tính năng nhập/xuất trò chuyện của ST (lá đi theo cuộc trò chuyện).
- Cài đặt: đồng bộ settings của ST (`extension_settings` nằm trong `settings.json` trên máy chủ).
- Phương án biến số: xuất ở trang Biến số (mẫu + giải thích, không chứa giá trị).

---

## 10. Tra cứu nhanh xử lý sự cố

| Triệu chứng | Nguyên nhân có thể / Cách xử lý |
|---|---|
| Hoàn toàn không có hiệu lực | Chưa bật công tắc tổng; nhân vật nằm trong danh sách loại trừ; chưa cấu hình API phụ (xem lỗi ở trang Tóm tắt) |
| Tóm tắt đi qua API chính (không đi qua API phụ) | Khi chưa chỉ định kênh sẽ tự động lùi về API chính (Mục 7); muốn đi qua kênh phụ thì hãy chỉ định trong Cài đặt |
| Tóm tắt thất bại liên tục | Kênh API phụ không thông / định dạng xuất của mô hình kém → đổi mô hình, điều chỉnh số lần thử lại, kiểm tra xem lời nhắc tùy chỉnh có làm hỏng yêu cầu JSON không |
| Không có lá, chỉ có "Chờ tóm tắt" | Tầng vừa tạo chưa kịp tóm tắt; sau khi lật trang bản tóm tắt gốc mất hiệu lực; API phụ thất bại (xem lastError) |
| Trạng thái không cập nhật | Biến số: xem đã cấu hình mẫu / ý nghĩa / quy tắc chưa (Mục 5); Vật phẩm / Kế hoạch: xem có sự kiện cốt truyện tương ứng không; tầng đó có thể chưa được tóm tắt |
| Vẫn tốn nhiều token như vậy | Hãy đối chiếu ước tính lượng tiêm ở trang Tóm tắt với tổng token trước (Mục 3): nếu phần tiêm chiếm tỷ lệ nhỏ thì phần nặng nhất nằm ở preset / Sách Thế Giới / chính văn, nếu chiếm tỷ lệ lớn mới điều chỉnh plugin (mức Tinh gọn / tắt vector / giảm trạng thái) |
| Mô hình cứ nói là "hôm qua" | Phần tiêm đã kèm nhãn tương đối 【3 ngày trước】 nhưng mô hình vẫn nói "hôm qua" = mô hình phớt lờ phần tiêm → thêm ràng buộc "khi thuật lại chuyện cũ phải dẫn chiếu thời gian tiêm" vào thẻ nhân vật / preset; nếu phần tiêm chỉ có thời gian tuyệt đối, tức là đoạn thời gian đó không phân tích ra được (lịch giả tưởng / không có năm), hãy đổi thẻ thời gian sang dùng ngày tháng chữ số đầy đủ có kèm năm |
| Vector mãi không truy xuất | Đọc "Chi tiết lần truy xuất trước" trước tiên; nguyên nhân thường gặp: queryRewrite chưa cấu hình mô hình đối thoại riêng, số tầng chưa đạt ngưỡng / đều nằm trong cửa sổ, điểm chưa đạt ngưỡng, dữ liệu cũ chưa lập chỉ mục (Mục 6) |
| Tóm tắt bị trùng lặp / bỏ sót | Các mục vừa kết thúc gần đây sẽ được tiêm để chống trùng lặp (cả hai phía đều xem plans); sau khi chỉnh sửa tin nhắn hãy nhớ tóm tắt lại |
| Tầng bị biến mất | Bình thường —— tầng đã tóm tắt được ẩn khỏi cửa sổ (dữ liệu không bị xóa) |
| Trong chính văn xuất hiện thẻ `<bbs_items>` / `<bbs_vars>` | Bình thường —— đó là chú thích, khi hiển thị sẽ được regex ẩn giấu đi; muốn sửa thủ công vật phẩm trong chính văn thì sửa ở đây |
| Trong chính văn lộ ra thẻ `<bbs_start>` / `<bbs_end>` | Về cơ chế tầng hiển thị sẽ giấu đi; bị lộ ra = định dạng không được regex ẩn nhận diện: thẻ thời gian yêu cầu đóng thẻ trên cùng một dòng, vắt qua nhiều dòng sẽ không giấu được → trong lời nhắc thẻ thời gian tùy chỉnh hãy nhấn mạnh "mỗi thẻ chiếm riêng một dòng, đóng thẻ trên cùng một dòng" |
| Trong chính văn không có thẻ thời gian | Mô hình không tuân thủ lời nhắc thẻ thời gian → tùy chỉnh lời nhắc đơn giản hơn hoặc đổi mô hình; lúc này thời gian dựa vào lá / suy đoán dự phòng, thời gian tương đối có thể không chuẩn |
| Sau khi chuyển cuộc trò chuyện vẫn còn tàn dư trí nhớ | CHAT_CHANGED sẽ xóa tàn dư truy xuất và tải lại trí nhớ; nếu vẫn bất thường, hãy làm mới trang |
| Muốn loại trừ một số nội dung Sách Thế Giới | Cài đặt → Loại trừ nội dung Sách Thế Giới (theo tên cuốn / regex tên mục, `renderWorldInfoTemplates` điều khiển việc có bung mẫu hay không) |
| Muốn tùy chỉnh thẻ làm sạch | Cài đặt → Thẻ làm sạch tùy chỉnh: những thẻ tùy chỉnh nào trong chính văn cần được xóa bỏ (như `<snow>`...) |
| Giao diện / Quả cầu nổi | Cài đặt → Cài đặt cơ bản (Giao diện), Quả cầu nổi trên màn hình (có thể bật/tắt) |

---

## 11. Tra cứu nhanh các mục cài đặt (Kèm giá trị mặc định)

> Định vị nhanh khi giải đáp: "Cài đặt XX dùng để làm gì" thì tra cứu tại đây. Giá trị mặc định lấy từ mã nguồn, đồng nhất với phân nhóm trên trang Cài đặt.

### Công tắc tổng

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Bộ máy trí nhớ (enabled) | Bật | Công tắc tổng; sau khi tắt sẽ dừng mọi hoạt động tự động tiêm / tóm tắt / đại tóm tắt / ẩn, lối vào menu vẫn còn, có thể mở lại giao diện để bật lên |

### Cài đặt cơ bản

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Giao diện | Theo ST | Giao diện Sáng / Tối / Pastel / Xanh lá / Theo ST |

### Quả cầu nổi trên màn hình

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Quả cầu nổi | Bật | Quả cầu nổi mở nhanh có thể kéo thả trên màn hình |

### API phụ

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Danh sách kênh | Trống | Kênh API độc lập: Tên / Địa chỉ / Mô hình / Khóa bảo mật / Tham số loại trừ |
| Chỉ định kênh Tóm tắt / Đại tóm tắt | Trống (Theo API chính) | Chỉ định riêng kênh cho summary và resummary; chưa chỉ định sẽ lùi về API chính |
| Lời nhắc tùy chỉnh · Phá giới hạn | Trống (Mặc định tích hợp sẵn) | Ghi đè lời nhắc phá giới hạn mặc định của yêu cầu tóm tắt / đại tóm tắt |

### Cài đặt tóm tắt

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Tóm tắt tự động autoSummaryEnabled | Bật | Công tắc một chạm: Tự động ẩn + Thẻ thời gian chính văn + Chặn tồn đọng (không còn tách thành công tắc độc lập nữa) |
| Chỉ tiêm tóm tắt cốt truyện summaryOnlyMode | Tắt | Tương thích hệ thống biến số có sẵn của thẻ nhân vật: vẫn phân tích / lưu / hiển thị trạng thái như thường, nhưng không tiêm vào mô hình chính và không ghi chú thích chính văn |
| Mức số chữ verbosity | Chi tiết | Chi tiết / Tinh gọn của mẫu tích hợp sẵn; mẫu tùy chỉnh không bị ảnh hưởng |
| keepRecent | 3 | Giữ lại N tin nhắn AI gần nhất để gửi toàn văn (cửa sổ trượt); các tin cũ hơn tự động tóm tắt và ẩn đi |
| leafBatchThreshold | 12 | Lá (L0) tích đủ N mục thì nén thành một bản đại tóm tắt L1 (0 = tắt) |
| leafKeepRecent | 3 | Khi nén L0→L1 giữ lại N lá gần nhất không nén để chống đứt gãy thông tin tiêm (0 = tích đủ nén hết) |
| resummaryThreshold | 7 | L1 tích đủ N mục thì nén thành L2 (0 = tắt) |
| higherResummaryThreshold | 3 | L2 trở lên tích đủ N mục thì nén lên tầng cao hơn (0 = tắt) |
| recentResolvedPlansCount | 5 | Số lượng mục kế hoạch / nghi vấn vừa kết thúc gần đây được đính kèm trong ảnh chụp nhanh trạng thái (kế hoạch, nghi vấn mỗi loại lấy N mục; 0 = không đính kèm, chống AI thúc đẩy trùng lặp) |
| summaryMaxRetries | 1 | Số lần thử lại tối đa khi tóm tắt / đại tóm tắt thất bại (lỗi yêu cầu / lỗi phân tích JSON) (0 = không thử lại) |
| batchMaxChars | 30000 | Số ký tự tối đa của một đợt khi tóm tắt bù hàng loạt (sau khi làm sạch), tích đủ sẽ cắt đợt |
| batchMaxFloors | 10 | Giới hạn số tầng tối đa dự phòng của một đợt khi tóm tắt bù hàng loạt |

### Cài đặt tiêm

> Chỉ ảnh hưởng tới các khối trạng thái mà mô hình chính nhìn thấy; API phụ tóm tắt luôn nhìn thấy toàn lượng và ghi nhận như thường (tắt tiêm không ảnh hưởng tới việc bật lại để khôi phục).

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Cục diện trước mắt sceneFocus | Bật | Thẻ cục diện tương tác: Cục diện / Người có mặt / Tiêu điểm / Căng thẳng / Sắp diễn ra |
| Hồ sơ đời sống lifeDetails | Bật | Hồ sơ nhỏ đời sống của nhân vật chính và nhân vật chính yếu (kích hoạt tiêm theo từ khóa) |
| Thông tin nhân vật chính protagonist | Bật | Giới tính / Tuổi / Thân phận / Ngoại hình / Trang phục / Trạng thái của nhân vật chính |
| Thông tin khung cảnh scenes | Bật | Địa điểm hiện tại + Chuỗi tổ tiên + Các địa điểm khác; sau khi tắt thì NPC / Vật phẩm cũng không được tiêm theo |
| Danh sách NPC npcs | Bật | Có mặt gửi toàn lượng, cùng khu vực gửi rút gọn, không có mặt chỉ gửi tên và thân phận; phụ thuộc Khung cảnh |
| Đánh giá hảo cảm nhân vật npcAffinity | Bật | Đánh giá hảo cảm 5 mức trong danh sách; sau khi tắt thì danh sách vẫn gửi như thường, chỉ là không đính kèm hảo cảm, phù hợp khi thẻ nhân vật đã có hệ thống hảo cảm riêng |
| Hiểu biết của nhân vật về nhân vật chính knowledge | Bật | Danh sách những chuyện nhân vật biết hoặc tưởng là vậy về nhân vật chính |
| Thông tin vật phẩm items | Bật | Vật phẩm mang theo / có thể tiếp cận gửi toàn lượng, gửi cất giữ nơi khác chỉ gửi tên và số lượng; phụ thuộc Khung cảnh |

### Loại trừ nhân vật

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Loại trừ nhân vật excludedChars | Trống | Trong cuộc trò chuyện của các nhân vật trong danh sách (bao gồm cả thẻ trùng tên), toàn bộ hệ thống trí nhớ đều không có hiệu lực |

### Loại trừ nội dung Sách Thế Giới

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Tên tệp Sách Thế Giới loại trừ excludedWorldNames | Trống | Loại trừ nguyên cuốn: mọi mục kích hoạt của những cuốn sách này đều không đưa vào ngữ cảnh tóm tắt (chỉ ảnh hưởng API phụ) |
| Mục Sách Thế Giới loại trừ excludedWorldInfoPatterns | Lần đầu sử dụng tự động gieo quy tắc mặc định | Lọc theo tên mục, mỗi mục được biên dịch như regex (tên thường = khớp bao gồm); biên dịch thất bại hạ cấp xuống chuỗi con |
| Kết xuất mẫu Sách Thế Giới renderWorldInfoTemplates | Bật | Trước khi tóm tắt sẽ bung `{{macro}}`/EJS của Sách Thế Giới; Sách Thế Giới có chứa EJS "ghi biến số" mỗi lần tóm tắt sẽ thực thi thêm gây làm bẩn biến số, có thể tắt đi |

### Thẻ làm sạch tùy chỉnh

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Thẻ làm sạch tùy chỉnh customStripTags | Trống | Tên thẻ cần xóa nguyên khối trong chính văn (chỉ điền tên không kèm dấu ngoặc nhọn, như snow → xóa `<snow>…</snow>` cùng nội dung); thay đổi có hiệu lực tức thì đối với truy xuất, không cần dựng lại chỉ mục |

### Lời nhắc tùy chỉnh

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Tóm tắt / Đại tóm tắt / Đại tóm tắt cấp hai / Phá giới hạn / Thẻ thời gian | Trống = Mặc định tích hợp sẵn | Ghi đè mẫu tích hợp sẵn tương ứng; để trống dùng bản tích hợp sẵn. Mức số chữ chỉ ảnh hưởng tới mẫu tích hợp sẵn |

### Trí nhớ vector

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| Trí nhớ vector enabled | Tắt | Công tắc tổng truy xuất vector |
| Điểm cuối embedding | SiliconFlow Qwen/Qwen3-Embedding-8B | `/embeddings` tương thích OpenAI; bắt buộc điền, cần mô hình embedding |
| Điểm cuối rerank | Tái sử dụng embedding | Mô hình sắp xếp lại; không điền sẽ hạ cấp xuống thứ tự độ tương đồng embedding |
| Điểm cuối queryRewrite | Tái sử dụng embedding | ⚠️ Cần mô hình đối thoại (`/chat/completions`); nếu không cấu hình mô hình riêng thì chắc chắn sẽ thất bại (xem Mục 6) |
| queryRewriteMaxTokens | 8192 | Giới hạn token đầu ra của viết lại truy vấn |
| Độ sâu tiêm truy xuất injectionDepth | 0 | Vị trí tiêm kết quả truy xuất (sát cuộc đối thoại) |
| rerankCandidates | 20 | Tìm kiếm lấy N ứng viên đầu đưa vào rerank (backend sắp xếp theo độ tương đồng, không áp ngưỡng) |
| embeddingThreshold | 0.8 | Giới hạn dưới độ tương đồng đầu vào của mức tóm tắt |
| rerankThreshold | 0.9 | Giới hạn dưới điểm sắp xếp lại đầu vào của mức toàn văn |
| fullTextCount | 2 | Số lượng mục tối đa gửi nguyên văn của mức toàn văn |
| finalRecallCount | 5 | Giới hạn tổng số mục tiêm truy xuất (ưu tiên mức toàn văn trước rồi đến mức tóm tắt) |
| minAiFloors | 30 | Ngưỡng tầng AI bắt đầu truy xuất: số tầng AI ít hơn giá trị này sẽ không truy xuất |

### Các tính năng khác

| Tính năng | Tác dụng |
|---|---|
| Tạo cuộc trò chuyện mới kèm dữ liệu | Mã hóa trạng thái hiện tại thành lá hạt giống + ảnh chụp nhanh bundle vector, cuộc trò chuyện mới bắt đầu từ trạng thái cũ (viết tiếp tiền truyện / phân nhánh) |
| Di chuyển dữ liệu từ Horae | Nhập tóm tắt lịch sử Horae chuyển thành định dạng Bách Bảo Thư (kèm thời gian bắt đầu/kết thúc) |
| Lấy dữ liệu | Danh sách tra cứu nhanh macro + xuất PUBLIC_API.md bằng một cú nhấn (tài liệu giao diện dành cho tác giả plugin) |

---

## Phụ lục: Tra cứu nhanh các khái niệm cốt lõi

- **Lá (Leaf)**: Tóm tắt tầng đơn + phần tăng thêm có cấu trúc, lưu ở `extra.bbs_leaf` của tin nhắn.
- **Rừng (Forest)**: Lá + nút nén; nút nén lưu ở `chatMetadata`.
- **L0 / L1 / L2+**: Lá / Đại tóm tắt thường / Đại tóm tắt cấp hai (nhãn cấp độ: Tóm tắt / Đại tóm tắt L1 / Đại tóm tắt L2…).
- **Trạng thái dẫn xuất (Derived)**: Vật phẩm / Kế hoạch / Khung cảnh / NPC / Nhân vật chính / Biến số, phát lại theo tầng từ phần tăng thêm của lá, không lưu cứng ổ đĩa.
- **Thẻ thời gian**: `<bbs_start>`/`<bbs_end>`, hiện thực hóa thời gian ngay trong chính văn.
- **Chú thích (Aside)**: `<bbs_items>` (biến động vật phẩm) / `<bbs_vars>` (biến động biến số), giúp mô hình chính "nhìn thấy đã sửa đổi", đồng thời là lối vào để sửa vật phẩm thủ công trong chính văn.
- **Khe tiêm**: `baibai_book_memory_history` (lịch sử, ở đỉnh), `baibai_book_memory_state` (trạng thái hiện tại, sát cuộc đối thoại), `baibai_book_time_tag` (thẻ thời gian, sát phản hồi nhất).
- **Biến số tùy chỉnh**: Một cây JSON + lệnh đường dẫn (set/add/assign/remove), mẫu ba tầng (global/char/chat), giá trị độc lập theo từng cuộc trò chuyện.
