/**
 * Viết lại truy vấn (Query Rewrite) của truy xuất vector.
 *
 * Sao chép ý tưởng và prompt (bản người dùng đã tối ưu) "mô hình nhỏ viết lại cốt truyện hiện tại thành INTENT + nhiều Q tìm kiếm" của Horae,
 * nhưng **việc xây dựng ngữ cảnh là của riêng Bách Bảo Thư**:
 *  Cấu trúc = [Tóm tắt cốt truyện lịch sử] + toàn văn cửa sổ gần đây + [Ảnh chụp trạng thái] + [Đầu vào người dùng]
 *  - Trạng thái nhất loạt đi qua deriveMemory (không giả định getLatestState sạch);
 *  - Ảnh chụp trạng thái đặt chính xác: quét từ điểm đầu cửa sổ đến tầng đầu tiên "không có lá hợp lệ" thì dừng lại,
 *    ảnh chụp = deriveMemory(chat, index tầng lỗ hổng), chèn vào sau "cuối tiền tố lá liên tục", trước tầng lỗ hổng;
 *  - Ảnh chụp chỉ chứa **hồ sơ nhân vật chính / items / plans đã cuộn ra ngoài cửa sổ** (thời gian/địa điểm/có mặt đã nằm trong toàn văn, không lặp lại).
 *
 * Sinh ra nhiều query, mỗi cái tự embed → backend vec/search tìm kiếm đa luồng + dung hợp; INTENT kiêm làm query cho rerank.
 * Bất kỳ thất bại nào cũng ném lỗi, do phía truy xuất catch rồi xử lý.
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { GENERATE_URL } from '@/api/client';
import { apiSettings, resolveVectorModel } from '@/api/settings';
import { deriveMemory, getLeaf, leafValid } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtNpcs, fmtPlans, fmtProtagonist, JAILBREAK_PROMPT, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';
import { cleanBody } from '../timeTag';
import { fetchWithTimeoutRetry } from './embed';

/** Mô hình rewrite lấy tối đa bao nhiêu query (khớp với Horae) */
const MAX_QUERIES = 6;
/** Giới hạn độ dài mô tả INTENT (prompt gốc yêu cầu 2–4 câu, ở đây đưa ra trần rộng rãi làm dự phòng, chống kết quả trả về cực đoan) */
const MAX_INTENT_LEN = 360;
/** Giới hạn độ dài một query đơn lẻ */
const MAX_QUERY_LEN = 220;

export interface RewriteResult {
  /** Mô tả ý đồ bối cảnh (kiêm làm query của rerank) */
  intent: string;
  /** Nhiều query tìm kiếm (đã khử trùng và giới hạn độ dài) */
  queries: string[];
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Làm sạch chính văn tầng lầu thành văn bản dễ đọc, cùng tiêu chuẩn với nạp cho mô hình tóm tắt (cleanBody: cắt gọn đoạn chính văn + xóa nguyên khối thẻ nhiễu + chuyển thời gian thành văn bản). */
function cleanFloor(m: STMessage): string {
  return cleanBody(m.mes);
}

/**
 * Xây dựng văn bản ảnh chụp trạng thái (chỉ chứa items/plans đã cuộn ra ngoài cửa sổ và có hiệu lực dài hạn).
 * upTo = chỉ mục của tầng không có lá đầu tiên (ảnh chụp cắt đến trước nó). Không có nội dung có ý nghĩa trả về chuỗi rỗng.
 */
function buildStateSnapshot(chat: STMessage[], upTo: number): string {
  const st = deriveMemory(chat, upTo);
  const lines: string[] = [];
  if (Object.values(st.protagonist).some(Boolean)) {
    lines.push(`Hồ sơ hiện tại của nhân vật chính:\n${fmtProtagonist(st.protagonist)}`);
  }
  if (st.items.length) {
    lines.push(`Danh sách vật phẩm:\n${fmtItems(st.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`);
  }
  if (st.npcs.length) {
    lines.push(`Danh sách NPC:\n${fmtNpcs(st.npcs.map(n => ({ name: n.name, gender: n.gender, title: n.title, follow: n.follow, location: n.location })))}`);
  }
  const openPlans = st.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    lines.push(`Kế hoạch/nghi vấn chưa khép lại:\n${fmtPlans(openPlans.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })))}`);
  }
  if (!lines.length) return '';
  return `[Ảnh chụp trạng thái: Dưới đây là hồ sơ nhân vật chính, vật phẩm, NPC và kế hoạch chưa khép lại đã cuộn ra khỏi cửa sổ gần đây nhưng vẫn còn hiệu lực, cung cấp để bạn phân giải các đại từ chỉ định mơ hồ]\n${lines.join('\n')}`;
}

/**
 * Tìm điểm chèn của ảnh chụp trạng thái: quét từ điểm đầu cửa sổ về sau, trả về chỉ mục của tầng đầu tiên "không có lá hợp lệ".
 * Toàn bộ đều có lá thì trả về chat.length (ảnh chụp cắt đến toàn bộ cửa sổ, đặt ở cuối cùng).
 */
function findSnapshotCut(chat: STMessage[], windowStart: number): number {
  for (let i = windowStart; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) return i;
  }
  return chat.length;
}

/**
 * Xây dựng chuỗi tin nhắn gửi cho mô hình rewrite.
 *
 * ⚠️ Nhiều kênh vector yêu cầu tin nhắn system **chỉ được phép xuất hiện ở ngay đầu mảng**, ở giữa không được có thêm system.
 * Do đó khớp với hình thái của Horae: **một tin nhắn system duy nhất ở đầu + đối thoại thuần user/assistant ở giữa + một tin nhắn user ở cuối**.
 *  - Tóm tắt cốt truyện lịch sử gộp vào tin nhắn system ở đầu đó (thuộc thiết lập bối cảnh, nằm hợp lệ ở đầu);
 *  - Ảnh chụp trạng thái không tách riêng thành system, mà **ghép vào chính văn tin nhắn đối thoại** (đặt ở sau tin nhắn ngay trước điểm cut, trước tầng lỗ hổng),
 *    giữ cho ở giữa không có system, nhờ đó tương thích với các kênh "system chỉ được nằm ở đầu".
 */
function buildMessages(chat: STMessage[]): ChatMsg[] {
  const windowStart = resolveKeepStart(chat);
  const cut = findSnapshotCut(chat, windowStart);

  // Tin nhắn system duy nhất ở đầu: vượt giới hạn (lõi NVWA) + prompt hệ thống + (tùy chọn) tóm tắt cốt truyện lịch sử, gộp thành một mục,
  // vừa đảm bảo system chỉ xuất hiện ở đầu, vừa để phần vượt giới hạn nằm ở ngay đầu yêu cầu. Lõi không viết vào chính văn viết lại, thống nhất do vị trí vượt giới hạn cung cấp
  // (ưu tiên tùy chỉnh, để trống thì dùng lõi NVWA tích hợp sẵn).
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, windowStart));
  const body = history ? `${QUERY_REWRITE_SYSTEM}\n\n[Tóm tắt cốt truyện lịch sử]\n${history}` : QUERY_REWRITE_SYSTEM;
  const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
  const systemContent = `${jb}\n\n${body}`;
  const messages: ChatMsg[] = [{ role: 'system', content: systemContent }];

  // Trải phẳng đối thoại trong cửa sổ (thuần user/assistant), ghi lại msgIndex gốc để định vị điểm chèn ảnh chụp
  const convo: Array<{ role: 'user' | 'assistant'; content: string; index: number }> = [];
  for (let i = windowStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (m.extra?.bbs_omit) continue;
    if (m.is_system && m.extra?.type) continue; // Bỏ qua tầng hệ thống gốc
    const text = cleanFloor(m);
    if (!text) continue;
    convo.push({ role: m.is_user ? 'user' : 'assistant', content: text, index: i });
  }

  // Ảnh chụp trạng thái: ghép vào chính văn tin nhắn đối thoại (không tách riêng thành system). Ngữ nghĩa = trạng thái xác thực tính đến trước cut (tầng không lá đầu tiên).
  const snapshot = buildStateSnapshot(chat, cut);
  if (snapshot) {
    if (!convo.length) {
      // Cửa sổ không có tin nhắn đối thoại khả dụng → dự phòng đặt một user để mang nó (vẫn không phải system)
      messages.push({ role: 'user', content: snapshot });
    } else {
      const cutPos = convo.findIndex(c => c.index >= cut);
      if (cutPos === -1) {
        // cut nằm sau toàn bộ đối thoại (cửa sổ đều có lá) → ghép vào cuối mục cuối cùng
        const last = convo[convo.length - 1];
        last.content = `${last.content}\n\n${snapshot}`;
      } else if (cutPos === 0) {
        // Điểm cut chính là đối thoại đầu tiên (phía trước không có đối thoại để mang) → ghép vào tiền tố của nó
        convo[0].content = `${snapshot}\n\n${convo[0].content}`;
      } else {
        // Ghép vào cuối đối thoại ngay trước điểm cut (sau cuối tiền tố lá liên tục, trước tầng lỗ hổng)
        const prev = convo[cutPos - 1];
        prev.content = `${prev.content}\n\n${snapshot}`;
      }
    }
  }

  for (const c of convo) messages.push({ role: c.role, content: c.content });

  // Prompt kết thúc ở cuối
  messages.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  return messages;
}

/** Chuẩn hóa base url: bỏ đuôi /embeddings, /chat/completions (proxy ST sẽ tự bù /chat/completions) */
function chatBaseUrl(rawUrl: string): string {
  return String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/chat\/completions$/i, '');
}

/** Phân tích INTENT + nhiều dòng Q (khớp với Horae: bỏ ký hiệu tiền tố, khử trùng, giới hạn độ dài) */
function parseResponse(text: string): RewriteResult {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    // Bảo hiểm kép: cho dù yêu cầu đã tắt enable_thinking, một số mô hình cá biệt vẫn nhả khối <think>, bóc nguyên đoạn trước rồi mới phân tích từng dòng,
    // nếu không chữ INTENT/Q xuất hiện trong chuỗi suy nghĩ sẽ làm bẩn kết quả phân tích.
    .replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let intent = '';
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    // Bỏ -/*/•, số thứ tự ở đầu dòng
    const line = raw.replace(/^\s*(?:[-*•]\s*)?(?:\d+[.)、]\s*)?/, '').trim();
    const im = line.match(/^INTENT\s*[:：]\s*(.+)$/i);
    if (im) {
      intent = sanitize(im[1], MAX_INTENT_LEN);
      continue;
    }
    const qm = line.match(/^Q\s*\d*\s*[:：]\s*(.+)$/i);
    if (qm) {
      const q = sanitize(qm[1]);
      if (!q) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(q);
      if (queries.length >= MAX_QUERIES) break;
    }
  }
  return { intent, queries };
}

function sanitize(text: string, maxLen = MAX_QUERY_LEN): string {
  return String(text || '')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Thực thi viết lại truy vấn. Khi điểm cuối queryRewrite chưa cấu hình model sẽ ném lỗi (bên gọi hạ cấp).
 * Giống như API phụ, đi qua chuyển tiếp máy chủ ST (không có vấn đề CORS); địa chỉ / khóa kênh có thể để trống để tái sử dụng embedding.
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = resolveVectorModel('queryRewrite');
  if (!ep.model) throw new Error('Chưa cấu hình mô hình viết lại Query');
  const baseUrl = chatBaseUrl(ep.url);
  if (!baseUrl) throw new Error('Chưa cấu hình địa chỉ viết lại Query');

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!ctx || !chat.length) throw new Error('Không có ngữ cảnh đối thoại để viết lại');

  const messages = buildMessages(chat);

  const resp = await fetchWithTimeoutRetry(
    GENERATE_URL,
    {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({
        // Đi qua nguồn custom: nguồn openai chỉ chuyển tiếp các trường trong danh sách trắng, enable_thinking sẽ bị ST vứt bỏ; custom_include_body gộp nguyên bản vào thân yêu cầu gửi lên nguồn cấp trên.
        // Nguồn custom không đọc proxy_password, khóa được tiêm qua custom_include_headers (ghi đè khóa Custom do ST tự lưu),
        // và nhất loạt sinh bằng JSON.stringify để chống lỗi phân tích YAML âm thầm thất bại —— hai điểm này xem chi tiết tại buildRequestBody của api/client.ts.
        chat_completion_source: 'custom',
        custom_url: baseUrl,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${ep.key || ''}` }),
        // Khớp với Horae: nhiệt độ thấp tuân thủ định dạng tốt hơn; enable_thinking:false tắt chuỗi suy nghĩ ——
        // các mô hình như Qwen3/GLM mặc định bật chuỗi suy nghĩ sẽ nhả suy luận <think> trước, làm loạn định dạng dòng INTENT/Q dẫn đến phân tích thất bại.
        custom_include_body: JSON.stringify({ enable_thinking: false }),
        model: ep.model,
        messages,
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: apiSettings.vector.queryRewriteMaxTokens,
        stream: false,
        // Chống bộ chặn fetch của bên thứ ba chiếm quyền yêu cầu /generate, giống buildRequestBody; ST chỉ chuyển tiếp nó khi có mang tools, không tới được nguồn cấp trên
        tool_choice: 'none',
      }),
    },
    { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'Viết lại Query', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`API viết lại Query ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  // ST bọc lỗi nguồn cấp trên thành 200 + { error }: 5xx/429 của nguồn cấp trên vì thế không còn kích hoạt tự động thử lại nữa (quá thời gian / lỗi mạng bất thường vẫn thử lại như cũ)
  if (json?.error) throw new Error(`Lỗi API viết lại Query: ${json.error.message || 'Lỗi không xác định'}`);
  const content = json?.choices?.[0]?.message?.content;
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) throw new Error('Viết lại Query trả về nội dung rỗng');

  const parsed = parseResponse(raw);
  if (!parsed.queries.length) throw new Error('Viết lại Query không phân tích ra được bất kỳ query tìm kiếm nào');
  return parsed;
}
