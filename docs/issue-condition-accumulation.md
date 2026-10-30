# Phân tích vấn đề: "Trạng thái" (condition) của nhân vật chính chỉ cộng dồn không xóa, càng dùng càng dài

- Thời gian ghi nhận: Dựa trên mã nguồn `21f7488` (v1.3.2)
- Phương thức tái hiện: Đọc tĩnh thuần túy + dùng node gọi trực tiếp `applyConditionPatch` thực tế để chạy thử nghiệm (xem kịch bản cuối bài)
- Trạng thái: **Tài liệu lịch sử chẩn đoán** + đề xuất cách sửa (đã được áp dụng trong các bản cập nhật sau)

## Phản hồi của người dùng

> Trạng thái user chỉ cộng dồn mà không xóa, về sau sẽ càng lúc càng dài.

Giới hạn phạm vi: **Chỉ có `protagonist.condition` / `npcs.condition`** (trường "Trạng thái" của tầng tức thời) mới có hiện tượng này.
Các trường cùng nhóm `gender / identity / appearance / outfit` đều là ghi đè thuần túy (`applyProtagonistState` tại `apply.ts:866-878`
gán giá trị từng khóa), đưa giá trị mới là thay thế cả đoạn, không tích lũy; `age` đi theo cơ chế điểm neo, cũng không bị.
Vì vậy vấn đề tập trung ở `condition` —— đây là trường duy nhất đi theo giao thức "bản vá phân mảnh (`conditionPatch`)".

## Tổng quan kết luận

| # | Vấn đề | Tính chất | Đã kiểm chứng |
|---|---|---|---|
| 1 | `applyConditionPatch` vừa duyệt vừa `splice`, khi xóa nhiều đoạn sẽ bị lệch mã số; vượt giới hạn thì bỏ qua im lặng | **Bug cứng cấp độ code**: con đường duy nhất có thể làm trạng thái ngắn lại bị hỏng | ✅ Thực nghiệm |
| 2 | Khi trong cùng một lượt xuất hiện đồng thời `condition` và `conditionPatch`, bản vá lại áp dụng lên **văn bản mới** | Bug cấp độ code (tầng làm sạch chưa loại trừ lẫn nhau) | ✅ Thực nghiệm |
| 3 | Người dùng mẫu tùy chỉnh nhìn thấy mã số `[c1]`, nhưng **không nhận được** giao thức conditionPatch | Lỗ hổng lắp ghép lời nhắc | ✅ Đọc code |
| 4 | Cắt phân mảnh theo `。；\n`, không bóc tiền tố `[cN]` → số lượng phân mảnh tự phình to | Bộ khuếch đại | ✅ Thực nghiệm |
| 5 | Phân mảnh trạng thái **không có TTL / giới hạn trên / khử trùng lặp**, chỉ có thể dựa vào việc mô hình replace tường minh mới xóa được | Lỗ hổng thiết kế cấu trúc | ✅ Đọc code |

Hai mục đầu là nguyên nhân trực tiếp khiến "xóa mất hiệu lực"; ba mục sau giải thích tại sao ngay cả khi việc xóa thỉnh thoảng có hiệu lực thì độ dài vẫn cứ tăng lên.

---

## 1. Bug cứng: `applyConditionPatch` bị lệch mã số khi xóa nhiều đoạn

`src/memory/conditionPatch.ts:50-72`

```ts
const fragments = splitConditionFragments(current);
const next = [...fragments];
for (const op of patch.replace ?? []) {
  const m = typeof op.id === 'string' ? op.id.match(FRAGMENT_ID_RE) : null;
  if (!m) continue;
  const idx = Number(m[1]) - 1;
  if (idx < 0 || idx >= next.length) continue;   // ← Vượt giới hạn thì bỏ qua im lặng, không có log
  const text = op.text.trim();
  if (!text) next.splice(idx, 1);                // ← Vừa duyệt vừa xóa, toàn bộ mã số phía sau bị dịch sang trái
  else next[idx] = text;
}
```

Mã số phân mảnh được tính theo mảng gốc **trước khi áp dụng**, nhưng `splice` lại làm ngắn mảng: sau lần xóa đầu tiên, toàn bộ
`idx` phía sau đều trỏ vào phân mảnh sai; khi trỏ ra ngoài phần đuôi thì `continue`, **phân mảnh mục tiêu không bao giờ xóa được, lại không có bất kỳ cảnh báo nào**.

### Thực nghiệm (chạy trực tiếp hàm thực tế bằng node)

```
Ban đầu: [c1] Cánh tay bị thương, cố định bằng nẹp; [c2] Cần tĩnh dưỡng ba ngày; [c3] Chân trái trầy xước

Xóa c1 + c3     →  "Cần tĩnh dưỡng ba ngày; Chân trái trầy xước"
                   Kỳ vọng "Cần tĩnh dưỡng ba ngày"; c3 (Chân trái trầy xước) không bị xóa
Xóa c1 + Sửa c2 →  "Cần tĩnh dưỡng ba ngày; Tĩnh dưỡng kết thúc, có thể xách vật nhẹ"
                   Kỳ vọng "Tĩnh dưỡng kết thúc, có thể xách vật nhẹ; Chân trái trầy xước";
                   Thực tế: c2 không được sửa mà lại sửa vào c3, nguyên văn c3 bị ghi đè mất
```

### Tại sao lỗi này lại đánh trúng ngay vào "kịch bản lẽ ra phải ngắn lại"

`src/memory/prompts/builtin-protocols.txt:117` yêu cầu rõ ràng phải xóa nhiều đoạn cùng lúc:

> Khi xác định đã hồi phục hoàn toàn / đính chính lỗi thì **replace từng mục thành rỗng để xóa trống**, không được dùng sự trôi qua của thời gian hay hồi tưởng khỏe mạnh để xóa bỏ thương tích hiện tại.

"Vết thương đã lành" = mô hình đưa ra nhiều lệnh `replace` rỗng trong cùng một bản vá = chắc chắn đạp trúng bug. Biểu hiện chính là: vết thương rõ ràng đã viết là lành rồi,
nhưng ở lượt sau trong trạng thái vẫn còn treo đó, mô hình (nhìn thấy vết thương cũ vẫn còn) lại tiếp tục add tình huống mới → chỉ có dài thêm một chiều.

### Tại sao kiểm thử hiện có không bắt được

Trong `src/memory/conditionPatch.test.ts` trước đó chỉ có xóa trống một phân mảnh đơn lẻ:

```ts
it('Sau khi xóa trống toàn bộ phân mảnh thì trả về undefined', () => {
  expect(applyConditionPatch('Cánh tay bị thương', { replace: [{ id: 'c1', text: '' }] })).toBeUndefined();
});
```

Không có ca kiểm thử "một bản vá xóa ≥2 đoạn" hoặc "xóa một đoạn + sửa một đoạn".

---

## 2. Bug cứng: `condition` và `conditionPatch` xuất hiện trong cùng một lượt, bản vá lại đánh vào văn bản mới

`src/memory/apply.ts:334-344` (`cleanProtagonistDelta`) thu nhận cả hai trường:

```ts
for (const key of ['gender', 'age', 'ageTime', 'identity', 'appearance', 'outfit', 'condition'] as const) {
  const value = patchText(raw[key]);          // Thu nhận condition
  if (value !== undefined) out[key] = value;
}
const conditionPatch = cleanConditionPatch(raw.conditionPatch);   // Cũng thu nhận cả conditionPatch
if (conditionPatch) out.conditionPatch = conditionPatch;
```

Mà `apply.ts:872-875` lại là "ghi đè cả đoạn trước → áp dụng bản vá sau":

```ts
if (typeof src[key] === 'string') target[key] = src[key]!.trim() || undefined;
if (src.conditionPatch && hasConditionPatchContent(src.conditionPatch)) {
  target.condition = applyConditionPatch(target.condition, src.conditionPatch);
}
```

Mã số bản vá được tính tương đối theo phân mảnh **cũ**, nhưng lại áp dụng lên văn bản mới vừa bị ghi đè:

```
Cũ: Cánh tay bị thương; Cần tĩnh dưỡng ba ngày; Chân trái trầy xước
Mô hình đồng thời đưa ra condition="Cánh tay đã bình phục; Bong gân mắt cá chân" + replace c2
→ Kết quả thực tế "Cánh tay đã bình phục; Tĩnh dưỡng kết thúc"     # Bong gân mắt cá chân bị c2 ghi đè mất
```

Lưu ý: `mergeProtagonistDelta` tại `src/memory/protagonist.ts:15-24` **đã** xử lý vấn đề này
(khi đưa ra condition thì xóa bỏ conditionPatch của cùng lá đó) —— nhưng hàm đó chỉ dùng cho đường dẫn **chỉnh sửa thủ công**
(`appendOpToLatestLeaf`, `apply.ts:1866`). Commit sửa lỗi lần trước `21f7488` sửa chính là việc lưu thủ công bị
bản vá còn sót lại trong cùng lá áp dụng lần hai dẫn tới "càng lúc càng dài". **Đường dẫn AI xuất ra (main path) chưa làm loại trừ lẫn nhau.**

---

## 3. Mẫu tùy chỉnh: nhìn thấy mã số `[cN]`, nhưng không nhận được giao thức

- Nguồn hiển thị mã số: `fmtProtagonist` tại `src/memory/prompts.ts:660-672`,
  `['Trạng thái', fmtConditionFragments(protagonist.condition)]` → kết xuất thành `[c1] xxx；[c2] yyy`.
- Tiêm giao thức: `prompts.ts:458` `SUMMARY_RULES = SUMMARY_SPLIT.rules + CONDITION_PATCH_PROTOCOL`
  —— chỉ có hiệu lực dưới mẫu tóm tắt **tích hợp sẵn** (`isBuiltinSummaryPrompt()`, `prompts.ts:951`).
- Nhánh mẫu tùy chỉnh (`prompts.ts:997-1012`) bổ sung là `PROTAGONIST_PROTOCOL_SUPPLEMENT`
  (`prompts.ts:900-912`), bên trong **không có** conditionPatch, chỉ nói "condition=trạng thái cơ thể/sức khỏe hiện tại".
- Nhưng `{{protagonist_block}}` trong nhánh tùy chỉnh vẫn bung ra như thường (`prompts.ts:1008`), mã số `[cN]` vẫn đưa cho mô hình xem.

Kết quả: người dùng mẫu tùy chỉnh nhận được một trạng thái có đánh số nhưng không có bất kỳ giải thích mã số nào → mô hình đành chép nguyên cả đoạn trả về,
mã số bị chép vào nội dung condition. Xem thực nghiệm ở Mục 4, sẽ chồng lớp qua từng lượt.

---

## 4. Bộ khuếch đại: quy tắc cắt + không bóc tiền tố `[cN]` → số lượng phân mảnh tự phình to

`conditionPatch.ts:28-35` cắt phân mảnh theo `[；;。\n]`, còn `applyConditionPatch` ghi trả lại
text của replace/add **nguyên mẫu** (không chuẩn hóa). Do đó:

1. **Dấu chấm câu sẽ tự dưng đẻ thêm phân mảnh**: mô hình viết `text: "Cánh tay bình phục. Chỉ để lại sẹo"` → lượt sau biến thành 2 phân mảnh.
   Thông tin không tăng thêm, nhưng số lượng phân mảnh, dấu phân cách `；`, token đều tăng lên.
2. **Tiền tố `[cN]` sẽ chồng lớp theo cấp số nhân** (kịch bản mẫu tùy chỉnh dễ kích hoạt nhất): mô hình chép định dạng hiển thị trả về condition,
   lượt sau khi kết xuất lại gắn thêm tiền tố một lần nữa.

Thực nghiệm chồng lớp:

```
Lượt 1 chép về: [c1] Cánh tay bị thương; [c2] Cần tĩnh dưỡng ba ngày; Cần tĩnh dưỡng ba ngày          Số phân mảnh: 3
Lượt 2 chép về: [c1] [c1] Cánh tay bị thương; [c2] [c2] Cần tĩnh dưỡng ba ngày; ...                   Số phân mảnh: 5
Lượt 3 chép về: [c1] [c1] [c1] Cánh tay bị thương; ...                                                Số phân mảnh: 9
```

---

## 5. Tính cấu trúc: phân mảnh trạng thái không có vòng đời

- Chú thích tại `types.ts:532`: `condition` là "tầng tức thời, kiểu ghi đè", nhưng lưu trữ thực tế lại là **danh sách phân mảnh**.
- Phân mảnh **không có TTL / thời gian hết hạn** (so sánh: `lifeDetails` có `until`; `timeRel.ts` / `timeTag.ts`
  đã có sẵn khả năng suy tính thời gian trong truyện hoàn thiện, nhưng ở đây hoàn toàn không dùng tới).
- Ý đồ thiết kế của `prompts/builtin-protocols.txt:114` là "các phân mảnh cũ không được liệt kê vào replace sẽ được chương trình giữ nguyên",
  tức là **không bao giờ tự động hồi máu**. Thế là việc xóa hay không hoàn toàn phụ thuộc vào việc mô hình có chủ động replace hay không, mà replace lại bị
  ngưỡng evidence ("bắt buộc phải là nguyên văn liên tục trong chính văn lượt này") chặn lại, cộng thêm bug ở Mục 1 → hiệu ứng ròng chỉ có thể là add tăng thêm.
- `add` cũng không có khử trùng lặp xấp xỉ: cùng một vết thương đổi cách diễn đạt thuật lại một lần là thêm một đoạn.

---

## Đề xuất cách sửa (theo tỷ lệ hiệu quả/chi phí, 4 mục đầu là sửa bug thuần túy, không đổi tiêu chuẩn sản phẩm)

1. **Viết lại việc áp dụng replace của `applyConditionPatch`**: duyệt một lần, không `splice`.
   Thu thập `replace` vào `Map<idx, text | DELETE>` trước, rồi dựng lại mảng theo độ dài gốc, cuối cùng push `add`;
   khi `idx` vượt giới hạn thì `console.warn` (kèm tên nhân vật / mã số / số lượng phân mảnh), đừng `continue` im lặng.
   Khoảng 10 dòng code, có thể giúp việc "bình phục / kết thúc" có hiệu lực ngay lập tức.
2. **Loại trừ lẫn nhau ở tầng làm sạch**: trong `cleanProtagonistDelta` / `cleanNpcDelta` (`apply.ts:334-344`,
   `apply.ts:196-262`) nếu xuất hiện đồng thời `condition` và `conditionPatch`, hãy ưu tiên một bên hoặc đóng cứng (bake) bản vá trước khi lưu.
3. **Chuẩn hóa condition trước khi vào kho**: bóc bỏ `[c\d+]` ở đầu dòng, `trim`, loại bỏ phân mảnh rỗng, chuẩn hóa dấu phân cách `；`.
4. **Bổ sung kiểm thử**: xóa nhiều op (xóa 2 đoạn / xóa 1 đoạn + sửa 1 đoạn), mã số vượt giới hạn, `condition` + `conditionPatch` cùng xuất hiện,
   bóc bỏ `[cN]`, cắt dấu chấm câu. Đặt trong `src/memory/conditionPatch.test.ts`.
5. **Mẫu tùy chỉnh cũng phải kèm giao thức**: bổ sung giao thức `conditionPatch` vào nhánh tùy chỉnh.
6. **Thêm vòng đời cho phân mảnh (cần quyết định sản phẩm, tạm thời chưa động tới)**.

## Kịch bản tái hiện (chỉ đọc, không sửa kho lưu trữ)

Chạy trực tiếp module thực tế bằng node (≥22, hỗ trợ bóc kiểu gốc) trong thư mục này:

```bash
node --input-type=module -e "
import { applyConditionPatch, splitConditionFragments, fmtConditionFragments } from './src/memory/conditionPatch.ts';
const start = 'Cánh tay bị thương, cố định bằng nẹp；Cần tĩnh dưỡng ba ngày；Chân trái trầy xước';
console.log('Hiển thị cho mô hình:', fmtConditionFragments(start));
console.log('Xóa c1 + c3  →', applyConditionPatch(start, { replace: [{id:'c1',text:''},{id:'c3',text:''}] }));
console.log('Xóa c1 + Sửa c2 →', applyConditionPatch(start, { replace: [{id:'c1',text:''},{id:'c2',text:'Tĩnh dưỡng kết thúc, có thể xách vật nhẹ'}] }));
console.log('Mã số vượt giới hạn →', applyConditionPatch('Cánh tay bị thương；Cần tĩnh dưỡng ba ngày', { replace: [{id:'c9',text:''}] }));
"
```

## Phụ lục: Quan hệ với bản sửa lỗi lịch sử

- `21f7488` sửa việc **lưu thủ công** bị `conditionPatch` còn sót lại trong cùng lá áp dụng lần hai (hiện tượng cũng là "càng lúc càng dài").
  Phản hồi của người dùng lần này là đường dẫn **tóm tắt tự động hàng ngày**, đường dẫn đó ở cấp độ Mục 1 và 2 đã được xử lý triệt để trong các bản cập nhật sau.
