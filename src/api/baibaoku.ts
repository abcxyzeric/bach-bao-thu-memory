/**
 * Tầng truyền tải thuần frontend của giao diện vector Bách Bảo Khố.
 * Chỉ phụ trách gửi các yêu cầu /api/plugins/baibaoku/v1/vec/* đi; các tham số nghiệp vụ như database/scope do bên gọi truyền vào.
 * Logic "chọn kho nào / scope nào" của trí nhớ vector nằm ở memory/vector/scope.ts, không nằm tại đây.
 */

import { getContext } from '@/st/context';

const BASE_URL = '/api/plugins/baibaoku/v1';

/** Một mục vector đơn lẻ khi upsert (vector là float32 little-endian được mã hóa base64) */
export interface VecItem {
  leafId: string;
  docHash: string;
  payloadHash: string;
  vector: string;
  dim: number;
  document: string;
  mesFull?: string | null;
  storyTime?: string | null;
  msgIndex?: number | null;
}

/** Khi vector tóm tắt không đổi, chỉ cập nhật toàn văn và thời gian câu chuyện. */
export interface VecPayloadItem {
  leafId: string;
  payloadHash: string;
  mesFull?: string | null;
  storyTime?: string | null;
}

/** Một mục trúng đơn lẻ khi search */
export interface VecHit {
  leafId: string;
  scope: string;
  similarity: number;
  /** Chỉ mục query đạt độ tương đồng tốt nhất (Q nguồn); khi backend cũ không trả về thì là -1 */
  queryIndex: number;
  document: string;
  mesFull: string | null;
  storyTime: string | null;
  msgIndex: number | null;
}

function headers(): Record<string, string> {
  const ctx = getContext();
  const h = ctx?.getRequestHeaders?.();
  return h ?? { 'Content-Type': 'application/json' };
}

/** Gửi một yêu cầu hành động vec; không ok sẽ ném lỗi (kèm code/message của backend). */
async function request<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${BASE_URL}/${action}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const payload = (await resp.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;
  if (!resp.ok || !payload?.ok) {
    const msg = (payload && !payload.ok && payload.error?.message) || `Yêu cầu Bách Bảo Khố thất bại: ${action}`;
    const err = new Error(msg) as Error & { code?: string };
    if (payload && !payload.ok) err.code = payload.error?.code;
    throw err;
  }
  return payload.data;
}

/** Bách Bảo Khố ở backend có khả dụng hay không (trình điều khiển đã sẵn sàng). Thất bại âm thầm trả về false, không chặn quy trình chính. */
export async function isBaiBaoKuAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/status`, { method: 'GET' });
    const payload = (await resp.json().catch(() => null)) as
      | { ok: true; data: { driver?: { available?: boolean } } }
      | null;
    return Boolean(payload?.ok && payload.data?.driver?.available);
  } catch {
    return false;
  }
}

export function vecUpsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }> {
  return request('vec/upsert', { database, scope, items });
}

export function vecUpdatePayload(
  database: string,
  scope: string,
  items: VecPayloadItem[],
): Promise<{ updated: number }> {
  return request('vec/update-payload', { database, scope, items });
}

export function vecSearch(
  database: string,
  scopes: string[],
  queryVectors: string[],
  opts: { topK?: number; excludeLeafIds?: string[] } = {},
): Promise<{ results: VecHit[] }> {
  return request('vec/search', {
    database,
    scopes,
    queryVectors,
    topK: opts.topK,
    excludeLeafIds: opts.excludeLeafIds,
  });
}

export function vecDelete(database: string, scope: string, leafIds: string[]): Promise<{ deleted: number }> {
  return request('vec/delete', { database, scope, leafIds });
}

export function vecClearScope(database: string, scope: string): Promise<{ deleted: number }> {
  return request('vec/clear-scope', { database, scope });
}

/** Đối chiếu: xóa các lá lỗi thời ở backend, trả về các leafId cần (lập lại) embed. */
export function vecReconcile(
  database: string,
  scope: string,
  present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }> {
  return request('vec/reconcile', { database, scope, present });
}

export function vecStats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }> {
  return request('vec/stats', { database, scopes });
}

export function vecBundleCreate(
  database: string,
  sourceChatId: string,
): Promise<{ hash: string; scope: string; copied: number; reused: boolean }> {
  return request('vec/bundle/create', { database, sourceChatId });
}
