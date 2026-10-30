/**
 * Trích xuất đối tượng JSON một cách bền vững từ đầu ra văn bản của LLM.
 * Xử lý: hàng rào ```json, tiền tố/hậu tố chuỗi suy nghĩ, dấu ngoặc kép thông minh, dấu phẩy thừa ở cuối.
 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim();

  // Bỏ chuỗi suy nghĩ <think>…</think> / <thinking>…</thinking> (không phân biệt hoa thường)
  s = s.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // Khối kiểm tra chưa đóng có thể chỉ là bản nháp bị cắt cụt, không thể coi JSON bên trong đó là kết quả cuối cùng.
  if (/^<think(?:ing)?\b/i.test(s)) return null;

  // Chịu lỗi: kết quả trả về có thể chỉ chứa chính văn chuỗi suy nghĩ + </thinking> + JSON mà thiếu <thinking> ở đầu,
  // lúc này hủy bỏ thẻ đóng cuối cùng và toàn bộ văn bản phía trước nó.
  const danglingThinkClose = s.match(/<\/think(?:ing)?>/gi);
  if (danglingThinkClose) {
    const lastClose = Math.max(
      s.toLowerCase().lastIndexOf('</think>'),
      s.toLowerCase().lastIndexOf('</thinking>'),
    );
    if (lastClose >= 0) {
      const close = s.slice(lastClose).match(/^<\/think(?:ing)?>/i)?.[0] ?? '';
      s = s.slice(lastClose + close.length).trim();
    }
  }

  // Bỏ hàng rào ```json ... ``` / ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Cắt từ dấu { đầu tiên đến dấu } cuối cùng (bỏ văn bản giải thích trước sau)
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let body = s.slice(first, last + 1);

  // Thử trực tiếp
  const direct = tryParse<T>(body);
  if (direct !== null) return direct;

  // Làm sạch chịu lỗi: ngoặc kép thông minh -> ngoặc kép thẳng, bỏ dấu phẩy thừa ở cuối
  const cleaned = body
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  const cleanedParsed = tryParse<T>(cleaned);
  if (cleanedParsed !== null) return cleanedParsed;

  // Vẫn thất bại: đa phần là trong chính văn có dấu ngoặc kép chưa thoát (như lời thoại He said "hi"). Bù ký tự thoát rồi thử lại.
  // Bù một lần cho cả chuỗi gốc lẫn chuỗi đã làm sạch (sau khi làm sạch biến ngoặc kép thông minh thành ngoặc kép thẳng có thể phát sinh thêm ngoặc kép hoang, nên cũng phải bù).
  const repaired = tryParse<T>(escapeStrayQuotes(body));
  if (repaired !== null) return repaired;
  return tryParse<T>(escapeStrayQuotes(cleaned));
}

/**
 * Bù ký tự thoát: đổi "dấu ngoặc kép chưa thoát bên trong giá trị chuỗi" thành \". Chỉ làm phương án dự phòng sau khi phân tích trực tiếp / làm sạch đều thất bại.
 * Quét từng ký tự và theo dõi xem có đang ở trong chuỗi hay không: khi đang trong chuỗi mà gặp ", nhìn về sau tìm ký tự phi khoảng trắng đầu tiên —— chỉ khi nó là
 * ký tự cấu trúc (: , } ] hoặc kết thúc chuỗi) thì mới coi là dấu ngoặc kép đóng, nếu không thì phán đoán là ngoặc kép hoang trong chính văn và bù thành \".
 * Đối với JSON vốn đã hợp lệ thì đây là phép biến đổi đồng nhất (bên trong chuỗi của JSON hợp lệ không tồn tại " chưa thoát), nên tuyệt đối không làm hỏng chuỗi vốn phân tích được;
 * khi gặp sự nhập nhằng thực sự (ngoặc kép hoang dán sát dấu phẩy ASCII) sẽ phân tích thất bại và rơi vào thử lại, không âm thầm cắt cụt thành dữ liệu sai.
 */
function escapeStrayQuotes(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      // Giữ nguyên cả cặp thoát (\" \\ \n v.v.) chuyển thẳng sang, không phán đoán nhầm dấu ngoặc kép bên trong đó
      out += c;
      if (i + 1 < s.length) { out += s[i + 1]; i++; }
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
        out += c;        // Dấu ngoặc kép đóng
        inString = false;
      } else {
        out += '\\"';    // Ngoặc kép hoang trong chính văn -> bù ký tự thoát
      }
      continue;
    }
    out += c;
  }
  return out;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
