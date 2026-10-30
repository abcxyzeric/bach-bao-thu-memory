import { getContext } from '@/st/context';
import type { ApiChannel } from './settings';

/**
 * Gọi điểm cuối tương thích OpenAI bất kỳ thông qua proxy máy chủ của SillyTavern.
 *
 * Then chốt: đi qua /api/backends/chat-completions/generate bằng chat_completion_source='openai' + reverse_proxy(base url) + proxy_password(key).
 * Yêu cầu do máy chủ ST chuyển tiếp, do đó không gặp vấn đề CORS trên trình duyệt, cũng không cần lưu khóa vào secrets của ST.
 */

export const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_TIMEOUT_SEC = 180;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Chuẩn hóa base url tương thích OpenAI:
 * - Khi người dùng điền đầy đủ /chat/completions thì chỉ bỏ hậu tố điểm cuối;
 * - Tên miền thuần tự động bù thêm /v1;
 * - Địa chỉ đã có đường dẫn thì giữ nguyên, tránh làm hỏng các định tuyến tùy chỉnh như /v2/coding.
 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** Dạng /v1 dự phòng khi kiểm tra kênh. Chỉ thử khi địa chỉ đầu tiên trả về rõ ràng 404/405. */
function alternateUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function validTimeoutSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SEC;
}

/**
 * Bọc giới hạn thời gian (timeout) cho toàn bộ vòng đời yêu cầu: không chỉ bao phủ việc thiết lập kết nối fetch, mà còn bao phủ cả đọc JSON phi luồng và đọc SSE luồng.
 * Signal bên ngoài vẫn có thể hủy sớm; chỉ khi bộ hẹn giờ này kích hoạt mới chuyển thành thông báo lỗi quá thời gian rõ ràng.
 */
async function withTimeout<T>(
  timeoutSec: number,
  externalSignal: AbortSignal | undefined,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutSec * 1000));

  try {
    return await task(ctrl.signal);
  } catch (e) {
    if (timedOut) throw new ApiError(`${label} quá thời gian (>${timeoutSec} giây)`);
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Phát đi một yêu cầu hoàn thành (completion), trả về nội dung văn bản.
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  return requestCompletionAtUrl(channel, messages, normalizeUrl(channel.url), opts);
}

/**
 * Xây dựng thân yêu cầu gửi cho proxy ST (hàm thuần, tiện kiểm thử sản phẩm của hai nhánh).
 *
 * Hai nhánh, chọn một trong hai tùy theo kênh có đặt cường độ suy nghĩ hay không:
 *
 * ① Chưa đặt (reasoningEffort trống = auto): đi qua `chat_completion_source: 'openai'`,
 *    **giống hệt từng byte** so với trước khi thêm tính năng này —— người dùng hiện tại không có bất kỳ thay đổi nào.
 *
 * ② Đã đặt: đi qua `'custom'`. Bởi vì proxy ST đối với reasoning_effort của nguồn openai có chặn **danh sách trắng tên mô hình**
 *    (OPENAI_REASONING_EFFORT_MODELS trong src/constants.js, chỉ khớp chính xác nhóm o1/o3/gpt-5),
 *    tên mô hình không khớp là âm thầm vứt bỏ mà vẫn trả về 200 như thường (đã kiểm chứng thực tế), người dùng đặt nhưng không có tác dụng mà cũng không nhìn ra.
 *    custom_include_body của nguồn custom được máy chủ dùng mergeObjectWithYaml gộp thẳng vào thân yêu cầu gửi lên nguồn cấp trên,
 *    không qua bất kỳ danh sách trắng nào, mọi trường / đối tượng lồng nhau đều truyền thẳng qua được.
 *
 * Cả hai nhánh đều vẫn đi qua chuyển tiếp máy chủ ST (cùng một điểm cuối /generate), không kết nối thẳng từ trình duyệt,
 * do đó các tính chất như CORS, khóa không lưu ở trình duyệt, chuyển tiếp SSE v.v. hoàn toàn không đổi.
 *
 * Hai cái bẫy của nguồn custom (đều đã né tránh):
 * - Nó **không đọc proxy_password**, chỉ đọc khóa Custom do ST tự lưu, vì vậy key bắt buộc phải dựa vào
 *   custom_include_headers để tiêm Authorization (`...headers` ở máy chủ xếp sau Authorization
 *   mặc định, việc ghi đè có hiệu lực);
 * - custom_include_* là chuỗi YAML và **nếu phân tích thất bại sẽ bị âm thầm bỏ qua** (khối catch trong util.js để trống).
 *   Trong key có chứa `:` `#` `{` hoặc bắt đầu bằng `*` đều sẽ làm nổ phân tích YAML → header không được tiêm →
 *   lùi về dùng khóa Custom của ST, có thể gửi nhầm key của nhà cung cấp khác của người dùng tới điểm cuối này.
 *   Do đó nhất loạt dùng JSON.stringify để sinh ra (YAML là tập cha của JSON), giao việc thoát ký tự cho nó, không ghép tay.
 *
 * Ngoài ra: thân yêu cầu cố định mang `tool_choice: 'none'`, đây là cái bắt tay khai báo cho qua dành cho bộ chặn fetch của bên thứ ba.
 * Các kịch bản thiết lập sẵn của Tavern Helper (như bảng Kemini Dramatron) có thể monkey-patch `window.parent.fetch`,
 * chặn mọi yêu cầu `/api/backends/…/generate` và nhét công cụ tổng hợp + tin nhắn điều khiển vào, chiếm quyền bản tóm tắt thành
 * lời gọi công cụ (thực tế làm chậm đi gấp nhiều lần). Các bộ chặn loại này nhìn chung đều hỗ trợ nguyên tắc "bên gọi tự mang tool_choice thì cho qua"
 * (callerControlsTools của Dramatron bypass rõ ràng đối với 'none'), vì vậy chúng ta chủ động khai báo không dùng công cụ.
 * Không ảnh hưởng tới nguồn cấp trên: máy chủ ST chỉ chuyển tiếp tool_choice khi tools là mảng khác rỗng
 * (src/endpoints/backends/chat-completions.js), hàm này không bao giờ gửi tools, trường đó không tới được nhà cung cấp dịch vụ.
 *
 * (Cùng nguồn với hàm cùng tên trong src/api/client.ts của Bách Bảo Hội, hành vi giữ nhất quán.)
 */
export function buildRequestBody(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  stream: boolean,
): Record<string, unknown> {
  const effort = channel.reasoningEffort?.trim() ?? '';
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    // Không dùng công cụ: xem chú thích đầu hàm, chống bộ chặn fetch bên thứ ba viết lại tóm tắt thành lời gọi công cụ
    tool_choice: 'none',
    // Im lặng: không ảnh hưởng trạng thái đối thoại chính
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: reverseProxy,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: reverseProxy,
        proxy_password: channel.key || '',
        ...common,
      };

  // Tham số loại trừ: xóa các trường do người dùng chỉ định khỏi body, tránh lỗi ở các điểm cuối tương thích không chấp nhận những tham số này.
  // Lưu ý: các trường định tuyến cố định (chat_completion_source/reverse_proxy v.v.) không nên bị xóa, nhưng hoàn toàn tùy thuộc người dùng điền,
  // ở đây chỉ loại bỏ trung thực —— văn bản giao diện sẽ nhắc điền tên tham số lấy mẫu (temperature/max_tokens/...).
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

async function requestCompletionAtUrl(
  channel: ApiChannel,
  messages: ChatMsg[],
  reverseProxy: string,
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('Ngữ cảnh SillyTavern không khả dụng');
  if (!channel.url || !channel.model) throw new ApiError('Kênh API phụ chưa được cấu hình đầy đủ (thiếu url hoặc model)');

  const stream = channel.stream ?? false;
  const body = buildRequestBody(channel, messages, reverseProxy, stream);

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, opts.signal, 'Yêu cầu API phụ', async signal => {
    const resp = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`Yêu cầu API phụ thất bại (${resp.status}): ${text.slice(0, 300)}`, resp.status);
    }

    // Luồng (stream): ghép tăng thêm theo SSE; Phi luồng: phân tích trực tiếp JSON.
    if (stream) {
      const content = await readSseContent(resp);
      if (!content) throw new ApiError('API phụ trả về nội dung rỗng');
      return content;
    }

    const data = await resp.json();
    if (data?.error) {
      throw new ApiError(data.error.message || 'API phụ trả về lỗi');
    }

    const content = extractContent(data);
    if (!content) throw new ApiError('API phụ trả về nội dung rỗng');
    return content;
  });
}

/**
 * Đọc luồng SSE (text/event-stream), ghép delta.content.
 * Điểm cuối generate của ST khi stream=true sẽ truyền thẳng SSE của nguồn cấp trên: mỗi dòng `data: {json}`, kết thúc bằng `data: [DONE]`.
 */
async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // Không thể đọc dạng luồng (về lý thuyết sẽ không xảy ra): lùi về xử lý như JSON tổng thể
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Phân tích theo dòng, giữ lại đoạn dòng chưa hoàn chỉnh cuối cùng cho lần sau
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || 'API phụ trả về lỗi');
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
        if (typeof delta === 'string') out += delta;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // Phân tích một dòng đơn lẻ thất bại thì bỏ qua (có thể là dòng chú thích / nhịp tim)
      }
    }
  }
  return out.trim();
}

/** Trích xuất văn bản từ thân phản hồi OpenAI chuẩn */
function extractContent(data: any): string {
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.content ??
    ''
  ).trim();
}

/* ============ Đi theo API chính (cài đặt API đang dùng trên giao diện chính hiện tại) ============ */

/** Trần phản hồi khi tóm tắt / tổng kết đi theo API chính: đủ để chứa chuỗi suy nghĩ + JSON, tránh bị max tokens mặc định của API chính cắt cụt. */
const MAIN_API_RESPONSE_LENGTH = 65535;

/**
 * Có đủ điều kiện để "Đi theo API chính" hay không: chỉ cần ST bộc lộ generateRaw (API ổn định) là được.
 * Không còn phụ thuộc quản lý kết nối / hồ sơ kết nối —— mượn trực tiếp API đang dùng trên giao diện chính hiện tại.
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * Dùng "API chính hiện tại" (cài đặt hoàn thành trò chuyện / hoàn thành văn bản đang dùng trên giao diện chính) để gửi một lần hoàn thành.
 * Đi qua generateRaw của ST: chỉ gửi mấy tin nhắn chúng ta đưa, không mang lịch sử trò chuyện / thẻ nhân vật; không cần hồ sơ kết nối.
 * Loại quiet bên trong cưỡng chế phi luồng, trả về toàn bộ đoạn văn bản sau khi làm sạch; thất bại ném ApiError.
 *
 * ⚠️ Thân yêu cầu của đường dẫn này do ST xây dựng, không mang theo được `tool_choice: 'none'`, bộ chặn fetch của bên thứ ba
 * (như kịch bản chống cắt cụt) vẫn có thể viết lại nó. Tóm tắt / tóm tắt lại nên cố gắng chỉ định kênh API phụ để đi theo nhánh buildRequestBody.
 */
export async function requestViaMainApi(messages: ChatMsg[], _opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('Phiên bản ST hiện tại không hỗ trợ generateRaw, không thể đi theo API chính');
  }
  const content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
  if (!content) throw new ApiError('API chính trả về nội dung rỗng');
  return content;
}

/** Kiểm tra kết nối: gửi một yêu cầu cực ngắn */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  const primaryUrl = normalizeUrl(channel.url);
  try {
    const reply = await requestCompletionAtUrl(
      channel,
      [{ role: 'user', content: 'Chỉ cần trả lời hai ký tự "ok".' }],
      primaryUrl,
    );
    const changed = channel.url.trim().replace(/\/+$/, '') !== primaryUrl;
    if (changed) channel.url = primaryUrl;
    return {
      ok: true,
      message: `Kết nối bình thường${changed ? `, đã áp dụng: ${primaryUrl}` : ''}, trả về: ${reply.slice(0, 40)}`,
    };
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    const fallbackUrl = alternateUrl(primaryUrl);
    if (!fallbackUrl || fallbackUrl === primaryUrl) {
      return { ok: false, message: e.message };
    }
    try {
      const reply = await requestCompletionAtUrl(
        channel,
        [{ role: 'user', content: 'Chỉ cần trả lời hai ký tự "ok".' }],
        fallbackUrl,
      );
      channel.url = fallbackUrl;
      return {
        ok: true,
        message: `Kết nối bình thường, đã tự động đổi sang dùng: ${fallbackUrl}, trả về: ${reply.slice(0, 40)}`,
      };
    } catch {
      // Khi địa chỉ dự phòng cũng thất bại thì giữ lại lỗi đầu tiên, tránh che lấp vấn đề thực sự như tên mô hình thành lỗi đường dẫn.
      return { ok: false, message: e.message };
    }
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * Kéo danh sách mô hình khả dụng của kênh (đi qua proxy /status của ST, chuẩn /v1/models).
 * Chỉ cần url + key, không cần điền model trước.
 */
export async function fetchModels(
  channel: Pick<ApiChannel, 'url' | 'key'> & Partial<Pick<ApiChannel, 'timeoutSec'>>,
): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('Ngữ cảnh SillyTavern không khả dụng');
  if (!channel.url) throw new ApiError('Vui lòng điền địa chỉ API trước');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const timeoutSec = validTimeoutSec(channel.timeoutSec);
  return withTimeout(timeoutSec, undefined, 'Kéo danh sách mô hình', async signal => {
    const resp = await fetch(STATUS_URL, {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(`Kéo danh sách mô hình thất bại (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data?.error && !Array.isArray(data?.data)) {
      throw new ApiError(data?.message || 'Kéo danh sách mô hình thất bại');
    }

    const list: unknown = data?.data ?? data?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      .sort();
  });
}
