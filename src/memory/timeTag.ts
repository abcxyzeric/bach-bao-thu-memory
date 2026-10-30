/**
 * Thẻ thời gian (mốc neo) —— yêu cầu mô hình đối thoại chính xuất thời gian bắt đầu và kết thúc ở đầu và cuối mỗi chính văn, biến "thời gian" từ suy đoán hậu kỳ thành sự thật trong chính văn.
 *
 * Giải quyết hai vấn đề cũ:
 *  1. Một tầng lầu có khoảng thời gian kéo dài, một ảnh chụp thời gian đơn lẻ không lấy chuẩn được → Nay có cả hai mốc bắt đầu + kết thúc.
 *  2. Yêu cầu tóm tắt và việc sinh cốt truyện mới chạy song song, tự suy đoán thời gian riêng dẫn đến loạn → Cả hai bên đều đọc cùng một thời gian có thẩm quyền trong chính văn, tự nhiên đồng bộ.
 *
 * Định dạng thẻ cố định là <bbs_start>…</bbs_start> / <bbs_end>…</bbs_end> (tiền tố bbs_ để tránh đụng độ với plugin/sách thế giới khác).
 * Thẻ **giữ lại trong chính văn** (gửi API phụ hay gửi mô hình chính viết tiếp đều mang theo), chỉ dùng regex của ST để ẩn ở "tầng hiển thị" —— nếu xóa thật sẽ khiến thời gian mất đồng bộ trở lại.
 */

import { apiSettings } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';
import { stripBaiBaiImageTags } from './imageTag';
import type { LeafExtra } from './types';
// Giao thức chú thích bên lề: giải thích thẻ chú thích bên lề chỉ đọc. Thẻ thời gian không cần lõi NVWA.
import builtinProtocolsRaw from './prompts/builtin-protocols.txt?raw';

/** Lấy phân đoạn LEDGER_PROTOCOL của mục 08 (phân công giữa thẻ chú thích bên lề và chính văn). */
const LEDGER_PROTOCOL = (() => {
  const re = /^=====\s*LEDGER_PROTOCOL\s*=====\s*$/m;
  const m = builtinProtocolsRaw.match(re);
  if (!m || m.index === undefined) return '';
  const rest = builtinProtocolsRaw.slice(m.index + m[0].length);
  const next = rest.search(/^=====\s*.+?\s*=====\s*$/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
})();

/** Định danh cố định của thẻ (cả regex phân tích lẫn regex ẩn đều phụ thuộc vào nó) */
export const START_TAG = 'bbs_start';
export const END_TAG = 'bbs_end';
/** Thẻ chú thích biến động vật phẩm: sau khi tóm tắt sẽ ghi biến động ròng của vật phẩm tầng này vào sau </bbs_end> trong chính văn, để các tầng toàn văn trong cửa sổ được mô hình chính nhìn thấy */
export const ITEMS_TAG = 'bbs_items';
/** Thẻ chú thích biến động biến số: cùng cơ chế với bbs_items, ghi biến động ròng của biến tùy chỉnh tầng này, để mô hình chính thấy "đã sửa rồi" tránh sửa lặp lại */
export const VARS_TAG = 'bbs_vars';

/**
 * Giao thức định dạng đầy đủ dùng chung cho mọi "prompt sản sinh mốc thời gian".
 * Khi ngày tháng dạng số thiếu năm thì dù miễn cưỡng phân tích được tháng ngày, nhưng thời gian tương đối qua năm và thứ trong tuần đều không đáng tin cậy, nên cấm lược bỏ ngay từ nguồn.
 */
export const RULE_COMPLETE_TIME_ANCHOR = `【Định dạng mốc thời gian đầy đủ (Hệ thống bắt buộc)】
- Với đề tài hiện đại, dương lịch hoặc các đề tài khác dùng ngày tháng bằng số, mỗi một mốc thời gian đều bắt buộc phải viết thành định dạng “YYYY/M/D HH:mm” có bao gồm đầy đủ năm (ví dụ 1988/9/29 21:30), không được lược bỏ năm.
- Nghiêm cấm chỉ viết các định dạng rút gọn lược bỏ năm hoặc ngày tháng như “9/29 21:30”, “ngày 29 tháng 9 21:30”, “21:30”, “cùng ngày 21:30”, v.v.
- Thời gian bắt đầu và thời gian kết thúc bắt buộc phải tự lặp lại đầy đủ ngày tháng và năm ở mỗi đầu; cho dù cả hai cùng năm, cùng tháng, cùng ngày cũng không được lược bỏ ở bất kỳ đầu nào.
- Khi mốc chuẩn thời gian đã có bao gồm năm hoặc kỷ nguyên, phần tiếp theo bắt buộc phải kế thừa nguyên vẹn và giữ lại năm hoặc kỷ nguyên đó, không được tự ý viết tắt hoặc làm mất.
- Khi mở đầu câu chuyện chưa có bất kỳ mốc chuẩn thời gian nào, bắt buộc phải thiết lập ngay một lần thời gian bắt đầu có bao gồm đầy đủ năm, sau đó tiếp tục dùng xuyên suốt.
- Đề tài cổ phong, kỳ ảo và các đề tài phi dương lịch khác không bắt buộc dùng số dương lịch, nhưng mỗi mốc thời gian đều phải giữ đầy đủ kỷ nguyên và năm (ví dụ “Khánh Lịch năm thứ tư cuối xuân · giờ Thìn ba khắc”), không được chỉ viết tháng, ngày, mùa hoặc canh giờ.`;

/** Giá trị mặc định của prompt cố định tiêm vào đối thoại chính (có thể ghi đè trong phần cài đặt). */
export const TIME_TAG_PROMPT = `【Yêu cầu mốc thời gian (Hệ thống bắt buộc)】
Ở ngay đầu tiên và ngay cuối cùng của chính văn mỗi lần bạn xuất ra, hãy đặt một thẻ thời gian, ghi rõ thời điểm bắt đầu và thời điểm kết thúc của đoạn cốt truyện này:

<${START_TAG}>1988/9/29 21:30</${START_TAG}>
(Chính văn……)
<${END_TAG}>1988/9/29 21:45</${END_TAG}>

Quy tắc:
- Thời gian phải cụ thể, định vị rõ ràng được, phong cách nhất quán với thế giới quan của chính văn: đề tài hiện đại dùng ngày giờ bằng số (ví dụ 1988/9/29 21:30); đề tài cổ phong/kỳ ảo dùng kỷ nguyên và canh giờ tương ứng (ví dụ Khánh Lịch năm thứ tư cuối xuân · giờ Thìn ba khắc). Trọng tâm là "định vị được đến một thời khắc cụ thể", không ép buộc dùng chữ số Ả Rập.
- Cấm các cách nói mơ hồ không thể định vị đến thời khắc cụ thể như "lát sau", "không lâu sau", "một ngày nọ", "cùng ngày", v.v.
- Lấy thời gian kết thúc của đoạn trước làm chuẩn, kết hợp với cốt truyện đoạn này để đẩy thời gian tiến lên hợp lý (trò chuyện khoảng vài phút, dùng bữa khoảng một tiếng, qua đêm bước sang ngày hôm sau, v.v.).
- Nếu đây là mở đầu câu chuyện, trước đó chưa có bất kỳ thời gian đã biết nào, xin bạn tự thiết lập một thời khắc bắt đầu cụ thể phù hợp với thế giới quan này, sau đó lấy đó làm chuẩn để đẩy tiếp —— đây là thiết lập hợp lý cần thiết để xây dựng mốc thời gian cho hệ thống trí nhớ, không tính là bịa đặt; nhưng tuyệt đối không được dùng từ giữ chỗ không thể định vị như "một ngày nọ" để làm qua loa.
- Mỗi thẻ chỉ xuất hiện một lần, lần lượt bám sát ngay đầu tiên và ngay cuối cùng của chính văn; bên trong thẻ chỉ có thời gian, đừng viết gì khác.
- Hai thẻ này là mốc neo để hệ thống trí nhớ đọc, xin nhất định phải xuất ra mỗi lần.

${RULE_COMPLETE_TIME_ANCHOR}

【Định dạng không cần xuất ra】
Trạng thái hiện tại bên trong bản tin mật là nội dung plugin trí nhớ cung cấp để hỗ trợ bạn nắm bắt văn cảnh phía trước, chứ không phải định dạng yêu cầu bạn xuất ra ở cuối chính văn, dù bất cứ lúc nào cũng tuyệt đối không được xuất bản tin mật ở cuối chính văn.

${LEDGER_PROTOCOL}`;

/** Prompt cố định đang có hiệu lực (ưu tiên tùy chỉnh của người dùng, nếu trống thì dùng mặc định tích hợp sẵn). */
export function timeTagPrompt(): string {
  const custom = apiSettings.prompts.timeTag.trim();
  return custom || TIME_TAG_PROMPT;
}

// Regex dùng để phân tích: chấp nhận chữ hoa/thường ở tên thẻ và khoảng trắng đầu cuối; lấy văn bản bên trongแบบ non-greedy.
const RE_START = new RegExp(`<${START_TAG}\\b[^>]*>([\\s\\S]*?)</${START_TAG}>`, 'i');
const RE_END = new RegExp(`<${END_TAG}\\b[^>]*>([\\s\\S]*?)</${END_TAG}>`, 'i');

/** Phân tích thời gian bắt đầu và kết thúc từ một đoạn chính văn; không lấy được thì là undefined (hạ cấp: bên gọi tự xử lý dự phòng). */
export function parseTimeRange(mes: string): { start?: string; end?: string } {
  const s = String(mes ?? '');
  const start = s.match(RE_START)?.[1]?.trim() || undefined;
  const end = s.match(RE_END)?.[1]?.trim() || undefined;
  return { start, end };
}

/**
 * "Thời gian mới nhất trong câu chuyện" hiện tại: quét từ cuối chat ngược lên trước, lấy thời gian phân tích được đầu tiên (ưu tiên end, thiếu thì lấy start).
 *
 * Tại sao không dùng trực tiếp memory.state.time dẫn xuất: cái đó chỉ phát lại các tầng "đã sinh lá", khi vài tầng mới nhất chưa tóm tắt thì nó dừng ở giá trị cũ.
 * Trong khi chính văn tầng AI mới nhất vốn đã mang <bbs_end>, ở đây đọc trực tiếp nó, bất kể đã tóm tắt hay chưa đều lấy được thời gian mới nhất thực sự.
 *
 * Thứ tự ưu tiên lấy giá trị (mỗi tin nhắn): ① Thẻ <bbs_start>/<bbs_end> trong chính văn (có thẩm quyền nhất, không bị ảnh hưởng bởi việc đã tóm tắt hay chưa);
 *   ② Khi thiếu thẻ thì lùi về timeEnd/timeStart của lá tầng đó —— bao phủ kịch bản "tóm tắt bù đoạn chat cũ": chính văn những tầng đó
 *   không có thẻ thời gian (sinh ra trước khi dùng plugin), nhưng việc tóm tắt bù đã ghi thời gian vào lá. Thiếu lớp dự phòng này, toàn bộ thời gian tương đối trên trang sẽ vì
 *   điểm tham chiếu (now) trống mà không hiển thị gì cả.
 * Công dụng: ① Hiển thị "Thời gian hiện tại" ở trang tóm tắt; ② Điểm tham chiếu ("hiện tại") của thời gian tương đối khi tiêm tóm tắt lịch sử.
 * Hoàn toàn không phân tích được (thuần hư cấu / không thẻ và không lá) → trả về chuỗi rỗng, bên gọi tự lùi về phương án dự phòng.
 */
export function latestStoryTime(chat: STMessage[] | null): string {
  if (!chat) return '';
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.extra?.bbs_omit) continue;
    if (typeof m?.mes !== 'string' || !m.mes) continue;
    // ① Ưu tiên thẻ trong chính văn
    const { start, end } = parseTimeRange(clampToTimeTags(m.mes));
    const tagTime = end || start;
    if (tagTime) return tagTime;
    // ② Thiếu thẻ → lùi về thời gian của lá hợp lệ tại tầng đó (tóm tắt bù chat cũ: chính văn không thẻ nhưng lá có thời gian)
    const leaf = m.extra?.bbs_leaf as LeafExtra | undefined;
    if (leaf?.id && leaf.delta && leafSwipeMatches(leaf, m)) {
      const leafTime = leaf.timeEnd?.trim() || leaf.timeStart?.trim();
      if (leafTime) return leafTime;
    }
  }
  return '';
}

/** Số trang của lá có khớp với swipe hiện tại hay không (cùng chuẩn với apply.leafValid; viết nội tuyến để tránh phụ thuộc vòng timeTag↔apply). */
function leafSwipeMatches(leaf: LeafExtra, m: STMessage): boolean {
  const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
  const msgSwipe = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
  return leafSwipe === msgSwipe;
}

/**
 * Tạo regex "xóa nguyên khối" theo tên thẻ (bao gồm bản thân thẻ và nội dung bên trong). tag đã được sanitizeTagName loại bỏ siêu ký tự regex,
 * ghép vào RegExp an toàn. Ranh giới dùng lookahead (?=[\s/>]) thay vì \b —— \b chỉ nhận ký tự từ ASCII, thẻ chữ tượng hình/Unicode
 * không có ranh giới từ giữa tên thẻ và `>` sẽ khớp thất bại; lookahead "sau tên thẻ phải theo sát bởi khoảng trắng / dấu gạch chéo / ngoặc nhọn đóng" đúng cho mọi ngôn ngữ,
 * và cũng ngăn <snow> ăn nhầm tiền tố của <snowball>. Đồng thời xóa cả khối có cặp lẫn thẻ đơn / thẻ tự đóng lẻ loi.
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // Khối có cặp đóng mở
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // Thẻ mở / đóng / tự đóng lẻ loi
  ];
}

/** Xóa bỏ các thẻ tùy chỉnh do người dùng cấu hình trong phần cài đặt (nguyên khối: thẻ + nội dung bên trong). Danh sách trống thì trả về nguyên bản. */
function stripCustomTags(s: string): string {
  let out = s;
  for (const tag of apiSettings.customStripTags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, '');
  }
  return out;
}

/**
 * Làm sạch một đoạn chính văn thành "đoạn chính văn sạch": loại bỏ định dạng và nhiễu bên ngoài chính văn, nhưng **không làm kiểu "xóa trần thẻ giữ lại nội dung"** ——
 * chỉ xóa nguyên khối các thẻ phi chính văn rõ ràng (chuỗi suy nghĩ / chú thích / horae cũ / chú thích vật phẩm / thẻ tùy chỉnh của người dùng), phần còn lại giữ nguyên.
 *
 * Hai bước:
 *  ① Xóa nguyên khối các thẻ nhiễu (bao gồm nội dung bên trong);
 *  ② Cắt gọn vào khoảng thẻ thời gian: lấy giữa "thẻ <bbs_start> cuối cùng" + "thẻ </bbs_end> đầu tiên" (giữ lại thẻ) ——
 *     chuỗi suy nghĩ / thanh trạng thái có thể lẫn thẻ cùng tên, thẻ bắt đầu lấy lần cuối, thẻ kết thúc lấy lần đầu, đóng khung chính xác đoạn chính văn thực sự;
 *     chỉ cắt khi thẻ tương ứng tồn tại, phía thiếu thẻ giữ nguyên (cả hai phía đều không có thì không cắt, bao phủ kịch bản "chat cũ không có thẻ").
 *     Các thẻ chứa khác như `<content>` không tham gia phán đoán ranh giới, tránh việc thẻ thời gian nằm ngoài thẻ chứa bị cắt mất sớm.
 *  ③ Chuẩn hóa khoảng trắng.
 *
 * Lưu ý: Trong lịch sử sau bước này còn nối thêm một bước stripHtml làm việc "xóa mọi thẻ giữ nội dung", ngược lại làm mất thẻ tùy chỉnh, khiến việc làm sạch nguyên khối mất tác dụng;
 * nay đã bỏ stripHtml, đổi sang chỉ xóa nguyên khối, giữ nguyên văn các thẻ còn lại (mô hình chính/phụ đều tiêu hóa được thẻ còn sót).
 */
// Regex khối chuỗi suy nghĩ (khối có cặp, gồm nội dung bên trong). Dùng chung cho clampToTimeTags và tiền làm sạch trước khi đưa vào kho vector, tránh lệch nhau ở hai nơi.
const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;

/**
 * Chỉ bóc tách khối chuỗi suy nghĩ <think>/<thinking> (bao gồm nội dung bên trong).
 * Dùng để tiền làm sạch **trước khi đưa vào kho vector**: chuỗi suy nghĩ là nhiễu tất định (không phụ thuộc cấu hình người dùng),
 * xóa lúc đưa vào kho vừa tiết kiệm dung lượng vừa không có rủi ro; còn việc làm sạch "cấu hình biến đổi" như thẻ tùy chỉnh vẫn để đến lúc truy xuất mới làm (để sửa cài đặt có hiệu lực tức thì).
 */
export function stripThinkBlocks(mes: string): string {
  return String(mes ?? '').replace(RE_THINK_BLOCK, '');
}

/** Vị trí kết thúc của lần khớp cuối cùng; không tìm thấy trả về -1. */
function lastRegexEnd(s: string, re: RegExp): number {
  let last = -1;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) last = m.index + m[0].length;
  return last;
}

/**
 * Hình thái an toàn của khối chú thích bên lề do plugin quản lý: thẻ mở / đóng đều đứng riêng một dòng.
 * Thẻ đóng ghép với thẻ mở đứng riêng dòng gần nhất, và nội dung khối bắt buộc phải giống dòng chú thích do plugin này viết ra.
 * Như vậy sẽ không nhận nhầm phần giải thích định dạng `<bbs_vars>` mà mô hình viết trong chuỗi suy nghĩ / chính văn thành đầu khối chú thích.
 */
interface LineSpan {
  start: number;
  end: number;
  text: string;
}

interface ManagedBlock {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

function lineSpans(s: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let pos = 0;
  while (pos < s.length) {
    const nl = s.indexOf('\n', pos);
    const end = nl >= 0 ? nl + 1 : s.length;
    const raw = s.slice(pos, end);
    lines.push({ start: pos, end, text: raw.replace(/\r?\n$/, '') });
    pos = end;
  }
  return lines;
}

function isManagedOpenLine(line: string, tag: string): boolean {
  return new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, 'i').test(line);
}

function isManagedCloseLine(line: string, tag: string): boolean {
  return new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, 'i').test(line);
}

function managedBlockLooksOwned(tag: string, inner: string): boolean {
  const lines = inner.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return false;
  const re = tag === ITEMS_TAG
    ? /^(Nhận|Tiêu hao|Mất|\u83b7\u5f97|\u6d88\u8017|\u5931\u53bb)\s+/
    : /^(Thiết lập|Thay đổi|Thêm mới|Xóa|\u8bbe\u5b9a|\u53d8\u66f4|\u65b0\u589e|\u5220\u9664)\s+/;
  return lines.every(line => re.test(line));
}

function managedBlocks(s: string, tag: string): ManagedBlock[] {
  const stack: Array<{ start: number; innerStart: number }> = [];
  const blocks: ManagedBlock[] = [];
  for (const line of lineSpans(s)) {
    if (isManagedOpenLine(line.text, tag)) {
      stack.push({ start: line.start, innerStart: line.end });
    } else if (isManagedCloseLine(line.text, tag) && stack.length) {
      const open = stack.pop()!;
      const inner = s.slice(open.innerStart, line.start);
      if (managedBlockLooksOwned(tag, inner)) {
        blocks.push({ start: open.start, end: line.end, innerStart: open.innerStart, innerEnd: line.start });
      }
    }
  }
  return blocks;
}

function stripManagedLineBlocks(region: string, tag: string): string {
  const blocks = managedBlocks(region, tag).sort((a, b) => b.start - a.start);
  let out = region;
  for (const b of blocks) out = out.slice(0, b.start) + out.slice(b.end);
  return out;
}

/** Dự phòng cho tin nhắn cũ không có thẻ thời gian: chỉ coi nhóm chú thích plugin liên tiếp ở cuối là khối được quản lý. */
function tailManagedGroupStart(s: string): number {
  const matches = [...managedBlocks(s, ITEMS_TAG), ...managedBlocks(s, VARS_TAG)]
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!matches.length) return -1;

  let pos = s.length;
  let start = -1;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (s.slice(m.end, pos).trim()) break;
    start = m.start;
    pos = m.start;
  }
  return start;
}

function managedRegionStart(s: string): number {
  const endPos = lastRegexEnd(s, RE_END_CLOSE_G);
  if (endPos >= 0) return endPos;
  return tailManagedGroupStart(s);
}

/** Chỉ xóa khối chú thích ở đuôi thực sự do plugin quản lý, không đụng đến văn bản thẻ cùng tên trong chính văn / chuỗi suy nghĩ. */
function stripManagedTag(mes: string, tag: string): string {
  const s = String(mes ?? '');
  const start = managedRegionStart(s);
  if (start < 0) return s;
  return s.slice(0, start) + stripManagedLineBlocks(s.slice(start), tag);
}

function stripManagedTags(mes: string): string {
  return stripManagedTag(stripManagedTag(mes, ITEMS_TAG), VARS_TAG);
}

function lastManagedBlockEnd(mes: string, tag: string): number {
  const s = String(mes ?? '');
  const start = managedRegionStart(s);
  if (start < 0) return -1;
  const blocks = managedBlocks(s.slice(start), tag);
  const last = blocks[blocks.length - 1];
  return last ? start + last.end : -1;
}

function readManagedTagText(mes: string, tag: string): string | null {
  const s = String(mes ?? '');
  const start = managedRegionStart(s);
  if (start < 0) return null;
  const block = managedBlocks(s.slice(start), tag)[0];
  return block ? s.slice(start + block.innerStart, start + block.innerEnd).trim() : null;
}

export function clampToTimeTags(mes: string): string {
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, '') // Chuỗi suy nghĩ
    .replace(/<!--[\s\S]+?-->/g, '') // Chú thích HTML
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, ''); // Định dạng horae cũ
  s = stripBaiBaiImageTags(s); // Thẻ Bách Bảo Hội (gồm prompt nhiều dòng); khi đứng riêng dòng thì khôi phục xuống dòng trước lúc chèn
  s = stripCustomTags(s); // Thẻ tùy chỉnh của người dùng
  s = stripManagedTags(s); // Chỉ dọn dẹp chú thích ở đuôi do plugin quản lý

  // Vị trí <bbs_start> cuối cùng: quét toàn cục một lượt lấy lần cuối
  const startRe = new RegExp(`<${START_TAG}\\b`, 'gi');
  let lastStart = -1;
  for (let m = startRe.exec(s); m; m = startRe.exec(s)) lastStart = m.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  // </bbs_end> đầu tiên (tìm trong chuỗi đã cắt tiền tố)
  const endMatch = s.match(new RegExp(`</${END_TAG}>`, 'i'));
  if (endMatch && endMatch.index !== undefined) {
    s = s.slice(0, endMatch.index + endMatch[0].length);
  }
  // Chuẩn hóa khoảng trắng (vốn do stripHtml phụ trách, nay tích hợp sẵn)
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cổng làm sạch chính văn thống nhất (thay thế chuỗi stripHtml cũ): cắt gọn đoạn chính văn → chuyển thẻ thời gian thành văn bản dễ đọc.
 * Tạo tóm tắt, quét sách thế giới, tiêm truy xuất vector đều đi qua hàm này, đảm bảo thống nhất tiêu chuẩn; không còn "xóa trần thẻ", thẻ còn sót giữ nguyên văn.
 */
export function cleanBody(mes: string): string {
  return inlineTimeTags(clampToTimeTags(mes));
}

/**
 * Chuyển thẻ thời gian trong chính văn thành văn bản nội tuyến dễ đọc (bước cuối cùng của cleanBody).
 * Thẻ thời gian <bbs_start>…</bbs_start> không nằm trong diện "xóa nguyên khối", nhưng hình thái ngoặc nhọn của nó không thân thiện với mô hình,
 * nên chuyển thành văn bản thuần "(Thời gian bắt đầu:X)/(Thời gian kết thúc:X)", giữ lại thông tin thời gian mà bỏ đi vỏ thẻ.
 */
export function inlineTimeTags(mes: string): string {
  return String(mes ?? '')
    .replace(RE_START, (_, t) => `(Thời gian bắt đầu:${String(t).trim()})`)
    .replace(RE_END, (_, t) => `(Thời gian kết thúc:${String(t).trim()})`);
}

// "Ranh giới phân cách" dùng để nén khoảng thời gian: lùi tiền tố chung về sau các ký tự này, tránh cắt vào giữa token.
// Chỉ gồm dấu phân cách giữa "đoạn ngày / đoạn giờ" (khoảng trắng / - và đơn vị ngày tháng năm),
// cố ý không gồm : và giờ/khắc —— vì sẽ cắt vụn cả giờ phút như 06:45 (cắt thành 55), ở đây chỉ muốn nén bỏ tiền tố ngày tháng bị lặp.
const RANGE_BOUNDARY = /[\s/／\-－\u5e74\u6708\u65e5]/;

/**
 * Nén khoảng thời gian "bắt đầu - kết thúc": xóa bỏ tiền tố bị lặp lại với thời gian bắt đầu ở trong thời gian kết thúc (đa phần là ngày tháng),
 * giúp "2023/9/10 06:45 - 2023/9/10 06:55" hiển thị thành "2023/9/10 06:45 - 06:55".
 *
 * Cách làm tổng quát (không phân tích định dạng ngày cụ thể): lấy tiền tố chung dài nhất giữa đầu và cuối, lùi về ranh giới phân cách gần nhất (bao gồm cả ranh giới),
 * xóa đoạn tiền tố này khỏi thời gian kết thúc. Định dạng chuẩn lẫn cổ phong ("Khánh Lịch năm thứ tư mùa xuân giờ Thìn") đều áp dụng được;
 * khi tiền tố hai chuỗi không trùng nhau thì không nén được, giữ nguyên toàn chuỗi —— không làm hỏng nhầm, không cần phán đoán "có phân tích được hay không".
 */
function compactPair(a: string, b: string): string {
  if (!a || !b) return a || b || '';
  if (a === b) return a;
  if (a.startsWith(b)) return a; // Thời gian kết thúc là tiền tố của thời gian bắt đầu (không có thông tin mới) → chỉ hiển thị bắt đầu
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n++;
  // Lùi về sau ký tự ranh giới cuối cùng bên trong tiền tố chung
  let cut = 0;
  for (let i = 0; i < n; i++) if (RANGE_BOUNDARY.test(a[i])) cut = i + 1;
  const tail = b.slice(cut).trim();
  return tail ? `${a} - ${tail}` : a;
}

/**
 * Định dạng thời gian bắt đầu và kết thúc thành chuỗi khoảng thời gian để hiển thị:
 *  - Có cả hai và khác nhau → "start - end" đã nén; có cả hai và giống nhau → "start"; chỉ có một → cái đó; không có cả hai → ''.
 */
export function formatRange(start?: string, end?: string): string {
  const a = start?.trim();
  const b = end?.trim();
  if (a && b) return compactPair(a, b);
  return a || b || '';
}

/**
 * Nén lại một lần nữa nhãn hiển thị đã lưu thành chuỗi đầy đủ ("bắt đầu - kết thúc"), dùng cho hiển thị danh sách.
 * Dùng cho dữ liệu lịch sử: timeLabel của tóm tắt cũ đã cố định thành chuỗi đầy đủ, khi hiển thị thì nén tức thì, không cần di chuyển dữ liệu.
 * Bất biến (idempotent) với nhãn đã nén (cắt rồi nén lại kết quả không đổi). Chuỗi đơn điểm không có phân cách " - " trả về nguyên bản.
 */
export function compactTimeLabel(label: string): string {
  const s = String(label ?? '').trim();
  const i = s.indexOf(' - ');
  if (i < 0) return s;
  return compactPair(s.slice(0, i).trim(), s.slice(i + 3).trim());
}

/**
 * Tách timeLabel đã cố định thành một trường đơn trong dữ liệu cũ về lại {start,end}, phục vụ di chuyển sang timeStart/timeEnd.
 * Chuỗi đơn điểm không có phân cách " - " → start=end=chuỗi đó. Chuỗi rỗng → cả hai đều undefined.
 */
export function splitTimeLabel(label?: string): { start?: string; end?: string } {
  const s = String(label ?? '').trim();
  if (!s) return {};
  const i = s.indexOf(' - ');
  if (i < 0) return { start: s, end: s };
  return { start: s.slice(0, i).trim() || undefined, end: s.slice(i + 3).trim() || undefined };
}

// Dùng để định vị "</bbs_end> cuối cùng" (quét toàn cục, lấy lần cuối): thẻ thời gian ở cuối chính văn mới là kết thúc cốt truyện thực sự,
// chuỗi suy nghĩ / thanh trạng thái có thể trộn thẻ cùng tên ở phía trước, nên không thể dùng cái đầu tiên (xem cân nhắc tương tự ở clampToTimeTags).
const RE_END_CLOSE_G = new RegExp(`</${END_TAG}>`, 'gi');

/**
 * Ghi chú thích biến động vật phẩm vào chính văn: trước tiên xóa khối <bbs_items> cũ (bất biến, tóm tắt lại / tạo lại không bị chồng lớp),
 * sau đó chèn khối mới vào sau thẻ </bbs_end> **cuối cùng** (không có thẻ end thì nối vào cuối).
 * inline trống → chỉ xóa khối cũ, không ghi khối mới (khi tầng này không có biến động vật phẩm).
 * Trả về chính văn sau khi xử lý (bên gọi chịu trách nhiệm ghi trả lại vào mes).
 */
export function writeItemLogTag(mes: string, inline: string): string {
  // Chế độ chỉ tóm tắt không đụng vào chính văn: vừa không thêm chú thích mới, vừa không chủ động dọn chú thích cũ trong các tầng đã có.
  if (apiSettings.summaryOnlyMode) return mes;

  let s = stripManagedTag(mes, ITEMS_TAG);
  const text = inline.trim();
  if (!text) return s;
  // Thẻ và nội dung mỗi thứ đứng riêng một dòng, trước khối để dòng trống, trình bày gọn gàng và không dính liền với thẻ thời gian
  const block = `<${ITEMS_TAG}>\n${text}\n</${ITEMS_TAG}>`;
  const lastEnd = lastRegexEnd(s, RE_END_CLOSE_G);
  if (lastEnd >= 0) {
    return `${s.slice(0, lastEnd)}\n${block}${s.slice(lastEnd)}`;
  }
  return `${s.trimEnd()}\n${block}`;
}

/**
 * Đọc văn bản bên trong khối <bbs_items> của chính văn (bỏ khoảng trắng đầu cuối).
 * Không có khối trả về null (phân biệt với "có khối nhưng trống" —— trường hợp sau trả về ''), để khi phân tích ngược biết được người dùng có xóa cả khối hay không.
 */
export function readItemsTagText(mes: string): string | null {
  return readManagedTagText(mes, ITEMS_TAG);
}

/**
 * Ghi chú thích biến động biến số vào chính văn: trước tiên xóa khối <bbs_vars> cũ (bất biến), sau đó chèn vào **sau khối vật phẩm** (không có khối vật phẩm thì sau </bbs_end> cuối cùng,
 * vẫn không có nữa thì nối vào cuối). Cùng kiểu với writeItemLogTag, chỉ khác là mốc chèn ưu tiên khối vật phẩm, để hai khối items/vars nằm cạnh nhau, bố cục ổn định.
 * inline trống → chỉ xóa khối cũ không ghi khối mới. Trả về chính văn sau khi xử lý.
 */
export function writeVarLogTag(mes: string, inline: string): string {
  // Cùng tiêu chuẩn với chú thích vật phẩm, mọi đường dẫn tự động tóm tắt, tóm tắt lại và chỉnh sửa trong tầng đều thống nhất ngừng ghi trả lại.
  if (apiSettings.summaryOnlyMode) return mes;

  const s = stripManagedTag(mes, VARS_TAG);
  const text = inline.trim();
  if (!text) return s;
  const block = `<${VARS_TAG}>\n${text}\n</${VARS_TAG}>`;
  // Ưu tiên mốc neo: vị trí kết thúc </bbs_items> cuối cùng; nếu không thì </bbs_end> cuối cùng; cả hai đều không có thì nối vào cuối
  const anchor = lastManagedBlockEnd(s, ITEMS_TAG);
  const pos = anchor >= 0 ? anchor : lastRegexEnd(s, RE_END_CLOSE_G);
  if (pos >= 0) return `${s.slice(0, pos)}\n${block}${s.slice(pos)}`;
  return `${s.trimEnd()}\n${block}`;
}

/** Đọc văn bản bên trong khối <bbs_vars> của chính văn (bỏ khoảng trắng đầu cuối); không có khối trả về null (phục vụ phân tích ngược phán đoán xem người dùng có xóa cả khối hay không). */
export function readVarsTagText(mes: string): string | null {
  return readManagedTagText(mes, VARS_TAG);
}

/* ============ Tự động đăng ký regex "chỉ ẩn ở tầng hiển thị" vào ST ============ */

// Kịch bản regex toàn cục của ST lưu tại extension_settings.regex (mảng). Mỗi loại thẻ dùng id cố định độc lập, đảm bảo tính bất biến (idempotent).
// Kịch bản thời gian giữ lại id lịch sử 'bbs-time-tag-hide': khi nâng cấp, quy tắc gộp ban đầu sẽ thu hẹp tại chỗ thành quy tắc thời gian,
// không để sót lại quy tắc cũ rồi tạo thêm một quy tắc trùng lặp.
const HIDE_TIME_SCRIPT_ID = 'bbs-time-tag-hide';
const HIDE_ITEMS_SCRIPT_ID = 'bbs-items-tag-hide';
const HIDE_VARS_SCRIPT_ID = 'bbs-vars-tag-hide';
// regex_placement (xem ST regex/engine.js): 0=MD_DISPLAY 1=USER_INPUT 2=AI_OUTPUT
const PLACEMENT_MD_DISPLAY = 0;
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;

/** Thẻ thời gian chỉ cho phép đóng trong cùng một dòng; hai thẻ viết thành nhánh hoàn chỉnh, không ghép chéo nhau. */
function hideTimeFindRegex(): string {
  const start = `<${START_TAG}\\b[^>\\r\\n]*>[^<\\r\\n]*<\\/${START_TAG}>`;
  const end = `<${END_TAG}\\b[^>\\r\\n]*>[^<\\r\\n]*<\\/${END_TAG}>`;
  return `/${start}|${end}/gi`;
}

/** Chú thích vật phẩm cho phép qua nhiều dòng, nhưng chỉ ẩn khối hoàn chỉnh "đứng riêng dòng + định dạng động từ vật phẩm của plugin". */
function hideItemsFindRegex(): string {
  const items = `(^|\\r?\\n)[ \\t]*<${ITEMS_TAG}\\b[^>]*>[ \\t]*\\r?\\n(?:[ \\t]*(?:Nhận|Tiêu hao|Mất|\\u83b7\\u5f97|\\u6d88\\u8017|\\u5931\\u53bb)\\s+[^\\r\\n]*(?:\\r?\\n))+[ \\t]*<\\/${ITEMS_TAG}>[ \\t]*(?=\\r?\\n|$)`;
  return `/${items}/gi`;
}

/** Chú thích biến số cho phép qua nhiều dòng, nhưng chỉ ẩn khối hoàn chỉnh "đứng riêng dòng + định dạng động từ biến số của plugin". */
function hideVarsFindRegex(): string {
  const vars = `(^|\\r?\\n)[ \\t]*<${VARS_TAG}\\b[^>]*>[ \\t]*\\r?\\n(?:[ \\t]*(?:Thiết lập|Thay đổi|Thêm mới|Xóa|\\u8bbe\\u5b9a|\\u53d8\\u66f4|\\u65b0\\u589e|\\u5220\\u9664)\\s+[^\\r\\n]*(?:\\r?\\n))+[ \\t]*<\\/${VARS_TAG}>[ \\t]*(?=\\r?\\n|$)`;
  return `/${vars}/gi`;
}

/**
 * Đảm bảo trong ST tồn tại ba regex ẩn chỉ ảnh hưởng đến việc hiển thị.
 * Bất biến (idempotent): tra cứu từng mục theo id cố định, thiếu thì bù, đã có thì cập nhật nội dung (tránh sót định dạng bản cũ). Người dùng xóa thủ công thì lần khởi động sau sẽ tự thêm lại.
 */
export function ensureHideRegexRegistered(): void {
  const ctx = getContext();
  const es = ctx?.extensionSettings as Record<string, unknown> | undefined;
  if (!es) return;
  if (!Array.isArray(es.regex)) es.regex = [];
  const list = es.regex as Array<Record<string, unknown>>;

  const common = {
    replaceString: '',
    trimStrings: [] as string[],
    // Chỉ tác dụng lên "hiển thị": MD_DISPLAY; đồng thời dọn sạch thẻ sót lại trong hiển thị đầu vào người dùng / đầu ra AI, nhưng không đi vào prompt.
    placement: [PLACEMENT_MD_DISPLAY, PLACEMENT_USER_INPUT, PLACEMENT_AI_OUTPUT],
    disabled: false,
    markdownOnly: true, // = Chỉ định dạng hiển thị, không viết lại prompt gửi cho mô hình (then chốt: thẻ bắt buộc phải nằm lại trong prompt)
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };

  const scripts = [
    {
      ...common,
      id: HIDE_TIME_SCRIPT_ID,
      scriptName: 'Bách Bảo Thư · Ẩn thẻ thời gian',
      findRegex: hideTimeFindRegex(),
    },
    {
      ...common,
      id: HIDE_ITEMS_SCRIPT_ID,
      scriptName: 'Bách Bảo Thư · Ẩn thẻ vật phẩm',
      findRegex: hideItemsFindRegex(),
    },
    {
      ...common,
      id: HIDE_VARS_SCRIPT_ID,
      scriptName: 'Bách Bảo Thư · Ẩn thẻ biến số',
      findRegex: hideVarsFindRegex(),
    },
  ];

  for (const script of scripts) {
    const idx = list.findIndex(s => s?.id === script.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...script };
    else list.push(script);
  }
  ctx?.saveSettingsDebounced?.();
}

/** Gỡ bỏ toàn bộ regex ẩn mà chúng ta đã đăng ký (gọi khi tắt tính năng thẻ thời gian). */
export function removeHideRegex(): void {
  const ctx = getContext();
  const es = ctx?.extensionSettings as Record<string, unknown> | undefined;
  if (!es || !Array.isArray(es.regex)) return;
  const list = es.regex as Array<Record<string, unknown>>;
  const ids = new Set([HIDE_TIME_SCRIPT_ID, HIDE_ITEMS_SCRIPT_ID, HIDE_VARS_SCRIPT_ID]);
  const next = list.filter(s => !ids.has(String(s?.id ?? '')));
  if (next.length !== list.length) {
    es.regex = next;
    ctx?.saveSettingsDebounced?.();
  }
}

/**
 * Đồng bộ tác dụng phụ của tính năng thẻ thời gian (gọi khi công tắc thay đổi hoặc lúc khởi động):
 *  - Bật: đăng ký regex ẩn; Tắt: gỡ bỏ. Việc tiêm prompt do refreshInjection của inject.ts phụ trách.
 * Đi theo công tắc "Tự động tóm tắt" (thẻ thời gian không còn tách riêng).
 */
export function syncTimeTagRegex(): void {
  if (apiSettings.autoSummaryEnabled) ensureHideRegexRegistered();
  else removeHideRegex();
}
