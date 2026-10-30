export interface SourceExcerpt {
  source: string;
  text: string;
}

export const SOURCE_HINTS_HEADER = '【Nhắc nhở nguyên văn dễ sót (Mã nguồn đánh dấu trước)】';

// Chỉ lọc manh mối câu chữ, không phán đoán thật giả hay mức độ quan trọng của sự thật; không dùng regex toàn cục, tránh các bài kiểm tra nhiều đoạn ảnh hưởng lẫn nhau.
const HINT_PATTERNS = [
  /không đủ|chưa tới|chưa đến|không quá|không vượt quá|không thể|chẳng thể|khó mà|khó lòng|rất khó|bị giới hạn|hạn chế|áp chế|bắt buộc|phải|chỉ có thể|chỉ được|không được|cấm|ít nhất|tối thiểu|nhiều nhất|tối đa|vượt quá|thấp hơn|cao hơn|kém hơn|không bằng|\u4e0d\u8db3|\u4e0d\u5230|\u4e0d\u8d85\u8fc7|\u4e0d\u80fd|\u65e0\u6cd5|\u96be\u4ee5|\u5f88\u96be|\u53d7\u9650|\u9650\u5236|\u538b\u5236|\u5fc5\u987b|\u53ea\u80fd|\u4ec5\u80fd|\u4e0d\u5f97|\u7981\u6b62|\u81f3\u5c11|\u81f3\u591a|\u8d85\u8fc7|\u8d85\u51fa|\u4f4e\u4e8e|\u9ad8\u4e8e|\u4e0d\u53ca|\u4e0d\u5982/i,
  /mạnh nhất|cao nhất|thấp nhất|nhiều nhất|ít nhất|lớn nhất|nhỏ nhất|hàng đầu|đỉnh cao|giới hạn trên|giới hạn dưới|trung bình|phổ biến|so với|\u6700\u5f3a|\u6700\u9ad8|\u6700\u4f4e|\u6700\u591a|\u6700\u5c11|\u6700\u5927|\u6700\u5c0f|\u9876\u5c16|\u5dc5\u5cf0|\u4e0a\u9650|\u4e0b\u9650|\u5e73\u5747|\u666e\u904d|\u76f8\u6bd4|\u6bd4\u8d77/i,
  /vốn dĩ|ban đầu|trước kia|từng|trước đây|hiện nay|giờ đây|từ đó|từ nay|không còn|đã|dần dần|trở nên|biến thành|trở thành|chuyển sang|khôi phục|hồi phục|giải trừ|cải thiện|xấu đi|trở nặng|chuyển biến tốt|dọn ra|dọn vào|dọn đến|chuyển ra|chuyển vào|chuyển đến|ở riêng|định cư|thoát khỏi|rời khỏi|thăng cấp|thăng lên|giáng xuống|không bao giờ|không cần phải|\u539f\u672c|\u539f\u5148|\u66fe\u7ecf|\u6b64\u524d|\u5982\u4eca|\u4ece\u6b64|\u81ea\u6b64|\u4e0d\u518d|\u5df2\u7ecf|\u9010\u6e10|\u53d8\u5f97|\u53d8\u4e3a|\u53d8\u6210|\u6210\u4e3a|\u8f6c\u4e3a|\u6062\u590d|\u89e3\u9664|\u6539\u5584|\u6076\u5316|\u597d\u8f6c|\u642c\u51fa|\u642c\u5165|\u642c\u5230|\u8fc1\u51fa|\u8fc1\u5165|\u8fc1\u5c45|\u72ec\u4f4f|\u5b9a\u5c45|\u8131\u79bb|\u6446\u8131|\u664b\u5347|\u964d\u4e3a|\u518d\u4e5f\u4e0d|\u4e0d\u5fc5\u518d|\u4e0d\u7528\u518d/i,
  // Chỉ nhận diện chữ số cuối trước đơn vị hoặc sau từ chỉ đơn vị tiếng Việt, không phân tích số, tránh chuỗi số dài quay lui lặp đi lặp lại.
  /(?:cấp|bậc|tầng|chuyển)\s*\d+|[\d\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u534a]\s*(?:cấp|bậc|tầng|chuyển|độ|℃|°[CF]?|km|ki-lô-mét|mét|kg|ki-lô-gam|cân|%|％|\u7ea7|\u9636|\u8f6c|\u5ea6|\u516c\u91cc|\u7c73|\u516c\u65a4|\u65a4)|[<>≤≥]\s*\d/i,
  /\b(?:cannot|can't|unable|limited|restricted|must|only|at least|at most|less than|more than|strongest|highest|lowest|maximum|minimum)\b/i,
  /\b(?:used to|no longer|previously|became|improved|worsened|recovered|moved (?:out|in|into|to))\b/i,
];

/** Trả về đoạn phụ lục của tài liệu yêu cầu; bên gọi cung cấp số đoạn thực tế, không đoán từ chính văn hay đánh số lại nguồn. */
export function renderSourceHints(sources: readonly SourceExcerpt[]): string {
  // Tối đa sao chép một bản nguyên đoạn trúng manh mối, không cắt ngắn hay khái quát, cũng không coi việc không trúng là không có sự thật quan trọng.
  const excerpts = sources
    .filter(({ text }) => HINT_PATTERNS.some(pattern => pattern.test(text)))
    .map(({ source, text }) => `${source} ${text}`);
  if (!excerpts.length) return '';
  return `\n\n${SOURCE_HINTS_HEADER}
Dưới đây là bản sao nguyên văn được chọn ra theo manh mối giới hạn, so sánh, chỉ số hoặc biến đổi trạng thái, không phải cốt truyện mới thêm, danh sách bắt buộc giữ lại hay mệnh lệnh; có thể chọn nhầm hoặc bỏ sót, vẫn phải đọc kỹ toàn bộ tài liệu.
Hãy chọn lọc theo quy tắc nhiệm vụ này, lưu ý các sự thật độc lập cùng phần giới hạn trong những đoạn này, không yêu cầu liệt kê riêng bản ghi từng đoạn. Nguồn kế thừa nguyên tầng lầu và phạm vi thời gian gốc, không coi đề xuất là đã thực thi, không ghi số đoạn hay lời nhắc vào JSON cuối cùng.
${excerpts.join('\n')}`;
}
