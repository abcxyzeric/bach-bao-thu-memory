/**
 * Mô hình dữ liệu bộ nhớ Bách Bảo Thư —— Kiến trúc lai: Lá nằm trên tin nhắn, Nút nén nằm trong rừng
 *
 * Vị trí lưu trữ:
 *  - **Tóm tắt lá**: lưu trên extra.bbs_leaf của đối tượng tin nhắn chat (LeafExtra). Được ST tự động
 *    mang theo cùng tin nhắn / swipe (per-swipe extra), lưu bền vững theo file chat. Xóa tin nhắn → lá biến mất theo;
 *    lật trang / regenerate → chuyển đổi lá hợp lệ theo số trang swipe; chỉnh sửa chính văn thông thường không còn tự động hủy bỏ tóm tắt.
 *  - **Nút nén** (L1/L2…): lưu ở rừng độc lập chat_metadata.baibai_book.summaries (MemSummary,
 *    level≥1). Nó là tổng hợp xuyên tầng, không có tin nhắn đơn lẻ nào để gắn vào, dùng childIds tham chiếu tầng dưới (L1→id lá, L2→id L1).
 *
 * Cốt lõi:
 *  - state / items / plans là **dữ liệu dẫn xuất**: quét chat theo thứ tự tầng lầu, phát lại delta của từng lá hợp lệ để tính ra,
 *    không lưu bền vững. Xóa lá / lá lỗi thời → delta của nó không còn được phát lại → dữ liệu dẫn xuất tự động lùi về.
 *  - Nút nén chỉ nén **văn bản tự sự** để tiết kiệm token tiêm, không mang delta, không ảnh hưởng dữ liệu có cấu trúc.
 *  - Chỉnh sửa / xóa một lá đã được nén → xóa toàn bộ chuỗi nén tổ tiên có chứa nó (xem apply.pruneBrokenComps).
 */

export const MEMORY_KEY = 'baibai_book';
/** 3 = Kiến trúc lai (lá nằm ở extra của tin nhắn); 2 = Lá cũng nằm trong rừng; 1 = items/plans/state độc lập */
export const MEMORY_VERSION = 3;

/**
 * Vật phẩm (sản phẩm dẫn xuất, không lưu bền vững).
 * id có **tính tất định**: `item:${tên chuẩn hóa}`, nên mỗi lần phát lại đều thu được cùng một id, op thủ công có thể tham chiếu ổn định.
 */
export interface MemItem {
  id: string;
  /** Tên vật phẩm (đồng thời làm khóa khớp) */
  name: string;
  /** Mô tả ngắn / ghi chú */
  desc?: string;
  /** Số lượng; lược bỏ biểu thị không đếm số lượng */
  qty?: number;
  /** Có mang theo người hay không (di chuyển theo nhân vật); lược bỏ/true = mang theo người, luôn được tiêm. false = cất ở nơi nào đó, chỉ khi khớp địa điểm hiện tại mới tiêm toàn bộ */
  carried?: boolean;
  /** Địa điểm cất giữ khi không mang theo người (tên địa danh trong truyện); khi carried=false dùng để khớp với địa điểm hiện tại */
  location?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Mục nhật ký biến động vật phẩm (sản phẩm dẫn xuất, không lưu bền vững).
 * Sản sinh kèm khi phát lại delta của lá: mỗi mục add/update/remove ghi một dòng, kèm "thời gian trong truyện".
 * Công dụng: tiêm vào đối thoại chính + nạp cho API phụ tóm tắt, để mô hình biết "khoản này đã quyết toán", tránh việc hai đoạn cốt truyện liên tiếp trừ hai lần cho cùng một lần tiêu hao.
 */
export interface ItemLogEntry {
  /** Tên vật phẩm */
  name: string;
  /** add=nhận được/thêm mới, update=thay đổi số lượng hoặc mô tả, remove=gỡ bỏ/tiêu hao hết */
  kind: 'add' | 'update' | 'remove';
  /** Số lượng trước khi đổi (chỉ khi đã biết và có ý nghĩa); vật phẩm không đếm qty thì lược bỏ */
  from?: number;
  /** Số lượng sau khi đổi (sau remove là 0/lược bỏ) */
  to?: number;
  /** Thời gian trong truyện (lấy timeEnd của lá tạo ra biến động đó, thiếu thì lấy timeStart); không có thì chuỗi rỗng */
  time: string;
}

/* ============ Biến tùy chỉnh (Kiểu MVU: một đối tượng JSON + lệnh đường dẫn) ============ */

/** Giá trị JSON. "Trạng thái" của biến tùy chỉnh chính là một cây như thế này, AI dùng lệnh đường dẫn tự do thêm xóa sửa. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Cấp độ phạm vi của biến. **Chỉ ảnh hưởng "khuôn mẫu ban đầu lưu ở đâu", giá trị luôn độc lập cho mỗi cuộc trò chuyện** (phát lại từ varOps trong lá riêng của từng cuộc trò chuyện):
 *  - global: mọi nhân vật mọi cuộc trò chuyện dùng chung khuôn mẫu (lưu ở extension_settings).
 *  - char: mọi cuộc trò chuyện của nhân vật hiện tại dùng chung khuôn mẫu (lưu ở extension_settings, phân biệt theo avatar nhân vật).
 *  - chat: chỉ cuộc trò chuyện hiện tại (lưu ở chatMetadata, mức mặc định).
 * Khi tải sẽ gộp sâu khuôn mẫu ba tầng (chat > char > global) thành trạng thái ban đầu; lệnh (delta) chỉ lưu ở lá (chat), nên giá trị tự nhiên độc lập theo từng cuộc trò chuyện.
 */
export type VarTier = 'global' | 'char' | 'chat';

/**
 * "Định nghĩa" biến của một tầng = khuôn mẫu cấu trúc ban đầu + hướng dẫn cho AI (tách làm hai đoạn). Ba tầng mỗi tầng một bản, khi tải sẽ gộp sâu thành trạng thái ban đầu.
 *  - json: JSON ban đầu (gốc phải là đối tượng), người dùng dựng sẵn cấu trúc muốn theo dõi (có thể để đối tượng rỗng, cho AI xây từ đầu).
 *  - meaning: các trường **là cái gì** (ý nghĩa / phạm vi giá trị). Cả API chính (viết chính văn) lẫn API phụ (tóm tắt) đều nhận được ——
 *    API chính dựa vào đó hiểu giá trị hiện tại, chỉ đọc tham khảo.
 *  - rule: **khi nào sửa thế nào**, có được tạo đối tượng mới không (tương đương điều kiện biến đổi / quy ước lệnh của MVU). **Chỉ gửi cho API phụ** ——
 *    nó chứa chỉ thị "cách thêm xóa sửa", API chính nhìn thấy sẽ hiểu lầm là phải xuất / thuật lại biến số trong chính văn, nên chắn khỏi API chính.
 */
export interface VarTemplate {
  json: Record<string, JsonValue>;
  meaning: string;
  rule: string;
}

/**
 * Lệnh đường dẫn (AI và thủ công dùng chung; cố định vào delta.varOps của lá, phát lại theo tầng lầu). Mô phỏng set/assign/remove/add của MVU:
 *  - set: đặt giá trị tại path thành value (tự động tạo tầng trung gian). path='' biểu thị toàn bộ gốc.
 *  - assign: chèn vào đối tượng / mảng tại path. Đưa key thì obj[key]=value (mảng thì là chỉ mục đó); không đưa key thì mảng push value.
 *  - remove: xóa. Đưa key thì xóa khóa đối tượng / chỉ mục mảng / phần tử trong mảng bằng với key; không đưa key thì xóa bản thân path.
 *  - add: cộng thêm delta vào con số tại path (số âm tức là trừ).
 */
export interface VarOp {
  op: 'set' | 'assign' | 'remove' | 'add';
  /** Định vị bằng dấu chấm / ngoặc vuông, như "Thế lực.Hội đồng Phép thuật.Danh vọng" hoặc "Đội hình[0].hp"; '' = gốc */
  path: string;
  /** Dùng cho assign/remove: khóa đối tượng hoặc chỉ mục mảng (hoặc giá trị cần xóa trong mảng) */
  key?: string | number;
  /** Dùng cho set/assign: giá trị cần ghi vào */
  value?: JsonValue;
  /** Dùng cho add: lượng tăng thêm bằng số */
  delta?: number;
}

/** Chuẩn hóa nguồn bất kỳ thành một bản khuôn mẫu biến (json phải là đối tượng; json cho phép truyền chuỗi, thử phân tích). Hàm thuần, dùng chung cho settings/store. */
export function normalizeTemplate(raw: unknown): VarTemplate {
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
    } else if (typeof o.json === 'string') {
      try {
        const p = JSON.parse(o.json);
        if (p && typeof p === 'object' && !Array.isArray(p)) json = p;
      } catch { /* JSON không hợp lệ → đối tượng rỗng */ }
    }
    if (typeof o.meaning === 'string') meaning = o.meaning;
    if (typeof o.rule === 'string') rule = o.rule;
    // Tương thích: khi định dạng cũ chia sẻ từ bên ngoài chỉ có một guide đơn lẻ, gộp vào rule (ý nghĩa có thể để trống, không ảnh hưởng sử dụng).
    if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide;
  }
  return { json, meaning, rule };
}

/**
 * Bối cảnh / Địa điểm (sản phẩm dẫn xuất, không lưu bền vững).
 * Cấp bậc địa lý thuần túy: địa điểm ∈ khu vực cấp trên, dùng id tất định nối thành cây lồng nhau (xóa / lá lỗi thời → delta không phát lại → cây tự động lùi về).
 * id tất định: `scene:${đường dẫn chuẩn hóa, phân cách bằng '/'}`, nên cùng một đường dẫn mỗi lần phát lại đều ra cùng id, op thủ công có thể tham chiếu ổn định.
 * Đổi tên một cấp = đổi id (biểu đạt bằng remove cũ + add mới, xem apply.renameScene).
 */
export interface MemScene {
  id: string;
  /** Tên địa danh cấp này (nguyên văn đoạn cuối cùng của đường dẫn) */
  name: string;
  /** Nguyên văn đường dẫn đầy đủ (từ lớn đến nhỏ, như ["Vương Đô","Khu Thành Tây","Khách điếm Quy Nhạn"]), dùng để hiển thị và khớp */
  path: string[];
  /** ID nút cha; nút gốc là chuỗi rỗng */
  parentId: string;
  /** Mô tả địa điểm (ngắn gọn khách quan) */
  desc?: string;
  createdAt: number;
  updatedAt: number;
}

/** Nhãn định tính 5 mức, không phải điểm số cộng dồn. */
export type NpcAffinityLevel = -2 | -1 | 0 | 1 | 2;

/** Ước lượng hảo cảm nội tâm và thái độ bên ngoài đối với nhân vật chính. Lược bỏ = giữ nguyên; null = khôi phục rõ ràng về chưa rõ, khác với trung lập (0). */
export interface NpcAffinity {
  /** Khuynh hướng yêu ghét / gần gũi thực sự, không phải tình yêu, sự tin tưởng hay mức độ phục tùng. */
  affinityInner?: NpcAffinityLevel | null;
  /** Thái độ đối ngoại tương đối ổn định, không phải giọng điệu hay tâm trạng trong lượt này. */
  affinityOuter?: NpcAffinityLevel | null;
  /** Một câu giải thích căn cứ / biểu hiện / mâu thuẫn; cùng mức mặc định kế thừa, chuỗi rỗng = xóa trống rõ ràng. */
  affinityNote?: string;
}

/**
 * Phân mức có mặt của NPC so với bối cảnh hiện tại của nhân vật chính (logic phán đoán xem apply.classifyNpcPresence là thẩm quyền duy nhất).
 * Nhãn có mặt trong danh sách tóm tắt, phân mức tiêm đối thoại chính, phân nhóm trang NPC dùng chung cùng một bộ từ vựng.
 */
export type NpcPresence = 'present' | 'nearby' | 'absent';

/**
 * NPC / Nhân vật (sản phẩm dẫn xuất, không lưu bền vững).
 * Đồng cấu với vật phẩm (MemItem): id tất định `npc:${tên chuẩn hóa}`, phát lại bất biến, op thủ công có thể tham chiếu ổn định.
 * Cơ chế tiết kiệm token tương tự carried/location của vật phẩm:
 *  - follow=true đi cùng (đồng hành di chuyển theo nhân vật chính), luôn có mặt và tiêm toàn bộ;
 *  - follow≠true cố định, chỉ khi location nằm ở địa điểm hiện tại hoặc chuỗi tổ tiên của nó mới tiêm toàn bộ, nếu không chỉ gửi tên + thân phận.
 * ⚠️ follow mặc định là false (đa số NPC ở cố định), ngược với vật phẩm carried mặc định là mang theo người.
 *
 * Các trường chia làm hai tầng:
 *  - **Tầng hồ sơ** (title/desc/personality): "người đó là ai / trông thế nào", ngưỡng cao, hầu như không đổi, ghi một lần.
 *  - **Tầng tức thời** (outfit/condition): "người đó hiện giờ ra sao", kiểu ghi đè, đổi là đè, không lắng đọng lịch sử, khuyến khích làm mới theo cốt truyện.
 *    Sở dĩ tầng tức thời không vi phạm quy tắc thép "chỉ ghi thông tin quan trọng dài hạn" chính là vì nó hoàn toàn không đi vào lịch sử —— cùng tính chất với thời gian / địa điểm hiện tại.
 * "Nhân vật chính yếu" có important=true: luôn luôn tiêm toàn bộ (bỏ qua phán đoán có mặt), giao diện / phần tiêm làm nhẹ hồ sơ, làm nổi bật bảng trạng thái tức thời.
 */
export interface MemNpc extends NpcAffinity {
  id: string;
  /** Tên (đồng thời làm khóa khớp) */
  name: string;
  /** Giới tính (tầng hồ sơ; giá trị ngắn, như "Nam", "Nữ". Không bị ảnh hưởng bởi phán đoán có mặt, mọi mức đều tiêm, chống AI nhầm giới tính) */
  gender?: string;
  /**
   * Nguyên văn tuổi tác (giá trị lúc ghi, như "25", "ngoài hai mươi"). **Không tự động viết lại lưu trữ theo thời gian**:
   * đi kèm mốc neo ageTime, khi tiêm / hiển thị sẽ do ageDisplay suy tính theo thời gian câu chuyện hiện tại (thời gian nhảy vọt tự động tăng tuổi),
   * AI có quên cập nhật hay không cũng không ảnh hưởng tính chính xác. Khi chính văn nêu rõ lại tuổi tác (qua sinh nhật / đính chính) thì ghi đè, mốc neo làm mới theo.
   */
  age?: string;
  /** Mốc neo tuổi tác: thời gian trong truyện lúc ghi age. AI không điền —— khi phát lại hệ thống tự động đóng dấu timeEnd của lá đó */
  ageTime?: string;
  /** Quan hệ với nhân vật chính (kiểu ghi đè; định dạng hướng dẫn "Danh xưng[, lập trường kéo dài]", lập trường có thể không có, danh xưng ở đầu để mức vắng mặt cắt lấy) */
  relation?: string;
  /** Quan hệ quan trọng với các nhân vật khác (tầng hồ sơ, ngưỡng cao; như "Cha của Adele; có thù cũ với trấn trưởng") */
  ties?: string;
  /** Một câu thân phận / nghề nghiệp (thông tin duy nhất giữ lại khi vắng mặt) */
  title?: string;
  /** Ngoại hình cố định: màu tóc / vóc dáng / vết sẹo v.v. diện mạo dài hạn không đổi (tầng hồ sơ, ngưỡng cao, hầu như không cập nhật) */
  desc?: string;
  /** Tính cách đơn giản */
  personality?: string;
  /** Trang phục hiện tại (tầng tức thời, kiểu ghi đè; thay đồ / làm bẩn làm rách là làm mới ngay, ngưỡng thấp hơn desc rất nhiều) */
  outfit?: string;
  /** Trạng thái / sức khỏe hiện tại (tầng tức thời, kiểu ghi đè; bị thương / mệt mỏi / trúng độc v.v., khi không có gì bất thường thì để trống) */
  condition?: string;
  /** Có phải "Nhân vật chính yếu" hay không: diễn viên chính cốt lõi của cốt truyện, luôn tiêm toàn bộ, chỉ theo dõi trạng thái tức thời, không theo dõi hồ sơ */
  important?: boolean;
  /** Có đi cùng hay không (di chuyển theo nhân vật chính); lược bỏ/false = cố định (khớp theo location), true = đồng hành, luôn có mặt */
  follow?: boolean;
  /** Nơi ở khi cố định (tên địa danh trong truyện); khi follow≠true dùng để khớp với địa điểm hiện tại. Trống = không rõ nơi ở (đã rời hiện trường và chưa rõ đi đâu) */
  location?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Hồ sơ hiện tại của nhân vật chính do người dùng điều khiển (sản phẩm dẫn xuất, không lưu bền vững).
 * Chỉ ghi lại các sự thật khách quan xuất hiện rõ ràng trong cốt truyện và sẽ ảnh hưởng việc viết tiếp về sau; không suy đoán tính cách hay nội tâm từ hành vi.
 * Địa điểm và vật phẩm đã có trạng thái độc lập, không lặp lại tại đây.
 */
export interface MemProtagonist {
  /** Giới tính / biểu hiện giới tính (ghi khi chính văn nêu rõ) */
  gender?: string;
  /** Nguyên văn tuổi tác (cùng cơ chế với NPC: kèm mốc neo ageTime, khi hiển thị / tiêm sẽ suy tính theo thời gian câu chuyện hiện tại) */
  age?: string;
  /** Mốc neo tuổi tác: thời gian trong truyện lúc ghi age, khi phát lại hệ thống tự động đóng dấu */
  ageTime?: string;
  /** Thân phận, nghề nghiệp, chủng tộc hoặc địa vị công khai hiện tại */
  identity?: string;
  /** Ngoại hình / đặc điểm cơ thể ổn định hiện tại; sau khi biến hình vĩnh viễn, có sẹo v.v. thì ghi đè */
  appearance?: string;
  /** Trang phục hiện tại (kiểu ghi đè) */
  outfit?: string;
  /** Trạng thái cơ thể / sức khỏe hiện tại (kiểu ghi đè; sau khi hồi phục bình thường thì xóa trống) */
  condition?: string;
}

/**
 * "Cách thức khép lại" của kế hoạch / nghi vấn. Phân biệt ba kiểu kết thúc hoàn toàn khác nhau, tránh dùng chung chữ "đã hoàn thành" làm mô hình chính hiểu lầm:
 *  - done      = kế hoạch thực sự đã làm xong / thực hiện được, nghi vấn thực sự đã sáng tỏ (kết quả đã rõ ràng);
 *  - cancelled = chưa làm thành mà bị hủy bỏ / rút lại / từ bỏ / vô hiệu hóa / không cần nữa (như đối phương rút lại yêu cầu, được hóa giải nhượng bộ ngay tại chỗ);
 *  - failed    = đã thử nhưng thất bại, hoặc nghi vấn khép lại bằng kết cục xấu.
 */
export type PlanOutcome = 'done' | 'cancelled' | 'failed';

/**
 * Một chỉ thị "khép lại". id: trong SummaryDelta là số thứ tự ngắn lúc chạy (p1/p2); trong StoredDelta là id plan ổn định.
 * outcome/reason mang thông tin "khép lại thế nào, tại sao", khi tiêm sẽ hiển thị cho mô hình chính, xóa bỏ sự bối rối "đã hoàn thành mà vẫn nhắc đi nhắc lại".
 */
export interface PlanResolveEntry {
  id: string;
  outcome?: PlanOutcome;
  /** Một câu nguyên nhân khép lại (tại sao gỡ xuống / kết thúc như thế nào) */
  reason?: string;
}
/** Tương thích: khi dữ liệu lịch sử / hạ cấp phần tử có thể là chuỗi trần (= không có outcome/nguyên nhân), nên phần tử resolve có thể ở cả hai dạng. */
export type PlanResolveItem = string | PlanResolveEntry;

/**
 * Dời lịch / tạm hoãn kế hoạch: sắp xếp mới cho cùng một việc chưa khép lại.
 * id trong SummaryDelta là số thứ tự ngắn (p1/p2), trong StoredDelta đã được dịch thành id plan ổn định.
 * Chỉ cập nhật tổng thể content / targetTime; không được xuất hiện đồng thời với resolve của cùng một mã số.
 */
export interface PlanUpdateItem {
  id: string;
  content?: string;
  /** Thời hạn mới; chuỗi rỗng = hủy bỏ thời hạn cũ và thời hạn mới chưa định (xóa targetTime) */
  targetTime?: string;
}

/**
 * Kế hoạch / Nghi vấn (sản phẩm dẫn xuất, không lưu bền vững).
 * id tất định: `plan:${id lá tạo ra nó}#${số thứ tự trong mảng add tại lá đó}`.
 */
export interface MemPlan {
  id: string;
  /** plan=kế hoạch/mục tiêu, suspense=nghi vấn/bí ẩn chưa lời giải */
  kind: 'plan' | 'suspense';
  content: string;
  /** open=đang tiến hành, resolved=đã khép lại */
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  /** Cách thức khép lại (chỉ có khi status=resolved); phân biệt "đã làm thật (done)" với "hủy bỏ/vô hiệu (cancelled)", "thất bại (failed)" */
  outcome?: PlanOutcome;
  /** Một câu nguyên nhân khép lại (tại sao gỡ xuống / kết thúc thế nào); tiêm cho mô hình chính, chống việc "đã hoàn thành mà vẫn nhắc" */
  resolvedReason?: string;
  /** "Thời gian tạo" trong truyện (chuỗi do AI xuất trực tiếp, như 1988/9/29); không liên quan tới createdAt (mili-giây thực tế) */
  createdTime?: string;
  /** "Thời gian mục tiêu" trong truyện (AI xuất trực tiếp, cho phép giá trị mơ hồ như "sau này có cơ hội" hoặc để trống) */
  targetTime?: string;
}

/**
 * Tóm tắt lá, lưu trên extra.bbs_leaf của đối tượng tin nhắn chat (không đưa vào rừng).
 * Tự động đi theo swipe_info, lưu bền vững theo file chat. **Nguồn duy nhất của việc phát lại**.
 */
export interface LeafExtra {
  /** ID lá ổn định (vừa ghi vào là cố định), childIds của nút nén tham chiếu nó */
  id: string;
  /** Chính văn tóm tắt */
  text: string;
  /** Lượng tăng thêm có cấu trúc */
  delta: StoredDelta;
  /** Thời gian bắt đầu trong truyện (đến từ thẻ <bbs_start> trong chính văn; khi không có thẻ thì do AI bù) */
  timeStart?: string;
  /** Thời gian kết thúc trong truyện (đến từ thẻ <bbs_end> trong chính văn; khi không có thẻ thì do AI bù) */
  timeEnd?: string;
  /** Trường cũ: ảnh chụp thời gian trong truyện lúc tạo (giá trị đơn / chuỗi gộp). Dữ liệu mới dùng timeStart/timeEnd; giữ lại nó để hiển thị dự phòng cho dữ liệu cũ */
  timeLabel?: string;
  /** Thời khắc tạo (hiển thị UI và phá thế hòa; thứ tự phát lại thực tế lấy thứ tự vật lý của tầng lầu làm chuẩn) */
  createdAt: number;
  /**
   * Số trang swipe lúc tạo lá này (= message.swipe_id lúc đó).
   * Dùng để phán đoán quyền sở hữu lá: khi ST tạo swipe mới sẽ structuredClone extra cũ (gồm cả bbs_leaf),
   * chép lá của trang trước sang trang mới; dựa vào "số trang lá ghi nhận ≠ swipe_id hiện tại" để nhận diện việc nhảy trang này và vô hiệu hóa.
   * Mặc định (dữ liệu cũ / di chuyển) xử lý như trang đầu tiên (0).
   */
  swipe?: number;
  /** Trường cũ: hash (mes sau khi làm sạch). Đã bỏ (tính hợp lệ của lá đổi sang khớp tầng lầu / cấu trúc, không còn đối chiếu chính văn); chỉ còn sót ở dữ liệu cũ */
  srcHash?: string;
  /**
   * Cờ lá hạt giống: lá gắn ở #0 khi carryover (tạo cuộc trò chuyện mới kèm dữ liệu), text của nó là văn xuôi "tổng kết gộp" của cuộc trò chuyện cũ.
   * Nó chỉ phục vụ việc phát lại trạng thái (deriveMemory đọc delta) và tiêm tóm tắt lịch sử (được L2 của sum_carry_ thu nạp),
   * **không nên đưa vào kho vector** —— nếu không khi truy xuất sẽ trúng cả một đoạn tổng kết dài (trong khi tóm tắt đơn lẻ của cuộc trò chuyện cũ đã được ảnh chụp bundle bao phủ truy xuất).
   * collectLeaves dựa vào đây để bỏ qua nó.
   */
  seed?: boolean;
  /** Phiên bản cấu trúc lá */
  v: 1;
}

/**
 * Nút nén (nút rừng, level ≥ 1). Mảng phẳng + childIds biểu đạt rừng:
 * Nút không bị bất kỳ childIds của nút nào tham chiếu chính là "gốc".
 * childIds: L1 tham chiếu id lá (trên extra của tin nhắn); L2+ tham chiếu id nút nén tầng dưới (trong mảng này).
 */
export interface MemSummary {
  id: string;
  /** Chính văn tóm tắt */
  text: string;
  /** Cấp độ nén: 1=L1, 2=L2… (lá level 0 đã chuyển sang extra của tin nhắn) */
  level: number;
  createdAt: number;
  /** Có phải tự động tạo hay không (false = thủ công / di chuyển) */
  auto: boolean;
  /** Thời gian bắt đầu trong truyện (bắt đầu của lá đầu tiên trong phạm vi bao phủ) */
  timeStart?: string;
  /** Thời gian kết thúc trong truyện (kết thúc của lá cuối cùng trong phạm vi bao phủ) */
  timeEnd?: string;
  /** Trường cũ: ảnh chụp thời gian hiện tại lúc tạo. Dữ liệu mới dùng timeStart/timeEnd; giữ lại để hiển thị dự phòng cho dữ liệu cũ */
  timeLabel?: string;
  /** ID các nút tầng dưới được thu nạp trực tiếp (L1→id lá, L2+→id nút nén tầng dưới); khi lịch sử nhập vào làm nút nguyên tử thì để trống. */
  childIds: string[];
  /** Nút lịch sử nguyên tử được nhập từ bên ngoài plugin. Nó không có lá từng tầng, do phạm vi tầng lầu dưới đây trực tiếp đại diện cho cốt truyện cũ. */
  imported?: boolean;
  /** Tầng lầu bắt đầu được lịch sử nhập vào bao phủ (bản đầu tiên hiện tại cố định là 0, giữ trường để sau này mở rộng nhập phân đoạn). */
  importedFloorStart?: number;
  /** Tầng lầu kết thúc (bao gồm cả tầng đó) được lịch sử nhập vào bao phủ. Các tầng trong phạm vi không tóm tắt bù lặp lại nữa. */
  importedFloorEnd?: number;
}

/** Trạng thái hiện tại kiểu ghi đè */
export interface MemState {
  /** Thời gian hiện tại trong truyện */
  time: string;
  /** Địa điểm hiện tại (chuỗi tự do, có thể chi tiết tùy ý: như "Trong phòng 302 - Khu chung cư cũ nọ quận Tân Giang thành phố Hàng Châu") */
  location: string;
  /**
   * Đường dẫn đầy đủ của "nút bối cảnh đã ghi nhận" nơi đang ở hiện tại (từ lớn đến nhỏ, như ["Thành phố Hàng Châu","Khu chung cư cũ nọ quận Tân Giang","Trong phòng 302"]).
   * Do AI tiện tay đưa ra khi sửa location, làm kết nối định vị có thẩm quyền —— giải quyết sự lệch độ mịn giữa chuỗi tự do location và cây bối cảnh.
   * Có thể thô hơn location (chỉ trỏ tới cấp trên); khi mặc định / không tìm thấy, việc định vị lùi về khớp mờ thu hẹp theo location.
   */
  locationPath?: string[];
  /** Thẻ cục diện tương tác: ảnh chụp cảnh tượng hiện tại. null = không có; ngữ nghĩa ghi đè (thay thế cả thẻ, không phải bản vá) */
  sceneFocus: SceneFocus | null;
}

/**
 * Thẻ cục diện tương tác: một ảnh chụp nhỏ về "những gì đang diễn ra ngay trước mắt", phục vụ cả hai tiêu chuẩn thẻ bầu bạn và thẻ cốt truyện.
 * Ba ngữ nghĩa delta: lược bỏ trường = không cập nhật; null = xóa trống rõ ràng; đối tượng = ghi đè cả thẻ.
 * updatedTime do mã nguồn đóng dấu thời gian trong truyện khi phát lại, không do AI xuất ra.
 */
export interface SceneFocus {
  /** Một câu cục diện hiện tại (thẻ bầu bạn viết bầu không khí tương tác, thẻ cốt truyện viết hoàn cảnh) */
  situation: string;
  /** Những người tham gia đang có mặt hiện tại */
  participants: string[];
  /** @deprecated Đã bỏ (trùng lặp với situation, không còn nhắc AI xuất ra); chỉ giữ lại để tương thích dữ liệu cũ, khi có giá trị vẫn tiêm / hiển thị */
  currentFocus?: string;
  /** Sức căng tương tác (ngưỡng cao, chỉ sức căng xã hội rõ ràng và kéo dài; tùy chọn) */
  tension?: string;
  /** Việc sắp xảy ra (chỉ những việc chính văn báo trước / hẹn ước rõ ràng / đã khởi động đang chờ kết quả; cấm dự đoán; tùy chọn) */
  pendingBeat?: string;
  /** Thời gian trong truyện tương ứng với ảnh chụp này (mã nguồn đóng dấu) */
  updatedTime?: string;
}

/**
 * Một mục hồ sơ nhỏ đời sống: sở thích / thói quen / trạng thái cá nhân gần đây của nhân vật chính hoặc nhân vật chính yếu.
 * Quy tắc thép: quy thuộc rõ ràng, chỉ ghi những điều chính miệng người đó nói / chính văn bộc lộ rõ ràng, cấm suy đoán từ hành vi đơn lẻ.
 * Ba tầng phân phối (lựa chọn khi tiêm, không đụng nguồn chân lý): pinned ghim đầu thường trú (≤5) / active còn thời hiệu và liên quan mới tiêm / archive lắng đọng chỉ kích hoạt bằng từ khóa.
 */
export interface MemLifeDetail {
  /** ID ổn định: detail:${leafId}#${số thứ tự add} (phát lại bất biến, op thủ công có thể tham chiếu ổn định) */
  id: string;
  /** Nhân vật sở hữu: user là nhân vật chính, giá trị khác là tên trong danh sách NPC; dữ liệu cũ lược bỏ thì coi là user. */
  subject?: string;
  /** Một câu chính văn chi tiết (chủ ngữ do subject biểu thị riêng) */
  text: string;
  /** Nhãn chủ đề (1-3 cái, dùng để khớp kích hoạt, như "ăn uống", "giờ giấc sinh hoạt") */
  topics: string[];
  /** Mốc neo từ khóa (từ có thể tìm kiếm trong nguyên văn, như "rau mùi", "dự án") */
  anchors: string[];
  /** Tầng phân phối: pinned ghim đầu thủ công / active mặc định / archive đã lắng đọng */
  tier: 'pinned' | 'active' | 'archive';
  /** Thời hiệu: thời gian hết hạn trong truyện (trống = ổn định dài hạn) */
  until?: string;
  /** Thời gian trong truyện lúc ghi */
  createdTime?: string;
  createdAt: number;
}

/** Phía AI thêm mới chi tiết đời sống (tier do mã nguồn định là active, ghim đầu chỉ làm thủ công) */
export interface LifeDetailAdd {
  /** user là nhân vật chính, giá trị khác là tên nhân vật; định dạng cũ lược bỏ vẫn xử lý như nhân vật chính. */
  subject?: string;
  text: string;
  topics?: string[];
  anchors?: string[];
  until?: string;
}

/** Phía AI cập nhật chi tiết đời sống (id có thể là số thứ tự ngắn d1/d2, khi finalize sẽ dịch thành id ổn định) */
export interface LifeDetailUpdate {
  id: string;
  /** Lược bỏ để giữ nguyên quy thuộc; chỉ điền khi đính chính rõ ràng nhân vật, user biểu thị đổi về nhân vật chính. */
  subject?: string;
  text?: string;
  topics?: string[];
  anchors?: string[];
  until?: string;
}

/**
 * Một mục danh sách hiểu biết: một việc về nhân vật chính mà một nhân vật hiện biết / tưởng là vậy (chống thiết lập nhân vật toàn tri: chuyện riêng tư chưa ghi mặc định không biết).
 * Thứ ghi lại là nhận thức của nhân vật chứ không phải chân tướng, mức độ nắm bắt viết vào câu (khẳng định…/nghi ngờ…/nghe nói…/nhân vật chính tự xưng…), bị lừa thì cứ ghi nhận thức sau khi bị lừa.
 */
export interface MemKnowledge {
  /** ID ổn định: know:${leafId}#${số thứ tự thao tác} (phát lại bất biến, op thủ công có thể tham chiếu ổn định) */
  id: string;
  /** Tên nhân vật biết chuyện (tên trong danh sách NPC; chỉ ghi nhân vật → nhân vật chính) */
  subject: string;
  text: string;
  /** Thời gian trong truyện lúc ghi */
  createdTime?: string;
  createdAt: number;
}

/**
 * Thao tác lưu trữ của danh sách hiểu biết: nhật ký có thứ tự, phát lại theo thứ tự mảng.
 * Không học theo kiểu chia nhóm add→update→remove của hồ sơ nhỏ đời sống —— thao tác thủ công "xóa rồi thêm lại" nếu theo thứ tự chia nhóm sẽ bị nuốt mất.
 */
export type KnowledgeOp =
  | { op: 'add'; subject: string; text: string }
  | { op: 'update'; id: string; subject?: string; text?: string }
  | { op: 'remove'; id: string };

/**
 * Đối tượng bộ nhớ tầng cao nhất.
 * **Chỉ có version + summaries là nguồn chân lý và được lưu bền vững**; state / items / plans là bộ nhớ đệm dẫn xuất
 * tính ra từ việc phát lại summaries (phục vụ trang giao diện đọc phản ứng, saveMemory không ghi chúng).
 */
export interface BaibaiMemory {
  version: number;
  /** Bộ nhớ đệm dẫn xuất: phát lại delta của lá mà thành */
  state: MemState;
  /** Bộ nhớ đệm dẫn xuất: hồ sơ khách quan hiện tại của nhân vật chính do người dùng điều khiển */
  protagonist: MemProtagonist;
  /** Bộ nhớ đệm dẫn xuất */
  items: MemItem[];
  /** Bộ nhớ đệm dẫn xuất */
  plans: MemPlan[];
  /** Bộ nhớ đệm dẫn xuất: các địa điểm đã đi qua (cây lồng ghép địa lý, phát lại từ delta của lá) */
  scenes: MemScene[];
  /** Bộ nhớ đệm dẫn xuất: các NPC đã xuất hiện (phát lại từ delta của lá) */
  npcs: MemNpc[];
  /** Bộ nhớ đệm dẫn xuất: nhật ký biến động vật phẩm gần đây (sản sinh khi phát lại, chỉ giữ lại một số mục gần nhất) */
  itemLog: ItemLogEntry[];
  /** Bộ nhớ đệm dẫn xuất: hồ sơ nhỏ đời sống của nhân vật chính và các nhân vật (phát lại từ delta của lá) */
  lifeDetails: MemLifeDetail[];
  /** Bộ nhớ đệm dẫn xuất: danh sách hiểu biết của các nhân vật về nhân vật chính (phát lại từ delta của lá) */
  knowledge: MemKnowledge[];
  /** Bản sao nguồn chân lý: khuôn mẫu định nghĩa biến ba tầng (global/char đến từ settings, chat đến từ chatMetadata) */
  varTemplates: Record<VarTier, VarTemplate>;
  /** Bộ nhớ đệm dẫn xuất: trạng thái hiện tại của biến (cây JSON thu được từ khuôn mẫu gộp, gấp từng varOps của các lá) */
  vars: Record<string, JsonValue>;
  /** Nguồn chân lý: rừng tóm tắt */
  summaries: MemSummary[];
}

export function createEmptyMemory(): BaibaiMemory {
  return {
    version: MEMORY_VERSION,
    state: { time: '', location: '', sceneFocus: null },
    protagonist: {},
    items: [],
    plans: [],
    lifeDetails: [],
    knowledge: [],
    scenes: [],
    npcs: [],
    itemLog: [],
    varTemplates: { global: { json: {}, meaning: '', rule: '' }, char: { json: {}, meaning: '', rule: '' }, chat: { json: {}, meaning: '', rule: '' } },
    vars: {},
    summaries: [],
  };
}

/* ============ Cấu trúc JSON lượng tăng thêm do AI trả về ============ */

/** Hình dạng một vật phẩm đơn lẻ trong chỉ thị vật phẩm */
export interface ItemDelta {
  name: string;
  desc?: string;
  qty?: number;
  /** Có mang theo người hay không (nhân vật mang trên người). Lược bỏ = mang theo người; vật phẩm đặt rõ ràng ở địa điểm nào đó điền false */
  carried?: boolean;
  /** Địa điểm cất giữ khi không mang theo người (tên địa danh trong truyện) */
  location?: string;
}

/** Hình dạng một nhân vật đơn lẻ trong chỉ thị NPC (AI / thủ công dùng chung) */
export interface NpcDelta extends NpcAffinity {
  name: string;
  /** Giới tính (tầng hồ sơ, giá trị ngắn; mọi mức đều tiêm) */
  gender?: string;
  /** Nguyên văn tuổi tác (chỉ viết khi lần đầu nêu rõ / được đính chính; mốc neo ageTime do phát lại tự động đóng dấu, AI không điền) */
  age?: string;
  /** Mốc neo tuổi tác (chỉ op thủ công / hạt giống carryover mới mang theo; trong đầu ra AI không có trường này) */
  ageTime?: string;
  /** Quan hệ với nhân vật chính (kiểu ghi đè; danh xưng ở đầu) */
  relation?: string;
  /** Quan hệ quan trọng với các nhân vật khác (tầng hồ sơ, ngưỡng cao) */
  ties?: string;
  /** Một câu thân phận / nghề nghiệp */
  title?: string;
  /** Ngoại hình cố định: diện mạo dài hạn không đổi (tầng hồ sơ) */
  desc?: string;
  /** Tính cách đơn giản */
  personality?: string;
  /** Trang phục hiện tại (tầng tức thời, kiểu ghi đè) */
  outfit?: string;
  /** Trạng thái / sức khỏe hiện tại (tầng tức thời, kiểu ghi đè) */
  condition?: string;
  /** Bản vá cục bộ thương tích của bản lưu cũ (giao thức đánh số v0.17, đã ngừng dùng): chỉ phát lại, đầu ra mới không còn tạo ra */
  conditionPatch?: ConditionPatch;
  /** Có phải "Nhân vật chính yếu" hay không (diễn viên chính cốt lõi của cốt truyện, luôn tiêm toàn bộ) */
  important?: boolean;
  /** Có đi cùng hay không (di chuyển theo nhân vật chính). Lược bỏ = cố định; đồng hành đi cùng rõ ràng với nhân vật chính điền true */
  follow?: boolean;
  /**
   * Nơi ở khi cố định (tên địa danh trong truyện). Chuỗi rỗng = không rõ nơi ở: nhân vật đã rời khỏi bối cảnh hiện tại nhưng chưa viết rõ đi đâu,
   * xóa địa điểm cũ, không còn coi là có mặt; sau này khi nói rõ đi đâu thì điền địa điểm mới.
   */
  location?: string;
}

/**
 * Bản vá ghi đè hồ sơ hiện tại của nhân vật chính.
 * Lược bỏ trường = giữ nguyên không đổi; chuỗi rỗng = xóa trống rõ ràng giá trị cũ (như vết thương lành hẳn, cởi bỏ trang phục cũ).
 */
export interface ProtagonistDelta {
  gender?: string;
  /** Nguyên văn tuổi tác (chỉ viết khi lần đầu nêu rõ / đính chính; mốc neo ageTime do phát lại tự động đóng dấu) */
  age?: string;
  /** Mốc neo tuổi tác (chỉ op thủ công / carryover mới mang theo) */
  ageTime?: string;
  identity?: string;
  appearance?: string;
  outfit?: string;
  /** Trạng thái / sức khỏe hiện tại (kiểu ghi đè) */
  condition?: string;
  /** Bản vá cục bộ thương tích của bản lưu cũ (giao thức đánh số v0.17, đã ngừng dùng): chỉ phát lại, đầu ra mới không còn tạo ra */
  conditionPatch?: ConditionPatch;
}

/**
 * Thao tác phân đoạn của bản vá cục bộ thương tích bản cũ (chỉ phát lại bản lưu cũ).
 * - replace dùng id (c1/c2…) định vị phân đoạn cũ, text là chuỗi rỗng biểu thị xóa phân đoạn đó;
 * - add nối thêm phân đoạn mới, không mang id;
 * Các phân đoạn cũ không nằm trong replace được chương trình giữ nguyên. Đánh số chỉ có hiệu lực trong một yêu cầu đơn lẻ.
 */
export interface ConditionPatchOp {
  id?: string;
  text: string;
  /** Trích dẫn ngắn nguyên văn liên tục trong chính văn lượt này (chỉ kiểm tra, không lưu trữ) */
  evidence?: string;
}

export interface ConditionPatch {
  replace?: ConditionPatchOp[];
  add?: ConditionPatchOp[];
}

/** Hình dạng một địa điểm đơn lẻ trong chỉ thị bối cảnh (AI / thủ công dùng chung) */
export interface SceneDelta {
  /** Đường dẫn địa lý đầy đủ, từ lớn đến nhỏ (như ["Vương Đô","Khu Thành Tây","Khách điếm Quy Nhạn"]) */
  path: string[];
  /** Mô tả địa điểm (add có thể lược bỏ: tạo điểm rộng, mô tả nghiêm; update đưa chuỗi rỗng = xóa mô tả, giữ lại nút) */
  desc?: string;
}

/**
 * Chỉ thị đặt lại cấp cha: dịch chuyển node đã tồn tại (cùng toàn bộ cây con của nó) sang newPath.
 * Bao phủ ba tình huống (đều là cùng một thao tác): thêm cha cho cấp cao nhất, chèn nút trung gian vào giữa cha con đã có, đổi cấp cha.
 *  - node: đường dẫn đầy đủ **hiện tại** của nút đó (từ lớn đến nhỏ).
 *  - newPath: đường dẫn đầy đủ **mới** mà nó nên nằm ở đó (đoạn cuối thường cùng tên với đoạn cuối của node).
 *  - descs: các cấp mới tạo / cần bù mô tả trên newPath, khóa = tên địa danh cấp đó, giá trị = mô tả (có thể lược bỏ, không viết ra được thì không bịa).
 */
export interface SceneReparent {
  node: string[];
  newPath: string[];
  descs?: Record<string, string>;
}

/**
 * Nhật ký có thứ tự của các thao tác bối cảnh thủ công.
 *
 * Tóm tắt AI vẫn dùng giao thức chia nhóm scenes.add/update/reparent; còn chỉnh sửa UI về sau thì ghi vào ops,
 * tránh việc nhiều thao tác gộp vào cùng một lá bị thứ tự cố định add→update→reparent→remove làm xáo trộn.
 */
export type SceneOp =
  | { op: 'add'; path: string[]; desc?: string }
  | { op: 'update'; path: string[]; desc?: string }
  | { op: 'reparent'; node: string[]; newPath: string[]; descs?: Record<string, string> }
  | { op: 'remove'; path: string[] };

/** JSON hoàn chỉnh do tóm tắt AI trả về (giao thức giữ nguyên: AI chỉ sinh add/update/remove/resolve) */
export interface SummaryDelta {
  /** Chính văn tóm tắt tự sự của tầng lầu này */
  summary?: string;
  /** Kiểu ghi đè: thời gian hiện tại trong truyện (viết trực tiếp giá trị mới). Chỉ dùng khi chính văn không có thẻ thời gian, cần AI dự phòng */
  time?: string;
  /** Thời gian bắt đầu đoạn này (chỉ khi chính văn thiếu thẻ <bbs_start> mới để AI bù) */
  timeStart?: string;
  /** Thời gian kết thúc đoạn này (chỉ khi chính văn thiếu thẻ <bbs_end> mới để AI bù) */
  timeEnd?: string;
  /** Kiểu ghi đè: địa điểm hiện tại (viết trực tiếp giá trị mới) */
  location?: string;
  /** Kiểu ghi đè: đường dẫn đầy đủ của nút bối cảnh đã ghi nhận nơi đang ở hiện tại (từ lớn đến nhỏ); đưa đồng thời với location, làm định vị có thẩm quyền */
  locationPath?: string[];
  /** Cập nhật thẻ cục diện: lược bỏ = giữ nguyên; null = xóa trống rõ ràng; đối tượng = ghi đè cả thẻ */
  sceneFocus?: SceneFocus | null;
  /** Kiểu ghi đè: thay đổi hồ sơ khách quan hiện tại của nhân vật chính do người dùng điều khiển */
  protagonist?: ProtagonistDelta;
  /** Kiểu chỉ thị: thêm xóa sửa vật phẩm */
  items?: {
    add?: ItemDelta[];
    /** Gỡ bỏ theo tên */
    remove?: string[];
    /** Cập nhật số lượng / mô tả theo tên */
    update?: ItemDelta[];
  };
  /** Kiểu chỉ thị: thêm sửa bối cảnh / địa điểm (đường dẫn địa lý từng cấp) */
  scenes?: {
    /** Địa điểm mới đến / mới ghi nhận; path đưa đường dẫn địa lý đầy đủ, upsert từng cấp */
    add?: SceneDelta[];
    /** Cập nhật mô tả của địa điểm đã có */
    update?: SceneDelta[];
    /** Đặt lại cấp cha: thêm cha cho nút đã có / chèn nút trung gian / đổi cha (dịch chuyển cả cây con) */
    reparent?: SceneReparent[];
  };
  /** Kiểu chỉ thị: thêm xóa sửa NPC */
  npcs?: {
    /** NPC mới xuất hiện / mới ghi nhận */
    add?: NpcDelta[];
    /** Cập nhật NPC đã có theo tên (thân phận/mô tả/tính cách/đi cùng/nơi ở) */
    update?: NpcDelta[];
    /** Gỡ bỏ theo tên (rút lui vĩnh viễn / tử vong) */
    remove?: string[];
  };
  /** Kiểu chỉ thị: thêm xóa kế hoạch / nghi vấn */
  plans?: {
    /** createdTime/targetTime do AI xuất trực tiếp (chuỗi thời gian trong truyện); targetTime cho phép mơ hồ hoặc lược bỏ */
    add?: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
    /** Khép lại theo id ngắn hiển thị trong prompt (p1/p2…), mỗi mục kèm outcome/reason giải thích khép lại thế nào; chuỗi trần tương thích định dạng cũ */
    resolve?: PlanResolveItem[];
    /** Cùng một việc chưa khép lại dời lịch / tạm hoãn / đổi điều kiện (id ngắn p1/p2…); cùng một mã số mỗi tầng chỉ làm một lần update hoặc resolve */
    update?: PlanUpdateItem[];
  };
  /** Kiểu chỉ thị: thêm xóa sửa hồ sơ nhỏ đời sống (tùy chọn; chỉ ghi của nhân vật chính hoặc nhân vật chính yếu có quy thuộc rõ ràng, đã nói rõ / chính văn bộc lộ rõ) */
  lifeDetails?: {
    add?: LifeDetailAdd[];
    update?: LifeDetailUpdate[];
    /** Lắng đọng thành chỉ kích hoạt bằng từ khóa (số thứ tự ngắn d1/d2 hoặc id ổn định) */
    archive?: string[];
    /** Xóa (số thứ tự ngắn d1/d2 hoặc id ổn định) */
    remove?: string[];
  };
  /** Kiểu chỉ thị: thêm xóa sửa danh sách hiểu biết (tùy chọn; chỉ ghi chuyện của nhân vật chính mà nhân vật tận tai nghe thấy / tận mắt nhìn thấy / nghe người khác kể) */
  knowledge?: {
    add?: { who: string; text: string }[];
    /** Số thứ tự ngắn k1/k2 hoặc id ổn định */
    update?: { id: string; text: string }[];
    /** Số thứ tự ngắn k1/k2 hoặc id ổn định */
    remove?: string[];
  };
  /**
   * Kiểu chỉ thị: mảng lệnh đường dẫn của biến tùy chỉnh (mô phỏng MVU). AI xem trạng thái JSON hiện tại + hướng dẫn, sản sinh lệnh tương ứng với sự kiện mới ở tầng này:
   *  - { "op":"set", "path":"Độ hảo cảm", "value":60 }
   *  - { "op":"add", "path":"Độ hảo cảm", "delta":5 }
   *  - { "op":"assign", "path":"Thế lực", "key":"Hội đồng Phép thuật", "value":{ "Lập trường":"Trung lập", "Danh vọng":50 } }  // Tạo đối tượng mới
   *  - { "op":"remove", "path":"Thế lực", "key":"Hội Ám Ảnh" }
   */
  vars?: VarOp[];
}

/**
 * Lượng tăng thêm có cấu trúc được cố định vào lá. Hầu như giống hệt SummaryDelta, nhưng khác hai điểm:
 *  1. plans.resolve lưu **id plan ổn định** (chứ không phải số thứ tự ngắn lúc chạy p1/p2);
 *  2. Mở rộng thêm các op nội bộ chỉ dành cho "thao tác thủ công": plans.remove / plans.reopen, items / scenes tiếp tục dùng remove.
 * AI không bao giờ sinh ra các op nội bộ này; chúng chỉ được ghi vào khi chỉnh sửa thủ công trên UI.
 */
export interface StoredDelta {
  time?: string;
  location?: string;
  /** Kiểu ghi đè: đường dẫn đầy đủ của nút bối cảnh đã ghi nhận nơi đang ở hiện tại (từ lớn đến nhỏ); định vị có thẩm quyền */
  locationPath?: string[];
  /** Cập nhật thẻ cục diện: lược bỏ = giữ nguyên; null = xóa trống rõ ràng; đối tượng = ghi đè cả thẻ */
  sceneFocus?: SceneFocus | null;
  /** Kiểu ghi đè: thay đổi hồ sơ khách quan hiện tại của nhân vật chính do người dùng điều khiển */
  protagonist?: ProtagonistDelta;
  items?: {
    add?: ItemDelta[];
    update?: ItemDelta[];
    /** Gỡ bỏ theo tên vật phẩm (khớp chuẩn hóa) */
    remove?: string[];
  };
  scenes?: {
    add?: SceneDelta[];
    update?: SceneDelta[];
    /** Đặt lại cấp cha (dịch chuyển cả cây con); AI và thủ công dùng chung */
    reparent?: SceneReparent[];
    /** Nội bộ / thủ công: gỡ bỏ theo đường dẫn đầy đủ (xóa kèm cả hậu duệ của nó) */
    remove?: string[][];
    /** Nội bộ / thủ công: phát lại nghiêm ngặt theo thứ tự trước sau của thao tác người dùng; các trường chia nhóm cũ tiếp tục tương thích với cuộc trò chuyện lịch sử. */
    ops?: SceneOp[];
  };
  npcs?: {
    add?: NpcDelta[];
    update?: NpcDelta[];
    /** Gỡ bỏ theo tên NPC (khớp chuẩn hóa) */
    remove?: string[];
  };
  plans?: {
    add?: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
    /** Khép lại: id plan ổn định (kèm outcome/reason); chuỗi trần tương thích dữ liệu cũ */
    resolve?: PlanResolveItem[];
    /** Dời lịch / tạm hoãn: id plan ổn định + content/targetTime mới */
    update?: PlanUpdateItem[];
    /** Nội bộ / thủ công: xóa plan (id ổn định) */
    remove?: string[];
    /** Nội bộ / thủ công: mở lại plan đã khép lại (id ổn định) */
    reopen?: string[];
  };
  /** Biến tùy chỉnh: chuỗi lệnh đường dẫn của tầng này (gấp tuần tự vào trạng thái JSON). AI và thủ công dùng chung. */
  lifeDetails?: {
    add?: LifeDetailAdd[];
    /** update kèm tier: dùng cho thao tác ghim đầu / khôi phục thủ công (AI không xuất tier) */
    update?: (LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' })[];
    /** Lắng đọng thành chỉ kích hoạt bằng từ khóa (id ổn định) */
    archive?: string[];
    /** Xóa (id ổn định) */
    remove?: string[];
  };
  /** Danh sách hiểu biết: nhật ký thao tác áp dụng theo thứ tự (AI và thủ công dùng chung) */
  knowledge?: KnowledgeOp[];
  varOps?: VarOp[];
}
