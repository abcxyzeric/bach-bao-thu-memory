/**
 * Tầng gọi frontend cho việc vector hóa / xếp hạng lại (rerank).
 *
 * embedding và rerank trực tiếp fetch nguồn cấp trên từ frontend (kênh url/key do người dùng tự điền, độc lập với kênh API phụ).
 * Đi qua frontend thay vì proxy máy chủ ST: điểm cuối /api/vector của ST buộc chặt vào cấu hình source của riêng nó, không thể dùng
 * kênh vector cấu hình độc lập của chúng ta; Horae cũng kết nối thẳng từ frontend và đã kiểm chứng khả thi (đánh đổi là nguồn cấp trên cần cho phép CORS).
 *
 * Tương thích hai loại điểm cuối embedding: OpenAI /embeddings và Gemini batchEmbedContents (tham khảo Horae).
 * Vector truyền tải giữa frontend và backend bằng base64 (float32 little-endian).
 */

import type { VectorEndpoint } from '@/api/settings';
import { resolveVectorModel } from '@/api/settings';

export class EmbedError extends Error {}

/* ============ Quá thời gian + Tự động thử lại ============ */

/** Thời gian lùi cố định trước khi thử lại (mili-giây). */
const RETRY_BACKOFF_MS = 800;

/**
 * fetch có kèm quá thời gian + tự động thử lại. Nguồn cấp trên của vector thường bị treo không trả về, fetch trần sẽ đợi khô héo ——
 * mỗi lần thử đều bọc một AbortController + bộ hẹn giờ, quá thời gian là ngắt ngay; thất bại sẽ quyết định có thử lại hay không tùy theo loại lỗi:
 *  - Quá thời gian nội bộ / lỗi mạng bất thường / máy chủ 5xx / giới hạn tần suất 429 → thử lại (khi vẫn còn số lần);
 *  - 4xx (sai xác thực / sai định dạng v.v.) → trả về thẳng resp, để bên gọi đi vào nhánh ném lỗi !resp.ok hiện có (thử lại vô nghĩa);
 *  - Ngắt do signal bên ngoài (người dùng hủy tạo) kích hoạt → ném ra ngay lập tức, tuyệt đối không thử lại (thử lại là lãng phí hạn mức và thời gian).
 * Trả về Response (có thể là 4xx, giao cho bên gọi xử lý); dùng hết số lần thử lại mà vẫn thất bại thì ném lỗi của lần cuối cùng.
 */
export async function fetchWithTimeoutRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutSec: number; retries: number; label: string; externalSignal?: AbortSignal },
): Promise<Response> {
  const { timeoutSec, retries, label, externalSignal } = opts;
  const maxAttempts = Math.max(1, 1 + Math.max(0, retries));
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Bên ngoài đã hủy: không thử thêm nữa, ném thẳng (người dùng chủ động hủy tạo)
    if (externalSignal?.aborted) throw new EmbedError(`${label} đã hủy`);

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, Math.max(1000, timeoutSec * 1000));
    // Chuyển tiếp việc hủy bên ngoài vào controller nội bộ (fetch chỉ nhận một signal)
    const onExternalAbort = () => ctrl.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);

    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      // 5xx / 429 và vẫn còn cơ hội thử lại → thử lại; phần còn lại (gồm cả 4xx) giao cho bên gọi xử lý
      if ((resp.status >= 500 || resp.status === 429) && attempt < maxAttempts - 1) {
        lastErr = new EmbedError(`${label} API ${resp.status}`);
      } else {
        return resp;
      }
    } catch (e) {
      // abort do hủy bên ngoài kích hoạt: ném ngay lập tức, không thử lại
      if (externalSignal?.aborted && !timedOut) throw new EmbedError(`${label} đã hủy`);
      lastErr = timedOut
        ? new EmbedError(`${label} quá thời gian (>${timeoutSec}s)`)
        : new EmbedError(`${label} lỗi mạng bất thường: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    // Đi đến đây chứng tỏ lần này cần thử lại: vẫn còn số lần thì lùi một nhịp rồi thử tiếp
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw lastErr instanceof Error ? lastErr : new EmbedError(`Yêu cầu ${label} thất bại`);
}

/* ============ float32 ↔ base64 ============ */

/** Float32Array (hoặc number[]) → base64 (thứ tự byte little-endian), dùng để tải lên backend lưu dạng BLOB */
export function encodeFloat32Base64(vec: number[] | Float32Array): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  // Ghép theo từng khối, tránh việc apply quá dài làm tràn ngăn xếp
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 (float32 little-endian) → Float32Array */
export function decodeFloat32Base64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/* ============ Tương thích endpoint ============ */

function isGeminiEndpoint(url: string, model: string): boolean {
  return /gemini|googleapis|generativelanguage|v1beta/i.test(`${url} ${model}`);
}

function isGoogleUrl(url: string): boolean {
  return /googleapis\.com|generativelanguage/i.test(url || '');
}

/** Bỏ /chat/completions, /embeddings, /v1 v.v. ở đuôi url, thu được base */
function embeddingBase(url: string): string {
  return String(url || '')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/embeddings$/i, '');
}

interface EmbeddingRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  parse: (json: any) => number[][];
}

function buildEmbeddingRequest(ep: VectorEndpoint, model: string, texts: string[]): EmbeddingRequest {
  const url = ep.url;
  const key = ep.key || '';

  if (!isGeminiEndpoint(url, model)) {
    const base = embeddingBase(url);
    return {
      endpoint: `${base}/embeddings`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
      parse: (json) => {
        if (!json?.data || !Array.isArray(json.data)) throw new EmbedError('Kết quả embedding trả về thiếu mảng data');
        return json.data.slice().sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
      },
    };
  }

  // Gemini batchEmbedContents
  const base = embeddingBase(url).replace(/\/v\d+(beta\d*|alpha\d*)?(?:\/.*)?$/i, '');
  const modelName = model.startsWith('models/') ? model : `models/${model}`;
  const google = isGoogleUrl(base);
  const endpoint = `${base}/v1beta/${modelName}:batchEmbedContents${google ? `?key=${encodeURIComponent(key)}` : ''}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!google) headers.Authorization = `Bearer ${key}`;
  return {
    endpoint,
    headers,
    body: JSON.stringify({ requests: texts.map((text) => ({ model: modelName, content: { parts: [{ text }] } })) }),
    parse: (json) => {
      if (!json?.embeddings || !Array.isArray(json.embeddings)) throw new EmbedError('Kết quả Gemini embedding trả về thiếu mảng embeddings');
      return json.embeddings.map((e: any) => e.values);
    },
  };
}

/* ============ Hướng ra ngoài: embed / rerank ============ */

/** Một yêu cầu embedding đơn lẻ nhét tối đa bao nhiêu văn bản (đa số nguồn cấp trên có trần batch ≤64, lấy giá trị thận trọng để chia đợt). */
const EMBED_BATCH = 64;

/** Gửi một đợt (≤EMBED_BATCH) yêu cầu embedding văn bản, trả về mảng vector (thứ tự tương ứng). */
async function embedBatch(ep: VectorEndpoint, model: string, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const req = buildEmbeddingRequest(ep, model, texts);
  const resp = await fetchWithTimeoutRetry(
    req.endpoint,
    { method: 'POST', headers: req.headers, body: req.body },
    { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'embedding', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`embedding API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const vectors = req.parse(json);
  if (!Array.isArray(vectors) || vectors.some((v) => !Array.isArray(v))) {
    throw new EmbedError('Dữ liệu vector do embedding trả về không hợp lệ');
  }
  return vectors.map((v) => Float32Array.from(v));
}

/**
 * Vector hóa một loạt văn bản, trả về Float32Array[] (thứ tự tương ứng với đầu vào). Kênh chưa cấu hình đủ sẽ ném lỗi.
 * Vượt quá EMBED_BATCH mục sẽ tự động cắt lát chia đợt gửi yêu cầu tuần tự (một batch đơn lẻ ở nguồn cấp trên có trần giới hạn, khi dựng bù vài trăm mục chắc chắn phải đi nhiều đợt).
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const ep = resolveVectorModel('embedding');
  if (!ep.url) throw new EmbedError('Trí nhớ vector: Chưa cấu hình địa chỉ Embedding');
  if (!ep.model) throw new EmbedError('Trí nhớ vector: Chưa cấu hình mô hình Embedding');

  if (texts.length <= EMBED_BATCH) return embedBatch(ep, ep.model, texts, signal);

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const part = await embedBatch(ep, ep.model, texts.slice(i, i + EMBED_BATCH), signal);
    out.push(...part);
  }
  return out;
}

/** Vector hóa một văn bản đơn lẻ → base64, dùng khi lập chỉ mục / tìm kiếm. */
export async function embedToBase64(text: string, signal?: AbortSignal): Promise<string> {
  const [v] = await embedTexts([text], signal);
  if (!v) throw new EmbedError('Kết quả embedding trả về trống');
  return encodeFloat32Base64(v);
}

export interface RerankResult {
  index: number;
  score: number;
}

/* ============ Ước tính token / Chia đợt rerank (tham khảo Horae, khi xếp hạng tinh toàn văn một yêu cầu đơn lẻ sẽ vượt quá ngữ cảnh nguồn cấp trên) ============ */

/** Trần ngữ cảnh (token) cho một yêu cầu đơn lẻ ở nguồn cấp trên của rerank; đa số mô hình rerank từ 32k trở lên, lấy giá trị thận trọng. */
const RERANK_CONTEXT_LIMIT = 32768;
const RERANK_SAFE_RATIO = 0.68; // Chỉ dùng 68% ngân sách, chừa khoảng dư cho khuôn mẫu prompt / phản hồi
const RERANK_STATIC_RESERVE = 1800; // Giữ lại cố định (chi phí khung mô hình)
const RERANK_PER_DOC_OVERHEAD = 24; // Chi phí phân cách / đóng gói cho mỗi tài liệu

/** Ước tính thô token văn bản: CJK ≈1.35, khác ≈0.45, cộng thêm hệ số an toàn (khớp với Horae, thà ước tính cao hơn). */
function estimateRerankTokens(text: string): number {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) cjk++;
  }
  const other = Math.max(0, str.length - cjk);
  return Math.ceil((cjk * 1.35 + other * 0.45 + 8) * 1.18);
}

/** Cắt cụt tìm kiếm nhị phân về trong trần token (giữ lại tiền tố). */
function truncateByTokens(text: string, tokenLimit: number): string {
  if (!text || tokenLimit <= 0) return '';
  if (estimateRerankTokens(text) <= tokenLimit) return text;
  let lo = 0, hi = text.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateRerankTokens(text.slice(0, mid)) <= tokenLimit) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return text.slice(0, best).trimEnd();
}

/** Trần đồng thời khi chia đợt rerank (có nhiều đợt hơn nữa cũng chỉ gửi đồng thời bấy nhiêu yêu cầu). */
const RERANK_BATCH_CONCURRENCY = 4;

interface RerankBatch {
  indices: number[]; // Chỉ mục toàn cục của từng tài liệu trong đợt đó
  documents: string[];
}

/** Cắt tài liệu thành nhiều đợt theo ngân sách token, mục đơn lẻ quá dài sẽ được cắt cụt trước. */
function buildRerankBatches(query: string, documents: string[]): RerankBatch[] {
  const queryTokens = estimateRerankTokens(query);
  const docBudget = Math.max(1024, Math.floor(RERANK_CONTEXT_LIMIT * RERANK_SAFE_RATIO) - RERANK_STATIC_RESERVE - queryTokens);
  const maxSingleDocTokens = Math.max(768, docBudget - 256);

  const batches: RerankBatch[] = [];
  let curIdx: number[] = [], curDocs: string[] = [], curTokens = 0;
  const flush = () => {
    if (!curIdx.length) return;
    batches.push({ indices: curIdx, documents: curDocs });
    curIdx = []; curDocs = []; curTokens = 0;
  };

  for (let i = 0; i < documents.length; i++) {
    let text = documents[i] ?? '';
    let est = estimateRerankTokens(text) + RERANK_PER_DOC_OVERHEAD;
    if (est > maxSingleDocTokens) {
      text = truncateByTokens(text, Math.max(512, maxSingleDocTokens - RERANK_PER_DOC_OVERHEAD));
      est = estimateRerankTokens(text) + RERANK_PER_DOC_OVERHEAD;
    }
    if (curIdx.length && curTokens + est > docBudget) flush();
    curIdx.push(i);
    curDocs.push(text);
    curTokens += est;
  }
  flush();
  return batches;
}

/** Yêu cầu rerank một đợt đơn lẻ, trả về {index(cục bộ), score} bên trong đợt đó. */
async function rerankBatch(
  endpoint: string, model: string, key: string, query: string, documents: string[],
  timeoutSec: number, retries: number, signal?: AbortSignal,
): Promise<RerankResult[]> {
  const resp = await fetchWithTimeoutRetry(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, query, documents, top_n: documents.length }),
    },
    { timeoutSec, retries, label: 'rerank', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`rerank API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const results = json?.results ?? json?.data;
  if (!Array.isArray(results)) throw new EmbedError('Kết quả rerank trả về thiếu mảng results');
  return results.map((r: any) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }));
}

/**
 * Xếp hạng lại: chấm điểm các tài liệu ứng viên (khi xếp hạng tinh toàn văn chính là nguyên văn tầng lầu) theo mức độ liên quan với query.
 * Trả về {index, score} giảm dần theo score (index = chỉ mục toàn cục của documents đầu vào).
 * Khi tổng lượng tài liệu vượt quá ngân sách ngữ cảnh rerank sẽ tự động chia đợt theo token, mục đơn lẻ quá dài bị cắt cụt, kết quả các đợt gộp lại theo chỉ mục toàn cục.
 * Khi kênh rerank chưa cấu hình đủ sẽ ném lỗi (do bên gọi quyết định hạ cấp: bỏ qua rerank, dùng thẳng thứ tự embedding).
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  _topN: number,
  signal?: AbortSignal,
): Promise<RerankResult[]> {
  if (!documents.length) return [];
  const ep = resolveVectorModel('rerank');
  if (!ep.url) throw new EmbedError('Trí nhớ vector: Chưa cấu hình địa chỉ Rerank');
  if (!ep.model) throw new EmbedError('Trí nhớ vector: Chưa cấu hình mô hình Rerank');

  const endpoint = `${embeddingBase(ep.url)}/rerank`;
  const batches = buildRerankBatches(query, documents);
  const key = ep.key || '';
  const model = ep.model;

  // Chạy đồng thời theo bể worker: có nhiều đợt hơn nữa cũng chỉ gửi đồng thời RERANK_BATCH_CONCURRENCY yêu cầu, kết quả các đợt gộp lại theo chỉ mục toàn cục.
  const merged: RerankResult[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const bi = next++;
      if (bi >= batches.length) break;
      const batch = batches[bi];
      const local = await rerankBatch(endpoint, model, key, query, batch.documents, ep.timeoutSec, ep.retries, signal);
      for (const r of local) {
        const globalIndex = batch.indices[r.index];
        if (globalIndex === undefined) continue;
        merged.push({ index: globalIndex, score: r.score });
      }
    }
  };
  const poolSize = Math.min(RERANK_BATCH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return merged.sort((a, b) => b.score - a.score);
}
