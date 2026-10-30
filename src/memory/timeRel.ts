/**
 * Suy đoán "thời gian tương đối" của thời gian trong truyện —— chuyển đổi từ timeUtils của plugin cũ Horae, chuẩn hóa sang tiếng Việt.
 *
 * Công dụng: Khi tiêm tóm tắt lịch sử và hiển thị ở trang tóm tắt, thêm một tiền tố tương đối trước thời gian tuyệt đối (như "Hôm qua", "3 ngày trước"),
 * giúp cả mô hình chính lẫn người dùng đều cảm nhận trực quan "đoạn cốt truyện này cách hiện tại bao lâu".
 *
 * Nguyên tắc thiết kế (kế thừa Horae): Thời gian là văn bản tự do do AI viết.
 *  - Lịch số (1988/9/29, ngày 29 tháng 9 năm 1988, 9/29, năm X tháng M ngày D có tiền tố lịch pháp) → tính chính xác độ lệch số ngày.
 *  - Lịch hư cấu (tên tháng phi chữ số như Tháng Sương ngày 3, chứa ký tự giữ chỗ XX/??) → chỉ tính được khi cùng tháng, khác tháng hư cấu thì bỏ qua.
 *  - Thuần canh giờ không có ngày tháng, hoàn toàn không phân tích ra → trả về chuỗi rỗng, bên gọi hạ cấp thành "không thêm tiền tố".
 * Tóm lại một câu: Thà không gắn nhãn, tuyệt đối không gắn nhãn sai.
 */

/** Thứ trong tuần tiếng Việt (0 = Chủ nhật) */
const WEEKDAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

/** Ngày tháng trong truyện phân tích ra được: standard có thể quy đổi chính xác, fantasy chỉ so sánh được trong cùng tháng */
interface StoryDate {
  type: 'standard' | 'fantasy';
  year?: number;
  month?: number;
  day?: number | null;
  /** Định danh tháng hư cấu (như "Tháng Sương"), dùng để đối chiếu khác tháng trong fantasy */
  monthId?: string;
  /** Tiền tố lịch pháp (như "Khánh Lịch"), chỉ dùng để hiển thị, không tham gia quy đổi */
  calendarPrefix?: string;
  raw?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Dấu phân cách trang trí cho phép xuất hiện giữa các trường ngày tháng có đơn vị "năm/tháng/ngày".
 *
 * AI thường viết kỷ nguyên thành "Nguyên Hội Lịch·3728·2·1" hoặc "2024／9／30".
 * Ở đây chỉ cho phép khoảng trắng và các dấu chấm, gạch chéo, dấu phẩy, gạch ngang phổ biến, và bắt buộc phải nằm ở ranh giới đơn vị rõ ràng năm→tháng / tháng→ngày,
 * không thay thế toàn cục, tránh làm hỏng nhầm tiền tố lịch pháp và tên tháng hư cấu.
 */
const DATE_FIELD_SEPARATOR = '[\\s·・•‧∙⋅.．。﹒/／,，、_\\-—–－]*';

/** Chuẩn hóa các dấu phân cách ngày tháng như dấu chấm toàn giác / chấm câu thành /, để các regex phía sau xử lý thống nhất */
function normalizeNumericDateSeparators(dateStr: string): string {
  if (!dateStr) return dateStr;
  return dateStr
    // Định dạng dài (từ năm 4 chữ số trở lên): sau số ngày chỉ cần không nối tiếp số/dấu chấm là nhận, chấp nhận theo sau bởi dấu phẩy, chữ, dấu ngoặc, v.v.
    // (như "2025.11.1, nhiều mây", "2025.11.1 nắng"); mở đầu bằng năm 4 chữ số hầu như không bao giờ là số thập phân/số phiên bản, nới lỏng rất an toàn.
    .replace(/^(\d{4,})[.．。﹒](\d{1,2})[.．。﹒](\d{1,2})(?![\d.．。﹒])/, '$1/$2/$3')
    // Định dạng ngắn (M.D): độ nhập nhằng lớn ("1.5 tiếng" là số thập phân không phải ngày tháng), vẫn yêu cầu theo sau bởi khoảng trắng hoặc kết thúc chuỗi, giữ thận trọng.
    .replace(/^(\d{1,2})[.．。﹒](\d{1,2})(?=$|\s)/, '$1/$2');
}

/** Trông giống ngày tháng bằng số có cấu trúc (dùng để loại trừ việc phán đoán nhầm thành lịch hư cấu) */
function looksLikeStructuredNumericDate(dateStr: string): boolean {
  if (!dateStr) return false;
  return (
    /^(?:\d{4,}[/.\-．。﹒]\d{1,2}[/.\-．。﹒]\d{1,2}|\d{1,2}[/.\-．。﹒]\d{1,2})(?=$|\s)/.test(dateStr) ||
    new RegExp(
      `^\\d+\\s*\\u5e74${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*\\u6708${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*\\u65e5?(?=$|\\s)`,
    ).test(dateStr) ||
    new RegExp(`^\\d{1,2}\\s*\\u6708${DATE_FIELD_SEPARATOR}\\d{1,2}\\s*\\u65e5?(?=$|\\s)`).test(dateStr)
  );
}

/** Rút trích "số ngày" từ chuỗi ngày tháng hư cấu (ưu tiên số Ả Rập, không có thì lấy số đầu tiên) */
function extractDayNumber(dateStr: string): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/(?:ngày|mùng)\s*(\d+)/i)
    || dateStr.match(/(\d+)\s*[\u65e5\u53f7]/)
    || dateStr.match(/\u7b2c\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const any = dateStr.match(/(\d+)/);
  if (any) return parseInt(any[1], 10);
  return null;
}

/** Rút trích "định danh tháng" từ chuỗi ngày tháng hư cấu (như "Tháng Sương") */
function extractMonthIdentifier(dateStr: string): string | null {
  if (!dateStr) return null;
  const vi = dateStr.match(/(tháng\s+[^\s\d,，.。·]+)/i);
  if (vi) return vi[1].trim();
  const m = dateStr.match(/([^\s\d]+\u6708)/);
  if (m) return m[1];
  const num = dateStr.match(/(?:\d{4}[/\-])?(\d{1,2})[/\-]\d{1,2}/);
  if (num) return num[1] + '\u6708';
  return null;
}

/** Chữ số Hán tự → giá trị (0-9); giữ tương thích cho dữ liệu/kỷ nguyên cổ phong */
const CN_DIGIT: Record<string, number> = {
  '\u3007': 0, '\u96f6': 0, '\u4e00': 1, '\u4e8c': 2, '\u4e24': 2, '\u4e09': 3,
  '\u56db': 4, '\u4e94': 5, '\u516d': 6, '\u4e03': 7, '\u516b': 8, '\u4e5d': 9,
};

/** Tập ký tự chữ số cổ phong (dùng để ghép regex; gồm cả 20, 30 viết tắt) */
const CN_NUM_CLASS = '[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341\\u4e24\\u96f6\\u3007\\u5eff\\u5345]';

/**
 * Phân tích chữ số 1-99; số Ả Rập thuần thì parseInt trực tiếp.
 * Chỉ bao phủ phạm vi cần thiết cho ngày / tháng / năm nhỏ, thất bại trả về null.
 */
function cnNumToInt(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Tiền tố âm lịch (mùng): mùng 1~mùng 9=hàng đơn vị, mùng 10=10. Bóc bỏ tiền tố mùng rồi giao cho phần dưới phân tích bình thường.
  const str = s
    .replace(/^\u521d/, '')
    .replace(/\u5eff/g, '\u4e8c\u5341')
    .replace(/\u5345/g, '\u4e09\u5341'); // Mở rộng chữ viết tắt 20/30 thành hai mươi/ba mươi
  if (!str) return null; // Chỉ có tiền tố mùng không có số
  // Có chứa hàng chục: xử lý trước, bao phủ 10, 15, 20, 21...; chữ đơn 10 cũng đi lối này
  const shiIdx = str.indexOf('\u5341');
  if (shiIdx >= 0) {
    const tens = shiIdx === 0 ? 1 : CN_DIGIT[str[shiIdx - 1]];
    const onesPart = str.slice(shiIdx + 1);
    const ones = onesPart ? CN_DIGIT[onesPart] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (str.length === 1) return CN_DIGIT[str] ?? null; // Hàng đơn vị thuần
  return null; // Không có hàng chục lại không phải chữ đơn → ngoài phạm vi hỗ trợ
}

/** Phân tích chuỗi ngày tháng trong truyện; không phân tích ra trả về null */
export function parseStoryDate(dateStr: string): StoryDate | null {
  if (!dateStr) return null;
  let s = dateStr.trim();
  // Bỏ ghi chú thứ trong tuần do AI viết như "(T4)" hoặc "(Thứ tư)"
  s = s.replace(/\s*\((?:[\u65e5\u4e00\u4e8c\u4e09\u56db\u4e94\u516d]|Thứ\s+[^\)]+|Chủ\s+nhật|CN)\)\s*/gi, ' ').trim();
  s = normalizeNumericDateSeparators(s);

  // Chứa ký tự giữ chỗ XX/?? → lịch hư cấu
  if (/[xX]{2}|[?？]{2}/.test(s)) {
    return { type: 'fantasy', raw: dateStr.trim() };
  }

  // Chuẩn: YYYY/M/D
  const full = s.match(/^(\d{4,})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (full) {
    const year = parseInt(full[1], 10);
    const month = parseInt(full[2], 10);
    const day = parseInt(full[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day, type: 'standard' };
  }

  // Chuẩn: M/D
  const short = s.match(/^(\d{1,2})[/\-](\d{1,2})(?:\s|$)/);
  if (short) {
    const month = parseInt(short[1], 10);
    const day = parseInt(short[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day, type: 'standard' };
  }

  // Định dạng tiếng Việt: [tiền tố] ngày D tháng M năm Y hoặc năm Y tháng M ngày D
  const viDmy = s.match(/(?:ngày|mùng)\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{1,4})/i);
  if (viDmy) {
    const day = parseInt(viDmy[1], 10);
    const month = parseInt(viDmy[2], 10);
    const year = parseInt(viDmy[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const prefixEnd = s.indexOf(viDmy[0]);
      const calendarPrefix = s.substring(0, prefixEnd).trim() || undefined;
      return { year, month, day, type: 'standard', calendarPrefix };
    }
  }
  const viYmd = s.match(/năm\s*(?:thứ\s*)?(\d{1,4})[\s,·.\-]*tháng\s*(\d{1,2})[\s,·.\-]*(?:ngày|mùng)\s*(\d{1,2})/i);
  if (viYmd) {
    const year = parseInt(viYmd[1], 10);
    const month = parseInt(viYmd[2], 10);
    const day = parseInt(viYmd[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const prefixEnd = s.indexOf(viYmd[0]);
      const calendarPrefix = s.substring(0, prefixEnd).trim() || undefined;
      return { year, month, day, type: 'standard', calendarPrefix };
    }
  }
  const viDm = s.match(/(?:ngày|mùng)\s*(\d{1,2})\s*tháng\s*(\d{1,2})(?!\s*năm)/i);
  if (viDm) {
    const day = parseInt(viDm[1], 10);
    const month = parseInt(viDm[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { month, day, type: 'standard' };
    }
  }

  // Trường số: số Ả Rập hoặc chữ số cổ phong (gồm 10/20/30), do cnNumToInt thống nhất phân tích.
  const NUM = `(?:\\d+|${CN_NUM_CLASS}+)`;
  // Trường ngày cho phép thêm tiền tố âm lịch (mùng); cnNumToInt sẽ bóc tiền tố mùng rồi phân tích.
  const DAY = `(?:\\u521d)?${NUM}`;

  // Chuẩn: Năm X tháng M ngày D (năm/tháng/ngày đều có thể là chữ số, kèm tiền tố lịch pháp tùy chọn)
  const yearCn = s.match(
    new RegExp(`(${NUM})\\s*\\u5e74${DATE_FIELD_SEPARATOR}(${NUM})\\s*\\u6708${DATE_FIELD_SEPARATOR}(${DAY})\\s*\\u65e5?`),
  );
  if (yearCn) {
    const year = cnNumToInt(yearCn[1]);
    const month = cnNumToInt(yearCn[2]);
    const day = cnNumToInt(yearCn[3]);
    if (year != null && month != null && day != null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const prefixEnd = s.indexOf(yearCn[0]);
      const calendarPrefix = s.substring(0, prefixEnd).trim() || undefined;
      return { year, month, day, type: 'standard', calendarPrefix };
    }
  }

  // Khi đã viết rõ năm nhưng không thể phân tích trọn vẹn, cấm tiếp tục hạ cấp thành tháng M ngày D không có năm.
  // Nếu không ngày tháng có năm bị lỗi định dạng sẽ âm thầm đánh rơi năm 3727, rồi đem so với một ngày không năm khác như thể cùng một năm,
  // hướng qua năm có thể bị đảo ngược hoàn toàn. Ở đây thà không gắn nhãn thời gian tương đối, chứ không đoán mò dựa trên ngày tháng khuyết tật.
  if (new RegExp(`(?:${NUM})\\s*\\u5e74`).test(s)) return null;

  // Chuẩn: Tháng M ngày D
  const cn = s.match(new RegExp(`(${NUM})\\s*\\u6708${DATE_FIELD_SEPARATOR}(${DAY})\\s*\\u65e5?`));
  if (cn) {
    const month = cnNumToInt(cn[1]);
    const day = cnNumToInt(cn[2]);
    if (month != null && day != null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { month, day, type: 'standard' };
    }
  }

  // Lịch hư cấu
  if (looksLikeStructuredNumericDate(s)) return null;
  const monthId = extractMonthIdentifier(s);
  const dayNum = extractDayNumber(s);
  if (monthId || dayNum !== null) {
    return { monthId: monthId ?? undefined, day: dayNum, type: 'fantasy', raw: dateStr.trim() };
  }

  return null;
}

/**
 * Tính độ lệch số ngày từ from→to (to - from, dương = to muộn hơn).
 * Không phân tích ra hoặc khác tháng hư cấu không thể phán đoán → trả về null.
 */
export function calculateRelativeDays(fromDate: string, toDate: string): number | null {
  if (!fromDate || !toDate) return null;

  // Trước tiên bóc bỏ thời khắc ở đuôi (15:00 / buổi chiều / giờ Dậu…), chỉ so sánh ngày tháng
  const stripTime = (x: string): string =>
    normalizeNumericDateSeparators(
      x
        .trim()
        .replace(/\s+\d{1,2}[:：]\d{2}.*$/, '')
        .replace(
          /\s+(rạng sáng|sáng sớm|buổi sáng|buổi trưa|buổi chiều|chập tối|buổi tối|đêm khuya|giờ\s+(?:tý|sửu|dần|mão|thìn|tỵ|ngọ|mùi|thân|dậu|tuất|hợi)|\u51cc\u6668|\u65e9\u4e0a|\u4e0a\u5348|\u4e2d\u5348|\u4e0b\u5348|\u508d\u665a|\u665a\u4e0a|\u6df1\u591c|\u5b50\u65f6|\u4e11\u65f6|\u5bc5\u65f6|\u536f\u65f6|\u8fb0\u65f6|\u5df3\u65f6|\u5348\u65f6|\u672a\u65f6|\u7533\u65f6|\u9149\u65f6|\u620c\u65f6|\u4ea5\u65f6).*$/i,
          '',
        )
        .trim(),
    );
  if (stripTime(fromDate) === stripTime(toDate)) return 0;

  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (!from || !to) return null;

  // Lịch chuẩn: tính chính xác (dùng setFullYear để tránh độ lệch của Date đối với năm nhỏ)
  if (from.type === 'standard' && to.type === 'standard') {
    const defaultYear = 2024;
    const fromYear = from.year || to.year || defaultYear;
    const toYear = to.year || from.year || defaultYear;
    const fromObj = new Date(0);
    fromObj.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
    const toObj = new Date(0);
    toObj.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
    return Math.round((toObj.getTime() - fromObj.getTime()) / DAY_MS);
  }

  // Lịch hư cấu: chỉ tính được khi cùng tháng, khác tên tháng hư cấu dễ phán đoán sai → bỏ qua
  if (from.type === 'fantasy' || to.type === 'fantasy') {
    const fromMonth = from.monthId ?? from.month;
    const toMonth = to.monthId ?? to.month;
    if (from.day != null && to.day != null) {
      if (fromMonth && toMonth && fromMonth !== toMonth) return null;
      return to.day - from.day;
    }
    return null;
  }

  return null;
}

/** Chuyển hai đầu của lịch chuẩn thành Date (phục vụ phán đoán ngữ nghĩa tuần/tháng/năm); bất kỳ bên nào không phải chuẩn thì trả về null */
function toDatePair(fromDate: string, toDate: string): { from: Date; to: Date } | null {
  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (from?.type !== 'standard' || to?.type !== 'standard') return null;
  const defaultYear = new Date().getFullYear();
  const fromYear = from.year || to.year || defaultYear;
  const toYear = to.year || from.year || defaultYear;
  const f = new Date(0);
  f.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
  const t = new Date(0);
  t.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
  return { from: f, to: t };
}

/** Tính độ lệch tuần lấy "Thứ hai" làm đầu tuần */
function weekDiffByMonday(from: Date, to: Date): number {
  const weekStart = (d: Date): number => {
    const wd = d.getDay();
    const offset = wd === 0 ? -6 : 1 - wd;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  };
  return Math.round((weekStart(to) - weekStart(from)) / WEEK_MS);
}

/** Độ lệch tháng tự nhiên */
function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * Tính "thứ mấy" (Chủ nhật…Thứ bảy) của một thời gian trong truyện, chỉ đưa ra khi là **dương lịch thuần số và có kèm năm**, nếu không trả về chuỗi rỗng.
 *
 * Ngưỡng nghiêm ngặt (cùng một bộ cân nhắc với mức khẩu ngữ thời gian tương đối, xem chú thích calendarPrefix của relativeTimeLabel):
 *  - Bắt buộc type==='standard': lịch hư cấu (Tháng Sương / chứa ký tự giữ chỗ XX) không tính ra thứ trong tuần.
 *  - Bắt buộc có year: cách viết không có năm như M/D không xác định được cụ thể ngày nào, không thể nói đến thứ mấy.
 *  - Bắt buộc không có calendarPrefix: Khánh Lịch / Nguyên Trì / Tinh Lịch… là kỷ nguyên cổ phong / cyberpunk, áp thứ trong tuần dương lịch vào vừa lạc quẻ,
 *    mà năm nhỏ (year=12) getDay() tính ra thứ thực tế của năm 12 Công nguyên, giá trị không kiểm soát được → nhất loạt không gắn nhãn.
 * Dùng setFullYear để tạo Date (tránh độ lệch của Date với năm nhỏ), giống hệt toDatePair.
 * Tóm lại một câu: Xác định được đến đúng một ngày dương lịch thì mới gắn nhãn thứ, nếu không thà không gắn.
 */
export function weekdayLabel(timeStr?: string): string {
  const s = timeStr?.trim();
  if (!s) return '';
  const d = parseStoryDate(s);
  if (!d || d.type !== 'standard' || d.year == null || d.calendarPrefix) return '';
  const obj = new Date(0);
  obj.setFullYear(d.year, (d.month ?? 1) - 1, d.day ?? 1);
  return WEEKDAY_NAMES[obj.getDay()];
}

/**
 * Định dạng "thời gian sự kiện event" so với "hiện tại now" thành văn bản tiền tố tương đối.
 * Không phân tích ra / không thể phán đoán → trả về chuỗi rỗng (bên gọi dựa vào đó không thêm tiền tố).
 */
export function relativeTimeLabel(eventTime?: string, nowTime?: string): string {
  const ev = eventTime?.trim();
  const now = nowTime?.trim();
  if (!ev || !now) return '';

  // days = now - event, dương = sự kiện ở quá khứ
  const days = calculateRelativeDays(ev, now);
  if (days === null || days === undefined) return '';

  if (days === 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  if (days === 2) return 'Hôm kia';
  if (days === 3) return 'Hôm kìa';
  if (days === -1) return 'Ngày mai';
  if (days === -2) return 'Ngày kia';
  if (days === -3) return 'Ngày kìa';

  // "Thứ X tuần trước / Ngày X tháng trước / Ngày X tháng X năm ngoái" v.v. là khẩu ngữ dương lịch, áp vào thời gian cổ phong / cyberpunk có tiền tố lịch pháp (Nguyên Trì / Khánh Lịch / Tinh Lịch…)
  // vừa lạc quẻ, mà getDay() đối với năm nhỏ còn tính loạn. Vì vậy khi có tiền tố thì không lấy pair → bỏ qua các mức này, hạ cấp thành "N ngày trước / N tháng trước / N năm trước" chung.
  // Ngày tháng thuần số (gồm cả thời gian cyberpunk như 2099/12/31) không có tiền tố, hiển thị mức khẩu ngữ bình thường theo dương lịch.
  const fromHasPrefix = !!parseStoryDate(ev)?.calendarPrefix;
  const toHasPrefix = !!parseStoryDate(now)?.calendarPrefix;
  const pair = fromHasPrefix || toHasPrefix ? null : toDatePair(ev, now);

  if (days > 0) {
    // Hướng quá khứ
    if (days < 4) return `${days} ngày trước`;
    if (days >= 4 && days <= 13 && pair) {
      const wd = weekDiffByMonday(pair.from, pair.to);
      if (wd === 1) return `${WEEKDAY_NAMES[pair.from.getDay()]} tuần trước`;
      if (wd === 2) return `${WEEKDAY_NAMES[pair.from.getDay()]} 2 tuần trước`;
    }
    if (days >= 7 && days < 60 && pair && monthDiff(pair.from, pair.to) === 1) {
      return `Ngày ${pair.from.getDate()} tháng trước`;
    }
    if (days >= 300 && pair) {
      const yearDiff = pair.to.getFullYear() - pair.from.getFullYear();
      if (yearDiff === 1) return `Ngày ${pair.from.getDate()} tháng ${pair.from.getMonth() + 1} năm ngoái`;
      if (yearDiff === 2) return `Ngày ${pair.from.getDate()} tháng ${pair.from.getMonth() + 1} năm kia`;
    }
    if (days < 30) return `${days} ngày trước`;
    if (days < 365) {
      const md = pair ? monthDiff(pair.from, pair.to) : 0;
      const months = md > 0 ? md : Math.floor(days / 30);
      return `${months} tháng trước`;
    }
    const years = Math.floor(days / 365);
    const remainMonths = Math.round((days % 365) / 30);
    if (remainMonths > 0 && years < 5) return `${years} năm ${remainMonths} tháng trước`;
    return `${years} năm trước`;
  }

  // Hướng tương lai
  const abs = Math.abs(days);
  if (abs < 4) return `${abs} ngày sau`;
  if (abs >= 4 && abs <= 13 && pair) {
    const wd = weekDiffByMonday(pair.from, pair.to);
    if (wd === -1) return `${WEEKDAY_NAMES[pair.from.getDay()]} tuần sau`;
    if (wd === -2) return `${WEEKDAY_NAMES[pair.from.getDay()]} 2 tuần sau`;
  }
  if (abs >= 7 && abs < 60 && pair && monthDiff(pair.from, pair.to) === -1) {
    return `Ngày ${pair.from.getDate()} tháng sau`;
  }
  if (abs < 30) return `${abs} ngày sau`;
  if (abs < 365) {
    const md = pair ? monthDiff(pair.from, pair.to) : 0;
    const months = md < 0 ? Math.abs(md) : Math.floor(abs / 30);
    return `${months} tháng sau`;
  }
  const years = Math.floor(abs / 365);
  const remainMonths = Math.round((abs % 365) / 30);
  if (remainMonths > 0 && years < 5) return `${years} năm ${remainMonths} tháng sau`;
  return `${years} năm sau`;
}

/* ============ Suy tính tuổi tác (Chế độ mốc neo) ============ */

/**
 * Phân tích ra con số có thể suy tính từ nguyên văn tuổi tác (khớp toàn chuỗi, tránh nhận nhầm "hơn hai mươi", "25%").
 * Cho phép tiền tố "khoảng" và hậu tố "tuổi"; các cách viết khác (ngoài hai mươi / xấp xỉ ba mươi…) coi là giá trị mơ hồ, trả về null.
 */
function parseAgeNumber(raw: string): number | null {
  const m = raw.trim().match(new RegExp(`^(?:khoảng|xấp xỉ|\\u7ea6|\\u5927\\u7ea6)?\\s*(\\d{1,3}|${CN_NUM_CLASS}+)\\s*(?:tuổi|\\u5c81)?$`, 'i'));
  if (!m) return null;
  const n = cnNumToInt(m[1]);
  return n != null && n > 0 && n < 1000 ? n : null;
}

/** Ghi chú ngắn gọn của thời gian mốc neo: phân tích ra được năm → "(tiền tố) năm X"; nếu không thì lấy nguyên văn sau khi bóc bỏ thời khắc; vẫn không được thì chuỗi rỗng. */
function anchorLabel(ageTime: string): string {
  const d = parseStoryDate(ageTime);
  if (d?.type === 'standard' && d.year != null) {
    return d.calendarPrefix ? `${d.calendarPrefix} năm ${d.year}` : `năm ${d.year}`;
  }
  return ageTime.trim();
}

/**
 * Suy tính tuổi hiển thị hiện tại theo "mốc neo tuổi tác". Tuổi không phải là trạng thái tĩnh mà là hàm số của thời gian:
 * Lưu trữ luôn luôn là "nguyên văn lúc ghi + thời gian mốc neo", khi hiển thị thì suy tính tương đối so với thời gian câu chuyện hiện tại,
 * thời gian nhảy vọt tự động tăng tuổi, AI có quên cập nhật hay không cũng không ảnh hưởng tính chính xác.
 *  - Từ mốc neo đến hiện tại chưa đầy một năm (hoặc thiếu mốc neo / thiếu thời gian hiện tại) → trả về nguyên văn.
 *  - Qua N năm và nguyên văn là con số phân tích được → "Khoảng (N+giá trị gốc) tuổi (năm mốc neo là giá trị gốc tuổi)" —— không biết sinh nhật, sai số ±1 tuổi, chữ "Khoảng" là trung thực.
 *  - Tuổi mơ hồ (ngoài hai mươi) / lịch hư cấu không tính ra / thời gian quay ngược → nguyên văn + chú thích ngoặc đơn mốc neo, nhường việc suy tính cho người đọc / mô hình chính.
 * Kế thừa nguyên tắc "thà không gắn nhãn, tuyệt đối không gắn nhãn sai". age trống → chuỗi rỗng.
 */
export function ageDisplay(age?: string, ageTime?: string, now?: string): string {
  const raw = age?.trim();
  if (!raw) return '';
  const anchor = ageTime?.trim();
  const cur = now?.trim();
  if (!anchor || !cur) return raw;

  const days = calculateRelativeDays(anchor, cur);
  const num = parseAgeNumber(raw);
  if (days != null && days >= 0 && days < 365) return raw; // Chưa đầy một năm: giữ nguyên văn
  if (days != null && days >= 365 && num != null) {
    const est = num + Math.floor(days / 365);
    const label = anchorLabel(anchor);
    return label ? `Khoảng ${est} tuổi(${label} là ${num} tuổi)` : `Khoảng ${est} tuổi`;
  }
  // Không tính ra (lịch hư cấu khác tháng / thời gian quay ngược / tuổi mơ hồ qua năm): nguyên văn + chú thích ngoặc đơn mốc neo, không đoán mò
  const label = anchorLabel(anchor);
  return label ? `${raw}(lúc ${label})` : raw;
}
