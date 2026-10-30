/**
 * Tầng điều độ lưu trữ vector + bản cài đặt cục bộ thuần frontend (IndexedDB), tập trung trong một file này để hạn chế làm bẩn mã nguồn khác.
 *
 * Đã cài Bách Bảo Khố ở backend → đi qua BackendStore (chuyển tiếp api/baibaoku.ts); chưa cài → tự động hạ cấp trong suốt sang
 * LocalStore: chỉ mục lưu ở IndexedDB của trình duyệt, truy xuất chỉ trong phạm vi cuộc trò chuyện hiện tại (không xuyên cuộc trò chuyện, không xuyên thiết bị).
 *
 * Xuất ra ngoài các hàm vec* **cùng tên cùng chữ ký** với api/baibaoku.ts: bên gọi (index.ts / recall.ts)
 * chỉ cần đổi nguồn import từ '@/api/baibaoku' thành './store', tên hàm và logic không phải sửa một chữ.
 *
 * bundle (ảnh chụp xuyên cuộc trò chuyện khi tạo cuộc trò chuyện mới kèm dữ liệu) là năng lực độc quyền của backend, cục bộ không cài đặt —— carryover.ts vẫn kết nối thẳng
 * với baibaoku, khi không có backend nó sẽ tự bỏ qua việc tạo bundle (cuộc trò chuyện mới không mang truy xuất vector cũ, văn bản tóm tắt vẫn mang theo như thường),
 * đúng là hành vi mong muốn khi hạ cấp, nên không đụng tới carryover.ts.
 *
 * Thăm dò một lần /status của backend, kết quả có bộ nhớ đệm kèm TTL: backend khả dụng thì lưu đệm dài, cục bộ thì lưu đệm ngắn (để nếu lát sau backend sẵn sàng có thể chuyển về lại).
 */

import {
  isBaiBaoKuAvailable,
  vecUpsert as vecUpsertBackend,
  vecUpdatePayload as vecUpdatePayloadBackend,
  vecSearch as vecSearchBackend,
  vecReconcile as vecReconcileBackend,
  vecClearScope as vecClearScopeBackend,
  vecStats as vecStatsBackend,
  type VecItem,
  type VecPayloadItem,
  type VecHit,
} from '@/api/baibaoku';
import { decodeFloat32Base64 } from './embed';

type SearchOpts = { topK?: number; excludeLeafIds?: string[] };

/** Giao diện lưu trữ tối thiểu tương ứng 1-1 với vec* của baibaoku.ts (bundle độc quyền ở backend, không đưa vào giao diện). */
export interface VectorStore {
  kind: 'backend' | 'local';
  upsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }>;
  updatePayload(database: string, scope: string, items: VecPayloadItem[]): Promise<{ updated: number }>;
  search(database: string, scopes: string[], queryVectors: string[], opts?: SearchOpts): Promise<{ results: VecHit[] }>;
  reconcile(
    database: string,
    scope: string,
    present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
  ): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }>;
  clearScope(database: string, scope: string): Promise<{ deleted: number }>;
  stats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }>;
}

/* ============ Bản cài đặt backend: chuyển tiếp api/baibaoku.ts ============ */

const backendStore: VectorStore = {
  kind: 'backend',
  upsert: vecUpsertBackend,
  updatePayload: vecUpdatePayloadBackend,
  search: (db, scopes, qv, opts = {}) => vecSearchBackend(db, scopes, qv, opts),
  reconcile: vecReconcileBackend,
  clearScope: vecClearScopeBackend,
  stats: vecStatsBackend,
};

/* ============ Bản cài đặt cục bộ: IndexedDB + Cosine JS ============ */

const DB_NAME = 'bbs_vec_local';
const DB_VERSION = 1;
const STORE = 'items';

/** Đơn kho đơn bảng trong IndexedDB: key = [database, scope, leafId]; chỉ mục by_scope lấy nguyên đoạn theo [database, scope]. */
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: ['database', 'scope', 'leafId'] });
        os.createIndex('by_scope', ['database', 'scope'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Bản ghi lưu kho: vector lưu trực tiếp dưới dạng Float32Array (sao chép có cấu trúc của IndexedDB hỗ trợ gốc mảng định kiểu, khỏi cần mã hóa/giải mã lặp đi lặp lại). */
interface LocalRecord {
  database: string;
  scope: string;
  leafId: string;
  docHash: string;
  payloadHash?: string;
  vector: Float32Array;
  dim: number;
  document: string;
  mesFull: string | null;
  storyTime: string | null;
  msgIndex: number | null;
}

/** Lấy toàn bộ bản ghi dưới một [database, scope] (quy mô = số lá của cuộc trò chuyện hiện tại, đơn nhân vật hoàn toàn kiểm soát được). */
async function getScopeRows(database: string, scope: string): Promise<LocalRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const idx = tx.objectStore(STORE).index('by_scope');
  const rows = await reqDone(idx.getAll(IDBKeyRange.only([database, scope])));
  return rows as LocalRecord[];
}

/* —— Chuẩn hóa vector / Cosine, tiêu chuẩn khớp với vector-store.js ở backend —— */

function normalize(vec: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const norm = Math.sqrt(s);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** a đã chuẩn hóa, b chuẩn hóa tại đây rồi nhân vô hướng = độ tương đồng cosine; số chiều không khớp trả về -1 (không thể so sánh). */
function dotNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(nb);
  if (norm === 0) return -1;
  return dot / norm;
}

const localStore: VectorStore = {
  kind: 'local',

  async upsert(database, scope, items) {
    if (!items.length) return { upserted: 0 };
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const it of items) {
      const rec: LocalRecord = {
        database,
        scope,
        leafId: it.leafId,
        docHash: it.docHash,
        payloadHash: it.payloadHash,
        vector: decodeFloat32Base64(it.vector),
        dim: it.dim,
        document: it.document,
        mesFull: it.mesFull ?? null,
        storyTime: it.storyTime ?? null,
        msgIndex: it.msgIndex ?? null,
      };
      os.put(rec);
    }
    await txDone(tx);
    return { upserted: items.length };
  },

  async updatePayload(database, scope, items) {
    if (!items.length) return { updated: 0 };
    const rows = await getScopeRows(database, scope);
    const byId = new Map(rows.map(row => [row.leafId, row]));
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    let updated = 0;
    for (const it of items) {
      const rec = byId.get(it.leafId);
      if (!rec) continue;
      rec.payloadHash = it.payloadHash;
      rec.mesFull = it.mesFull ?? null;
      rec.storyTime = it.storyTime ?? null;
      os.put(rec);
      updated++;
    }
    await txDone(tx);
    return { updated };
  },

  // Dung hợp max: mỗi lá lấy cosine cao nhất của nó trên các query, cùng một lá xuyên scope gộp lại giữ điểm cao nhất.
  // Thuần túy lấy topK mục đầu theo điểm cuối cùng, không áp ngưỡng (ngưỡng để dành cho đầu truy xuất phân mức). Khớp hoàn toàn với search ở backend.
  async search(database, scopes, queryVectors, opts = {}) {
    const topK = Number.isInteger(opts.topK) && (opts.topK as number) > 0 ? (opts.topK as number) : 20;
    const exclude = new Set((opts.excludeLeafIds ?? []).map(String));
    if (!scopes.length || !queryVectors.length) return { results: [] };

    const queries = queryVectors.map(decodeFloat32Base64).map(normalize);
    const fused = new Map<string, { row: LocalRecord; bestSim: number; bestQuery: number }>();

    for (const scope of scopes) {
      const rows = await getScopeRows(database, scope);
      for (const r of rows) {
        if (exclude.has(String(r.leafId))) continue;
        const v = r.vector instanceof Float32Array ? r.vector : Float32Array.from(r.vector as ArrayLike<number>);
        let best = -1;
        let bestQ = -1;
        for (let qi = 0; qi < queries.length; qi++) {
          const sim = dotNormalized(queries[qi], v);
          if (sim > best) {
            best = sim;
            bestQ = qi;
          }
        }
        const key = String(r.leafId);
        const prev = fused.get(key);
        if (!prev || best > prev.bestSim || (best === prev.bestSim && r.scope === scopes[0] && prev.row.scope !== scopes[0])) {
          fused.set(key, { row: r, bestSim: best, bestQuery: bestQ });
        }
      }
    }

    const merged = [...fused.values()].sort((a, b) => b.bestSim - a.bestSim).slice(0, topK);
    return {
      results: merged.map(({ row, bestSim, bestQuery }) => ({
        leafId: row.leafId,
        scope: row.scope,
        similarity: bestSim,
        queryIndex: bestQuery,
        document: row.document,
        mesFull: row.mesFull ?? null,
        storyTime: row.storyTime ?? null,
        msgIndex: row.msgIndex ?? null,
      })),
    };
  },

  // Xóa các lá lỗi thời dưới scope không có trong present; trả về các leafId mà kho chưa có / đã đổi hash (cần embed lại).
  async reconcile(database, scope, present) {
    const rows = await getScopeRows(database, scope);
    const presentMap = new Map(present.map(p => [String(p.leafId), {
      docHash: String(p.docHash ?? ''),
      payloadHash: String(p.payloadHash ?? ''),
    }]));
    const existing = new Map(rows.map(r => [String(r.leafId), {
      docHash: String(r.docHash),
      payloadHash: String(r.payloadHash ?? ''),
    }]));

    const toDelete: string[] = [];
    for (const id of existing.keys()) if (!presentMap.has(id)) toDelete.push(id);

    const missing: string[] = [];
    const stalePayload: string[] = [];
    for (const [id, hashes] of presentMap) {
      const cur = existing.get(id);
      if (cur === undefined || cur.docHash !== hashes.docHash) missing.push(id);
      else if (cur.payloadHash !== hashes.payloadHash) stalePayload.push(id);
    }

    if (toDelete.length) {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      for (const id of toDelete) os.delete([database, scope, id]);
      await txDone(tx);
    }
    return { deleted: toDelete.length, missing, stalePayload };
  },

  async clearScope(database, scope) {
    const rows = await getScopeRows(database, scope);
    if (!rows.length) return { deleted: 0 };
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const r of rows) os.delete([database, r.scope, r.leafId]);
    await txDone(tx);
    return { deleted: rows.length };
  },

  async stats(database, scopes) {
    const out: Record<string, number> = {};
    for (const s of scopes) {
      const rows = await getScopeRows(database, s);
      out[s] = rows.length;
    }
    return { stats: out };
  },
};

/* ============ Điều độ: thăm dò backend, chọn store (có bộ nhớ đệm TTL) ============ */

let probe: { store: VectorStore; at: number } | null = null;
const TTL_BACKEND = 5 * 60_000; // Backend khả dụng: trong vòng 5 phút không thăm dò lại
const TTL_LOCAL = 15_000; // Đã hạ cấp xuống cục bộ: sau 15 giây cho phép thăm dò lại (backend có thể vừa mới sẵn sàng)

/** Lấy store đang có hiệu lực: thăm dò /status của backend, khả dụng thì đi qua backend, nếu không thì hạ cấp xuống cục bộ. Kết quả có bộ nhớ đệm TTL. */
export async function getVectorStore(): Promise<VectorStore> {
  const now = Date.now();
  if (probe) {
    const ttl = probe.store.kind === 'backend' ? TTL_BACKEND : TTL_LOCAL;
    if (now - probe.at < ttl) return probe.store;
  }
  let store: VectorStore;
  try {
    store = (await isBaiBaoKuAvailable()) ? backendStore : localStore;
  } catch {
    store = localStore;
  }
  probe = { store, at: now };
  return store;
}

/** Loại backend vector hiện tại ('backend' backend / 'local' hạ cấp cục bộ), phục vụ chỉ báo trạng thái ở trang cài đặt. */
export async function vectorBackendKind(): Promise<'backend' | 'local'> {
  return (await getVectorStore()).kind;
}

/** Xóa bộ nhớ đệm thăm dò: gọi trước khi "Dựng lại / Xóa trống chỉ mục" thủ công, cưỡng chế kiểm tra lại một lần xem backend đã sẵn sàng chưa. */
export function resetVectorStoreProbe(): void {
  probe = null;
}

/* ============ Chuyển tiếp hướng ra ngoài: cùng tên cùng chữ ký với api/baibaoku.ts ============ */

export async function vecUpsert(database: string, scope: string, items: VecItem[]): Promise<{ upserted: number }> {
  return (await getVectorStore()).upsert(database, scope, items);
}

export async function vecUpdatePayload(
  database: string,
  scope: string,
  items: VecPayloadItem[],
): Promise<{ updated: number }> {
  return (await getVectorStore()).updatePayload(database, scope, items);
}

export async function vecSearch(
  database: string,
  scopes: string[],
  queryVectors: string[],
  opts: SearchOpts = {},
): Promise<{ results: VecHit[] }> {
  return (await getVectorStore()).search(database, scopes, queryVectors, opts);
}

export async function vecReconcile(
  database: string,
  scope: string,
  present: Array<{ leafId: string; docHash: string; payloadHash: string }>,
): Promise<{ deleted: number; missing: string[]; stalePayload: string[] }> {
  return (await getVectorStore()).reconcile(database, scope, present);
}

export async function vecClearScope(database: string, scope: string): Promise<{ deleted: number }> {
  return (await getVectorStore()).clearScope(database, scope);
}

export async function vecStats(database: string, scopes: string[]): Promise<{ stats: Record<string, number> }> {
  return (await getVectorStore()).stats(database, scopes);
}
