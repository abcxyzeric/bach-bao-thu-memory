/**
 * Mẫu từ nhắc (Prompt templates).
 *
 * Điểm thiết kế cốt lõi (cải tiến so với bản gốc Horae):
 *  1. Xuất JSON thay vì văn bản thuần, thuận tiện cho việc trích xuất có cấu trúc và cập nhật tăng thêm (delta).
 *  2. Phân biệt rõ hai loại ngữ nghĩa:
 *     - Kiểu ghi đè (time/location): Viết giá trị mới nhất hiện tại, code thay thế trực tiếp.
 *     - Kiểu chỉ thị (items/plans): Chỉ đưa ra「thay đổi」, code áp dụng tăng thêm, tiết kiệm token và tránh làm sai lệch toàn bộ dữ liệu.
 *  3. Đưa「trạng thái hiện tại」(tên vật phẩm hiện có, kế hoạch/nghi vấn chưa kết thúc kèm đánh số) vào từ nhắc,
 *     để mô hình quyết định chính xác add/remove/update/resolve.
 *  4. Giữ lại ưu điểm của Horae: neo mốc thời gian, cụ thể hóa, giữ nguyên danh từ riêng, chính văn không chứa markdown.
 *
 * Các ký hiệu giữ chỗ (Macros): {{user}} {{char}} {{state_time}} {{state_location}}
 *         {{protagonist_block}} {{items_block}} {{plans_block}} {{content}}
 */

import { apiSettings, type Verbosity } from '@/api/settings';
import { fmtLifeDetail } from './lifeDetails';
import { fmtKnowledgeForSummary } from './knowledge';
import { fmtNpcSummaryList, type NpcSummaryView } from './npcRelations';
import { RULE_COMPLETE_TIME_ANCHOR } from './timeTag';
// Nội dung từ nhắc mới lấy theo tệp văn bản gốc (?raw nội tuyến, giữ nguyên vẹn bố cục và thẻ).
import summaryRaw from './prompts/summary.txt?raw';
import resummaryRaw from './prompts/resummary.txt?raw';
import resummary2Raw from './prompts/resummary2.txt?raw';
import tasksRaw from './prompts/tasks.txt?raw';
import builtinProtocolsRaw from './prompts/builtin-protocols.txt?raw';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';
import type { ItemLogEntry, JsonValue, MemKnowledge, MemLifeDetail, MemPlan, MemProtagonist, PlanOutcome, SceneFocus } from './types';

/** Phân tích tệp giao thức theo từng mục「===== NAME =====」(08). */
function protocolSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^=====\s*(.+?)\s*=====\s*$/gm;
  const marks: { name: string; headerStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) marks.push({ name: m[1].trim(), headerStart: m.index, contentStart: re.lastIndex });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].headerStart : raw.length;
    out[mark.name] = raw.slice(mark.contentStart, end).trim();
  });
  return out;
}
const PROTOCOLS = protocolSections(builtinProtocolsRaw);
/** Lấy mục bắt đầu bằng prefix (tên mục có thể kèm chú thích trong ngoặc). */
function protocolSection(prefix: string): string {
  const key = Object.keys(PROTOCOLS).find(k => k.startsWith(prefix));
  return key ? PROTOCOLS[key] : '';
}
/** Tách thành ba đoạn「Quy tắc / Tài liệu / Giao thức xuất」: tài liệu bắt đầu từ `【Nhân vật chính】{{user}}`, giao thức bắt đầu từ `【Giao thức xuất bản ghi kiểm tra và kết quả cuối cùng】`. */
function splitPrompt(raw: string): { rules: string; input: string; protocol: string } {
  const i = raw.indexOf('【Nhân vật chính】{{user}}');
  const j = raw.indexOf('【Giao thức xuất bản ghi kiểm tra và kết quả cuối cùng】', i >= 0 ? i : 0);
  return {
    rules: (i >= 0 ? raw.slice(0, i) : raw).trim(),
    input: (i >= 0 ? raw.slice(i, j >= 0 ? j : undefined) : '').trim(),
    protocol: (j >= 0 ? raw.slice(j) : '').trim(),
  };
}
/** Cắt đoạn quy tắc nằm giữa [start, end) trong mẫu tích hợp sẵn; nếu thiếu dấu mốc thì trả về chuỗi rỗng (bộ test sẽ bắt lỗi). */
function sliceSection(raw: string, start: string, end: string): string {
  const i = raw.indexOf(start);
  const j = i >= 0 ? raw.indexOf(end, i) : -1;
  return i >= 0 && j > i ? raw.slice(i, j).trim() : '';
}
/** Loại bỏ lõi NVWA, chỉ giữ lại phần hướng dẫn nhiệm vụ. */
function afterStandaloneCore(raw: string): string {
  const tag = '</nvwa_standalone_core>';
  const i = raw.indexOf(tag);
  return (i >= 0 ? raw.slice(i + tag.length) : raw).trim();
}
/** Loại bỏ lõi độc lập: lõi được đặt thống nhất ở vị trí「Vượt giới hạn」(JAILBREAK_PROMPT).
 *  Từ nhắc chính văn không mang lặp lại nữa, tránh việc lõi xuất hiện hai lần trong cùng một yêu cầu và tránh cảm giác「vượt giới hạn bị xé lẻ」. */
const SUMMARY_BODY = afterStandaloneCore(summaryRaw);
const RESUMMARY_BODY = afterStandaloneCore(resummaryRaw);
const RESUMMARY2_BODY = afterStandaloneCore(resummary2Raw);

const SUMMARY_SPLIT = splitPrompt(SUMMARY_BODY);
const RESUMMARY_SPLIT = splitPrompt(RESUMMARY_BODY);
const RESUMMARY2_SPLIT = splitPrompt(RESUMMARY2_BODY);

/** Giao thức đọc ghi chú bên lề (chèn vào cuộc trò chuyện chính, nhắc mô hình chính không viết lặp lại <bbs_items>/<bbs_vars>). */
export const LEDGER_PROTOCOL = protocolSection('LEDGER_PROTOCOL');

/** Một ký hiệu giữ chỗ khả dụng (macro): token dùng để chèn, desc cho người dùng biết「chỗ này sẽ được thay thế bằng gì」. */
export interface PromptMacro {
  token: string;
  desc: string;
}

/** Các macro khả dụng cho từ nhắc tóm tắt (dùng để hiển thị ở trang cài đặt + nhấp để chèn) */
export const SUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: 'Tên nhân vật chính' },
  { token: '{{char}}', desc: 'Tên nhân vật' },
  { token: '{{history_block}}', desc: 'Bản tóm tắt cốt truyện lịch sử trước lượt này' },
  { token: '{{state_time}}', desc: 'Thời gian đã biết hiện tại' },
  { token: '{{state_location}}', desc: 'Địa điểm đã biết hiện tại' },
  { token: '{{protagonist_block}}', desc: 'Hồ sơ khách quan hiện tại của nhân vật chính' },
  { token: '{{items_block}}', desc: 'Danh sách vật phẩm hiện có' },
  { token: '{{itemlog_block}}', desc: 'Biến động vật phẩm gần đây (sổ đã kết toán)' },
  { token: '{{scenes_block}}', desc: 'Danh sách địa điểm đã biết (tránh ghi trùng lặp)' },
  { token: '{{npcs_block}}', desc: 'Danh sách NPC đã xuất hiện (tránh ghi trùng lặp)' },
  { token: '{{plans_block}}', desc: 'Kế hoạch/nghi vấn chưa kết thúc' },
  { token: '{{resolved_plans_block}}', desc: 'Kế hoạch/nghi vấn vừa kết thúc gần đây (kèm cách thức/nguyên nhân kết thúc, chống ghi trùng lặp)' },
  { token: '{{scenefocus_block}}', desc: 'Trường cảnh tức thời/có mặt trong lượt này và hành động chưa hoàn thành (cập nhật khi cần)' },
  { token: '{{vars_state_block}}', desc: 'Trạng thái hiện tại + ý nghĩa + quy tắc biến đổi của biến số tùy chỉnh (trống khi chưa cấu hình)' },
  { token: '{{varlog_block}}', desc: 'Ý nghĩa biến số + quy tắc biến đổi (hợp nhất)' },
  { token: '{{content}}', desc: 'Chính văn cuộc đối thoại cần tóm tắt trong lượt này' },
  { token: '{{summary_words}}', desc: 'Khoảng số chữ mục tiêu của bản tóm tắt (thay đổi theo mức Chi tiết/Tinh gọn)' },
  { token: '{{summary_max_chars}}', desc: 'Giới hạn ký tự tối đa của bản tóm tắt (mức trần cứng, thay đổi theo mức cấu hình)' },
];

/** Các macro khả dụng cho từ nhắc tổng kết (nén) */
export const RESUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: 'Tên nhân vật chính' },
  { token: '{{char}}', desc: 'Tên nhân vật' },
  { token: '{{content}}', desc: 'Chính văn nhiều bản tóm tắt cần hợp nhất' },
  { token: '{{resummary_words}}', desc: 'Khoảng số chữ mục tiêu của bản tổng kết (thay đổi theo mức Chi tiết/Tinh gọn)' },
];

/** Các macro khả dụng cho từ nhắc tổng kết cấp 2 (khoảng số chữ động thay đổi theo mức Chi tiết/Tinh gọn) */
export const RESUMMARY2_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: 'Tên nhân vật chính' },
  { token: '{{char}}', desc: 'Tên nhân vật' },
  { token: '{{content}}', desc: 'Chính văn nhiều bản tổng kết tầng trên cần hợp nhất' },
  { token: '{{target_min}}', desc: 'Số chữ tối thiểu (Chi tiết là 40% đầu vào, Tinh gọn là 30%)' },
  { token: '{{target_max}}', desc: 'Số chữ tối đa (Chi tiết là 50% đầu vào, Tinh gọn là 40%)' },
  { token: '{{target}}', desc: 'Tương thích mẫu tùy chỉnh cũ: tương đương với số chữ tối đa {{target_max}}' },
];

/**
 * Lời đóng khung「Bản tin nội bộ」cho khối chèn ký ức: dán ở đầu mỗi khối ký ức được chèn vào cuộc trò chuyện chính.
 * Tại sao cần thiết: [Trạng thái hiện tại]/[Tóm tắt cốt truyện lịch sử]/[Ký ức liên quan] trông giống bảng dữ liệu, mô hình chính dễ hiểu nhầm là
 * mẫu cần nó điền/lặp lại, dẫn đến việc xuất kèm một bản chụp nhanh trạng thái ở cuối chính văn. Câu này nêu rõ「chỉ đọc, chỉ mình bạn thấy,
 * nghiêm cấm lặp lại」, đóng khung chúng thành bối cảnh hậu trường chứ không phải nội dung cần xuất ra. (Từ nhắc thẻ thời gian là chỉ thị thực sự yêu cầu mô hình xuất thẻ,
 * nên không bọc lớp đóng khung này.)
 */
export const MEMORY_BRIEFING_NOTE = protocolSection('MEMORY_BRIEFING_NOTE');

/**
 * Kết thúc bản tin: bọc đầu cuối cùng với NOTE để「niêm phong」rõ ràng khối ký ức, tránh việc mô hình chính coi phần chính văn tiếp theo cũng là một phần của bản tin mà viết nối vào.
 * Câu cuối đưa ra hướng dẫn tích cực —— không chỉ là lệnh cấm「đừng lặp lại」, mà là「hãy viết tiếp tự nhiên như một người kể chuyện đã đọc qua tiền truyện」, cho mô hình biết
 * công dụng của bản tin là「tôi đã biết những điều này」, chỉ cần thể hiện tự nhiên trong chính văn là được.
 */
export const MEMORY_BRIEFING_END = protocolSection('MEMORY_BRIEFING_END');

/* ============ Các đoạn quy tắc dùng chung: mẫu tích hợp sẵn chèn qua macro, mẫu tùy chỉnh khi thiếu sẽ dùng làm phần bổ sung tương thích; các đoạn có sẵn trong nguyên văn summary.txt được cắt trực tiếp từ một nguồn duy nhất để tránh phân nhánh ============ */

/** Quy tắc hồ sơ hiện tại khách quan của nhân vật chính do người dùng điều khiển. Cắt từ summary.txt. */
export const RULE_PROTAGONIST = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Quy tắc hồ sơ hiện tại của nhân vật chính】', '═══ 【Quy tắc vật phẩm】');

/**
 * Chỉ mở ước lượng cho các trường hảo cảm của NPC, không nới lỏng ranh giới bằng chứng của bản tóm tắt sự thật/quan hệ/hồ sơ nhân vật chính.
 * Cắt từ summary.txt: dòng bậc hảo cảm được viết cố định trong tệp, phải khớp với NPC_AFFINITY_FIELDS (được kiểm tra bởi bộ test npcAffinity).
 */
export const RULE_NPC_AFFINITY = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Quy tắc hảo cảm nội tâm và thái độ bên ngoài】', '═══ 【Quy tắc kế hoạch/nghi vấn】');

/** Quy tắc thẻ cục diện tương tác (trường sceneFocus). Cắt đến dòng macro: các quy tắc hồ sơ đời sống... phía sau đó được bổ sung riêng bởi giao thức tương thích tương ứng. */
export const RULE_SCENE_FOCUS = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Quy tắc thẻ cục diện tương tác】', '{{lifedetails_rule}}');

/** Quy tắc hồ sơ đời sống (trường lifeDetails). */
export const RULE_LIFE_DETAILS = `═══ 【Quy tắc hồ sơ đời sống】(trường lifeDetails, sàng lọc cực kỳ nghiêm ngặt) ═══
Ghi lại sở thích / thói quen / trạng thái cá nhân gần đây của **nhân vật chính và nhân vật chính yếu**, giúp AI viết truyện lồng ghép tự nhiên khi có liên quan; không mở rộng sang người qua đường hoặc vai phụ xuất hiện một lần.
【Nhân vật sở hữu bắt buộc phải điền】Mỗi mục \`add\` bắt buộc phải kèm theo \`subject\`: nhân vật chính viết cố định giá trị chuỗi \`"user"\` (không phải họ tên nhân vật chính), nhân vật chính yếu viết đúng tên chính xác trong danh sách NPC (bao gồm cả nhân vật chính yếu mới được thêm/đánh dấu \`important\` ở tầng này theo quy tắc NPC). Một mục chỉ thuộc về một người, nhiều người có cùng thói quen thì ghi riêng từng người. \`text\` viết chi tiết cụ thể của nhân vật đó, khi hiển thị hệ thống sẽ tự ghép thêm họ tên; hãy phân giải "tôi/anh ấy/cô ấy" thành nhân vật sở hữu rõ ràng, không trộn lẫn người nói, người được nhắc tới hoặc user thành một người. Chủ ngữ không rõ thà không ghi.
【Quy tắc thép: Chỉ công nhận sự thật do chính bản thân nhân vật nói rõ, hoặc được chính văn tiết lộ rõ ràng】Nghiêm cấm suy diễn sở thích và nội tâm từ hành vi/giọng điệu; ăn bánh kếp một lần không đồng nghĩa với thích ăn bánh kếp. Lời trích dẫn, lời kể lại, lời nói đùa, mỉa mai hoặc suy đoán không được trực tiếp coi là thói quen thực sự của nhân vật đó; không có căn cứ văn bản rõ ràng đáng tin cậy thì không ghi. Ước lượng hảo cảm và thái độ không viết ở đây.
【Mặc định không ghi】Trước hết hãy đối chiếu với【Hồ sơ đời sống】trong tài liệu để kiểm tra trùng lặp theo "cùng một nhân vật + nội dung đồng nghĩa", mục đã có thì không \`add\` trùng lặp; các nhân vật khác nhau dù câu chữ giống hệt nhau cũng không gộp làm một. Mục cũ thiếu \`subject\` chỉ được coi là của nhân vật chính theo giao thức cũ, đừng tự ý sửa sang cho một NPC nào đó.
【add】\`topics\` điền 1-3 nhãn chủ đề (Ăn uống/Sinh hoạt/Công việc…), \`anchors\` điền từ khóa có thể truy xuất trong nguyên văn (rau mùi/dự án…), để hệ thống đưa vào ngữ cảnh theo độ liên quan; \`until\` điền thời gian hết hạn trong truyện để biểu thị có thời hạn (như ngày kết thúc dự án), sở thích ổn định lâu dài thì để trống \`until\`.
【update/archive/remove】Dùng mã số d1, d2… để chỉ định danh sách này, trước hết phải đối chiếu nhân vật sở hữu:
  ✦ Mục bị chính văn bác bỏ/đính chính rõ ràng → \`update\` sửa \`text\`; chỉ khi ghi nhầm người sở hữu một cách rõ ràng mới sửa \`subject\`, lược bỏ \`subject\` = giữ nguyên nhân vật gốc;
  ✦ Đã hết thời hạn/không còn liên quan → \`archive\` (lắng xuống thành chỉ kích hoạt khi khớp từ khóa, không phải xóa);
  ✦ Ghi nhầm → \`remove\`. Không chắc chắn thì giữ nguyên, không được lấy sở thích của người khác để ghi đè lên mục của bản thân nhân vật đó.
【Phân công】Chi tiết đời sống như ăn uống, giờ giấc sinh hoạt thuộc về nơi này; thân phận/ngoại hình/trang phục hiện tại/trạng thái sức khỏe vẫn thuộc về \`protagonist\` hoặc \`npcs\`, đừng ghi trùng lặp. Nơi này chỉ đặt những chi tiết đáng giữ lại xuyên trường cảnh, không phải sổ ghi chép vặt mỗi lượt.
【Tiết chế】Những chi tiết này chỉ dùng làm tham khảo viết truyện cho nhân vật liên quan, không phải nhiệm vụ bắt buộc phải viết; nghiêm cấm liệt kê từng mục trong \`summary\`, không được đem thói quen của người này áp cho người khác.`;

/** Quy tắc danh sách hiểu biết (trường knowledge). Không dùng {{user}}: quy tắc được chèn dưới dạng giá trị macro, sẽ không được triển khai thêm lần nữa. */
export const RULE_KNOWLEDGE = `═══ 【Quy tắc danh sách hiểu biết】(trường knowledge) ═══
Ghi lại **những việc về nhân vật chính mà mỗi NPC hiện đang biết/tưởng là vậy**. AI viết truyện sẽ coi đây là「phạm vi hiểu biết」của nhân vật: những chuyện riêng tư của nhân vật chính không có trong danh sách thì mặc định nhân vật đó không biết, qua đó ngăn nhân vật dựa vào thiết lập nhân vật hay sổ thế giới mà biết tuốt mọi chuyện về nhân vật chính. Chỉ ghi nhận thức của nhân vật đối với nhân vật chính, không ghi giữa các nhân vật với nhau; hảo cảm và thái độ vẫn thuộc về \`npcs\`.
【Quy tắc thép về nguồn tin】Chỉ ghi những điều mà nhân vật đó trong lượt này **tận tai nghe thấy, tận mắt nhìn thấy, hoặc nghe người khác kể lại**: điều nhân vật chính nói trực diện, làm ngay trước mặt họ, hoặc do người thứ ba thuật lại. Độc thoại nội tâm của nhân vật chính, lời dẫn chuyện bên ngoài, sự việc xảy ra khi nhân vật đó vắng mặt nhất loạt không tính —— nhân vật đó hoàn toàn không biết.
【Ghi điều nhân vật tưởng là vậy, không phải chân tướng】Mức độ nắm bắt được viết ngay ở đầu câu: Khẳng định…/Nghi ngờ…/Nghe nói…/Nhân vật chính tự xưng…. Nhân vật bị lừa thì cứ ghi đúng nhận thức sau khi bị lừa (nhân vật chính nói dối là thương buôn → "Khẳng định nhân vật chính là thương buôn"), không chú thích chân tướng; sau này bị vạch trần thì dùng \`update\` viết lại mục gốc (như "Biết được nhân vật chính thực chất là hoàng tử, trước đây luôn bị giấu"), đừng thêm mới một mục mâu thuẫn.
【Ghi những gì】Tên của nhân vật chính (ghi khi nhân vật lần đầu biết được), thân thế, trải nghiệm quá khứ, bí mật, sở thích và thói quen riêng tư, thân phận mà nhân vật chính tự xưng hoặc cố tình che giấu. Ngoại hình, hành động nhìn thấy ngay tại chỗ, thân phận công khai ai cũng thấy được thì không cần ghi; chuyện vặt vãnh một lần không ghi.
【Kiểm tra trùng lặp】Trước hết đối chiếu với danh sách「Hiểu biết của nhân vật về nhân vật chính」trong tài liệu, kiểm tra trùng lặp theo "cùng một nhân vật + nội dung đồng nghĩa"; đã có rồi thì không \`add\` lặp lại, nhận thức sâu hơn hoặc thay đổi thì dùng \`update\` sửa mục gốc.
【add】\`who\` viết đúng tên chính xác trong danh sách NPC (bao gồm cả nhân vật mới xuất hiện qua \`npcs.add\` ở tầng này), không được là nhân vật chính; nhân vật không có trong danh sách thì không ghi. \`text\` mỗi câu chỉ viết một việc.
【update/remove】Dùng mã số k1, k2… của danh sách đó để chỉ định: nhận thức được đính chính/sâu sắc hơn → \`update\` sửa \`text\`; ghi nhầm (nhân vật đó thực chất không biết / ghi nhầm sang đầu người khác) → \`remove\`. Không chắc chắn thì giữ nguyên.`;

/**
 * Quy tắc biến số tùy chỉnh (trường vars, lệnh đường dẫn). Chỉ chèn khi người dùng đã cấu hình biến số (có trạng thái hiện tại hoặc mô tả) (xem {{vars_rule}}).
 * Biến số là một cây trạng thái JSON, AI dùng set/assign/remove/add tự do thêm/sửa/xóa theo đường dẫn, có thể tạo mới đối tượng/trường theo quy ước trong【Mô tả】.
 */
export const RULE_VARS = `═══ 【Quy tắc biến số tùy chỉnh】(trường vars, lệnh đường dẫn) ═══
Phần【Biến số tùy chỉnh · Trạng thái hiện tại】trong tài liệu là một cây trạng thái JSON (đã kết toán tính đến thời điểm này);【Ý nghĩa biến số】cho bạn biết mỗi trường là gì;【Quy tắc biến đổi biến số】cho bạn biết khi nào thay đổi ra sao và có được tạo mới hay không.
Khi trong chính văn lượt này xảy ra sự kiện rõ ràng, cụ thể làm cho trạng thái cần thay đổi, hãy xuất một **mảng lệnh** trong trường \`vars\` để sửa đổi nó. Mỗi lệnh là một đối tượng:
  · Gán giá trị/Ghi đè: \`{ "op":"set", "path":"đường_dẫn", "value":giá_trị_mới }\`
  · Tăng giảm con số: \`{ "op":"add", "path":"đường_dẫn", "delta":lượng_tăng_giảm }\` (\`delta\` có thể âm, như -10)
  · Thêm vào đối tượng/mảng (bao gồm **tạo mới đối tượng**): \`{ "op":"assign", "path":"đường_dẫn_cha", "key":"khóa_mới", "value":giá_trị }\`; thêm vào cuối mảng thì lược bỏ \`key\`
  · Xóa: \`{ "op":"remove", "path":"đường_dẫn", "key":"khóa/chỉ_số/giá_trị_cần_xóa" }\`; xóa toàn bộ nút thì lược bỏ \`key\`, \`path\` trỏ thẳng vào nút đó
【Đường dẫn】Dùng dấu chấm và dấu ngoặc vuông để định địa chỉ: \`"Thế lực.Hội đồng Phép thuật.Danh vọng"\`, \`"Đội hình[0].hp"\`. Các tầng trung gian còn thiếu trên đường dẫn cha sẽ được tự động tạo ra.
【Tự do tạo mới (Trọng tâm)】Cho phép bạn dựa theo cốt truyện để **tạo mới** trường/đối tượng chưa có trong cây trạng thái —— ví dụ khi gặp một thế lực mới, dùng \`assign\` thêm một đối tượng dưới「Thế lực」(khóa = tên thế lực, giá trị = đối tượng chứa các thuộc tính), tuân thủ quy ước trong【Quy tắc biến đổi biến số】.
【Chỉ sửa những gì thực sự thay đổi · Chống kết toán lặp lại】Trạng thái hiện tại đã là giá trị được kết toán tính đến thời điểm này. Chỉ phát lệnh đối với sự kiện **mới xảy ra** trong chính văn; không thay đổi thì đừng phát lệnh; khoản đã tính ở đoạn trước rồi (như đã +5) mà đoạn này không có sự kiện mới thì đừng động vào nữa.
【Tiết chế】Chưa chắc chắn, suy đoán thuần túy, chính văn không nhắc tới → không phát lệnh. Thà phát ít nhưng lệnh phải chuẩn xác. Khi không có bất kỳ thay đổi nào, hãy lược bỏ luôn \`vars\` hoặc đưa ra mảng rỗng.`;

/**
 * Quy tắc thép về ngôn ngữ thời gian trong chính văn tóm tắt. Dùng chung cho mọi tầng tóm tắt; khi mẫu tùy chỉnh không kèm đoạn này thì tự động bổ sung lúc khởi tạo,
 * nếu đã kèm theo rồi thì lấy mẫu làm chuẩn —— mẫu cũ thường có sẵn bản cũ, nếu bổ sung thêm bản mới sẽ khiến hai quy chuẩn cùng tồn tại.
 * Thời gian tương đối có thể đúng ngay tại thời điểm tạo, nhưng sau khi lưu vào ký ức dài hạn sẽ bị sai lệch khi mốc「hiện tại」dịch chuyển, vì vậy phải tuyệt đối hóa trước khi lưu vào kho.
 * Cắt trực tiếp từ summary.txt: nếu bản tích hợp sẵn và bản bổ sung tùy chỉnh mỗi nơi viết một kiểu thì sớm muộn cũng mâu thuẫn.
 */
export const RULE_ABSOLUTE_TIME_LANGUAGE = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】', '【Đối chiếu trạng thái】');

/** Tách biệt bản ghi kiểm tra và dữ liệu cuối cùng; mọi cấp tóm tắt và mẫu tùy chỉnh đều dùng chung một quy ước xuất. */
export const SUMMARY_OUTPUT_PROTOCOL = SUMMARY_SPLIT.protocol;

/**
 * Giữ lại mạch quan hệ: dùng chung cho tóm tắt L0 và hai cấp nén.
 *
 * Quan hệ phát triển chậm thường được tạo nên từ một chuỗi tương tác nhỏ tương tự nhau và quan sát được, trong khi quy tắc nén vốn coi "sự lặp lại cùng loại" là nhiễu ——
 * nếu không tuyên bố riêng, mạch này sẽ bị gộp xóa mất ở L1/L2, khiến cả mô hình chính lẫn trường trạng thái đều không nắm được xu hướng "gần đây đang tiến triển theo hướng nào".
 * Quy tắc này chỉ yêu cầu giữ lại sự thật quan sát được, không nới lỏng ngưỡng suy diễn kết luận tâm lý/quan hệ (ranh giới bằng chứng vẫn nằm trong quy tắc của từng nhiệm vụ).
 * Cũng cắt từ summary.txt, phần bổ sung cho mẫu tùy chỉnh và bản tích hợp sẵn là cùng một bản.
 */
export const RULE_RELATION_MOMENTUM = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Giữ lại mạch quan hệ】', '【Trình tự viết tóm tắt】');

/**
 * Đoạn quy tắc viết tóm tắt (Quy tắc viết → Mạch quan hệ → Trình tự viết → Bảo toàn khi nén → Ví dụ diễn đạt → Quy tắc thép về thời gian), cắt từ summary.txt để dùng lại cho tóm tắt hàng loạt,
 * tránh việc tóm tắt hàng loạt phải duy trì riêng một bộ quy tắc viết cũ. Do đó đoạn này không phụ thuộc vào trường đơn lẻ: việc đối chiếu trường dành riêng cho đơn tầng được đặt ở mục【Đối chiếu trạng thái】ngay phía sau.
 */
const SUMMARY_WRITING_RULES = sliceSection(SUMMARY_SPLIT.rules, '═══ 【Quy tắc viết tóm tắt】', '【Đối chiếu trạng thái】');

const SUMMARY_INPUT = SUMMARY_SPLIT.input;

const SUMMARY_RULES = SUMMARY_SPLIT.rules;

/** Trang cài đặt vẫn cung cấp mẫu hoàn chỉnh có thể chỉnh sửa; khi gửi đi thì quy phạm tích hợp sẵn và tài liệu được triển khai riêng, không phân tích tiêu đề bên trong chính văn. */
export const SUMMARY_PROMPT = SUMMARY_BODY;

/**
 * Từ nhắc tóm tắt hàng loạt: một yêu cầu bao phủ K tầng AI liên tiếp, xuất mảng floors (mỗi phần tử tương ứng với một tầng).
 * Dùng cho「Tóm tắt bù hàng loạt」—— phân bổ ngữ cảnh cố định (vượt giới hạn/thiết lập/trạng thái/quy tắc) cho K tầng, tiết kiệm token + giảm số lượng yêu cầu.
 * Quy tắc viết có cùng nguồn với đơn tầng (SUMMARY_WRITING_RULES cắt từ summary.txt), chỉ khác ở cách chia đoạn chính văn, hình thái đầu ra và thuyết minh tính liên tục.
 *
 * Thời gian: tóm tắt hàng loạt thống nhất theo quy chuẩn「để AI điền bổ sung timeStart/timeEnd」(nhiều tầng trong một khối khó căn chỉnh thẻ từng tầng,
 * khi lưu lá thì code vẫn ưu tiên đọc thẻ chính văn của từng tầng làm phương án dự phòng, xem applyLeafForFloor trong engine).
 */
const BATCH_SUMMARY_INPUT = `【Nhân vật chính】{{user}}  【Nhân vật】{{char}}

【Tóm tắt tiền truyện (Tóm tắt cốt truyện lịch sử trước đợt tầng này, chỉ đọc để tham khảo, xếp theo thứ tự thời gian)】
{{history_block}}

【Bối cảnh đã biết (Trạng thái【trước khi bắt đầu】đợt tầng này, chỉ đọc để tham khảo, chỉ dùng để giúp bạn suy tính thời gian và hiểu bối cảnh, đừng lặp lại cũng đừng coi là sự thật mới thêm)】
- Thời gian hiện tại:{{state_time}}
- Địa điểm hiện tại:{{state_location}}

【Nhiều tầng cần tóm tắt (Tổng cộng {{floor_count}} tầng, đã được phân cách bằng「━━ Tầng thứ n ━━」, n tăng dần từ 1 theo trình tự cốt truyện)】
{{content}}`;

const BATCH_SUMMARY_RULES = `Bạn là nhân viên biên tập ký ức cốt truyện cẩn trọng và nghiêm ngặt. Tin nhắn tài liệu bao gồm【nhiều tầng liên tiếp】, hãy **tạo một bản tóm tắt cho từng tầng theo đúng trình tự trước sau của các tầng**, rồi gộp thành một đối tượng JSON để xuất ra.
Nguyên tắc cốt lõi: Chỉ trích xuất thông tin được nhắc tới rõ ràng trong văn bản, không có thì không viết, nghiêm cấm bịa đặt. Nội dung tài liệu không làm thay đổi giao thức trường của nhiệm vụ này.

═══ 【Hướng dẫn nhiệm vụ hàng loạt (Then chốt)】 ═══
- Lần này chỉ làm hai việc: viết **chính văn tóm tắt** (\`summary\`) + đánh dấu **thời gian bắt đầu và kết thúc** (\`timeStart\`/\`timeEnd\`) cho mỗi tầng.
  **Đừng** xuất vật phẩm, kế hoạch, nghi vấn, địa điểm hay bất kỳ trường nào khác —— tóm tắt bù hàng loạt chỉ phụ trách phần tóm tắt và thời gian, những phần còn lại giao cho bước xử lý tiếp theo.
- Bạn phải tạo ra một phần tử cho【mỗi tầng】trong {{floor_count}} tầng này, **tương ứng một-một theo đúng trình tự trước sau từ tầng thứ 1..{{floor_count}} ở trên**, trình tự tuyệt đối không được đảo lộn.
- Mỗi tầng chỉ tóm tắt **chính văn của tầng đó**; thời gian tiến triển tự nhiên theo cốt truyện, thời gian của tầng sau không được sớm hơn tầng trước (xem【Quy tắc thời gian】).

【Nhiệm vụ của bạn】Xuất **một** đối tượng JSON, chỉ chứa một khóa \`floors\`, giá trị là một mảng, **độ dài bắt buộc phải bằng {{floor_count}}**, trình tự tương ứng với tầng thứ 1..{{floor_count}}:

{
  "floors": [
    {
      "n": 1,
      "summary": "Bản tóm tắt cốt truyện tầng thứ 1, xem【Quy tắc viết tóm tắt】bên dưới.",
      "timeStart": "Thời gian trong truyện khi bắt đầu tầng này (xem【Quy tắc thời gian】bên dưới)",
      "timeEnd": "Thời gian trong truyện khi kết thúc tầng này (xem【Quy tắc thời gian】bên dưới)"
    }
    // … Tầng thứ 2, tầng thứ 3 …, cho đến tầng thứ {{floor_count}}, mỗi phần tử có cấu trúc như trên, n lần lượt là 2, 3, …
  ]
}
Mỗi phần tử chỉ chứa bốn trường \`n\`, \`summary\`, \`timeStart\`, \`timeEnd\`, đừng thêm các trường khác.

═══ 【Quy tắc thời gian】(Trường timeStart / timeEnd của mỗi tầng) ═══
Hãy đưa ra thời gian bắt đầu (\`timeStart\`) và thời gian kết thúc (\`timeEnd\`) cho mỗi tầng để làm mốc neo thời gian cốt truyện.
- Thời gian phải cụ thể, có thể định vị được, phong cách nhất quán với thế giới quan trong chính văn: đề tài hiện đại dùng ngày giờ dạng số (như 1988/9/29 21:30); cổ phong/kỳ ảo dùng niên hiệu và canh giờ tương ứng (như Khánh Lịch năm thứ tư cuối xuân · giờ Thìn ba khắc). Trọng tâm là「có thể định vị đến một thời khắc cụ thể」.
- Tuyệt đối nghiêm cấm các cách nói mơ hồ không thể định vị đến thời khắc cụ thể như "Chưa rõ", "Năm nào đó ngày nào đó", "Ngày nọ", "Muộn hơn một chút", "Không lâu sau", "Cùng ngày".
- Cách điền: ① Chính văn tầng đó viết rõ thời gian → dùng trực tiếp; ② Không viết rõ → lấy "Thời gian hiện tại" trong tài liệu và sự tiến triển của các tầng phía trước làm mốc chuẩn, kết hợp với sự trôi qua của cốt truyện ở tầng này (trò chuyện khoảng vài phút, dùng bữa khoảng một tiếng, qua đêm bước sang ngày hôm sau...) để suy tính ra thời gian cụ thể; ③ Hoàn toàn không có căn cứ → tự thiết lập một điểm khởi đầu hợp lý phù hợp với thế giới quan.
- **Cho phép và yêu cầu suy đoán hợp lý**: Dựa vào ngữ cảnh để suy tính ra một thời gian cụ thể thuộc về thiết lập hợp lý dựa trên cốt truyện, **không tính là bịa đặt**; thà đưa ra một thời gian chưa hoàn hảo nhưng cụ thể, chứ tuyệt đối không được để trống hoặc viết từ mơ hồ. Điều này là cần thiết để thiết lập mốc neo thời gian.
- **Thời gian bắt buộc phải tăng đơn điệu**: Thời gian của tầng thứ n không được sớm hơn tầng thứ n-1; nếu thời gian của một tầng nào đó không tiến thêm thì \`timeStart\` và \`timeEnd\` viết cùng một giá trị là được.
- Hai trường mốc neo này không chịu sự hạn chế "lời trần thuật không tự bù năm, phút" của【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】; còn trong \`summary\` vẫn chỉ viết thời gian có căn cứ.

${RULE_COMPLETE_TIME_ANCHOR}

${SUMMARY_WRITING_RULES}

【Quy tắc thép khi xuất】
- Trong JSON cuối cùng sau bản ghi kiểm tra, khóa gốc chỉ có \`floors\`; độ dài của \`floors\` nghiêm ngặt bằng {{floor_count}}, \`n\` liên tục từ 1 đến {{floor_count}}, không được thiếu tầng, không được thừa tầng, không được loạn thứ tự.
- Mỗi phần tử chỉ chứa \`n\` / \`summary\` / \`timeStart\` / \`timeEnd\`, đừng xuất các trường \`items\` / \`plans\` / \`location\`...`;

export const BATCH_SUMMARY_PROMPT = `${BATCH_SUMMARY_RULES}\n\n${BATCH_SUMMARY_INPUT}\n\n${SUMMARY_OUTPUT_PROTOCOL}`;

/**
 * Danh sách suy nghĩ cho tóm tắt hàng loạt (đặt sau user). Giữ lại việc căn chỉnh từng tầng và kiểm tra thời gian,
 * các điểm chính về chọn lọc/phúc tra có cùng quy chuẩn với danh sách đơn tầng, không đưa vào việc kiểm điểm cập nhật trạng thái vật phẩm/NPC của đơn tầng.
 */
export const BATCH_THINKING_CHECKLIST = `【Suy nghĩ trước khi xuất (Kiểm tra từng tầng)】
${SUMMARY_OUTPUT_PROTOCOL}
Trong cùng một khối kiểm tra, hãy hoàn thành các kiểm tra dưới đây theo trình tự tầng, sau khi hoàn tất toàn bộ thì đóng khối kiểm tra rồi mới xuất JSON:
1. Định vị từng tầng: Đợt này có tổng cộng {{floor_count}} tầng, tôi sẽ **tạo ra một phần tử mảng cho mỗi tầng theo đúng trình tự trước sau**, \`n\` lần lượt từ 1..{{floor_count}}, không bỏ sót, không trùng lặp, không loạn thứ tự.
2. Thời gian đơn điệu và đầy đủ: Mỗi tầng đều gắn thời gian bắt đầu và kết thúc, tầng sau không sớm hơn tầng trước; không có căn cứ thì suy tính hợp lý theo sự trôi qua của cốt truyện. Cả hai đầu mút của ngày tháng hiện đại/dạng số đều bắt buộc phải bao gồm đầy đủ năm, không được viết tắt thành tháng ngày hoặc chỉ ghi giờ giấc riêng lẻ.
3. Điểm dừng bút: \`summary\` của mỗi tầng dừng lại ở hành động rõ ràng cuối cùng trong chính văn của tầng đó, không viết tiếp, không lấn sang tầng tiếp theo.
4. Chỉ tạo tóm tắt + thời gian: Mỗi phần tử chỉ chứa \`n\` / \`summary\` / \`timeStart\` / \`timeEnd\`, không xuất các trường vật phẩm, kế hoạch, địa điểm...

Mỗi tầng ghi ngắn gọn các chọn lọc hoặc chỉnh sửa then chốt dưới dạng「Tầng thứ n」, lần lượt đối chiếu các điểm chính dưới đây, không chép lặp lại chính văn. Tầng phía trước chỉ dùng làm tham khảo lịch sử, không được mượn tầng phía sau để điền bù kết luận cho tầng hiện tại. Ký hiệu \`[M_số_tin_nhắn-P_số_đoạn]\` của chính văn chỉ dùng để định vị, không bằng với \`n\` của kết quả.
【Chọn lọc tóm tắt】
- Mỗi tầng chỉ tóm tắt chính văn của tầng đó; tiền truyện và bối cảnh chỉ dùng để đối chiếu, không coi là sự kiện mới của tầng đó. Ưu tiên giữ lại quyết định làm thay đổi hướng hành động, kết quả then chốt, hạn chế vẫn còn hiệu lực và tương tác quan hệ, sau đó mới bổ sung tiền nhân cần thiết và thông tin tình báo hữu dụng; tương tác cốt lõi cùng lời thoại then chốt, cảm xúc được viết rõ, tình báo mới cùng kết quả, phục bút được giữ lại theo【Quy tắc viết tóm tắt】, những gì nguyên văn không có thì không tự ghép thêm.
- Giữ lại chủ thể, nguồn, điều kiện, đối tượng, hậu quả và phạm vi thời gian theo mệnh đề hoàn chỉnh, không làm mất con số then chốt và mốc chuẩn so sánh; phân biệt rõ đề xuất, đã quyết định, đã khởi động và đã hoàn thành. Không để trạng thái cũ mạo danh hiện trạng, có xung đột thì giữ nguyên sự khác biệt.
【Phúc tra bản tóm tắt】
- Đối chiếu từ ngữ về nguồn: Đối chiếu nguyên văn tầng đó để kiểm tra điều kiện và hậu quả có còn tương ứng từng mục không, chủ thể, nguồn, phủ định, mức độ, khung thời gian và phương vị có giữ nguyên giới hạn ban đầu không; sự thật song song không bị tự ghép thành liên hệ nhân quả, thời gian của đoạn không bị đổi thành mốc thời gian cũ.
- Sự việc giải quyết xong phải viết rõ kết quả thực tế, không viết ý định thành đã hoàn thành, không viết tương tác thành kết luận quan hệ; sau đó xóa các bước kiểm tra cất giữ không có kết quả và quá trình lặp lại, không xóa tham số quan trọng, thương tích có hiệu lực và tương tác quan hệ.

Sau khi kiểm tra xong toàn bộ các tầng thì đóng \`</thinking>\`, rồi xuất đối tượng JSON (khóa gốc \`floors\`), không có hàng rào markdown, không giải thích thêm.`;

/**
 * Quy tắc thời gian có hai hình thái, được quyết định bởi việc「chính văn đang phân tích có mang thẻ thời gian <bbs_start>/<bbs_end> hay không」:
 *  - Có thẻ: Thời gian được tiện ích đọc trực tiếp từ thẻ (mốc neo có thẩm quyền), AI không cần tính lại → lược bỏ trường time.
 *  - Không có thẻ (thường là đoạn mở đầu / cuộc trò chuyện cũ): Để AI điền bổ sung cả hai đầu timeStart/timeEnd làm mốc neo dự phòng.
 * buildSummaryPrompt dựa vào đây để điền {{time_field}} (mô tả trường trong mẫu JSON) và {{time_rule}} (đoạn quy tắc).
 */
export const TIME_FIELD_WITH_TAGS = `  // Thời gian đã được cung cấp bởi thẻ trong chính văn, không cần xuất trường time`;
export const TIME_RULE_WITH_TAGS = `═══ 【Quy tắc thời gian】 ═══
Chính văn lượt này đã mang thẻ thời gian, thời gian trong truyện được hệ thống tự động đọc, bạn **không cần xuất trường time / timeStart / timeEnd**. Khi kiểm tra thời hạn hãy dùng trực tiếp thời gian kết thúc của tầng này, không được suy tính lại mốc neo thời gian đã có.`;

export const TIME_FIELD_NO_TAGS = `  "timeStart": "Thời gian trong truyện khi bắt đầu đoạn này, xem【Quy tắc thời gian】bên dưới.",
  "timeEnd": "Thời gian trong truyện khi kết thúc đoạn này, xem【Quy tắc thời gian】bên dưới.",`;
export const TIME_RULE_NO_TAGS = `═══ 【Quy tắc thời gian】(trường timeStart / timeEnd) ═══
Chính văn lượt này không có thẻ thời gian, hãy đưa ra hai giá trị thời gian bắt đầu (\`timeStart\`) và thời gian kết thúc (\`timeEnd\`) của đoạn này để làm mốc neo thời gian cho cốt truyện.
- Thời gian phải cụ thể, định vị được rõ ràng, phong cách nhất quán với thế giới quan trong chính văn: đề tài hiện đại dùng ngày giờ dạng số (như 1988/9/29 21:30); đề tài cổ phong/kỳ ảo dùng niên hiệu và canh giờ tương ứng (như Khánh Lịch năm thứ tư cuối xuân · giờ Thìn ba khắc). Trọng tâm là「có thể định vị đến một thời khắc cụ thể」, không ép buộc phải dùng chữ số Ả Rập.
- Tuyệt đối nghiêm cấm các cách nói mơ hồ không thể định vị đến thời khắc cụ thể như "Chưa rõ", "Ngày nọ", "Muộn hơn một chút", "Không lâu sau", "Cùng ngày".
- Thứ tự ưu tiên khi điền: ① Chính văn viết rõ thời gian → dùng trực tiếp; ② Chính văn không viết rõ → lấy "Thời gian hiện tại" trong tài liệu làm mốc chuẩn, kết hợp với sự trôi qua của cốt truyện trong lượt này (trò chuyện khoảng vài phút, dùng bữa khoảng một tiếng, qua đêm bước sang ngày hôm sau...) để suy tính; ③ Ngay cả trạng thái tham khảo cũng không có thời gian → tự thiết lập một điểm khởi đầu hợp lý phù hợp với thế giới quan.
- Điều này là cần thiết để thiết lập mốc neo thời gian cho cốt truyện, thuộc về thiết lập hợp lý dựa trên ngữ cảnh, không tính là bịa đặt; thà đưa ra một thời gian chưa hoàn hảo nhưng cụ thể, chứ tuyệt đối không được để trống hoặc viết từ mơ hồ.
- Nếu thời gian của đoạn này không tiến thêm (bắt đầu và kết thúc giống nhau), \`timeStart\` và \`timeEnd\` chỉ cần viết cùng một giá trị.
- Hai trường mốc neo này không chịu sự hạn chế "lời trần thuật không tự bù năm, phút" của【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】; còn trong \`summary\` vẫn chỉ viết thời gian có căn cứ.

${RULE_COMPLETE_TIME_ANCHOR}`;

const RESUMMARY_INPUT = RESUMMARY_SPLIT.input;

const RESUMMARY_RULES = RESUMMARY_SPLIT.rules;

export const RESUMMARY_PROMPT = RESUMMARY_BODY;

/**
 * Tổng kết cấp 2 (L1+ → tầng cao hơn): nén thêm một tầng nữa đối với nhiều bản tổng kết đã qua một vòng nén.
 * Khác biệt then chốt so với tổng kết thông thường —— dung lượng được cấp ngân sách động theo quy mô đầu vào: mức Chi tiết tham khảo 40%–50%,
 * mức Tinh gọn tham khảo 30%–40%; mẫu tích hợp sẵn coi mức sàn là tham khảo và mức trần là ngân sách cứng, tránh việc giữ lại chi tiết vụn vặt chỉ để cho đủ số chữ.
 * Trường xuất ra vẫn là { summary } (cùng quy chuẩn với tổng kết thông thường để tái sử dụng extractJsonObject).
 */
const RESUMMARY2_INPUT = RESUMMARY2_SPLIT.input;

const RESUMMARY2_RULES = RESUMMARY2_SPLIT.rules;

export const RESUMMARY2_PROMPT = RESUMMARY2_BODY;

/** Hai cấp nén dùng lại bản ghi kiểm tra tường minh của tóm tắt, nhưng không thực hiện cập nhật trạng thái vật phẩm/NPC... */
export const RESUMMARY_THINKING_CHECKLIST = protocolSection('RESUMMARY_THINKING_CHECKLIST');

/**
 * Giá trị mặc định của từ nhắc vượt giới hạn (Jailbreak): được đính kèm làm tin nhắn system ghim trên cùng trong các yêu cầu tóm tắt/tổng kết, giúp giảm tỷ lệ từ chối trả lời của API phụ đối với nội dung trần trụi/bạo lực.
 * Người dùng có thể ghi đè trong phần cài đặt; để trống (xóa sạch) thì không đính kèm. Nhiệm vụ tóm tắt đối mặt với chính văn đã được tạo ra, cần ghi chép trung thực chứ không phải kiểm duyệt lần hai.
 * Vượt giới hạn = Lõi độc lập NVWA thuần túy (không bao gồm đoạn「Hướng dẫn nhiệm vụ biên tập ký ức」ở phía sau 04). Được đặt làm tin nhắn system độc lập ở đầu mỗi yêu cầu ký ức.
 */
export const JAILBREAK_PROMPT = (() => {
  const close = '</nvwa_standalone_core>';
  const end = tasksRaw.indexOf(close);
  return end >= 0 ? tasksRaw.slice(0, end + close.length).trim() : tasksRaw.trim();
})();

interface BuildArgs {
  user: string;
  char: string;
  time: string;
  location: string;
  /** Hồ sơ khách quan hiện tại của nhân vật chính do người dùng điều khiển */
  protagonist: MemProtagonist;
  /** Cục diện tương tác hiện tại (tấm thẻ cục diện trước đó, ghi đè tính đến trước tầng đó; chỉ đọc để tham khảo, null = không có) */
  sceneFocus: SceneFocus | null;
  /** Hồ sơ đời sống của nhân vật chính và nhân vật chính yếu (đã ghi nhận hiện tại; dùng để đối chiếu nhân vật, kiểm tra trùng lặp và chỉ định bằng mã số d) */
  lifeDetails: MemLifeDetail[];
  /** Danh sách hiểu biết của các nhân vật liên quan (có mặt/chính yếu/được gọi tên trong lượt này), trình tự chính là k1/k2…; lược bỏ = tính năng đang tắt, toàn bộ khối quy tắc/trường/tài liệu không gửi đi */
  knowledge?: MemKnowledge[];
  /** Danh sách tên vật phẩm hiện có */
  items: { name: string; qty?: number; desc?: string; carried?: boolean; location?: string }[];
  /** Nhật ký biến động vật phẩm gần đây (sổ đã kết toán, dùng để chống kết toán lặp lại) */
  itemLog: ItemLogEntry[];
  /** Địa điểm đã biết (đường dẫn đầy đủ + mô tả, để AI dùng lại cách đặt tên, chống ghi trùng lặp, phán đoán reparent) */
  scenes: { path: string[]; desc?: string }[];
  /** NPC đã xuất hiện (để AI dùng lại cách đặt tên, chống ghi trùng lặp, phán đoán cập nhật trạng thái) */
  npcs: NpcSummaryView[];
  /** Kế hoạch chưa kết thúc (trình tự chính là mã số p1..pn); createdTime/targetTime là thời gian trong truyện (có thể trống) */
  openPlans: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
  /** Kế hoạch/nghi vấn vừa hoàn thành gần đây (đã lấy N mục gần nhất xếp ngược theo resolvedAt); chống mô hình phụ ghi trùng lặp. Mảng rỗng → hiển thị「(Không có)」 */
  resolvedPlans: MemPlan[];
  /** Văn bản tóm tắt lịch sử trước lượt này (đã chọn các nút ở「tầng nén cao nhất」để ghép nối); rỗng biểu thị chưa có tiền truyện */
  history: string;
  /** Chính văn cần tóm tắt */
  content: string;
  /** Chính văn đã mang thẻ thời gian <bbs_start>/<bbs_end> hay chưa: có thì thời gian lấy theo thẻ và lược bỏ time khỏi từ nhắc; không có thì để AI điền bổ sung cả hai đầu */
  hasTimeTags: boolean;
  /** Trạng thái hiện tại của biến số tùy chỉnh (cây JSON đã kết toán tính đến trước tầng này; đối tượng rỗng + mô tả rỗng = chưa bật, lược bỏ toàn bộ khối trong từ nhắc) */
  varsState: Record<string, JsonValue>;
  /** Ý nghĩa biến số (hợp nhất meaning của 3 tầng): mỗi trường là gì; cả API chính và phụ đều nhận được */
  varsMeaning: string;
  /** Quy tắc biến đổi biến số (hợp nhất rule của 3 tầng): khi nào sửa ra sao/có được tạo mới không; chỉ API phụ nhận được */
  varsRule: string;
}

/**
 * Gộp thành một dòng: gộp các ký tự xuống dòng trong giá trị thành dấu cách. Danh sách NPC/vật phẩm/địa điểm/kế hoạch đều có định dạng「mỗi mục một dòng, các trường ghép nội tuyến」,
 * nếu giá trị có chứa dấu xuống dòng sẽ làm tách một mục thành nhiều dòng, phá vỡ cấu trúc và gây hiểu nhầm cho mô hình. Vì vậy mọi trường nội tuyến đều đi qua hàm này trước khi hiển thị (trim không chặn được dấu xuống dòng ở giữa).
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function fmtItems(items: BuildArgs['items']): string {
  if (!items.length) return '  (Không có)';
  return items
    .map(i => {
      const qty = typeof i.qty === 'number' ? ` ×${i.qty}` : '';
      const desc = oneLine(i.desc) ? ` —— ${oneLine(i.desc)}` : '';
      // Ghi chú mang theo/nơi cất giữ: mang theo bên mình (mặc định) thì không ghi chú, không mang theo bên mình thì ghi [Cất:Địa điểm], để AI biết hiện trạng mà di chuyển vật phẩm cho đúng
      const place = i.carried === false ? ` [Cất:${oneLine(i.location) || 'Nơi nào đó'}]` : '';
      return `  - ${i.name}${qty}${place}${desc}`;
    })
    .join('\n');
}

/** Hồ sơ khách quan hiện tại của nhân vật chính. Các trường luôn hiển thị toàn bộ, không tham gia phân nhóm có mặt của NPC. Hiển thị tuổi kèm theo mốc neo (đừng ghi lặp lại nữa). */
export function fmtProtagonist(protagonist: MemProtagonist): string {
  const age = protagonist.age
    ? `${protagonist.age}${protagonist.ageTime ? `(Ghi nhận vào ${protagonist.ageTime})` : ''}`
    : '';
  const rows: Array<[string, string | undefined]> = [
    ['Giới tính', protagonist.gender],
    ['Tuổi', age],
    ['Thân phận', protagonist.identity],
    ['Ngoại hình', protagonist.appearance],
    ['Trang phục', protagonist.outfit],
    ['Trạng thái', protagonist.condition],
  ];
  const lines = rows
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  return lines.length ? lines.join('\n') : '  (Chưa có ghi chép)';
}

/**
 * Cây địa điểm đã biết (kèm thụt lề theo phân cấp + mô tả): để AI dùng lại cách đặt tên, tránh ghi trùng lặp, phán đoán quan hệ gắn kết reparent.
 * Sắp xếp theo thứ tự từ điển của đường dẫn, độ sâu chính là mức thụt lề; mỗi cấp hiển thị tên cấp đó + mô tả. Trống thì trả về「(Không có)」.
 */
export function fmtScenes(scenes: BuildArgs['scenes']): string {
  if (!scenes.length) return '  (Không có)';
  // Sắp xếp theo thứ tự từ điển của đường dẫn đầy đủ, đảm bảo cấp cha đứng trước cấp con, các mục cùng cấp đứng cạnh nhau
  const sorted = [...scenes].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  return sorted
    .map(s => {
      const depth = Math.max(0, s.path.length - 1);
      const indent = '  '.repeat(depth + 1); // Ít nhất một cấp thụt lề để căn chỉnh với các khối khác
      const name = s.path[s.path.length - 1] ?? '';
      const desc = oneLine(s.desc) ? ` —— ${oneLine(s.desc)}` : '';
      return `${indent}- ${name}${desc}`;
    })
    .join('\n');
}

/**
 * Danh sách NPC đã xuất hiện: để AI dùng lại cách đặt tên, tránh ghi trùng lặp, phán đoán cập nhật/rút lui/diễn biến trạng thái.
 * Mỗi mục hiển thị Tên + Giới tính + Tuổi (kèm thời điểm ghi nhận, báo hiệu「đã ghi rồi, đừng lặp lại」) + ★Chính yếu + [Đi cùng/Nơi ở] + Thân phận
 * + Quan hệ với nhân vật chính + Quan hệ dài hạn với nhân vật khác + Trạng thái tức thời hiện tại (Trang phục/Trạng thái).
 * Giới tính được gửi ở mọi phân nhóm (bao gồm cả khi vắng mặt) để tránh AI nhầm giới tính; trạng thái tức thời đưa vào danh sách là có chủ đích:
 * AI cần dựa vào đó để phán đoán「có nên cập nhật trang phục không」「nhân vật chính yếu đang vắng mặt có nên suy diễn diễn biến không」.
 * Tính cách/ngoại hình vẫn không đưa vào (đủ để nhận diện dùng lại là được, tiết kiệm token). Trống thì trả về「(Không có)」.
 */
export function fmtNpcs(npcs: BuildArgs['npcs']): string {
  return fmtNpcSummaryList(npcs);
}

/**
 * Định dạng nhật ký biến động vật phẩm gần đây thành danh sách cho mô hình xem.
 * Thay đổi số lượng được biểu đạt bằng from→to (khi biết rõ cả hai đầu); chỉ ghi từ chỉ hướng (Nhận/Thay đổi/Dùng hết) làm dự phòng khi không có số lượng.
 * Trống thì trả về "(Không có)".
 */
export function fmtItemLog(log: ItemLogEntry[]): string {
  if (!log.length) return '  (Không có)';
  const kindWord = (k: ItemLogEntry['kind']): string =>
    k === 'add' ? 'Nhận' : k === 'remove' ? 'Loại bỏ' : 'Thay đổi';
  return log
    .map(e => {
      const time = e.time?.trim() ? `${e.time.trim()}:` : '';
      // Thay đổi số lượng: biết rõ cả hai đầu và khác nhau → from→to; nếu không thì chỉ đưa từ chỉ hướng
      const hasFrom = typeof e.from === 'number';
      const hasTo = typeof e.to === 'number';
      let qty = '';
      if (hasFrom && hasTo && e.from !== e.to) qty = `(${e.from}→${e.to})`;
      else if (!hasFrom && hasTo) qty = `(×${e.to})`;
      else if (hasFrom && !hasTo) qty = `(Gốc ×${e.from})`;
      return `  - ${time}${e.name} ${kindWord(e.kind)}${qty}`;
    })
    .join('\n');
}

/**
 * Định dạng nhiều dòng「kiểu động từ」dùng để ghi vào ghi chú bên lề <bbs_items> trong chính văn (mỗi dòng một vật phẩm, mỗi dòng bắt buộc kèm số lượng).
 * Động từ được quyết định bởi chiều hướng tăng giảm số lượng (không nhìn kind): to>from → Nhận, to<from → Tiêu hao, làm trống (to=0) → Mất.
 * Số lượng = mức chênh lệch liên quan trong lần này (|to-from|). Mọi vật phẩm đều đếm số lượng, from khuyết thì tính từ 0 (vật phẩm mới).
 * Ví dụ:
 *   Nhận Dao găm 1
 *   Tiêu hao Thuốc giải 1
 *   Mất Đuốc 2
 * Trống thì trả về chuỗi rỗng (bên gọi dựa vào đó để không ghi khối).
 */
export function fmtItemLogInline(log: ItemLogEntry[]): string {
  if (!log.length) return '';
  const lines: string[] = [];
  for (const e of log) {
    const from = typeof e.from === 'number' ? e.from : 0;
    const to = typeof e.to === 'number' ? e.to : 0;
    const diff = to - from;
    if (diff === 0) continue; // Không thay đổi số lượng (chỉ cập nhật mô tả thuần túy) thì không ghi vào ghi chú bên lề
    if (to <= 0) lines.push(`Mất ${e.name} ${from}`); // Làm trống: mất toàn bộ số lượng ban đầu
    else if (diff > 0) lines.push(`Nhận ${e.name} ${diff}`);
    else lines.push(`Tiêu hao ${e.name} ${-diff}`);
  }
  return lines.join('\n');
}

/* ============ Biến số tùy chỉnh: Hiển thị trạng thái JSON (Chèn ngữ cảnh / Từ nhắc) ============ */

/** Hiển thị JSON trạng thái biến số hiện tại thành văn bản dễ đọc (JSON có thụt lề). Đối tượng rỗng →「(Trống)」. */
export function renderVarsState(json: Record<string, JsonValue>): string {
  if (!json || !Object.keys(json).length) return '(Trống)';
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return '(Không thể hiển thị)';
  }
}

/**
 * Chọn「Kế hoạch/nghi vấn vừa hoàn thành gần đây」: **kế hoạch và nghi vấn mỗi loại lấy n mục gần nhất** (sắp xếp ngược theo resolvedAt riêng từng loại), rồi gộp lại.
 * Lý do đếm phân loại: kế hoạch (việc nhân vật chủ động muốn làm) sau khi kết thúc rất dễ bị AI tưởng là chưa hoàn thành rồi lại thúc đẩy tiếp —— nguy cơ lặp lại cao;
 * trong khi nghi vấn (mục chờ giải quyết bị động) rất ít khi bị chủ động add lại. Nếu lấy chung N mục, một loạt nghi vấn kết thúc dồn dập sẽ đẩy kế hoạch ra khỏi danh sách,
 * làm mất đúng loại cần giữ lại nhất. Lấy riêng N mục cho mỗi loại đảm bảo cả hai loại đều có đại diện và kế hoạch chắc chắn có mặt.
 * Phía chèn ngữ cảnh và API phụ dùng chung một logic chọn lọc —— quy chuẩn nhất quán, chỉ khác ở điểm cắt của plans truyền vào
 * (chèn ngữ cảnh dùng toàn bộ memory.plans; API phụ dùng deriveMemory(chat, beforeIndex).plans).
 * n<=0 hoặc không có mục đã kết thúc → mảng rỗng (bên gọi dựa vào đó để không hiển thị cả khối). Danh sách cuối cùng sắp xếp ngược theo resolvedAt để dễ đọc.
 */
export function selectRecentResolvedPlans(plans: MemPlan[], n: number): MemPlan[] {
  if (!(n > 0)) return [];
  const resolved = plans.filter(p => p.status === 'resolved');
  const byTimeDesc = (a: MemPlan, b: MemPlan): number => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0);
  const plansTop = resolved.filter(p => p.kind === 'plan').sort(byTimeDesc).slice(0, n);
  const suspenseTop = resolved.filter(p => p.kind === 'suspense').sort(byTimeDesc).slice(0, n);
  return [...plansTop, ...suspenseTop].sort(byTimeDesc);
}

/**
 * Nhãn hiển thị trung tính cho phương thức kết thúc (dùng từ theo kind để đọc tự nhiên). Không có outcome (dữ liệu cũ) →「Đã kết thúc」.
 * Then chốt: cancelled hiển thị rõ là「Đã hủy/Đã phế bỏ」, không gộp chung với done thành「Đã hoàn thành」nữa, để mô hình chính không phán đoán nhầm là vẫn phải làm.
 */
export function outcomeLabel(kind: MemPlan['kind'], outcome?: PlanOutcome): string {
  if (kind === 'suspense') {
    return outcome === 'done' ? 'Đã sáng tỏ' : outcome === 'cancelled' ? 'Đã phế bỏ' : outcome === 'failed' ? 'Đã thất bại' : 'Đã kết thúc';
  }
  return outcome === 'done' ? 'Đã hoàn thành' : outcome === 'cancelled' ? 'Đã hủy' : outcome === 'failed' ? 'Đã thất bại' : 'Đã kết thúc';
}

/**
 * Hiển thị danh sách「Kế hoạch/nghi vấn vừa kết thúc gần đây」(không đánh số —— chúng đã kết thúc, không cần dùng để chỉ định khi resolve như các mục chưa kết thúc).
 * Mỗi mục: [Kế hoạch·Đã hủy] Nội dung —— Nguyên nhân kết thúc (Lập vào X · Mục tiêu Y). Phương thức và nguyên nhân kết thúc là điểm then chốt: cho mô hình chính biết
 * 「việc này khép lại như thế nào, tại sao」, xóa bỏ sự bối rối「đã hoàn thành mà vẫn nhắc đi nhắc lại」. Trống thì trả về「(Không có)」.
 */
export function fmtResolvedPlans(plans: MemPlan[]): string {
  if (!plans.length) return '  (Không có)';
  return plans
    .map(p => {
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`Lập vào ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`Mục tiêu ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      const tag = `${p.kind === 'suspense' ? 'Nghi vấn' : 'Kế hoạch'}·${outcomeLabel(p.kind, p.outcome)}`;
      const reason = oneLine(p.resolvedReason) ? ` —— ${oneLine(p.resolvedReason)}` : '';
      return `  - [${tag}] ${oneLine(p.content)}${reason}${time}`;
    })
    .join('\n');
}

export function fmtPlans(plans: BuildArgs['openPlans']): string {
  if (!plans.length) return '  (Không có)';
  return plans
    .map((p, idx) => {
      // Chú thích thời gian trong ngoặc: có thời gian tạo/mục tiêu mới kèm theo, định dạng A —— (Lập vào X · Mục tiêu Y), thiếu một trong hai thì chỉ hiển thị cái hiện có
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`Lập vào ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`Mục tiêu ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      return `  p${idx + 1}. [${p.kind === 'suspense' ? 'Nghi vấn' : 'Kế hoạch'}] ${oneLine(p.content)}${time}`;
    })
    .join('\n');
}

/** Hiển thị thẻ cục diện cho API phụ (chỉ đọc để tham khảo, ghép nội tuyến trên một dòng). null → (Không có). */
export function fmtSceneFocus(f: SceneFocus | null): string {
  if (!f) return '  (Không có)';
  const bits: string[] = [`Cục diện:${oneLine(f.situation)}`];
  const who = f.participants.map(oneLine).filter(Boolean).join('、');
  if (who) bits.push(`Có mặt:${who}`);
  if (f.currentFocus) bits.push(`Tiêu điểm:${oneLine(f.currentFocus)}`);
  if (f.tension) bits.push(`Căng thẳng:${oneLine(f.tension)}`);
  if (f.pendingBeat) bits.push(`Sắp diễn ra:${oneLine(f.pendingBeat)}`);
  return `  ${bits.join(' | ')}`;
}

/** Hiển thị hồ sơ đời sống cho API phụ (đánh số d1/d2… để chỉ định khi update/archive/remove). */
export function fmtLifeDetails(details: MemLifeDetail[], userName = 'Nhân vật chính'): string {
  if (!details.length) return '  (Không có)';
  return details
    .map((d, idx) => {
      const tierLabel = d.tier === 'pinned' ? 'Ghim đầu' : d.tier === 'archive' ? 'Lưu trữ' : d.until ? `Thời hạn·đến ${oneLine(d.until)}` : 'Dài hạn';
      const meta: string[] = [];
      if (d.topics.length) meta.push(`Chủ đề:${d.topics.map(oneLine).filter(Boolean).join('/')}`);
      if (d.anchors.length) meta.push(`Từ khóa:${d.anchors.map(oneLine).filter(Boolean).join('/')}`);
      return `  d${idx + 1}. [${tierLabel}] ${oneLine(fmtLifeDetail(d, userName))}${meta.length ? ` (${meta.join(' | ')})` : ''}`;
    })
    .join('\n');
}

function fill(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? '');
}

/**
 * Cấu hình mức số chữ: Chi tiết (mặc định) / Tinh gọn. Số chữ ở ba nơi + khoảng tỷ lệ của tổng kết cấp 2 được chuyển đổi đồng bộ theo mức cấu hình.
 * Chỉ tác động lên các macro {{summary_words}} / {{resummary_words}} / {{target_min}} / {{target_max}} của mẫu tích hợp sẵn;
 * {{target}} đóng vai trò là macro tương thích cho mẫu tùy chỉnh cũ, tương đương với {{target_max}}. Nếu trong mẫu người dùng tự điền có sử dụng các macro này thì cũng sẽ được điền theo mức cấu hình.
 */
interface VerbosityProfile {
  summaryWords: string; // Khoảng số chữ tóm tắt (điền vào {{summary_words}})
  /** Giới hạn trần cứng của bản tóm tắt (ký tự, tính cả dấu câu), điền vào {{summary_max_chars}}; dùng làm mức trần chứ không phải mục tiêu phải viết cho đủ */
  summaryMaxChars: number;
  resummaryWords: string; // Khoảng số chữ tổng kết thông thường (điền vào {{resummary_words}})
  resummary2MinRatio: number; // Số chữ tối thiểu của tổng kết cấp 2 = tổng số chữ đầu vào × tỷ lệ tối thiểu
  resummary2MaxRatio: number; // Số chữ tối đa của tổng kết cấp 2 = tổng số chữ đầu vào × tỷ lệ tối đa
}
const VERBOSITY_PROFILES: Record<Verbosity, VerbosityProfile> = {
  detailed: {
    summaryWords: '150-300',
    summaryMaxChars: 360,
    resummaryWords: '300-500',
    resummary2MinRatio: 0.4,
    resummary2MaxRatio: 0.5,
  },
  concise: {
    summaryWords: '80-150',
    summaryMaxChars: 180,
    resummaryWords: '150-300',
    resummary2MinRatio: 0.3,
    resummary2MaxRatio: 0.4,
  },
};

/** Lấy cấu hình mức số chữ đang có hiệu lực hiện tại (đọc apiSettings.verbosity, giá trị không hợp lệ thì lùi về mặc định Chi tiết). */
function currentVerbosity(): VerbosityProfile {
  return VERBOSITY_PROFILES[apiSettings.verbosity] ?? VERBOSITY_PROFILES.detailed;
}

/**
 * Mẫu tóm tắt tùy chỉnh sẽ không tự động kế thừa các trường mới thêm của mẫu tích hợp sẵn, vì vậy cần gửi riêng giao thức tương thích tối thiểu.
 * Nhờ đó người dùng cũ không cần đặt lại mẫu thủ công mà vẫn có thể bắt đầu tạo ra phần cập nhật protagonist.
 */
const PROTAGONIST_PROTOCOL_SUPPLEMENT = `【Giao thức tương thích hồ sơ nhân vật chính của Bách Bảo Thư】
Bất kể mẫu tùy chỉnh có nhắc tới giao thức này hay không, đối tượng JSON gốc cuối cùng đều được phép bao gồm \`protagonist\` khi cần:
{
  "protagonist": {
    "gender": "Giới tính/biểu hiện giới tính",
    "age": "Tuổi (chỉ viết khi lần đầu nêu rõ hoặc thay đổi rõ ràng, viết giá trị nguyên văn, đừng tự quy đổi theo thời gian)",
    "identity": "Thân phận/nghề nghiệp/chủng tộc/địa vị công khai hiện tại",
    "appearance": "Ngoại hình ổn định/đặc điểm cơ thể hiện tại",
    "outfit": "Trang phục đầy đủ hiện tại",
    "condition": "Nội dung đầy đủ sau khi trạng thái cơ thể/sức khỏe thay đổi (vết thương cũ chưa khỏi thì chép lại nguyên vẹn; chuỗi rỗng = bình phục hoàn toàn)"
  }
}
Trường bị lược bỏ biểu thị giữ nguyên giá trị cũ; chuỗi rỗng biểu thị làm trống rõ ràng giá trị cũ.

${RULE_PROTAGONIST}`;

/**
 * Mẫu mặc định v0.17 hướng dẫn bản vá mảnh tình trạng thương tích đã ngừng sử dụng: nếu viết theo nó, bản vá sẽ bị tầng làm sạch loại bỏ, khiến nhân vật chính/NPC đã có thương tích không bao giờ cập nhật được nữa.
 * Quy tắc nhân vật chính của nó ngoại trừ cách viết thương tích thì đều khớp với hiện hành, chỉ cần đính chính điểm này là đủ, không cần gửi lại cả đoạn quy tắc nhân vật chính.
 */
const CONDITION_PATCH_RETIRED_SUPPLEMENT = `【Đính chính cách viết tình trạng thương tích của Bách Bảo Thư】
\`conditionPatch\` (bản vá mảnh tình trạng thương tích) và【Giao thức cập nhật cục bộ tình trạng thương tích】trong mẫu tùy chỉnh đã ngừng sử dụng, hệ thống không còn đọc và cũng không còn cung cấp mã số thương tích nữa. \`condition\` của nhân vật chính và NPC nhất loạt ghi đè toàn đoạn: khi có thay đổi thì viết trạng thái đầy đủ sau khi thay đổi, vết thương cũ chưa được giải trừ thì chép lại nguyên vẹn, thực sự đã bình phục hoàn toàn thì viết chuỗi rỗng; không có thay đổi thì lược bỏ. Các cách nói trong mẫu như "khi có vết thương cũ thì đổi sang dùng conditionPatch", "đã có thương tích khác rỗng thì lược bỏ trường này", "không ghi đè toàn đoạn" đều lấy bản đính chính này làm chuẩn.`;

/** Tóm tắt tùy chỉnh có thể không dùng {{time_field}}/{{time_rule}}, tầng không có thẻ thời gian vẫn bắt buộc phải tạo ra trường mốc neo. */
const TIME_ANCHOR_PROTOCOL_SUPPLEMENT = `【Giao thức tương thích mốc thời gian của Bách Bảo Thư】
Chính văn lượt này không có thẻ thời gian có thể đọc được. Bất kể mẫu tùy chỉnh có nhắc tới thời gian hay không, đối tượng JSON gốc cuối cùng đều bắt buộc phải bao gồm:
{
  "timeStart": "Thời gian trong truyện đầy đủ khi bắt đầu đoạn này",
  "timeEnd": "Thời gian trong truyện đầy đủ khi kết thúc đoạn này"
}
Cả hai trường đều không được lược bỏ, phải viết thời gian đầy đủ (không chịu sự hạn chế "không tự bù năm, phút" của lời trần thuật tóm tắt); nếu thời gian của đoạn này không tiến thêm thì viết cùng một thời gian đầy đủ như nhau.

${RULE_COMPLETE_TIME_ANCHOR}`;

/** Tóm tắt tùy chỉnh có thể không nhắc tới thẻ cục diện; bổ sung giao thức trường sceneFocus (trường tùy chọn, không làm hỏng mẫu cũ). */
const SCENE_FOCUS_PROTOCOL_SUPPLEMENT = `【Giao thức tương thích thẻ cục diện tương tác của Bách Bảo Thư】
Đối tượng JSON gốc cuối cùng có thể thêm một trường tùy chọn (không có thay đổi thực chất thì đừng xuất nó):
{
  "sceneFocus": { "situation": "Một câu về cục diện hiện tại (đời thường viết bầu không khí, cốt truyện viết hoàn cảnh trước mắt; lời kể miệng kèm theo nguồn)", "participants": ["Tên người tham gia có mặt"], "tension": "Căng thẳng tương tác (tùy chọn, ngưỡng cao)", "pendingBeat": "Sự việc sắp xảy ra được báo trước rõ ràng trong chính văn (tùy chọn, cấm dự đoán, không lặp lại situation)" }
}
Lược bỏ biểu thị giữ nguyên tấm thẻ trước đó; viết \`null\` biểu thị làm trống rõ ràng.

${RULE_SCENE_FOCUS}`;

/** Tóm tắt tùy chỉnh có thể không nhắc tới hồ sơ đời sống; bổ sung giao thức trường lifeDetails (trường tùy chọn, không làm hỏng mẫu cũ). */
const LIFE_DETAILS_PROTOCOL_SUPPLEMENT = `【Giao thức tương thích hồ sơ đời sống của Bách Bảo Thư】
Giao thức này cập nhật giới hạn "chỉ nhân vật chính" của mẫu cũ: hiện hỗ trợ cả nhân vật chính và nhân vật chính yếu, bắt buộc phải nêu rõ nhân vật sở hữu, các ngưỡng chuẩn nhận sự thật khác không đổi.
Đối tượng JSON gốc cuối cùng có thể thêm một trường tùy chọn (không có gì đáng ghi thì đừng xuất nó):
{
  "lifeDetails": {
    "add": [{ "subject": "user hoặc tên chính xác của nhân vật chính yếu trong danh sách NPC", "text": "Một câu về sở thích, thói quen hoặc trạng thái gần đây mà nhân vật đó đã nói rõ / chính văn tiết lộ rõ ràng", "topics": ["Nhãn chủ đề"], "anchors": ["Từ khóa nguyên văn"], "until": "Thời gian hết hạn trong truyện (sở thích lâu dài để trống, tùy chọn)" }],
    "update": [{ "id": "d1", "subject": "Chỉ điền khi đính chính rõ ràng người sở hữu; lược bỏ để giữ nguyên", "text": "Nội dung mới sau khi đính chính (tùy chọn)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }
}

${RULE_LIFE_DETAILS}`;

/** Hiện tại có đang dùng mẫu tóm tắt tích hợp sẵn hay không (trống = tích hợp sẵn; khớp hoàn toàn với mặc định tích hợp sẵn cũng tính là tích hợp sẵn). */
export function isBuiltinSummaryPrompt(): boolean {
  const custom = apiSettings.prompts.summary.trim();
  return !custom || custom === SUMMARY_PROMPT.trim();
}

/** Quy tắc tích hợp sẵn và tài liệu được triển khai riêng; mẫu tùy chỉnh không đoán ranh giới mà chỉ chuyển các quy phạm tương thích sang system. */
export function buildSummaryPrompt(a: BuildArgs): { system: string; user: string } {
  const custom = apiSettings.prompts.summary.trim();
  const macros = {
    user: a.user || 'Nhân vật chính',
    char: a.char || 'Nhân vật',
    history_block: a.history.trim() || '(Không có, đây là đoạn mở đầu)',
    state_time: a.time || '(Chưa rõ)',
    state_location: a.location || '(Chưa rõ)',
    protagonist_block: fmtProtagonist(a.protagonist),
    items_block: fmtItems(a.items),
    itemlog_block: fmtItemLog(a.itemLog),
    scenes_block: fmtScenes(a.scenes),
    npcs_block: fmtNpcs(a.npcs),
    plans_block: fmtPlans(a.openPlans),
    resolved_plans_block: fmtResolvedPlans(a.resolvedPlans),
    scenefocus_block: fmtSceneFocus(a.sceneFocus),
    lifedetails_block: `- Hồ sơ đời sống (Đã ghi nhận, dùng mã số d1/d2… để chỉ định; chỉ đọc để tham khảo, đừng ghi trùng lặp —— xem【Quy tắc hồ sơ đời sống】):\n${fmtLifeDetails(a.lifeDetails, a.user || 'Nhân vật chính')}\n`,
    lifedetails_field: LIFE_DETAILS_FIELD_TMPL,
    lifedetails_rule: `\n${RULE_LIFE_DETAILS}\n`,
    // Ba vị trí của danh sách hiểu biết: khi tính năng tắt (không truyền knowledge) thì tất cả đều là chuỗi rỗng, từ nhắc không lệch một chữ so với trước khi có tính năng
    knowledge_block: a.knowledge
      ? `- Hiểu biết của nhân vật về nhân vật chính (Nhận thức đã ghi lại của các nhân vật liên quan, dùng mã số k1/k2… để chỉ định; chỉ đọc để tham khảo, đừng ghi trùng lặp —— xem【Quy tắc danh sách hiểu biết】):\n${fmtKnowledgeForSummary(a.knowledge)}\n`
      : '',
    knowledge_field: a.knowledge ? KNOWLEDGE_FIELD_TMPL : '',
    knowledge_rule: a.knowledge ? `\n${RULE_KNOWLEDGE}\n` : '',
    content: a.content,
    time_field: a.hasTimeTags ? TIME_FIELD_WITH_TAGS : TIME_FIELD_NO_TAGS,
    time_rule: a.hasTimeTags ? TIME_RULE_WITH_TAGS : TIME_RULE_NO_TAGS,
    summary_words: currentVerbosity().summaryWords,
    summary_max_chars: String(currentVerbosity().summaryMaxChars),
    // Ba vị trí của biến số tùy chỉnh: khi chưa cấu hình biến số (trạng thái trống + mô tả trống) thì tất cả đều là chuỗi rỗng (chi phí 0 token, hành vi người dùng cũ không đổi)
    vars_state_block: hasVars(a)
      ? `- Biến số tùy chỉnh · Trạng thái hiện tại (JSON đã kết toán tính đến thời điểm này, chỉ đọc để tham khảo, nghiêm cấm kết toán lặp lại):\n${renderVarsState(a.varsState)}`
        + (a.varsMeaning.trim() ? `\n- Ý nghĩa biến số (Mỗi trường là gì):\n${a.varsMeaning.trim()}` : '')
        + (a.varsRule.trim() ? `\n- Quy tắc biến đổi biến số (Khi nào sửa ra sao/có được tạo mới không):\n${a.varsRule.trim()}` : '')
      : '',
    vars_field: hasVars(a) ? VARS_FIELD_TMPL : '',
    vars_rule: hasVars(a) ? `\n${RULE_VARS}\n` : '',
    // Khối nguyên bản để mẫu tùy chỉnh lấy riêng khi cần
    vars_block: renderVarsState(a.varsState),
    varlog_block: [a.varsMeaning.trim(), a.varsRule.trim()].filter(Boolean).join('\n\n') || '(Không có)',
  };
  if (isBuiltinSummaryPrompt()) {
    return { system: fill(SUMMARY_RULES, macros), user: fill(SUMMARY_INPUT, macros) };
  }
  const prompt = fill(custom, macros);
  // Mẫu tùy chỉnh được sửa từ mẫu tích hợp sẵn vốn đã có sẵn các mục này, nếu bổ sung thêm sẽ thành gửi cùng một quy tắc hai lần.
  const supplements: string[] = [];
  if (!prompt.includes('═══ 【Quy tắc hồ sơ hiện tại của nhân vật chính】')) supplements.push(PROTAGONIST_PROTOCOL_SUPPLEMENT);
  // Mẫu mặc định v0.17 hướng dẫn bản vá thương tích đã ngừng sử dụng (conditionPatch), chỉ bổ sung một câu đính chính cho cả nhân vật chính và NPC
  if (custom.includes('conditionPatch')) supplements.push(CONDITION_PATCH_RETIRED_SUPPLEMENT);
  // Quy tắc thép về thời gian: kiểm tra trên mẫu gốc custom thay vì prompt đã triển khai
  if (!custom.includes('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】')) supplements.push(RULE_ABSOLUTE_TIME_LANGUAGE);
  if (!prompt.includes('═══ 【Quy tắc thẻ cục diện tương tác】')) supplements.push(SCENE_FOCUS_PROTOCOL_SUPPLEMENT);
  if (!custom.includes('{{lifedetails_rule}}')) supplements.push(LIFE_DETAILS_PROTOCOL_SUPPLEMENT);
  if (a.knowledge && !custom.includes('{{knowledge_rule}}')) supplements.push(KNOWLEDGE_PROTOCOL_SUPPLEMENT);
  if (!prompt.includes('═══ 【Quy tắc hảo cảm nội tâm và thái độ bên ngoài】')) supplements.push(RULE_NPC_AFFINITY);
  // Giữ lại mạch quan hệ: bổ sung khi mẫu tùy chỉnh chưa kèm theo
  if (!prompt.includes('【Giữ lại mạch quan hệ】')) supplements.push(RULE_RELATION_MOMENTUM);
  // {{time_rule}} khi không có thẻ thời gian vốn đã mang giao thức thời gian đầy đủ;
  // chỉ khi mẫu tùy chỉnh không kèm theo nó mới thêm giao thức tương thích.
  if (!a.hasTimeTags && !prompt.includes('【Định dạng mốc thời gian đầy đủ (Hệ thống bắt buộc)】')) {
    supplements.push(TIME_ANCHOR_PROTOCOL_SUPPLEMENT);
  }
  return {
    system: fill(supplements.join('\n\n'), macros),
    user: `${prompt}\n\n【Hồ sơ hiện tại của nhân vật chính (Trước lượt này, chỉ đọc để tham khảo)】\n${macros.protagonist_block}`
      + (prompt.includes(macros.npcs_block) ? '' : `\n\n【NPC đã xuất hiện (Trước lượt này, ước lượng hảo cảm chỉ làm mốc cơ sở, không kết toán lặp lại)】\n${macros.npcs_block}`)
      + (prompt.includes(macros.lifedetails_block.trim()) ? '' : `\n\n${macros.lifedetails_block}`)
      + (!a.knowledge || prompt.includes(macros.knowledge_block.trim()) ? '' : `\n\n${macros.knowledge_block}`),
  };
}

/** Đã bật biến số tùy chỉnh hay chưa (có trạng thái hiện tại hoặc mô tả). */
function hasVars(a: BuildArgs): boolean {
  return Object.keys(a.varsState).length > 0 || a.varsMeaning.trim().length > 0 || a.varsRule.trim().length > 0;
}

/** Đoạn mẫu JSON của trường vars (nối tiếp sau plans nên có dấu phẩy đứng trước). Mảng lệnh, xem【Quy tắc biến số tùy chỉnh】. */
const VARS_FIELD_TMPL = `,
  "vars": [ { "op": "set|add|assign|remove", "path": "Đường dẫn dấu chấm/ngoặc vuông", "key": "Dùng cho assign/remove (tùy chọn)", "value": "Dùng cho set/assign (tùy chọn)", "delta": "Con số dùng cho add (tùy chọn)" } ]`;

/** Đoạn mẫu JSON của trường hồ sơ đời sống (nối tiếp sau plans nên có dấu phẩy đứng trước). */
const LIFE_DETAILS_FIELD_TMPL = `,
  "lifeDetails": {
    "add": [{ "subject": "user hoặc tên chính xác của nhân vật chính yếu trong danh sách NPC", "text": "Một câu về sở thích, thói quen hoặc trạng thái gần đây mà nhân vật đó đã nói rõ / chính văn tiết lộ rõ ràng", "topics": ["Nhãn chủ đề, 1-3 nhãn"], "anchors": ["Từ khóa nguyên văn"], "until": "Thời gian hết hạn trong truyện (sở thích lâu dài để trống, tùy chọn)" }],
    "update": [{ "id": "d1", "subject": "Chỉ điền khi đính chính rõ ràng người sở hữu; lược bỏ để giữ nguyên", "text": "Nội dung mới sau khi đính chính (tùy chọn)", "topics": ["Nhãn mới (tùy chọn, ghi đè toàn bộ)"], "anchors": ["Từ khóa mới (tùy chọn, ghi đè toàn bộ)"], "until": "Thời hạn mới (tùy chọn; chuỗi rỗng = xóa)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }`;

/** Đoạn mẫu JSON của trường danh sách hiểu biết (có dấu phẩy đứng trước, nối tiếp sau lifeDetails). */
const KNOWLEDGE_FIELD_TMPL = `,
  "knowledge": {
    "add": [{ "who": "Tên chính xác trong danh sách NPC (không được là nhân vật chính)", "text": "Một việc về nhân vật chính mà nhân vật đó tận tai nghe/tận mắt thấy/được kể lại trong lượt này, gói gọn trong một câu, mở đầu viết rõ mức độ nắm bắt: Khẳng định/Nghi ngờ/Nghe nói/Nhân vật chính tự xưng" }],
    "update": [{ "id": "k1", "text": "Nội dung mới sau khi nhận thức được đính chính hoặc sâu sắc hơn" }],
    "remove": ["k2"]
  }`;

/** Mẫu tóm tắt tùy chỉnh chưa biết đến danh sách hiểu biết; khi tính năng bật thì bổ sung giao thức trường (trường tùy chọn, không làm hỏng mẫu cũ). */
const KNOWLEDGE_PROTOCOL_SUPPLEMENT = `【Giao thức tương thích danh sách hiểu biết của Bách Bảo Thư】
Đối tượng JSON gốc cuối cùng có thể thêm một trường tùy chọn (không có gì đáng ghi thì đừng xuất nó):
{
${KNOWLEDGE_FIELD_TMPL.replace(/^,\n/, '')}
}

${RULE_KNOWLEDGE}`;

/**
 * Tham số của tóm tắt hàng loạt. Tóm tắt hàng loạt chỉ tạo ra summary + thời gian bắt đầu/kết thúc, nên không truyền vật phẩm/kế hoạch (tránh loạn thứ tự qua nhiều tầng) ——
 * chỉ giữ lại thời gian/địa điểm/tiền truyện làm bối cảnh chỉ đọc để giúp AI suy tính thời gian và hiểu bối cảnh.
 */
export interface BatchBuildArgs {
  user: string;
  char: string;
  /** Thời gian đã biết trước khi bắt đầu đợt tầng này (bối cảnh chỉ đọc, giúp AI suy tính thời gian từng tầng) */
  time: string;
  /** Địa điểm đã biết trước khi bắt đầu đợt tầng này (bối cảnh chỉ đọc) */
  location: string;
  history: string;
  /** Chính văn ghép nối nhiều tầng (trước mỗi tầng có dòng phân cách「━━ Tầng thứ n ━━」) */
  content: string;
  /** Số lượng tầng trong đợt này (= độ dài cần có của mảng floors) */
  floorCount: number;
}

/** Khởi tạo từ nhắc tóm tắt hàng loạt. Mẫu tùy chỉnh của người dùng (prompts.summary) không tác động lên tóm tắt hàng loạt —— tóm tắt hàng loạt dùng BATCH_SUMMARY_PROMPT tích hợp sẵn. */
export function buildBatchSummaryPrompt(a: BatchBuildArgs): { system: string; user: string } {
  const macros = {
    user: a.user || 'Nhân vật chính',
    char: a.char || 'Nhân vật',
    history_block: a.history.trim() || '(Không có, đây là đoạn mở đầu)',
    state_time: a.time || '(Chưa rõ)',
    state_location: a.location || '(Chưa rõ)',
    content: a.content,
    floor_count: String(a.floorCount),
    summary_words: currentVerbosity().summaryWords,
    // Đoạn quy tắc viết được cắt từ mẫu đơn tầng, có mang macro giới hạn ký tự tối đa; nếu điền thiếu sẽ bị fill âm thầm thay bằng chuỗi rỗng
    summary_max_chars: String(currentVerbosity().summaryMaxChars),
  };
  return { system: fill(BATCH_SUMMARY_RULES, macros), user: fill(BATCH_SUMMARY_INPUT, macros) };
}

/** Điền macro {{floor_count}} trong danh sách suy nghĩ hàng loạt. */
export function buildBatchThinking(floorCount: number): string {
  return fill(BATCH_THINKING_CHECKLIST, { floor_count: String(floorCount) });
}

/**
 * Khoảng số chữ của tổng kết cấp 2: Chi tiết là 40%–50% tổng số chữ nội dung, Tinh gọn là 30%–40%.
 */
export function resummary2Targets(contentLen: number): { min: number; max: number } {
  const v = currentVerbosity();
  return {
    min: Math.round(contentLen * v.resummary2MinRatio),
    max: Math.round(contentLen * v.resummary2MaxRatio),
  };
}

/**
 * Khởi tạo từ nhắc tổng kết. Chia làm hai bộ theo tầng cấp:
 *  - level<=1 (Lá L0 → L1): Tổng kết thông thường, số chữ cố định → RESUMMARY_PROMPT.
 *  - level>=2 (L1+ → tầng cao hơn): Tổng kết cấp 2, số chữ mục tiêu được cấp động theo quy mô đầu vào → RESUMMARY2_PROMPT.
 * Mỗi bộ ưu tiên dùng mẫu tùy chỉnh tương ứng, nếu trống thì lùi về bản tích hợp sẵn. Số chữ chuyển đổi theo mức cấu hình (Chi tiết/Tinh gọn).
 */
export function buildResummaryPrompt(
  a: Pick<BuildArgs, 'user' | 'char' | 'content'> & { level: number },
): { system: string; user: string } {
  const isSecond = a.level >= 2;
  const custom = isSecond
    ? apiSettings.prompts.resummary2.trim()
    : apiSettings.prompts.resummary.trim();
  const builtin = isSecond ? RESUMMARY2_PROMPT : RESUMMARY_PROMPT;
  const targets = isSecond ? resummary2Targets(a.content.length) : { min: 0, max: 0 };
  const macros = {
    user: a.user || 'Nhân vật chính',
    char: a.char || 'Nhân vật',
    content: a.content,
    resummary_words: currentVerbosity().resummaryWords,
    target_min: isSecond ? String(targets.min) : '',
    target_max: isSecond ? String(targets.max) : '',
    // Tương thích với mẫu tùy chỉnh đã lưu {{target}} phiên bản cũ; ngữ nghĩa cũ tương ứng với số chữ mục tiêu/tối đa.
    target: isSecond ? String(targets.max) : '',
  };
  if (custom && custom !== builtin.trim()) {
    // Tương tự như tóm tắt, đoạn nào mẫu đã có sẵn thì không bổ sung lặp lại; khi có sẵn cả hai đoạn thì system rỗng để bên gọi bỏ qua tin nhắn đó
    const supplements: string[] = [];
    if (!custom.includes('【Quy tắc thép về ngôn ngữ thời gian trong tóm tắt】')) supplements.push(RULE_ABSOLUTE_TIME_LANGUAGE);
    if (!custom.includes('【Giữ lại mạch quan hệ】')) supplements.push(RULE_RELATION_MOMENTUM);
    return { system: supplements.join('\n\n'), user: fill(custom, macros) };
  }
  return {
    system: fill(isSecond ? RESUMMARY2_RULES : RESUMMARY_RULES, macros),
    user: fill(isSecond ? RESUMMARY2_INPUT : RESUMMARY_INPUT, macros),
  };
}

/**
 * Đóng gói thiết lập nhân vật của người dùng (persona) thành tin nhắn system độc lập (tóm tắt cần dựa vào đây để hiểu「nhân vật chính là ai」,
 * viết đúng summary và phán đoán tương tác giữa NPC với nhân vật chính). Khi persona trống thì bên gọi nên bỏ qua.
 * Trường đã được bên gọi (fetchUserPersona) triển khai macro; ở đây chỉ mô tả đó là「thiết lập của bản thân nhân vật chính」, phân biệt với thẻ nhân vật.
 */
/** Mẫu đóng gói tư liệu (09): câu chữ cố định + chỗ trống tư liệu động, lấy trực tiếp từ nguyên văn để tránh sai lệch khi chép tay. */
const DATA_WRAPPERS = (() => {
  const out: Record<string, string> = {};
  for (const block of dataWrappersRaw.split(/\n\s*\n(?=【)/)) {
    const name = block.match(/^【([^】]+)】/)?.[1];
    if (name) out[name] = block.replace(/〔[^〕]*〕[\s\S]*$/, '').replace(/\s+$/, '');
  }
  return out;
})();
function dataWrapper(prefix: string): string {
  const want = prefix.replace(/^【/, '');
  const key = Object.keys(DATA_WRAPPERS).find(k => k.startsWith(want));
  return key ? DATA_WRAPPERS[key] : '';
}

export function buildPersonaSystem(persona: string): string {
  return `${dataWrapper('【Thiết lập nhân vật chính (')}\n\n${persona.trim()}`;
}

/** Đóng gói thiết lập sổ thế giới thành nội dung tin nhắn system độc lập (khi thiết lập trống thì bên gọi nên bỏ qua) */
export function buildWorldInfoSystem(worldInfo: string): string {
  return `${dataWrapper('【Thiết lập thế giới (')}\n\n${worldInfo.trim()}`;
}

/**
 * Đóng gói mô tả thẻ nhân vật thành tin nhắn system độc lập (một số thẻ viết thiết lập nhân vật trong phần mô tả nhân vật thay vì sổ thế giới, tóm tắt cũng cần dựa vào đây để hiểu nhân vật).
 * Các trường đã được bên gọi triển khai macro và ghép nối khi khác rỗng; nếu trống thì bên gọi nên bỏ qua khối này.
 */
export function buildCharCardSystem(charCard: string): string {
  return `${dataWrapper('【Thiết lập nhân vật (')}\n\n${charCard.trim()}`;
}

/* ============ Chuỗi suy nghĩ (Cơ chế kế thừa từ Horae, các trường tương thích với JSON của Bách Bảo) ============ */

/**
 * Danh sách kiểm tra「Suy nghĩ trước khi xuất」, đóng vai trò là từ nhắc system đặt ngay sau user_input.
 * Các điểm suy nghĩ căn chỉnh với Horae (sự kiện cốt lõi tầng này → kiểm kê vật phẩm → tất toán nghi vấn → vị trí dừng bút → tự kiểm tra định dạng),
 * nhưng tên trường/định dạng đều căn chỉnh hoàn toàn với JSON của Bách Bảo (summary/time/location/items/plans), không nhắc tới thẻ <horae>.
 */
export const THINKING_CHECKLIST = protocolSection('THINKING_CHECKLIST');

/** Kiểm điểm danh sách hiểu biết, gắn dưới mục kiểm điểm NPC; giống như quy tắc, chỉ xuất hiện khi tính năng được bật, khi tắt thì danh sách không lệch một chữ so với khi chưa có tính năng này. */
const KNOWLEDGE_CHECK = `
   - Danh sách hiểu biết: Đối chiếu với「Hiểu biết của nhân vật về nhân vật chính」, ở tầng này có ai tận tai nghe thấy, tận mắt nhìn thấy hoặc nghe người khác kể lại về tên, thân thế, trải nghiệm, bí mật, sở thích riêng tư hay thân phận tự xưng của {{user}} không? Chưa từng ghi → \`knowledge.add\`, viết đúng theo điều nhân vật đó tưởng là vậy; nhận thức cũ bị vạch trần hoặc sâu sắc hơn → \`update\` mục gốc, không thêm mới một mục mâu thuẫn. Độc thoại nội tâm của {{user}}, sự việc xảy ra khi nhân vật đó vắng mặt không được tính.`;

/** Triển khai macro trước khi gửi giống như danh sách hàng loạt, không để lại ký hiệu giữ chỗ cho kênh xử lý. */
export function buildSummaryThinking(user: string, knowledge = false): string {
  const name = user || 'Nhân vật chính';
  // Giá trị macro sẽ không được triển khai thêm lần nữa, nên {{user}} trong mục kiểm điểm phải được điền trước
  return fill(THINKING_CHECKLIST, { user: name, knowledge_check: knowledge ? fill(KNOWLEDGE_CHECK, { user: name }) : '' });
}

/* ============ Truy xuất Vector: Viết lại truy vấn (Query Rewrite) ============ */

/** Các macro khả dụng cho viết lại truy vấn (dùng để hiển thị ở trang cài đặt) */
export const QUERY_REWRITE_MACROS: PromptMacro[] = [
  { token: '{{history_block}}', desc: 'Tóm tắt cốt truyện lịch sử (đã chèn làm ngữ cảnh phía trước)' },
  { token: '{{state_snapshot}}', desc: 'Bản chụp nhanh trạng thái (vật phẩm/kế hoạch đã trôi ra ngoài cửa sổ)' },
];

/**
 * Từ nhắc hệ thống viết lại truy vấn (tái hiện từ Horae, bản đã được người dùng tối ưu).
 * Để mô hình nhỏ viết lại「cốt truyện gần đây + trạng thái」thành INTENT + nhiều câu truy vấn Q, phục vụ truy xuất đa luồng + hợp nhất RRF của truy xuất vector.
 */
export const QUERY_REWRITE_SYSTEM = `Bạn là bộ lập kế hoạch ngữ cảnh trong kịch bản viết tiếp nhập vai.

Bối cảnh:
Người dùng đang thực hiện cuộc đối thoại nhập vai với AI. Tin nhắn assistant trong lịch sử đối thoại là phản hồi của nhân vật do AI nhập vai. Tin nhắn của người dùng là hành vi, lời thoại của nhân vật do người dùng nhập vai hoặc chỉ thị (như "tiếp tục", "thúc đẩy cốt truyện").
Ở phía hạ nguồn của bạn có một cơ sở dữ liệu vector đang lưu trữ toàn bộ các phân đoạn cốt truyện lịch sử đã từng xảy ra.
Nhiệm vụ của bạn là: phán đoán xem khi AI viết tiếp đoạn cốt truyện tiếp theo thì có thể cần đến những thông tin lịch sử nào, từ đó tạo ra các câu truy vấn tìm kiếm để truy xuất những thông tin đó.

Nguyên tắc cốt lõi:
Bạn không phải đang phân tích "người dùng muốn tra cứu cái gì". Tin nhắn của người dùng là lời thoại hoặc hành vi của nhân vật, không phải yêu cầu tìm kiếm.
Điều bạn cần suy nghĩ là: tiếp theo AI sắp phải viết tiếp đoạn cốt truyện này, nó có thể cần tham khảo những sự kiện, thiết lập, mối quan hệ, phục bút nào đã từng xảy ra để có thể viết một cách mạch lạc, chính xác và phong phú?
Sau đó tạo ra các câu truy vấn tìm kiếm cho những nội dung đó.
Bạn không thể biết trong cơ sở dữ liệu thực tế đang lưu trữ những gì. Vì vậy chiến lược của bạn là bao phủ ở nhiều góc độ nhất có thể để tối đa hóa xác suất truy xuất thành công. Truy xuất trả về rỗng không tốn chi phí gì, nhưng bỏ sót thông tin then chốt sẽ dẫn đến viết tiếp bị sai.

Quy trình làm việc:

Bước 1: Hiểu rõ trường cảnh hiện tại
Trích xuất từ vài lượt đối thoại gần nhất:
- Thời gian, địa điểm hiện tại, những nhân vật đang có mặt
- Sự kiện đang diễn ra hoặc chủ đề đang trò chuyện
- Trạng thái cảm xúc và xu hướng hành vi hiện tại của các nhân vật
- Nếu người dùng đưa ra chỉ thị thúc đẩy (như "tiếp tục", "thúc đẩy cốt truyện"), hãy phán đoán cốt truyện sắp bước vào giai đoạn nào

Bước 2: Nhận diện các phụ thuộc lịch sử mà việc viết tiếp có thể liên quan tới
Hãy suy nghĩ xem khi AI viết tiếp, những thông tin lịch sử nào không nằm trong cửa sổ đối thoại hiện tại có thể sẽ cần đến. Hãy triển khai suy nghĩ từ tất cả các chiều dưới đây:
- Sự kiện quá khứ liên quan đến chủ đề hiện tại, trong đối thoại chỉ mới nhắc qua một câu nhưng thiếu chi tiết
- Trường cảnh hoặc địa điểm sắp bước vào, trong quá khứ đã từng có miêu tả, sự kiện hay thiết lập liên quan nào chưa
- Lịch sử phát triển mối quan hệ và những tương tác then chốt trong quá khứ giữa các nhân vật đang có mặt
- Biểu hiện lịch sử về năng lực, thói quen, đặc điểm tính cách của các nhân vật liên quan
- Những phục bút, nghi vấn, tuyến sự kiện chưa hoàn thành đã được cài cắm từ trước nhưng vẫn chưa giải quyết
- Quy tắc hoặc bối cảnh trong thiết lập thế giới quan có liên quan đến tình tiết hiện tại
- Xuất xứ lịch sử của các danh từ riêng như vật phẩm, tên đất, tên tổ chức xuất hiện trong cuộc đối thoại hiện tại
- Trải nghiệm quá khứ có thể tồn tại giữa các nhân vật có liên quan đến cảm xúc hoặc chủ đề hiện tại

Bước 3: Tạo câu truy vấn tìm kiếm
- Tạo cố định 5 câu truy vấn
- Dùng câu ngắn bằng ngôn ngữ tự nhiên, gần với văn phong tự sự tiểu thuyết hoặc khái quát cốt truyện
- Mỗi câu truy vấn hướng tới một mục tiêu truy xuất rõ ràng và khác biệt nhau
- 5 câu truy vấn bắt buộc phải bao phủ nhiều chiều khác nhau nhất có thể: diễn biến sự kiện, quan hệ nhân vật, thiết lập năng lực, miêu tả môi trường, đầu mối phục bút, lịch sử tình cảm, bối cảnh thế giới quan...
- Bao gồm tên người, tên đất, tên sự kiện cụ thể, đừng sử dụng đại từ
- Đừng lặp lại những nội dung đã được thể hiện đầy đủ trong cửa sổ đối thoại hiện tại (AI đã có thể nhìn thấy những thứ này rồi), câu truy vấn phải hướng tới những thông tin có khả năng tồn tại bên ngoài cửa sổ
- Toàn bộ câu truy vấn chỉ được hướng về những việc đã xảy ra trong quá khứ, đừng suy đoán những sự kiện chưa xảy ra

Góc độ truy vấn tham khảo (mỗi lần chọn ra 5 hướng liên quan nhất từ danh sách này):
- Chi tiết sự kiện lịch sử đằng sau chủ đề hiện tại
- Mô hình hành vi của nhân vật liên quan trong trường cảnh tương tự ở quá khứ
- Miêu tả và sự kiện đã có của địa điểm hoặc trường cảnh sắp bước vào
- Lịch sử mối quan hệ và bước ngoặt then chốt giữa các nhân vật
- Ràng buộc liên quan trong hệ thống năng lực, quy tắc phép thuật, thiết lập thế giới quan
- Nguyên nhân hình thành trong lịch sử của trạng thái cảm xúc hiện tại
- Nguồn gốc và bối cảnh của vật phẩm hoặc manh mối được nhắc tới trong đối thoại
- Phục bút đã cài cắm và tuyến sự kiện còn bỏ ngỏ chưa giải quyết
- Sự kiện quá khứ có mô hình tương tự với sự kiện hiện tại

Những điều nghiêm cấm:
- Đừng trả lời câu hỏi của người dùng hoặc viết tiếp cốt truyện
- Đừng giải thích quá trình suy luận của bạn
- Đừng bịa đặt nhân vật, sự kiện hoặc thiết lập không có căn cứ trong ngữ cảnh
- Đừng tạo câu truy vấn hướng tới sự kiện tương lai chưa xảy ra
- Đừng truy xuất lặp lại những nội dung giống nhau hoặc tương đồng cao độ

Yêu cầu cách viết INTENT:
- Dùng một đoạn ngôn ngữ tự nhiên để miêu tả thông tin cốt lõi của trường cảnh hiện tại, bao gồm tên người, tên đất, sự kiện, trạng thái nhân vật và mối quan hệ cụ thể
- Văn phong gần với tóm tắt cốt truyện hoặc tự sự tiểu thuyết, đừng sử dụng thuật ngữ siêu tự sự (như "cốt truyện sắp bước vào", "giai đoạn", "thúc đẩy")
- Mục đích là làm ngữ cảnh so khớp toàn văn ở giai đoạn xếp hạng tinh (rerank), vì vậy phải bao phủ tối đa các thực thể và sự thật then chốt liên quan đến trường cảnh hiện tại
- Bao gồm các sự thật cốt lõi liên quan đến việc tìm kiếm trong cửa sổ hiện tại, giúp mô hình xếp hạng tinh phán đoán được mức độ liên quan giữa phân đoạn ứng viên với tình huống hiện tại
- Độ dài từ 2 đến 4 câu

Định dạng xuất:
Dòng đầu tiên bắt đầu bằng \`INTENT:\`, viết mô tả trường cảnh hiện tại theo yêu cầu nêu trên.
Sau đó là đúng 5 dòng, mỗi dòng bắt đầu bằng \`Q:\`, viết một câu truy vấn tìm kiếm.
Đừng xuất bất kỳ nội dung nào khác.

---

Ví dụ 1:

Bối cảnh đối thoại: Lục Viễn Châu bị ám sát rơi vào hôn mê tại thành Thiên Uyên, sau khi Tô Vãn Ninh chạy đến đã luôn chăm sóc anh. Lượt assistant gần nhất viết cảnh Tô Vãn Ninh lục xem vật phẩm mang theo bên người của Lục Viễn Châu trong quán trọ và phát hiện một bức thư bị xé vụn. Tin nhắn mới nhất của người dùng là Tô Vãn Ninh ghép các mảnh vụn lại để thử nhận diện nét chữ.

Đầu ra:
INTENT: Tô Vãn Ninh đang ở trong quán trọ tại thành Thiên Uyên ghép lại bức thư bị xé vụn mà Lục Viễn Châu mang theo bên mình, cố gắng nhận diện nét chữ và người gửi thư. Trước đó Lục Viễn Châu bị ám sát tại thành Thiên Uyên dẫn đến hôn mê, sau khi Tô Vãn Ninh chạy tới đã luôn túc trực bên cạnh chăm sóc anh và bắt đầu điều tra chân tướng vụ ám sát.
Q: Trước khi bị ám sát tại thành Thiên Uyên thì Lục Viễn Châu từng có qua lại thư từ với những ai
Q: Nguyên nhân Lục Viễn Châu đến thành Thiên Uyên và mục đích chuyến đi này của anh
Q: Những thế lực và nhân vật từng có tiếp xúc hoặc quan hệ thù địch với Lục Viễn Châu trong thành Thiên Uyên
Q: Quá trình phát triển mối quan hệ và sự thay đổi lòng tin giữa Tô Vãn Ninh và Lục Viễn Châu
Q: Trong quá khứ Lục Viễn Châu có từng có ghi chép nào về việc che giấu thân phận hoặc hành động bí mật không

Ví dụ 2:

Bối cảnh đối thoại: Hai người đang ở trong lớp học, một tuần trước kỳ thi cuối kỳ, nhân vật A nói với nhân vật B "Lần này chắc là thi tốt thôi nhỉ", giọng điệu có chút chột dạ.

Đầu ra:
INTENT: Một tuần trước kỳ thi cuối kỳ, nhân vật A ở trong lớp học nói với nhân vật B "Lần này chắc là thi tốt thôi nhỉ" với giọng điệu chột dạ. Nhân vật A dường như thiếu tự tin vào biểu hiện thi cử của bản thân.
Q: Bản ghi thành tích thi cử và biểu hiện học tập trong quá khứ của nhân vật A
Q: Tương tác và trải nghiệm chung giữa nhân vật A và nhân vật B trong các kỳ thi trước đây
Q: Nhân vật A có từng gặp vấp ngã hoặc chịu áp lực gì trong chuyện học hành không
Q: Cách nhìn nhận và đánh giá trước đây của nhân vật B đối với năng lực hoặc thái độ học tập của nhân vật A
Q: Các miêu tả liên quan đến trạng thái học tập và hành vi ôn thi gần đây của nhân vật A

Ví dụ 3:

Bối cảnh đối thoại: Mộc Bạch Bạch và user thảo luận về bài đăng xuất hiện ác ma ở nhiều địa điểm, xác nhận công viên Đích Trường xuất hiện bất thường sớm hơn núi Kê Sơn, Mộc Bạch Bạch nhắc tới việc bản thân chưa từng gặp thiếu nữ phép thuật nào khác. Trường cảnh hiện tại là hai người đang ở hiên nhà chuẩn bị ra ngoài đi khảo sát thực địa tại công viên Đích Trường. Tin nhắn mới nhất của người dùng là "thúc đẩy cốt truyện".

Đầu ra:
INTENT: Mộc Bạch Bạch và user đang ở hiên nhà chuẩn bị ra ngoài tới công viên Đích Trường để điều tra sự kiện ác ma tấn công xuất hiện ở nhiều nơi gần đây. Tối qua sau khi chiến đấu ở núi Kê Sơn, Mộc Bạch Bạch đã bổ sung ma lực, nhưng cô chưa từng gặp thiếu nữ phép thuật nào khác nên chỉ có thể một mình ứng phó. Bản ghi bất thường ở công viên Đích Trường có sớm hơn núi Kê Sơn, ác ma ở hai nơi có thể có liên hệ với nhau.
Q: Miêu tả cụ thể về sự kiện bất thường và báo cáo nhân chứng nhìn thấy ác ma xảy ra trong quá khứ tại công viên Đích Trường
Q: Đặc điểm hình dáng và hành vi tấn công của ác ma khi Mộc Bạch Bạch chiến đấu với ác ma tại núi Kê Sơn
Q: Thiết lập đã biết về năng lực chiến đấu như hình thái biến thân, vũ khí, giới hạn ma lực tối đa của Mộc Bạch Bạch
Q: Miêu tả cụ thể về phương thức bổ sung ma lực của Mộc Bạch Bạch và trạng thái hồi phục sau khi bổ sung
Q: Quy luật thời gian phát tán và sự thay đổi phạm vi hoạt động của ác ma ở các địa điểm khác nhau gần đây`;

/** Từ nhắc kết thúc viết lại truy vấn (đặt ở cuối cuộc đối thoại để nhấn mạnh lại một lần nữa nhiệm vụ và định dạng) */
export const QUERY_REWRITE_TAIL = `Hãy nhớ kỹ nhiệm vụ của bạn:
- Bạn là bộ lập kế hoạch ngữ cảnh, không phải người nhập vai, đừng viết tiếp cốt truyện
- Hãy suy nghĩ xem khi AI viết tiếp đoạn tiếp theo thì cần tham khảo những thông tin lịch sử nào đã xảy ra
- Toàn bộ câu truy vấn chỉ được hướng về những việc đã xảy ra trong quá khứ
- Đừng truy vấn những nội dung đã được thể hiện đầy đủ trong cửa sổ đối thoại hiện tại
- Xuất theo đúng định dạng nghiêm ngặt: một dòng INTENT cộng với đúng 5 dòng Q, đừng xuất bất kỳ nội dung nào khác`;