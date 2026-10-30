# Giao diện Đọc Công khai của Bách Bảo Thư (API v1)

Tài liệu này dành cho các tác giả viết plugin, kịch bản (script) và preset trên SillyTavern. Bách Bảo Thư cung cấp ba lối vào chỉ đọc:

1. API toàn cục JavaScript: `globalThis.STBaiBaiBook`
2. Lệnh gạch chéo STscript: `/bbs-get`
3. Macro ST: `{{bbsVars}}`, `{{bbsVar::Đường_dẫn}}`, v.v.

Giao diện công khai chỉ trả về DTO sao chép sâu (deep clone), không phơi bày đối tượng phản ứng Vue, tham chiếu tin nhắn trò chuyện hay phương thức ghi. Mã bên ngoài sửa đổi giá trị trả về sẽ không làm thay đổi dữ liệu của Bách Bảo Thư.

## Quy ước tương thích

- `apiVersion` hiện tại cố định là `1`, đây là phiên bản cấu trúc dữ liệu công khai, tách biệt với `pluginVersion` của bản thân plugin.
- Số thứ tự tầng thống nhất sử dụng `mesid` tính từ 0 của SillyTavern.
- `at: "before"`: trạng thái không bao gồm tầng mục tiêu, tức là chỉ phát lại phần tăng thêm tóm tắt của `mesid < floor`.
- `at: "after"`: trạng thái bao gồm tầng mục tiêu, tức là phát lại phần tăng thêm tóm tắt của `mesid <= floor`; đây là giá trị mặc định.
- Các tầng được đánh dấu là ngoại truyện `bbs_omit` luôn bị bỏ qua.
- Các lá tóm tắt không hợp lệ, lệch trang (swipe) hoặc bị thiếu sẽ không tham gia phát lại trạng thái.
- Khả năng đọc của giao diện không phụ thuộc vào việc công tắc tổng "Bách Bảo Thư · Bộ máy trí nhớ" có bật hay không.

DTO của ảnh chụp nhanh đầy đủ, lịch sử và ngữ cảnh tầng sẽ trả về thông tin độ bao phủ:

```js
coverage: {
  complete: false,
  missingAiFloors: [38, 41],
}
```

Phía tiêu thụ không nên coi kết quả là trí nhớ đầy đủ không có lỗ hổng khi `complete === false`. `missingAiFloors` chỉ thống kê các tầng AI trước điểm kết thúc truy vấn hiện tại mà lẽ ra phải có tóm tắt nhưng lại chưa có tóm tắt hợp lệ; tầng ngoại truyện không được tính vào.

Các tài nguyên truy cập nhanh như `getVar()` và `query({ resource: "state" })` chỉ trả về giá trị mục tiêu, không đính kèm thông tin độ bao phủ. Khi cần phán đoán tính toàn vẹn, nên đọc đồng thời `getSnapshot()`, hoặc lấy trực tiếp trường tương ứng từ ảnh chụp nhanh.

## Đợi giao diện sẵn sàng

Thứ tự tải plugin không cố định. Khuyên dùng kiểm tra đối tượng toàn cục trước, khi chưa sẵn sàng mới lắng nghe sự kiện:

```js
function useBaiBaiBook(callback) {
  if (globalThis.STBaiBaiBook) {
    callback(globalThis.STBaiBaiBook);
    return;
  }

  window.addEventListener(
    'st-baibai-book:ready',
    () => callback(globalThis.STBaiBaiBook),
    { once: true },
  );
}
```

Sau khi giao diện sẵn sàng có thể kiểm tra các khả năng hỗ trợ:

```js
const api = globalThis.STBaiBaiBook;

console.log(api.apiVersion);     // 1
console.log(api.pluginVersion);  // Phiên bản plugin Bách Bảo Thư
console.log(api.capabilities);
```

Cấu trúc của `capabilities`:

```js
{
  globalApi: true,
  slashCommand: true,
  macros: true,
  parameterizedMacros: true,
  events: true,
}
```

Nếu phiên bản ST chủ không hỗ trợ một lối vào đăng ký nào đó, trường tương ứng sẽ là `false`. Bộ máy macro cũ hỗ trợ macro cố định không tham số nhưng không hỗ trợ macro có tham số, do đó thường là `macros: true`, `parameterizedMacros: false`.

## JavaScript API

### Đọc ảnh chụp nhanh hiện tại

```js
const snapshot = globalThis.STBaiBaiBook.getSnapshot();

console.log(snapshot.state);
console.log(snapshot.protagonist);
console.log(snapshot.vars);
console.log(snapshot.items);
console.log(snapshot.plans);
console.log(snapshot.scenes);
console.log(snapshot.npcs);
console.log(snapshot.itemLog);
console.log(snapshot.lifeDetails);
```

Cấu trúc trả về chính:

```js
{
  apiVersion: 1,
  pluginVersion: "1.0",
  revision: 12,
  chat: {
    id: "Định danh tệp trò chuyện",
    characterName: "Tên nhân vật",
    groupId: null,
    length: 86,
  },
  point: {
    floor: 85,
    at: "after",
    upToExclusive: 86,
  },
  coverage: {
    complete: true,
    missingAiFloors: [],
  },
  state: { time: "...", location: "...", locationPath: [] },
  protagonist: {
    gender: "Nữ",
    identity: "Điều tra viên",
    appearance: "Tóc ngắn màu đen, lông mày trái có sẹo",
    outfit: "Áo khoác măng tô tối màu",
    condition: "Cánh tay trái bị thương nhẹ",
  },
  vars: {},
  items: [],
  plans: [],
  scenes: [],
  npcs: [],
  itemLog: [],
  lifeDetails: [],
}
```

Mỗi nhân vật trong `snapshot.npcs` có thể kèm theo đánh giá hảo cảm nội tâm và thái độ bên ngoài độc lập (không phải biến số tùy chỉnh, cũng không phải điểm số có thể cộng trừ):

| Trường | Ý nghĩa |
| --- | --- |
| `affinityInner` | Hảo cảm nội tâm (đối với user): `-2` Phản cảm mãnh liệt, `-1` Không thích, `0` Không rõ yêu ghét, `1` Có thiện cảm, `2` Tình cảm sâu đậm |
| `affinityOuter` | Thái độ bên ngoài (đối với user): `-2` Thù địch rõ rệt, `-1` Lạnh nhạt xa cách, `0` Không rõ thân sơ, `1` Thân thiện gần gũi, `2` Gần gũi rõ rệt, thể hiện tích cực |
| `affinityNote` | Một câu giải thích căn cứ, biểu hiện hoặc mâu thuẫn |

Cả hai phía đều có thể khuyết hoặc là `null`, biểu thị chưa rõ, không được xử lý như `0`. Trong delta tầng, lược bỏ trường biểu thị giữ nguyên, `null` biểu thị rút lại đánh giá phía đó, `affinityNote: ""` biểu thị xóa trống ghi chú giải thích. Đánh giá không đồng nghĩa với sự thật tâm lý đã được chứng thực, cũng không đại diện cho tình yêu, sự tin tưởng, phục tùng hay đồng thuận.

`snapshot.lifeDetails` là hồ sơ nhỏ đời sống được ghi nhận theo nhân vật. `subject: "user"` biểu thị nhân vật chính, các chuỗi khác là tên của nhân vật trong danh sách NPC; khi lá cũ thiếu `subject` sẽ xử lý theo ngữ nghĩa dành riêng cho nhân vật chính vốn có, không đoán nhân vật từ chính văn. `text` là nội dung chi tiết của nhân vật đó, khi hiển thị hoặc tiêm sẽ cộng thêm họ tên. Nội dung giống nhau được khử trùng lặp riêng theo từng nhân vật, không gộp xuyên nhân vật.

```js
{ subject: "user", text: "Cho rằng bánh kếp không thêm bánh giòn thì mất hết linh hồn", topics: ["Ăn uống"], anchors: ["Bánh kếp"], tier: "active" }
{ subject: "Eileen", text: "Uống trà không bỏ đường", topics: ["Ăn uống"], anchors: ["Trà"], tier: "active" }
```

Trong `lifeDetails.update` của tầng, lược bỏ `subject` sẽ giữ nguyên nhân vật gốc, viết tường minh `"user"` có thể chỉnh sửa quay về nhân vật chính; việc ghi nhận tự động giới hạn ở các sự thật rõ ràng của nhân vật chính và nhân vật chính yếu. Đổi tên NPC thủ công sẽ đồng bộ quy thuộc của các mục đời sống, xóa nhân vật sẽ không xóa hồ sơ đời sống lịch sử của họ. Quy tắc ghim đầu / kích hoạt từ khóa / thời hạn và lắng đọng không đổi, đổi cuộc trò chuyện cũng sẽ giữ lại quy thuộc.

Đọc trạng thái trước hoặc sau một tầng nào đó:

```js
const before = globalThis.STBaiBaiBook.getSnapshot({
  floor: 42,
  at: 'before',
});

const after = globalThis.STBaiBaiBook.getSnapshot({
  floor: 42,
  at: 'after',
});
```

### Đọc biến số

Đường dẫn biến số đồng nhất với bên trong Bách Bảo Thư, hỗ trợ dấu chấm và chỉ số mảng dạng chữ số:

```js
const favor = globalThis.STBaiBaiBook.getVar('Quan hệ.Alice.Hảo cảm');
const hp = globalThis.STBaiBaiBook.getVar('Đội hình[0].hp', {
  floor: 42,
  at: 'after',
});
```

Khi đường dẫn không tồn tại sẽ trả về `undefined`. Truyền vào đường dẫn rỗng `""` sẽ trả về toàn bộ cây biến số.

### Đọc cốt truyện lịch sử

```js
const history = globalThis.STBaiBaiBook.getHistory({
  before: 42,
});

console.log(history.text);
console.log(history.relativeText);
console.log(history.nodes);
console.log(history.coverage);
```

`before: 42` chỉ bao gồm cốt truyện của `mesid < 42`. `text` là văn bản lịch sử nén chỉ kèm thời gian tuyệt đối, được ghép theo trình tự thời gian; `relativeText` sẽ cộng thêm các thời gian tương đối như "Hôm qua", "3 ngày trước" và thứ mấy trong tuần, điểm tham chiếu là thời gian trong truyện mới nhất trước vị trí kết thúc truy vấn lần này. `nodes` đồng thời cung cấp cấp độ, thời gian và phạm vi tầng bao phủ của mỗi nút tóm tắt / đại tóm tắt được chọn.

Bách Bảo Thư sẽ ưu tiên sử dụng bản đại tóm tắt tầng cao nhất có thể đại diện trọn vẹn cho một đoạn lịch sử; nếu nút đại tóm tắt có hậu duệ mất hiệu lực thì sẽ tự động tách về các nút tầng dưới vẫn còn hợp lệ.

### Đọc cốt truyện lịch sử theo tiêu chuẩn tiêm thông thường

```js
const injectedHistory = globalThis.STBaiBaiBook.getInjectedHistory();

console.log(injectedHistory.relativeText);
console.log(injectedHistory.nodes);
console.log(injectedHistory.coverage);
```

`getInjectedHistory()` dùng chung cùng một bộ quy tắc chọn nút với phần tiêm trí nhớ thông thường của Bách Bảo Thư: chỉ trả về các bản tóm tắt hợp lệ có chính văn đã ẩn và đã rời khỏi cửa sổ trượt, đồng thời sử dụng thời gian trong truyện mới nhất hiện tại để tạo thời gian tương đối. `relativeText` là nội dung lịch sử được macro và phần tiêm thông thường sử dụng; `text` là phiên bản thời gian thuần tuyệt đối của cùng các nút đó.

Giá trị trả về không bao gồm lời nhắc bao ngoài được dùng bởi khe tiêm nội bộ của Bách Bảo Thư, mà chỉ bao gồm nội dung chính của cốt truyện lịch sử.

### Đọc tầng đơn

```js
const floor = globalThis.STBaiBaiBook.getFloor(42);

console.log(floor.body);             // Chính văn tầng sau khi đã làm sạch theo quy tắc Bách Bảo Thư
console.log(floor.omitted);          // Có phải ngoại truyện hay không
console.log(floor.memory.valid);     // Có tóm tắt khả dụng ở trang (swipe) hiện tại hay không
console.log(floor.memory.summary);
console.log(floor.memory.delta);
```

`memory.stored` biểu thị trên tin nhắn có tồn tại dữ liệu lá về mặt vật lý; `memory.valid` mới biểu thị lá đó thuộc về swipe hiện tại, không bị quy tắc ngoại truyện loại trừ và có thể dùng để truy vấn. Tóm tắt cũ và phần tăng thêm của lá không hợp lệ sẽ không được phơi bày làm kết quả hợp lệ.

### Đọc ngữ cảnh đầy đủ của một tầng trong một lần

Đây là lối vào được khuyên dùng cho "ảnh chụp nhanh trạng thái của một tầng + cốt truyện lịch sử trước đó":

```js
const context = globalThis.STBaiBaiBook.getContextAtFloor({
  floor: 42,
});

console.log(context.floorData);
console.log(context.floorSummary);
console.log(context.floorDelta);
console.log(context.snapshotBefore);
console.log(context.snapshotAfter);
console.log(context.historyBefore.text);
console.log(context.coverage);
```

### Truy vấn chung (query)

```js
const result = globalThis.STBaiBaiBook.query({
  resource: 'var',
  path: 'Quan hệ.Alice.Hảo cảm',
  floor: 42,
  at: 'after',
});
```

Các `resource` được hỗ trợ:

```text
var, vars, state, protagonist, items, plans, scenes, npcs, itemLog,
snapshot, history, injectedHistory, floor, context
```

- `var` cần `path`.
- `floor`, `context` cần `floor`.
- `history` sử dụng `before`; cũng chấp nhận `floor` làm bí danh điểm kết thúc.
- `injectedHistory` không cần tham số bổ sung, sử dụng quy tắc lọc cửa sổ trượt của phần tiêm trí nhớ thông thường.
- Các tài nguyên trạng thái còn lại có thể tùy chọn `floor` và `at`.

## Thông báo thay đổi

Đăng ký qua API:

```js
const unsubscribe = globalThis.STBaiBaiBook.subscribe(notice => {
  console.log(notice.type, notice.revision, notice.chatId);
  const latest = globalThis.STBaiBaiBook.getSnapshot();
});

// Khi gỡ plugin
unsubscribe();
```

Cũng có thể lắng nghe sự kiện DOM:

```js
window.addEventListener('st-baibai-book:changed', event => {
  console.log(event.detail);
});
```

Tên sự kiện:

- `st-baibai-book:ready`
- `st-baibai-book:changed`

Cả `detail` của sự kiện và thông báo đăng ký đều bao gồm:

```js
{
  type: "ready" | "changed",
  apiVersion: 1,
  pluginVersion: "1.0",
  revision: 12,
  chatId: "...",
  capabilities: {},
}
```

Các cập nhật nội bộ diễn ra liên tiếp có thể được gộp thành một thông báo `changed`. Phía tiêu thụ nên hiểu thông báo là "dữ liệu có thể đã thay đổi", sau khi nhận được hãy gọi lại phương thức truy vấn, đừng tự đoán phần tăng thêm.

## Lệnh gạch chéo `/bbs-get`

Mặc định xuất JSON nhỏ gọn, có thể đi thẳng vào đường ống (pipe) STscript:

```text
/bbs-get resource=snapshot
/bbs-get resource=var path="Quan hệ.Alice.Hảo cảm" floor=42 at=after format=raw
/bbs-get resource=history before=42 format=text
/bbs-get resource=injectedHistory format=text
/bbs-get resource=floor floor=42 format=json
/bbs-get resource=context floor=42 format=json
```

Cũng có thể đặt tên tài nguyên làm tham số không tên đầu tiên:

```text
/bbs-get snapshot
/bbs-get history before=42 format=text
/bbs-get injectedHistory format=text
```

Tham số:

| Tham số | Ý nghĩa |
| --- | --- |
| `resource` | Tên tài nguyên giống với `query()` trong JavaScript, mặc định là `snapshot` |
| `path` | Đường dẫn biến số được `var` sử dụng |
| `floor` | `mesid` tính từ 0 của ST |
| `at` | `before` hoặc `after`, mặc định là `after` |
| `before` | Tầng kết thúc lịch sử, không bao gồm tầng đó |
| `format` | `json`, `raw` hoặc `text` |

Quy tắc định dạng:

- `json`: Mặc định; luôn xuất JSON nhỏ gọn hợp lệ, biến số bị thiếu là `null`.
- `raw`: Chuỗi / số / giá trị boolean không kèm dấu ngoặc kép JSON; đối tượng và mảng vẫn xuất JSON nhỏ gọn.
- `text`: Lịch sử thường trả về chính văn thời gian tuyệt đối; lịch sử theo tiêu chuẩn tiêm trả về chính văn thời gian tương đối giống với tiêm thông thường; tầng đơn trả về tóm tắt (không có tóm tắt thì trả về chính văn sau khi làm sạch); ngữ cảnh tầng trả về "lịch sử trước đó + tóm tắt tầng này".

## Macro ST

### Cả bộ máy macro mới và cũ đều hỗ trợ

```text
{{bbsVars}}       Cây biến số hiện tại, JSON nhỏ gọn
{{bbsState}}      Trạng thái thời gian/địa điểm hiện tại, JSON nhỏ gọn
{{bbsSnapshot}}   Ảnh chụp nhanh đầy đủ hiện tại, JSON nhỏ gọn
{{bbsHistory}}    Toàn bộ lịch sử nén hiện tại, văn bản thuần kèm thời gian tương đối
{{bbsInjectedHistory}} Giống với tiêm trí nhớ thông thường, bỏ qua tóm tắt trong cửa sổ trượt
```

### Bộ máy macro mới hỗ trợ tham số

```text
{{bbsVar::Quan hệ.Alice.Hảo cảm}}
{{bbsVar::Đội hình[0].hp::42::after}}
{{bbsSnapshot::42::before}}
{{bbsSnapshot::42::after}}
{{bbsHistory::42}}
{{bbsFloor::42}}
```

`{{bbsHistory}}` và `{{bbsHistory::42}}` trả về `getHistory(...).relativeText`. Cái sau chỉ bao gồm cốt truyện của `mesid < 42`, và lấy thời gian trong truyện mới nhất trước tầng 42 để tính các nhãn như "Hôm qua", "3 ngày trước" và thứ mấy trong tuần.

`{{bbsInjectedHistory}}` trả về `getInjectedHistory().relativeText`, sử dụng cùng quy tắc chọn nút và thời gian tương đối với phần tiêm trí nhớ thông thường, do đó sẽ tự động bỏ qua các bản tóm tắt trong cửa sổ trượt vốn vẫn đang gửi toàn văn.

Giá trị chuỗi trong macro được trả về nguyên mẫu; số và giá trị boolean chuyển thành chuỗi; đối tượng và mảng sử dụng JSON nhỏ gọn; `null`, biến số không tồn tại hoặc lỗi truy vấn trả về chuỗi rỗng.

Bộ máy macro phiên bản cũ chỉ có thể sử dụng năm macro không tham số. Khi cần đọc có tham số, nên kiểm tra:

```js
globalThis.STBaiBaiBook.capabilities.parameterizedMacros
```

Nếu là `false`, hãy chuyển sang dùng `/bbs-get` hoặc JavaScript API.

## Lỗi và ranh giới

- `floor` bắt buộc phải là số nguyên `mesid` hợp lệ trong cuộc trò chuyện hiện tại, nếu không JavaScript API sẽ ném ra `TypeError` hoặc `RangeError`.
- `before` có thể nhận giá trị từ `0` đến `chat.length`; nó biểu thị chỉ số kết thúc loại trừ (exclusive).
- Khi hiện tại không mở cuộc trò chuyện nào, ảnh chụp nhanh cuối và lịch sử sẽ trả về kết quả rỗng; các phương thức cần tầng cụ thể sẽ ném lỗi do không có tầng hợp lệ.
- DTO của API có thể tự do lưu đệm và sửa đổi, nhưng nó là bản sao tại thời điểm đọc; khi cần giá trị mới nhất hãy truy vấn lại và so sánh `revision`.
- Đừng đọc đối tượng phản ứng `memory` nội bộ của Bách Bảo Thư hoặc phân tích trực tiếp `chatMetadata`. Những thứ đó thuộc về triển khai nội bộ, không được bảo vệ bởi cam kết tương thích API v1.

Định nghĩa kiểu TypeScript công khai nằm tại `src/public/types.ts`.
